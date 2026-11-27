/**
 * 节拍跟踪流（逐跳推进，无 DOM 依赖），Worklet 与离线分析共用。
 *  - 包络 = 0.7*log(鼓点低频能量 30-120Hz) + 0.3*log(频谱通量)
 *  - 自适应阈值（滚动均值/标准差）+ 不应期峰值拾取
 *  - flush 时对包络做自相关估计全局 BPM（抛物线插值），
 *    再用相邻 onset 间隔中位数给出逐拍局部 BPM，容忍缓慢变速。
 */
import { fftInPlace, hannWindow, onePole } from './dsp.ts';
import type { BeatEvent } from './types.ts';

const FFT_SIZE = 1024;
const HOP_SIZE = 512;
const EPS = 1e-10;

export class BeatTrackerStream {
  private readonly win = hannWindow(FFT_SIZE);
  private readonly re = new Float32Array(FFT_SIZE);
  private readonly im = new Float32Array(FFT_SIZE);
  private readonly prevMag = new Float32Array(FFT_SIZE / 2 + 1);
  private readonly ring = new Float32Array(FFT_SIZE);
  private writePos = 0;
  private sinceHop = 0;
  private hop = 0;

  private envMean = 0;
  private envVar = 0;
  private primed = false;
  private lastOnsetHop = -Infinity;
  private readonly onsetHops: number[] = [];
  private readonly envelope: number[] = [];
  private readonly sampleRate: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
  }

  pushSamples(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) {
      this.ring[this.writePos] = chunk[i];
      this.writePos = (this.writePos + 1) % FFT_SIZE;
      this.sinceHop++;
      if (this.sinceHop === HOP_SIZE) {
        this.sinceHop = 0;
        this.processFrame();
      }
    }
  }

  private processFrame(): void {
    const sr = this.sampleRate;
    for (let i = 0; i < FFT_SIZE; i++) {
      const x = this.ring[(this.writePos + i) % FFT_SIZE];
      this.re[i] = x * this.win[i];
      this.im[i] = 0;
    }
    fftInPlace(this.re, this.im);
    const bins = FFT_SIZE >> 1;
    const binHz = sr / FFT_SIZE;
    const kickLo = Math.max(1, Math.floor(30 / binHz));
    const kickHi = Math.ceil(120 / binHz);

    let kickE = 0;
    let flux = 0;
    for (let k = 1; k <= bins; k++) {
      const m = Math.hypot(this.re[k], this.im[k]) / FFT_SIZE;
      if (k >= kickLo && k <= kickHi) kickE += m * m;
      const d = m - this.prevMag[k];
      if (d > 0) flux += d;
      this.prevMag[k] = m;
    }
    const env = 0.7 * Math.log(kickE + EPS) + 0.3 * Math.log(flux + EPS);
    this.envelope.push(env);

    const hopSec = HOP_SIZE / sr;
    if (!this.primed) {
      this.envMean = env;
      this.envVar = 1;
      this.primed = true;
    } else {
      const old = this.envMean;
      this.envMean = onePole(this.envMean, env, 1 / hopSec, 2);
      this.envVar = onePole(this.envVar, (env - old) * (env - old), 1 / hopSec, 2);
    }
    const std = Math.sqrt(Math.max(this.envVar, EPS));
    const threshold = this.envMean + 0.85 * std;
    const refractoryHops = Math.ceil(0.2 / hopSec);
    const isLocalPeak =
      this.envelope.length >= 3 &&
      env >= this.envelope[this.envelope.length - 2] &&
      env >= (this.envelope[this.envelope.length - 3] ?? -Infinity);

    if (env > threshold && this.hop - this.lastOnsetHop > refractoryHops && isLocalPeak) {
      this.onsetHops.push(this.hop);
      this.lastOnsetHop = this.hop;
    }
    this.hop++;
  }

  /** 自相关估计 BPM（60-200），返回拍周期（hop 数）。 */
  private globalPeriodHops(): number {
    const env = this.envelope;
    const sr = this.sampleRate;
    const hopSec = HOP_SIZE / sr;
    const minLag = Math.floor(60 / 200 / hopSec);
    const maxLag = Math.ceil(60 / 60 / hopSec);
    // 去均值
    let mean = 0;
    for (const v of env) mean += v;
    mean /= env.length;
    let bestLag = minLag;
    let bestVal = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let acc = 0;
      let n = 0;
      for (let i = 0; i + lag < env.length; i += 1) {
        acc += (env[i] - mean) * (env[i + lag] - mean);
        n++;
      }
      const val = acc / Math.max(1, n);
      if (val > bestVal) {
        bestVal = val;
        bestLag = lag;
      }
    }
    // 抛物线插值细化峰值
    if (bestLag > minLag && bestLag < maxLag) {
      const y0 = this.acfAt(bestLag - 1, mean);
      const y1 = this.acfAt(bestLag, mean);
      const y2 = this.acfAt(bestLag + 1, mean);
      const denom = y0 - 2 * y1 + y2;
      if (Math.abs(denom) > EPS) bestLag += 0.5 * (y0 - y2) / denom;
    }
    return bestLag;
  }

  private acfAt(lag: number, mean: number): number {
    const env = this.envelope;
    let acc = 0;
    let n = 0;
    for (let i = 0; i + lag < env.length; i++) {
      acc += (env[i] - mean) * (env[i + lag] - mean);
      n++;
    }
    return acc / Math.max(1, n);
  }

  getBeats(): BeatEvent[] {
    if (this.onsetHops.length === 0) return [];
    const hopSec = HOP_SIZE / this.sampleRate;
    const T0 = this.globalPeriodHops();
    const onsets = [...this.onsetHops].sort((a, b) => a - b);

    // ---- 起始锚点：用前若干稳定 onset 的等间隔回归定位第一个真拍 ----
    // 直接取首个 onset 易受开场杂散污染，改为收集 5 个间隔接近全局周期的
    // 连续 onset，线性回归外推到序列起点
    let startIdx = 0;
    {
      const stable: number[] = [];
      for (let i = 0; i < Math.min(16, onsets.length); i++) {
        if (stable.length === 0 || Math.abs(onsets[i] - stable[stable.length - 1] - T0) < 0.3 * T0) {
          stable.push(onsets[i]);
        } else if (stable.length < 3) {
          stable.length = 0;
          stable.push(onsets[i]);
        }
        if (stable.length >= 4) break;
      }
      if (stable.length >= 3) {
        // 对 stable 做 index->hop 线性拟合，截距即首拍相位
        const n = stable.length;
        const sx = (n - 1) / 2;
        const sy = stable.reduce((a, v) => a + v, 0) / n;
        let num = 0;
        let den = 0;
        stable.forEach((v, i) => {
          num += (i - sx) * (v - sy);
          den += (i - sx) ** 2;
        });
        const slope = num / Math.max(1e-9, den);
        const intercept = sy - slope * sx;
        // 找最接近外推首拍的真实 onset
        let bestI = 0;
        let bestD = Infinity;
        onsets.forEach((h, i) => {
          const d = Math.abs(h - intercept);
          if (d < bestD) {
            bestD = d;
            bestI = i;
          }
        });
        startIdx = bestI;
      }
    }

    // ---- 滑动网格 + 局部周期自适应 ----
    // 每步在 ±0.35 周期窗口找真实 onset 锚点（保留原时刻），并以最近 6 个
    // 锚点间隔的中位数动态更新周期，吸收 BPM 漂移、避免长片段累积偏差
    const tol = 0.45 * T0;
    const beats: BeatEvent[] = [];
    const anchorHops: number[] = [];
    let T = T0;
    let cursor = onsets[startIdx];
    let oi = startIdx;
    const last = onsets[onsets.length - 1];
    let guard = 0;
    let prevBeatHop: number | undefined;
    while (cursor <= last && guard++ < 100000) {
      let nearest = onsets[oi];
      while (oi + 1 < onsets.length && Math.abs(onsets[oi + 1] - cursor) < Math.abs(nearest - cursor)) {
        oi++;
        nearest = onsets[oi];
      }
      if (Math.abs(nearest - cursor) <= tol) {
        const predicted = prevBeatHop === undefined ? nearest : prevBeatHop + T;
        const smoothed = prevBeatHop === undefined ? nearest : 0.65 * predicted + 0.35 * nearest;
        beats.push({ timeSec: smoothed * hopSec, bpm: Math.round(60 / (T * hopSec) * 10) / 10, strong: beats.length % 4 === 0 });
        prevBeatHop = smoothed;
        const prevAnchor = anchorHops[anchorHops.length - 1];
        const interval = prevAnchor === undefined ? T : nearest - prevAnchor;
        anchorHops.push(nearest);
        // 周期更新只用接近当前周期的干净间隔；每个锚点都把相位拉回，
        // 即便间隔异常也不沿错误外推，从下一锚点自然恢复
        if (anchorHops.length >= 2 && Math.abs(interval - T) <= 0.4 * T) {
          const intervals: number[] = [];
          for (let j = Math.max(1, anchorHops.length - 6); j < anchorHops.length; j++) {
            const iv = anchorHops[j] - anchorHops[j - 1];
            if (Math.abs(iv - T) <= 0.4 * T) intervals.push(iv);
          }
          if (intervals.length > 0) {
            intervals.sort((a, b) => a - b);
            const localT = intervals[Math.floor(intervals.length / 2)];
            T = Math.max(T0 * 0.88, Math.min(T0 * 1.12, localT));
          }
        }
        cursor = nearest + T;
        oi++;
      } else if (nearest < cursor - tol) {
        oi++;
      } else {
        const fillHop = cursor;
        beats.push({ timeSec: fillHop * hopSec, bpm: Math.round(60 / (T * hopSec) * 10) / 10, strong: beats.length % 4 === 0 });
        prevBeatHop = fillHop;
        cursor += T;
      }
    }
    return beats;
  }
}

export function trackBeats(channelData: Float32Array, sampleRate: number): BeatEvent[] {
  const t = new BeatTrackerStream(sampleRate);
  t.pushSamples(channelData);
  return t.getBeats();
}
