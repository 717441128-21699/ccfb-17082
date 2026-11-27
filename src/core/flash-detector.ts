/**
 * 画面闪光检测：从逐帧亮度序列中找出开花造成的亮度突变。
 *  - 帧间亮度差分，滚动 1 秒窗口估计基线均值/标准差
 *  - 差分超过 max(绝对阈值, 基线+4σ) 视为突变帧
 *  - 相距 <120ms 的突变帧合并为一次开花，事件时刻取突变首帧
 * 舞台灯光的缓慢闪烁差分量级远低于开花闪光，不会越阈。
 */
import type { FlashEvent } from './types.ts';

export function detectFlashes(
  frames: { timeSec: number; luminance: number }[],
): FlashEvent[] {
  if (frames.length < 2) return [];
  const deltas: number[] = [];
  for (let i = 1; i < frames.length; i++) deltas.push(frames[i].luminance - frames[i - 1].luminance);

  const windowSize = 30; // 30fps 下约 1 秒
  const events: FlashEvent[] = [];
  let group: number[] | null = null;

  for (let i = 0; i < deltas.length; i++) {
    const from = Math.max(0, i - windowSize);
    let mean = 0;
    for (let j = from; j < i; j++) mean += deltas[j];
    const n = Math.max(1, i - from);
    mean /= n;
    let varAcc = 0;
    for (let j = from; j < i; j++) varAcc += (deltas[j] - mean) ** 2;
    const std = Math.sqrt(varAcc / n);
    const threshold = Math.max(0.12, mean + 4 * std);

    if (deltas[i] > threshold) {
      if (group === null) group = [i];
      else group.push(i);
    } else if (group !== null) {
      const ev = buildEvent(group, frames);
      if (ev) events.push(ev);
      group = null;
    }
  }
  if (group !== null) {
    const ev = buildEvent(group, frames);
    if (ev) events.push(ev);
  }
  return events;
}

function buildEvent(deltaIdx: number[], frames: { timeSec: number; luminance: number }[]): FlashEvent | null {
  const firstFrame = deltaIdx[0]; // deltaIdx[i] 对应 frames[i+1]
  const lastFrame = deltaIdx[deltaIdx.length - 1] + 1;
  if (lastFrame - firstFrame > 10) return null; // 超过 ~330ms 的连续抬升不是瞬态闪光
  let peakFrame = firstFrame;
  let peakLum = -Infinity;
  for (let f = firstFrame; f <= lastFrame; f++) {
    if (frames[f].luminance > peakLum) {
      peakLum = frames[f].luminance;
      peakFrame = f;
    }
  }
  const preLum = frames[Math.max(0, firstFrame - 1)].luminance;
  const peakTime = subFramePeak(frames, peakFrame);
  return {
    // 事件时刻取亮度峰值帧（开花最亮瞬间），抛物线亚帧插值后与声峰对齐测距
    timeSec: peakTime,
    peakSec: peakTime,
    strength: Math.max(0, peakLum - preLum),
  };
}

/** 亮度峰值的抛物线亚帧插值，降低 30fps 的帧量化误差。 */
function subFramePeak(frames: { timeSec: number; luminance: number }[], peakFrame: number): number {
  if (peakFrame === 0 || peakFrame >= frames.length - 1) return frames[peakFrame].timeSec;
  const y0 = frames[peakFrame - 1].luminance;
  const y1 = frames[peakFrame].luminance;
  const y2 = frames[peakFrame + 1].luminance;
  const denom = y0 - 2 * y1 + y2;
  let offset = 0;
  if (Math.abs(denom) > 1e-9) offset = 0.5 * (y0 - y2) / denom;
  offset = Math.max(-1, Math.min(1, offset));
  const framePeriod = frames[1].timeSec - frames[0].timeSec;
  return frames[peakFrame].timeSec + offset * framePeriod;
}
