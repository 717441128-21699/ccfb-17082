/**
 * 爆炸声检测流（逐跳推进，无 DOM 依赖）。
 * AudioWorklet 实时节点与 Node/离线分析共用本类，保证自检覆盖的就是上线代码。
 *
 * 两阶段设计：
 *  1) 逐帧特征（低频冲击能量 40-350Hz、宽带爆轰能量 1-6kHz、频谱平坦度），
 *     相对对数域自适应噪声底计算突变量，onset 必须低频与高频同时突增；
 *  2) 有界分组：onset 后把仍高于维持线的帧归入同一事件（最长 0.5s），
 *     按持续时长/平坦度/高频抬升拒绝鼓点。
 * 回声抑制：场地时间窗内，频谱指纹同源（余弦相似度）且能量严格衰减者判为回声。
 */
import { fftInPlace, hannWindow, onePole, cosineSimilarity, percentile } from './dsp.ts';
import { VENUES, type SoundEvent, type VenueId } from './types.ts';

const FFT_SIZE = 1024;
const HOP_SIZE = 256;
const EPS = 1e-10;
/** FFT 窗中心相对信号起振的固定群延迟标定值（合成数据实测，约 1.6 跳）。 */
const ONSET_BIAS_SEC = 0.0085;

interface Frame {
  hop: number;
  timeSec: number;
  lowE: number;
  highE: number;
  flatness: number;
  lowRatio: number;
  highRatio: number;
}

export class ExplosionDetectorStream {
  private readonly win = hannWindow(FFT_SIZE);
  private readonly re = new Float32Array(FFT_SIZE);
  private readonly im = new Float32Array(FFT_SIZE);
  private readonly ring = new Float32Array(FFT_SIZE);
  private writePos = 0;
  private sinceHop = 0;
  private hop = 0;

  private floorLow = 0;
  private floorHigh = 0;
  private floorRms = 0;
  private primed = false;
  private readonly frames: Frame[] = [];
  private readonly rawCandidates: SoundEvent[] = [];

  private grouping = false;
  private groupStartHop = 0;
  private groupPeakLow = 0;
  private groupPeakHigh = 0;
  private groupPeakFlat = 0;
  private groupFp: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private groupBelowHops = 0;
  private cooldownHops = 0;
  private groupMaxHighRatio = 0;
  private groupEndHop = 0;
  private groupCentroidNum = 0;
  private groupCentroidDen = 0;
  private groupMaxEnergy = 0;
  private groupOnsetHop = 0;
  private groupMaxNovelty = -Infinity;
  private prevLogLow = 0;
  private noveltyHistory: { hop: number; value: number }[] = [];

  private readonly echoWindow: number;
  private readonly echoSim: number;
  private readonly echoRatio: number;
  private readonly sampleRate: number;

  constructor(sampleRate: number, venue: VenueId) {
    this.sampleRate = sampleRate;
    const p = VENUES[venue];
    this.echoWindow = p.echoWindowSec;
    this.echoSim = p.echoSimilarity;
    this.echoRatio = p.echoEnergyRatio;
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
    const loBin = Math.max(1, Math.floor(40 / binHz));
    const lowCut = Math.ceil(350 / binHz);
    const hiLo = Math.floor(1000 / binHz);
    const hiCut = Math.min(bins, Math.ceil(6000 / binHz));
    const flatLo = Math.max(1, Math.floor(100 / binHz));

    let lowE = 0;
    let highE = 0;
    let geo = 0;
    let arith = 0;
    let flatCount = 0;
    const mags = new Float32Array(bins + 1);
    for (let k = 1; k <= bins; k++) {
      const m = Math.hypot(this.re[k], this.im[k]) / FFT_SIZE;
      mags[k] = m;
      if (k >= loBin && k <= lowCut) lowE += m * m;
      if (k >= hiLo && k <= hiCut) highE += m * m;
      if (k >= flatLo && k <= hiCut) {
        geo += Math.log(m + EPS);
        arith += m;
        flatCount++;
      }
    }
    const flatness = Math.exp(geo / flatCount) / (arith / flatCount + EPS);
    // 有效分析频带（40-6000Hz）的总能量，避免全频带安静 bin 稀释突变量
    const rms = Math.sqrt(lowE + highE);
    const logLow = Math.log(lowE + EPS);
    const logHigh = Math.log(highE + EPS);
    const logRms = Math.log(rms + EPS);
    const hopSec = HOP_SIZE / sr;

    if (!this.primed) {
      this.floorLow = logLow;
      this.floorHigh = logHigh;
      this.floorRms = logRms;
      this.primed = true;
    } else {
      // 噪声底在分组外持续适应；分组期间保持慢速跟踪即可
      const tau = this.grouping ? 4 : 0.6;
      this.floorLow = onePole(this.floorLow, logLow, 1 / hopSec, tau);
      this.floorHigh = onePole(this.floorHigh, logHigh, 1 / hopSec, tau);
      this.floorRms = onePole(this.floorRms, logRms, 1 / hopSec, tau);
    }

    const lowRatio = lowE / (Math.exp(this.floorLow) + EPS);
    const highRatio = highE / (Math.exp(this.floorHigh) + EPS);
    const rmsRatio = rms / (Math.exp(this.floorRms) + EPS);
    const f: Frame = { hop: this.hop, timeSec: this.hop * hopSec, lowE, highE, flatness, lowRatio, highRatio };
    this.frames.push(f);

    // 起爆点新颖度（每跳都算，含空闲路径，保证跨组首帧差值有效）
    const novelty = logLow - this.prevLogLow;
    // 全局保留最近 4 跳，供组内峰值的抛物线插值取前一跳
    this.noveltyHistory.push({ hop: this.hop, value: novelty });
    if (this.noveltyHistory.length > 4) this.noveltyHistory.shift();

    // onset 三条路径：
    //  A 低频强冲击（典型爆炸起振的 thump 帧）
    //  B 高频宽带突增 + 高平坦度（低频被前序尾焰掩蔽时的爆炸，鼓点平坦度低走不通）
    //  C 山谷/楼群混响抹平高频后的纯低频重炮（rms 与低频都极强，鼓点 rms 达不到）
    const onsetLow = lowRatio > 12 && rmsRatio > 5;
    const onsetHigh = highRatio > 3 && rmsRatio > 8 && flatness > 0.7;
    const onsetBass = lowRatio > 40 && rmsRatio > 25;
    const onset = onsetLow || onsetHigh || onsetBass;
    // 分组进行中若出现与本组峰值同量级的新冲击，强制切分（相隔较近的两发）
    const strongNewOnset =
      this.grouping &&
      rmsRatio > 6 &&
      (lowE > 0.75 * this.groupPeakLow || highE > 0.75 * this.groupPeakHigh) &&
      (this.hop - this.groupStartHop) * hopSec > 0.2;

    if (!this.grouping && onset && this.cooldownHops === 0) {
      this.startGroup(lowE, highE, flatness, highRatio, mags, binHz, hopSec, novelty);
    } else if (strongNewOnset) {
      this.groupEndHop = this.hop - 1;
      this.closeGroup();
      this.cooldownHops = 0;
      this.startGroup(lowE, highE, flatness, highRatio, mags, binHz, hopSec, novelty);
    } else if (this.grouping) {
      this.groupMaxHighRatio = Math.max(this.groupMaxHighRatio, highRatio);
      this.groupEndHop = this.hop;
      this.groupMaxEnergy = Math.max(this.groupMaxEnergy, lowE + highE);
      // 起爆点 = 组内低频新颖度（帧间 log 能量增量）峰值，抛物线亚帧插值
      if (novelty > this.groupMaxNovelty) {
        this.groupMaxNovelty = novelty;
        this.groupOnsetHop = this.hop;
      }
      // 峰时用前 150ms 低频能量加权质心，比单帧峰值更稳、更贴近真实起爆
      if ((this.hop - this.groupStartHop) * hopSec <= 0.15) {
        this.groupCentroidNum += this.hop * lowE;
        this.groupCentroidDen += lowE;
      }
      // 峰值只在事件前 120ms 的上升段更新，避免尾声/回声把峰时拖偏
      const inAttack = (this.hop - this.groupStartHop) * hopSec <= 0.12;
      if (inAttack && lowE > this.groupPeakLow) {
        this.groupPeakLow = lowE;
        this.groupPeakHigh = highE;
        this.groupPeakFlat = flatness;
        this.groupFp = this.fingerprint(mags, binHz);
      }
      // 按相对本组峰值的衰减收尾：鼓点 <70ms 即跌破，爆炸尾焰约 200-400ms
      const decayed = lowE < 0.1 * this.groupPeakLow && highE < 0.15 * this.groupPeakHigh;
      if (decayed) this.groupBelowHops++;
      else this.groupBelowHops = 0;
      const maxHops = 0.55 / hopSec;
      if (this.groupBelowHops >= 2 || this.hop - this.groupStartHop >= maxHops) {
        this.groupEndHop = this.hop;
        this.closeGroup();
        this.cooldownHops = Math.ceil(0.1 / hopSec);
      }
    }
    if (this.cooldownHops > 0) this.cooldownHops--;
    this.prevLogLow = logLow;
    this.hop++;
  }

  /** 新颖度峰值的抛物线亚帧插值。 */
  private refinedOnsetTime(hopSec: number): number {
    const at = (hop: number) => this.noveltyHistory.find((h) => h.hop === hop)?.value;
    const y0 = at(this.groupOnsetHop - 1);
    const y1 = this.groupMaxNovelty;
    const y2 = at(this.groupOnsetHop + 1);
    let offset = 0;
    if (y0 !== undefined && y2 !== undefined) {
      const denom = y0 - 2 * y1 + y2;
      if (Math.abs(denom) > EPS) offset = 0.5 * (y0 - y2) / denom;
      offset = Math.max(-1, Math.min(1, offset));
    }
    return (this.groupOnsetHop + offset) * hopSec - ONSET_BIAS_SEC;
  }

  private startGroup(
    lowE: number,
    highE: number,
    flatness: number,
    highRatio: number,
    mags: Float32Array,
    binHz: number,
    hopSec: number,
    novelty: number,
  ): void {
    this.grouping = true;
    this.groupStartHop = this.hop;
    this.groupPeakLow = lowE;
    this.groupPeakHigh = highE;
    this.groupPeakFlat = flatness;
    this.groupFp = this.fingerprint(mags, binHz);
    this.groupBelowHops = 0;
    this.groupMaxHighRatio = highRatio;
    this.groupEndHop = this.hop;
    this.groupCentroidNum = this.hop * lowE;
    this.groupCentroidDen = lowE;
    this.groupMaxEnergy = lowE + highE;
    this.groupOnsetHop = this.hop;
    this.groupMaxNovelty = novelty;
    this.prevLogLow = Math.log(lowE + EPS);
    void hopSec;
  }

  private closeGroup(): void {
    const sr = this.sampleRate;
    const hopSec = HOP_SIZE / sr;
    const duration = (this.groupEndHop - this.groupStartHop + 1) * hopSec;
    // 用全片段特征的 20 分位重建稳健参考，避免分组期间噪声底漂移
    const lows = this.frames.map((f) => f.lowE).sort((a, b) => a - b);
    const highs = this.frames.map((f) => f.highE).sort((a, b) => a - b);
    const refLow = percentile(lows, 0.2) + EPS;
    const refHigh = percentile(highs, 0.2) + EPS;
    const highVsFloor = this.groupPeakHigh / refHigh;
    const lowVsFloor = this.groupPeakLow / refLow;

    // 事件级确认：真实爆炸宽带爆轰的高频抬升显著高于音乐/鼓点
    // （真爆 highVsFloor 常达数百，开场音乐等误报 <30）；
    // maxHighRatio 在山谷长混响下会被压低，故以 highVsFloor 为主判据
    if (
      duration >= 0.1 &&
      highVsFloor > 40 &&
      lowVsFloor > 20 &&
      this.groupPeakFlat > 0.6 &&
      this.groupMaxHighRatio > 30
    ) {
      const score = Math.min(
        1,
        0.15 * Math.min(lowVsFloor / 20, 1) +
          0.2 * Math.min(this.groupMaxHighRatio / 20, 1) +
          0.25 * Math.min(this.groupPeakFlat, 1) +
          0.4 * Math.min(duration / 0.3, 1),
      );
      const onsetTime = this.refinedOnsetTime(hopSec);
      this.rawCandidates.push({
        timeSec: this.groupStartHop * hopSec,
        peakSec: onsetTime,
        score,
        lowEnergy: this.groupMaxEnergy,
        flatness: this.groupPeakFlat,
        durationSec: duration,
        fingerprint: this.groupFp,
      });
    }
    this.grouping = false;
  }

  private fingerprint(mags: Float32Array, binHz: number): Float32Array {
    const lo = Math.max(1, Math.floor(40 / binHz));
    const hi = Math.min(mags.length - 1, Math.ceil(2000 / binHz));
    const fp = new Float32Array(hi - lo + 1);
    let norm = 0;
    for (let k = lo; k <= hi; k++) {
      const v = mags[k] + EPS;
      fp[k - lo] = v;
      norm += v * v;
    }
    norm = Math.sqrt(norm);
    for (let i = 0; i < fp.length; i++) fp[i] /= norm;
    return fp;
  }

  getEvents(): { primary: SoundEvent[]; all: SoundEvent[] } {
    if (this.grouping) this.closeGroup();
    const ordered = [...this.rawCandidates].sort((a, b) => a.timeSec - b.timeSec);
    const primaries: SoundEvent[] = [];
    const all: SoundEvent[] = [];
    // 回声链：新事件可挂到任意更早的同源事件（主事件或已确认的回声），
    // 但综合响度不得显著超过链条起点的主事件，防止两发真实爆炸被并成一发
    for (const c of ordered) {
      let echoOf: number | undefined;
      let chainRoot: SoundEvent | undefined;
      for (const p of all) {
        const dt = c.timeSec - p.timeSec;
        if (dt <= 0 || dt > this.echoWindow) continue;
        const root = this.findRoot(p, all);
        const ratioToRoot = c.lowEnergy / (root.lowEnergy + EPS);
        const sim = cosineSimilarity(c.fingerprint, p.fingerprint);
        // 自适应相似度：早期反射频谱畸变小门槛高，多次反射后放宽
        const simThreshold = this.echoSim - 0.12 * Math.min(1, dt / 0.3);
        // 能量显著衰减（<0.55 倍链主）的弱事件物理上只能是回声：
        // 多次反射会让频谱指纹大幅漂移，弱回声只要求非负相关（>0.4）
        const weakEcho = ratioToRoot < 0.55;
        const threshold = weakEcho ? 0.4 : simThreshold;
        if (sim < threshold) continue;
        // 能量约束随相似度放松：频谱高度同源（>=0.93）时，即使窗口因主爆
        // 尾焰叠加而偏响也判回声；相似度一般时仍要求不显著超过链主
        const energyLimit = sim >= 0.93 ? 1.9 : this.echoRatio;
        if (ratioToRoot <= energyLimit) {
          echoOf = p.timeSec;
          chainRoot = root;
          break;
        }
      }
      if (echoOf !== undefined && chainRoot) {
        all.push({ ...c, echoOf: chainRoot.timeSec });
      } else {
        primaries.push(c);
        all.push(c);
      }
    }
    return { primary: primaries, all };
  }

  private findRoot(event: SoundEvent, all: SoundEvent[]): SoundEvent {
    let cur = event;
    const guard = new Set<number>();
    while (cur.echoOf !== undefined && !guard.has(cur.timeSec)) {
      guard.add(cur.timeSec);
      const parent = all.find((e) => Math.abs(e.timeSec - (cur.echoOf as number)) < 1e-6);
      if (!parent) break;
      cur = parent;
    }
    return cur;
  }
}

export function detectExplosions(
  channelData: Float32Array,
  sampleRate: number,
  venue: VenueId,
): { primary: SoundEvent[]; all: SoundEvent[] } {
  const det = new ExplosionDetectorStream(sampleRate, venue);
  det.pushSamples(channelData);
  return det.getEvents();
}
