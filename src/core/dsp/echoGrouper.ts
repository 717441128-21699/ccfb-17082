// 回声分组 v2：时间窗聚类 + 簇内主声选择。
// 同一发的直达声、隆隆二次脉冲和楼群/山谷多次反射都落在 ~1.75s 窗内；
// 簇内选“达到最大强度 82% 的最早 hit”作为主声，避免弱前驱/回声被当成另一发。

import type { SoundHit, SoundShot } from '../types';

export interface EchoGroupParams {
  maxWindowSec?: number;
  /** 距簇内上一个成员超过该间隔则断簇（山谷回声链约 0.7s） */
  chainGapSec?: number;
}

function strength(h: SoundHit): number {
  // 高频宽带能量是爆炸/回声最稳定的强度指标，RMS 辅助
  return h.rms + 3 * h.highEnergy;
}

export function groupEchoes(hits: SoundHit[], params: EchoGroupParams = {}): SoundShot[] {
  const maxWindow = params.maxWindowSec ?? 1.75;
  const chainGap = params.chainGapSec ?? 1.05;

  const sorted = [...hits].sort((a, b) => a.time - b.time);
  const used = new Array(sorted.length).fill(false);
  const shots: SoundShot[] = [];
  let shotId = 1;

  for (let i = 0; i < sorted.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const members: SoundHit[] = [sorted[i]];
    let lastT = sorted[i].time;

    for (let j = i + 1; j < sorted.length; j++) {
      if (used[j]) continue;
      const h = sorted[j];
      const fromStart = h.time - sorted[i].time;
      if (fromStart > maxWindow) break;
      if (h.time - lastT > chainGap) break;
      used[j] = true;
      members.push(h);
      lastT = h.time;
    }

    // 选择主声：直达声是最早的可信脉冲。取强度达到簇内最大值 60% 的最早成员；
    // 明显偏弱（<60%）的前驱声才会让位给紧随其后的强爆炸。
    let maxS = 0;
    for (const m of members) maxS = Math.max(maxS, strength(m));
    const strongEnough = members.filter((m) => strength(m) >= 0.6 * maxS);
    strongEnough.sort((a, b) => a.time - b.time);
    const primary = strongEnough[0] ?? members[0];
    const echoes = members.filter((m) => m.id !== primary.id).sort((a, b) => a.time - b.time);

    shots.push({
      id: shotId++,
      primary,
      echoes,
      echoScore: echoes.length ? Math.min(1, 0.55 + echoes.length * 0.15) : 0,
    });
  }

  return shots;
}

/**
 * 光-声融合纠错：若某个被归入回声的 hit 能与一个未配对亮光组成距离合理的对，
 * 则把它从原组拆出成为独立 SoundShot。
 */
export function splitEchoForLight(
  shots: SoundShot[],
  orphanLightTimes: number[],
  speed: number,
  minDistanceM: number,
  maxDistanceM: number,
): SoundShot[] {
  const minDelay = minDistanceM / speed;
  const maxDelay = maxDistanceM / speed;
  const result: SoundShot[] = [];
  let nextId = shots.length + 1;

  for (const shot of shots) {
    const keepEchoes: SoundHit[] = [];
    for (const e of shot.echoes) {
      const fits = orphanLightTimes.some((lt) => {
        const d = e.time - lt;
        return d >= minDelay && d <= maxDelay;
      });
      if (fits) {
        result.push({ id: nextId++, primary: e, echoes: [], echoScore: 0 });
      } else {
        keepEchoes.push(e);
      }
    }
    result.push({ ...shot, echoes: keepEchoes });
  }

  return result.sort((a, b) => a.primary.time - b.primary.time).map((s, i) => ({ ...s, id: i + 1 }));
}
