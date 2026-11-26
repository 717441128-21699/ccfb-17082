// 声速与温度校正、通用数值工具

/**
 * 干燥空气声速近似：c ≈ 331.3 * sqrt(1 + T/273.15) m/s
 * 线性近似 c ≈ 331.3 + 0.606 * T 在 -10..30°C 误差 < 0.1%，
 * 这里直接用平方根公式。
 */
export function speedOfSound(tempC: number): number {
  return 331.297 * Math.sqrt(1 + tempC / 273.15);
}

/** 温度每偏差 1°C 约影响 0.6 m/s，给出校正说明 */
export function soundSpeedNote(tempC: number): string {
  const c = speedOfSound(tempC);
  const c0 = speedOfSound(0);
  return `${tempC}°C 时 c=${c.toFixed(1)} m/s（0°C 时 ${c0.toFixed(1)}，温差修正 ${(c - c0 >= 0 ? '+' : '')}${(c - c0).toFixed(1)} m/s）`;
}

/** 可复现的伪随机数（mulberry32），合成测试要求确定性 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const idx = clamp(Math.round((p / 100) * (s.length - 1)), 0, s.length - 1);
  return s[idx];
}

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) * (x - m))));
}

/** 最近时刻匹配（一对一贪心由 matcher 完成，这里只做简单最近） */
export function nearestIndex(sorted: number[], t: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - t) < Math.abs(sorted[lo] - t)) return lo - 1;
  return lo;
}

export function formatTime(sec: number | undefined): string {
  if (sec === undefined || Number.isNaN(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

export function formatMs(v: number | undefined): string {
  if (v === undefined || Number.isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(0)} ms`;
}
