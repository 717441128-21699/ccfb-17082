// 光-声配对：在气温校正后的距离窗内，做保序的全局最优一一配对。
// 直达声是开花后的第一个强声，回声已在 SoundShot 分组中归并。

import { speedOfSound } from '../physics';
import type { LightEvent, LightSoundPair, SoundShot } from '../types';

export interface MatchOptions {
  temperatureC: number;
  minDistanceM?: number;
  maxDistanceM?: number;
  avOffsetMs?: number;
}

/**
 * 返回配对。avOffsetSec 为“画面时间 - 声音时间”的系统偏差校正：
 * 若手机音轨相对画面有偏移，由用户给出。校正后声达 = soundTime + avOffset?
 * 约定 avOffsetMs 正值表示声音比画面晚（常见蓝牙/封装延迟），需要从 delay 中扣除。
 */
export function matchLightSound(
  lights: LightEvent[],
  shots: SoundShot[],
  opts: MatchOptions,
): LightSoundPair[] {
  const c = speedOfSound(opts.temperatureC);
  const dMin = opts.minDistanceM ?? 50;
  const dMax = opts.maxDistanceM ?? 450;
  const minDelay = dMin / c;
  const maxDelay = dMax / c;
  const avCorrection = (opts.avOffsetMs ?? 0) / 1000;

  const L = [...lights].sort((a, b) => a.time - b.time);
  const S = [...shots].sort((a, b) => a.primary.time - b.primary.time);
  const n = L.length;
  const m = S.length;

  const matchCost = (i: number, j: number): number | null => {
    const delay = S[j].primary.time - L[i].time - avCorrection;
    if (delay < minDelay || delay > maxDelay) return null;
    // 越强的事件越可信；轻微偏向更早的声音（直达声先于残余干扰）
    const scorePart = 1.1 * (1 - S[j].primary.score) + 0.5 * (1 - L[i].score);
    const earlyBias = 0.08 * delay;
    return scorePart + earlyBias;
  };

  // DP：dp[i][j] 前 i 个光、j 个声的最小代价
  const SKIP_L = 0.9;
  const SKIP_S = 0.55;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const choice: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) dp[i][0] = i * SKIP_L;
  for (let j = 1; j <= m; j++) dp[0][j] = j * SKIP_S;

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      let best = dp[i - 1][j] + SKIP_L;
      let ch = 1; // skip light
      const cs = dp[i][j - 1] + SKIP_S;
      if (cs < best) {
        best = cs;
        ch = 2;
      }
      const mc = matchCost(i - 1, j - 1);
      if (mc !== null) {
        const v = dp[i - 1][j - 1] + mc;
        if (v < best) {
          best = v;
          ch = 3;
        }
      }
      dp[i][j] = best;
      choice[i][j] = ch;
    }
  }

  const pairs: LightSoundPair[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const ch = choice[i][j];
    if (ch === 3) {
      const Lv = L[i - 1];
      const Sv = S[j - 1];
      const delay = Sv.primary.time - Lv.time - avCorrection;
      pairs.push({
        lightId: Lv.id,
        soundShotId: Sv.id,
        lightTime: Lv.time,
        soundTime: Sv.primary.time,
        delaySec: delay,
        speedOfSound: c,
        distanceM: delay * c,
        matchCost: matchCost(i - 1, j - 1) ?? 0,
      });
      i--;
      j--;
    } else if (ch === 1) i--;
    else j--;
  }
  pairs.sort((a, b) => a.lightTime - b.lightTime);
  return pairs;
}
