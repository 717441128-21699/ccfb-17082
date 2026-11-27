import { clamp } from './dsp.ts';

/**
 * 声速与光声测距。
 * 干空气声速 c ≈ 331.3 * sqrt(1 + T/273.15)，工程上常用线性式
 * c ≈ 331.3 + 0.606 * T（T 为摄氏度），两者在 -10~30℃ 区间差异 <0.05%。
 * 这里采用线性式并允许湿度微调（默认干燥空气）。
 */
export function soundSpeed(temperatureC: number, relativeHumidity = 0): number {
  const t = clamp(temperatureC, -50, 60);
  const dry = 331.3 + 0.606 * t;
  // 湿度修正项很小（常温常湿下约 +0.1~0.4 m/s），来自 Cramer 经验式的简化
  const humidityTerm = 0.000124 * relativeHumidity * (t + 100) * 0.05;
  return dry + humidityTerm;
}

/** 由光声延迟反算距离：d = c(T) * (t_听到 - t_看到)。 */
export function distanceFromDelay(delaySec: number, temperatureC: number, relativeHumidity = 0): number {
  if (!Number.isFinite(delaySec) || delaySec < 0) return NaN;
  return soundSpeed(temperatureC, relativeHumidity) * delaySec;
}

/** 由距离与气温求传播延迟（合成测试数据用）。 */
export function delayFromDistance(distanceM: number, temperatureC: number, relativeHumidity = 0): number {
  return distanceM / soundSpeed(temperatureC, relativeHumidity);
}

/** 毫秒格式化。 */
export function fmtMs(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return '—';
  return `${(sec * 1000).toFixed(0)} ms`;
}

/** 秒 -> mm:ss.mmm。 */
export function fmtTime(sec: number | undefined): string {
  if (sec === undefined || !Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(3).padStart(6, '0')}`;
}
