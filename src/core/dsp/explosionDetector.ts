// 爆炸声检测核心 v2：
// 长时非对称自适应底噪 + 高频碎裂突增 + 低频轰击 + 宽带长尾确认。
// 与运行环境无关：AudioWorklet 处理器和 Node 基准脚本调用同一个类。

import { Biquad } from './filters';
import type { SoundHit } from '../types';

const HOP = 128; // 44.1k 下约 2.9ms

interface Hop {
  t: number;
  all: number;
  low: number;
  high: number;
  peak: number;
  flux: number;
  fluxHigh: number;
}

interface Pending {
  onsetIndex: number;
  triggerIndex: number;
  onsetTime: number;
  floorAll: number;
  floorLow: number;
  floorHigh: number;
}

export interface ExplosionParams {
  sensitivity?: number;
  refractorySec?: number;
  /** 输入预增益（由调用方按峰值归一化后给出），让绝对高频门限稳定 */
  inputGain?: number;
}

export class ExplosionDetector {
  readonly sampleRate: number;
  private hopSize = HOP;
  private lp: Biquad;
  private hp: Biquad;
  private inputGain: number;

  private accAll = 0;
  private accLow = 0;
  private accHigh = 0;
  private peak = 0;
  private accCount = 0;
  private totalHops = 0;

  private hist: Hop[] = [];

  // 长时非对称底噪
  private floorAll = 0.02;
  private floorLow = 0.02;
  private floorHigh = 0.008;
  private floorFluxHigh = 0.002;
  private floorsInit = false;

  private pending: Pending | null = null;
  private pendingAge = 0;
  private idSeq = 1;
  private lastEmitTime = -10;
  private refractory: number;
  private sensitivity: number;

  private readonly confirmHops = 52; // ~150ms

  diag = { triggers: 0, emitted: 0, reject: {} as Record<string, number> };

  constructor(sampleRate: number, params: ExplosionParams = {}) {
    this.sampleRate = sampleRate;
    this.lp = new Biquad('lowpass', 170, sampleRate, 0.8);
    this.hp = new Biquad('highpass', 850, sampleRate, 0.7);
    this.refractory = params.refractorySec ?? 0.2;
    this.sensitivity = params.sensitivity ?? 0.55;
    this.inputGain = params.inputGain ?? 1;
  }

  process(input: Float32Array): SoundHit[] {
    const out: SoundHit[] = [];
    for (let i = 0; i < input.length; i++) {
      const x = input[i] * this.inputGain;
      const lo = this.lp.process(x);
      const hi = this.hp.process(x);
      this.accAll += x * x;
      this.accLow += lo * lo;
      this.accHigh += hi * hi;
      const ax = x < 0 ? -x : x;
      if (ax > this.peak) this.peak = ax;
      this.accCount++;

      if (this.accCount === this.hopSize) {
        const hop = this.buildHop();
        this.accAll = this.accLow = this.accHigh = 0;
        this.peak = 0;
        this.accCount = 0;
        this.handleHop(hop, out);
      }
    }
    return out;
  }

  detectAll(samples: Float32Array): SoundHit[] {
    const hits: SoundHit[] = [];
    const block = 128;
    for (let i = 0; i < samples.length; i += block) {
      hits.push(...this.process(samples.subarray(i, Math.min(i + block, samples.length))));
    }
    if (this.pending) {
      const hit = this.confirm(this.pending);
      if (hit) hits.push(hit);
      this.pending = null;
    }
    return hits;
  }

  private buildHop(): Hop {
    const n = this.hopSize;
    const all = Math.sqrt(this.accAll / n);
    const low = Math.sqrt(this.accLow / n);
    const high = Math.sqrt(this.accHigh / n);
    const t = (this.totalHops * this.hopSize) / this.sampleRate;
    const prev = this.hist[this.hist.length - 1];
    let flux = 0;
    let fluxHigh = 0;
    if (prev) {
      flux += Math.max(0, all - prev.all) * 1.0;
      flux += Math.max(0, low - prev.low) * 1.4;
      flux += Math.max(0, high - prev.high) * 1.1;
      fluxHigh = Math.max(0, high - prev.high);
    }
    const hop: Hop = { t, all, low, high, peak: this.peak, flux, fluxHigh };
    this.totalHops++;
    return hop;
  }

  /** 非对称底噪：低于底噪时快速下跟，高于时缓慢上抬 */
  private adaptFloor(f: number, v: number): number {
    const a = v < f ? 0.06 : 0.004;
    return f + a * (v - f);
  }

  private trace(...args: unknown[]): void {
    const g = globalThis as unknown as { __TRACE_T?: [number, number] };
    if (g.__TRACE_T) {
      const t = args[0] as number;
      if (t >= g.__TRACE_T[0] && t <= g.__TRACE_T[1]) console.log(...args.slice(1));
    }
  }

  private handleHop(hop: Hop, out: SoundHit[]): void {
    if (!this.floorsInit && this.totalHops > 4) {
      this.floorAll = Math.max(0.01, hop.all);
      this.floorLow = Math.max(0.01, hop.low);
      this.floorHigh = Math.max(0.004, hop.high);
      this.floorsInit = true;
    }
    this.floorAll = this.adaptFloor(this.floorAll, hop.all);
    this.floorLow = this.adaptFloor(this.floorLow, hop.low);
    this.floorHigh = this.adaptFloor(this.floorHigh, hop.high);
    this.floorFluxHigh = this.adaptFloor(this.floorFluxHigh, hop.fluxHigh);

    if (this.pending) {
      // 强 onset 抢占（仅一次）：确认真正的爆炸起点，避免被前面的弱触发声锁死，
      // 也防止爆炸内部渐强的调制尖峰把时刻不断向后推。
      const trigFlux = (this.pending as Pending & { trigFlux?: number }).trigFlux ?? 0;
      const preempted = (this.pending as Pending & { preempted?: boolean }).preempted ?? false;
      const preempt =
        !preempted &&
        hop.fluxHigh > trigFlux * 1.6 &&
        hop.high > this.pending.floorHigh * 2.8 &&
        this.pendingAge < this.confirmHops;
      if (preempt) {
        this.trace(hop.t, `PREEMPT at ${hop.t.toFixed(4)} flux=${hop.fluxHigh.toFixed(3)} trigFlux=${trigFlux.toFixed(3)} age=${this.pendingAge}`);
        let onsetIndex = this.hist.length;
        for (let back = 1; back <= 6; back++) {
          const idx = this.hist.length - back;
          if (idx < 0) break;
          const cur = this.hist[idx];
          const nxt = this.hist[idx + 1] ?? hop;
          if (nxt.high >= cur.high * 1.3) onsetIndex = idx + 1;
          else break;
        }
        const onsetHop = onsetIndex < this.hist.length ? this.hist[onsetIndex] : hop;
        this.pending.onsetIndex = onsetIndex;
        this.pending.triggerIndex = this.hist.length;
        this.pending.onsetTime = onsetHop.t;
        (this.pending as Pending & { trigFlux?: number }).trigFlux = hop.fluxHigh;
        (this.pending as Pending & { preempted?: boolean }).preempted = true;
        this.pendingAge = 0;
      } else {
        this.pendingAge++;
        if (this.pendingAge >= this.confirmHops) {
          const hit = this.confirm(this.pending);
          if (hit) {
            out.push(hit);
            this.lastEmitTime = hit.time;
          }
          this.pending = null;
        }
      }
    }

    const highRatio = hop.high / (this.floorHigh + 1e-4);
    const fluxGate = hop.fluxHigh > (2.2 - this.sensitivity) * (this.floorFluxHigh + 0.004);
    const highGate = highRatio >= 2.1 - this.sensitivity * 0.4; // .55 -> 1.88
    const energyGate = hop.all > Math.max(0.05, this.floorAll * 1.5);
    const timeOk = hop.t - this.lastEmitTime > this.refractory;

    if (!this.pending && fluxGate && highGate && energyGate && timeOk) {
      this.diag.triggers++;
      this.trace(hop.t, `TRIGGER t=${hop.t.toFixed(4)} fH=${hop.fluxHigh.toFixed(3)} hR=${highRatio.toFixed(1)} timeOk=${timeOk}`);
      // 回溯起振点：高频/总能量刚抬起的位置
      let onsetIndex = this.hist.length;
      for (let back = 1; back <= 8; back++) {
        const idx = this.hist.length - back;
        if (idx < 0) break;
        const cur = this.hist[idx];
        const nxt = this.hist[idx + 1] ?? hop;
        if (nxt.high >= cur.high * 1.35 || nxt.all >= cur.all * 1.22) {
          onsetIndex = idx + 1;
        } else {
          break;
        }
      }
      const onsetHop = onsetIndex < this.hist.length ? this.hist[onsetIndex] : hop;
      this.pending = {
        onsetIndex,
        triggerIndex: this.hist.length,
        onsetTime: onsetHop.t,
        floorAll: this.floorAll,
        floorLow: this.floorLow,
        floorHigh: this.floorHigh,
      };
      (this.pending as Pending & { trigFlux?: number }).trigFlux = hop.fluxHigh;
      this.pendingAge = 0;
    }

    this.hist.push(hop);
  }

  private confirm(p: Pending): SoundHit | null {
    const start = Math.max(0, p.onsetIndex);
    const end = Math.min(this.hist.length, p.triggerIndex + this.confirmHops);
    const win = this.hist.slice(start, end + 1);
    if (win.length < 6) return null;

    let lowPeak = 0;
    let highPeak = 0;
    let allPeak = 0;
    let peakSample = 0;
    let tailHighSum = 0;
    let tailHighN = 0;
    let tailAllSum = 0;
    let tailAllN = 0;
    let first40HighSq = 0;

    for (let i = 0; i < win.length; i++) {
      const h = win[i];
      if (h.low > lowPeak) lowPeak = h.low;
      if (h.high > highPeak) highPeak = h.high;
      if (h.all > allPeak) allPeak = h.all;
      if (h.peak > peakSample) peakSample = h.peak;
      if (i <= 42) first40HighSq += h.high * h.high;
      // 起振后 35..150ms 的尾部：爆炸宽带隆隆/碎裂仍在，鼓/镲已衰减
      if (i >= 12 && i <= 50) {
        tailHighSum += h.high;
        tailHighN++;
      }
      if (i >= 18 && i <= 50) {
        tailAllSum += h.all;
        tailAllN++;
      }
    }

    const rHigh = highPeak / (p.floorHigh + 1e-4);
    const rLow = lowPeak / (p.floorLow + 1e-4);
    const rAll = allPeak / (p.floorAll + 1e-4);
    const tailHigh = tailHighN ? tailHighSum / tailHighN / (p.floorHigh + 1e-4) : 0;
    const tailAll = tailAllN ? tailAllSum / tailAllN / (p.floorAll + 1e-4) : 0;
    const highRms = Math.sqrt(first40HighSq / Math.max(1, Math.min(43, win.length)));

    const highReq = 3.4 - this.sensitivity * 1.2; // .55 -> 2.74
    const lowReq = 1.9 - this.sensitivity * 0.5; // .55 -> 1.62
    const tailReq = 2.4 - this.sensitivity * 0.8; // .55 -> 1.96
    const absHighReq = 0.075 - this.sensitivity * 0.04; // .55 -> .053

    const checks: [string, boolean][] = [
      ['rHigh', rHigh >= highReq],
      ['rLow', rLow >= lowReq],
      ['tailHigh', tailHigh >= tailReq],
      ['allPeak', allPeak >= 0.07],
      ['rAll', rAll >= 1.8],
      ['absHigh', highRms >= absHighReq],
    ];
    const failed = checks.filter(([, ok]) => !ok).map(([k]) => k);
    if (failed.length) {
      for (const f of failed) this.diag.reject[f] = (this.diag.reject[f] ?? 0) + 1;
      const dbg = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process?.env
        ?.DEBUG_DETECT;
      if (dbg) {
        // eslint-disable-next-line no-console
        console.log(
          `reject t=${p.onsetTime.toFixed(3)} rH=${rHigh.toFixed(1)} rL=${rLow.toFixed(1)} rA=${rAll.toFixed(1)} tailH=${tailHigh.toFixed(1)} tailA=${tailAll.toFixed(1)} peak=${allPeak.toFixed(2)} fail=${failed.join(',')}`,
        );
      }
      return null;
    }

    const score = Math.min(
      1,
      0.3 +
        Math.min(rHigh / 12, 1) * 0.3 +
        Math.min(rLow / 7, 1) * 0.18 +
        Math.min(tailHigh / 8, 1) * 0.17 +
        Math.min(rAll / 6, 1) * 0.05,
    );

    this.diag.emitted++;
    const refinedTime = this.estimateOnset(p, start, end);
    return {
      id: this.idSeq++,
      time: refinedTime,
      triggerTime: p.onsetTime,
      peak: peakSample,
      rms: allPeak,
      lowEnergy: lowPeak,
      highEnergy: highRms,
      score,
    };
  }

  /**
   * 稳健起振估计：确认窗内找高频能量主峰，再在其前方 ~90ms 找“最大高频通量峰”
   * 作为真正的炸裂起点（爆炸 crack 的通量远大于其前几十毫秒的鼓/军鼓），
   * 最后做抛物线亚 hop 插值。不依赖触发锚点，避免弱前驱/内部调制尖峰带偏。
   */
  private estimateOnset(p: Pending, start: number, end: number): number {
    const hopDur = this.hopSize / this.sampleRate;
    let highPeakIdx = start;
    let highPeak = 0;
    for (let i = start; i <= end && i < this.hist.length; i++) {
      if (this.hist[i].high > highPeak) {
        highPeak = this.hist[i].high;
        highPeakIdx = i;
      }
    }
    const from = Math.max(start, highPeakIdx - 32);
    const to = Math.min(this.hist.length - 1, highPeakIdx + 2);
    let fluxIdx = highPeakIdx;
    let fluxPeak = -1;
    for (let i = from; i <= to; i++) {
      // 通量与高频绝对增量联合，偏好真正的炸裂瞬态
      const f = this.hist[i].fluxHigh + 0.15 * Math.max(0, this.hist[i].high - p.floorHigh);
      if (f > fluxPeak) {
        fluxPeak = f;
        fluxIdx = i;
      }
    }
    // 若前一 hop 已出现同等强的抬起，前移一格
    if (fluxIdx - 1 >= start && this.hist[fluxIdx - 1].fluxHigh >= this.hist[fluxIdx].fluxHigh * 0.6) {
      fluxIdx -= 1;
    }

    const h0 = this.hist[fluxIdx - 1];
    const h1 = this.hist[fluxIdx];
    const h2 = this.hist[fluxIdx + 1];
    let shift = 0;
    if (h0 && h1 && h2) {
      const y0 = h0.fluxHigh;
      const y1 = h1.fluxHigh;
      const y2 = h2.fluxHigh;
      const denom = y0 - 2 * y1 + y2;
      if (denom < 0) shift = (0.5 * (y0 - y2)) / denom;
      shift = Math.max(-0.5, Math.min(0.5, shift));
    }
    let t = (this.hist[fluxIdx]?.t ?? p.onsetTime) + shift * hopDur;
    // 安全夹：相对候选锚点不允许跳到过远的独立音乐事件
    t = Math.max(p.onsetTime - 0.12, Math.min(p.onsetTime + 0.08, t));
    return t;
  }
}

export function detectExplosions(samples: Float32Array, sampleRate: number, sensitivity?: number): SoundHit[] {
  const d = new ExplosionDetector(sampleRate, { sensitivity });
  return d.detectAll(samples);
}
