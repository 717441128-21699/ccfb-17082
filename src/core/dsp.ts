/**
 * 基础数字信号处理工具：窗函数、原地 radix-2 FFT、频段能量、包络平滑。
 * 全部为纯函数/无 DOM 依赖，可在 AudioWorklet、Node 自检脚本中复用。
 */

export function hannWindow(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / Math.max(1, n - 1)));
  }
  return w;
}

/** 原地迭代 radix-2 Cooley-Tukey FFT，n 必须为 2 的幂。re/im 长度均为 n。 */
export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('FFT 长度必须为 2 的幂');

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < half; k++) {
        const aR = re[i + k];
        const aI = im[i + k];
        const bR = re[i + k + half] * curR - im[i + k + half] * curI;
        const bI = re[i + k + half] * curI + im[i + k + half] * curR;
        re[i + k] = aR + bR;
        im[i + k] = aI + bI;
        re[i + k + half] = aR - bR;
        im[i + k + half] = aI - bI;
        const nxtR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nxtR;
      }
    }
  }
}

export interface FrameSpectrum {
  mag: Float32Array;
  binHz: number;
}

/** 对一帧时域信号加 Hann 窗并求幅度谱（长度 frameSize/2+1）。 */
export function magnitudeSpectrum(frame: Float32Array): FrameSpectrum {
  const n = frame.length;
  const win = hannWindow(n);
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = frame[i] * win[i];
  fftInPlace(re, im);
  const bins = n >> 1;
  const mag = new Float32Array(bins + 1);
  for (let k = 0; k <= bins; k++) {
    mag[k] = Math.hypot(re[k], im[k]) / n;
  }
  return { mag, binHz: 1 /* 占位，调用方按 sampleRate/n 换算 */ };
}

/** 指定频段（Hz，含端点）内的能量，输入为幅度谱。 */
export function bandEnergy(mag: Float32Array, sampleRate: number, fftSize: number, loHz: number, hiHz: number): number {
  const binHz = sampleRate / fftSize;
  const lo = Math.max(1, Math.floor(loHz / binHz));
  const hi = Math.min(mag.length - 1, Math.ceil(hiHz / binHz));
  let e = 0;
  for (let k = lo; k <= hi; k++) e += mag[k] * mag[k];
  return e;
}

/** 一阶低通包络（one-pole），timeConstantSec 为时间常数。 */
export function onePole(prev: number, x: number, sampleRate: number, timeConstantSec: number): number {
  const alpha = 1 - Math.exp(-1 / Math.max(1e-6, timeConstantSec * sampleRate));
  return prev + alpha * (x - prev);
}

export function percentile(sortedAsc: number[] | Float32Array, q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const pos = Math.min(n - 1, Math.max(0, q * (n - 1)));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] * (hi - pos) + sortedAsc[hi] * (pos - lo);
}

/** 两个向量的余弦相似度，用于回声频谱指纹比对。 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na * nb);
  return den > 1e-12 ? dot / den : 0;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
