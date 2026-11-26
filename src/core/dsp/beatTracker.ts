// 节拍跟踪核心 v3：低频 onset 通量自相关估速度，
// 再对 (周期, 相位) 做小范围连续联合搜索，消除整格速度误差在长曲上的累计漂移。

import { Biquad } from './filters';
import type { BeatGrid } from '../types';

const HOP = 256;

export class BeatTracker {
  readonly sampleRate: number;
  private lp: Biquad;
  private accLow = 0;
  private accAll = 0;
  private count = 0;
  private hopIndex = 0;
  private prevLow = 0;
  private prevAll = 0;
  readonly lowFlux: number[] = [];
  readonly onset: number[] = [];
  readonly lowEnv: number[] = [];

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.lp = new Biquad('lowpass', 160, sampleRate, 0.7);
  }

  process(input: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      const x = input[i];
      const lo = this.lp.process(x);
      this.accLow += lo * lo;
      this.accAll += x * x;
      this.count++;
      if (this.count === HOP) {
        const low = Math.sqrt(this.accLow / HOP);
        const e = Math.sqrt(this.accAll / HOP);
        const lf = Math.max(0, low - this.prevLow);
        const flux = lf * 1.5 + Math.max(0, e - this.prevAll) * 0.5;
        this.lowFlux.push(lf);
        this.onset.push(flux);
        this.lowEnv.push(low);
        this.prevLow = low;
        this.prevAll = e;
        this.accLow = 0;
        this.accAll = 0;
        this.count = 0;
        this.hopIndex++;
      }
    }
  }

  /** 掩蔽爆炸时刻附近的低频通量，避免巨大的离网低频 onset 拉偏网格 */
  maskTimes(times: number[], guardSec = 0.34): void {
    const hopRate = this.sampleRate / HOP;
    const g = Math.round(guardSec * hopRate);
    for (const t of times) {
      const ci = Math.round(t * hopRate);
      for (let i = Math.max(0, ci - g); i <= Math.min(this.lowFlux.length - 1, ci + g); i++) {
        this.lowFlux[i] = 0;
        this.onset[i] = 0;
      }
    }
  }

  finalize(durationSec?: number): BeatGrid {
    const hopRate = this.sampleRate / HOP;
    const env0 = this.lowFlux;
    const dur = durationSec ?? this.hopIndex / hopRate;
    if (env0.length < hopRate * 8) {
      return { bpm: 0, confidence: 0, beats: [], periodSec: 0, phaseSec: 0 };
    }

    // 3 点平滑
    const env = env0.map((_, i) => {
      let s = 0;
      let n = 0;
      for (let k = -1; k <= 1; k++) {
        const j = i + k;
        if (j >= 0 && j < env0.length) {
          s += env0[j];
          n++;
        }
      }
      return s / n;
    });
    const mean = env.reduce((a, b) => a + b, 0) / env.length;
    const x = env.map((v) => Math.max(0, v - mean * 0.4));

    // 自相关找整数 lag
    const minLag = Math.round((60 / 168) * hopRate);
    const maxLag = Math.round((60 / 76) * hopRate);
    const corrAt = (lag: number): number => {
      let c = 0;
      let n = 0;
      for (let i = lag; i < x.length; i++) {
        c += x[i] * x[i - lag];
        n++;
      }
      return n ? c / n : 0;
    };
    let bestLag = minLag;
    let bestCorr = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const c = corrAt(lag);
      if (c > bestCorr) {
        bestCorr = c;
        bestLag = lag;
      }
    }
    // 倍频程校正
    const candidates = [bestLag, bestLag * 2, Math.round(bestLag / 2)].filter(
      (l) => l >= minLag && l <= maxLag,
    );
    let chosenLag = bestLag;
    let chosenScore = bestCorr;
    for (const lag of candidates) {
      if (lag === bestLag) continue;
      const c = corrAt(lag);
      const bpm = 60 / (lag / hopRate);
      const prior = 1 - Math.min(0.3, Math.abs(Math.log2(bpm / 120)) * 0.45);
      const score = c * (0.85 + 0.3 * prior);
      if (score > chosenScore) {
        chosenScore = score;
        chosenLag = lag;
      }
    }
    const p0 = chosenLag / hopRate;

    // ---- (P, phi) 连续联合搜索：网格点低频通量均值最大化 ----
    const valueAt = (timeSec: number): number => {
      const i = Math.round(timeSec * hopRate);
      let v = 0;
      for (let k = -1; k <= 1; k++) {
        const j = i + k;
        if (j >= 0 && j < env.length && env[j] > v) v = env[j];
      }
      return v;
    };
    const scoreGrid = (P: number, phi: number): number => {
      let s = 0;
      let n = 0;
      for (let t = phi; t <= dur + 0.02; t += P) {
        s += valueAt(t);
        n++;
      }
      return n ? s / Math.sqrt(n) : 0;
    };

    let best = { P: p0, phi: 0, score: -Infinity };
    // 粗搜 phi 5ms，P 在 ±5ms 内 0.25ms
    for (let dP = -0.005; dP <= 0.00501; dP += 0.00025) {
      const P = p0 + dP;
      for (let phi = 0; phi < P; phi += 0.005) {
        const s = scoreGrid(P, phi);
        if (s > best.score) best = { P, phi, score: s };
      }
    }
    // 细搜：P ±0.3ms / 0.05ms，phi ±6ms / 1ms
    const bp = best.phi;
    for (let dP = -0.0004; dP <= 0.000401; dP += 0.00005) {
      const P = best.P + dP;
      for (let dphi = -0.008; dphi <= 0.00801; dphi += 0.001) {
        let phi = bp + dphi;
        phi = ((phi % P) + P) % P;
        const s = scoreGrid(P, phi);
        if (s > best.score) best = { P, phi, score: s };
      }
    }

    const periodSec = best.P;
    const phaseSec = best.phi;
    const bpm = 60 / periodSec;

    const beats: number[] = [];
    const firstK = Math.ceil((0 - phaseSec) / periodSec);
    for (let k = firstK; ; k++) {
      const t = phaseSec + k * periodSec;
      if (t > dur + 0.05) break;
      if (t >= -0.02) beats.push(Math.max(0, t));
    }

    // 置信度：网格点通量相对邻域的突出程度
    let on = 0;
    let off = 0;
    let onN = 0;
    let offN = 0;
    for (const b of beats) {
      on += valueAt(b);
      onN++;
      off += valueAt(b + periodSec / 2);
      offN++;
    }
    const ratio = onN && offN ? on / onN / (off / offN + 1e-6) : 1;
    const confidence = Math.max(0.25, Math.min(1, 0.35 + (ratio - 1) * 0.5));

    return { bpm, confidence, beats, periodSec, phaseSec };
  }
}

export function trackBeats(samples: Float32Array, sampleRate: number, durationSec?: number): BeatGrid {
  const t = new BeatTracker(sampleRate);
  const block = 2048;
  for (let i = 0; i < samples.length; i += block) {
    t.process(samples.subarray(i, Math.min(i + block, samples.length)));
  }
  return t.finalize(durationSec ?? samples.length / sampleRate);
}
