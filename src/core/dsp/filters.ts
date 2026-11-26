// 轻量 IIR 滤波器组（Biquad），供爆炸声/节拍检测共用。
// 同时可在 AudioWorklet 与 Node 基准中运行，不依赖任何 Web API。

export type BiquadType = 'lowpass' | 'highpass' | 'bandpass';

export class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private x1 = 0;
  private x2 = 0;
  private y1 = 0;
  private y2 = 0;

  constructor(
    public type: BiquadType,
    public freq: number,
    public sampleRate: number,
    public q = 0.707,
  ) {
    this.coeff();
  }

  private coeff(): void {
    const w0 = (2 * Math.PI * this.freq) / this.sampleRate;
    const cosw = Math.cos(w0);
    const sinw = Math.sin(w0);
    const alpha = sinw / (2 * this.q);
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number;
    if (this.type === 'lowpass') {
      b0 = (1 - cosw) / 2;
      b1 = 1 - cosw;
      b2 = (1 - cosw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    } else if (this.type === 'highpass') {
      b0 = (1 + cosw) / 2;
      b1 = -(1 + cosw);
      b2 = (1 + cosw) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    } else {
      // bandpass, 0 dB peak gain
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cosw;
      a2 = 1 - alpha;
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1;
    this.x1 = x;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }

  reset(): void {
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
}

/** 一阶指数平滑包络 */
export class EnvelopeFollower {
  private v = 0;
  constructor(
    public attackMs: number,
    public releaseMs: number,
    private sampleRate: number,
  ) {}

  process(x: number): number {
    const coef = x > this.v ? Math.exp(-1 / ((this.attackMs / 1000) * this.sampleRate)) : Math.exp(-1 / ((this.releaseMs / 1000) * this.sampleRate));
    this.v = coef * this.v + (1 - coef) * x;
    return this.v;
  }

  get value(): number {
    return this.v;
  }
}

/** 计算一段信号的 RMS 与峰值 */
export function rmsPeak(buf: Float32Array | number[], start = 0, end?: number): { rms: number; peak: number } {
  const e = end ?? buf.length;
  let sum = 0;
  let peak = 0;
  for (let i = start; i < e; i++) {
    const x = buf[i];
    sum += x * x;
    const a = Math.abs(x);
    if (a > peak) peak = a;
  }
  const n = Math.max(1, e - start);
  return { rms: Math.sqrt(sum / n), peak };
}
