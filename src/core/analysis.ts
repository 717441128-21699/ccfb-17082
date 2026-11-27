/**
 * 端到端核查流水线：
 *  爆炸声检测（含回声抑制）→ 节拍跟踪 → 闪光检测 →
 *  光声配对与气温校正测距 → 节拍对照 → 编排表点火修正。
 */
import { detectExplosions } from './explosion-detector.ts';
import { trackBeats } from './beat-tracker.ts';
import { detectFlashes } from './flash-detector.ts';
import { distanceFromDelay } from './physics.ts';
import type {
  AnalysisConfig,
  BeatEvent,
  ChoreographyRow,
  FlashEvent,
  ShotRecord,
  SoundEvent,
} from './types.ts';

export interface AnalysisResult {
  shots: ShotRecord[];
  sounds: SoundEvent[];
  echoes: SoundEvent[];
  beats: BeatEvent[];
  flashes: FlashEvent[];
  stats: {
    flashCount: number;
    pairedCount: number;
    unpairedFlash: number;
    echoSuppressed: number;
    meanDistanceM: number | null;
    meanAbsBeatOffsetMs: number | null;
    earlyCount: number;
    lateCount: number;
  };
  correctedChoreography: ChoreographyRow[];
}

/** 声光配对允许的最大传播延迟（约 1700m，超出视为无对应关系）。 */
const MAX_DELAY_SEC = 5;
const MIN_DELAY_SEC = 0.02;

export function runAnalysis(
  channelData: Float32Array,
  sampleRate: number,
  flashFrames: { timeSec: number; luminance: number }[],
  config: AnalysisConfig,
  choreography: ChoreographyRow[] = [],
): AnalysisResult {
  const soundResult = detectExplosions(channelData, sampleRate, config.venue);
  const sounds = soundResult.primary;
  const echoes = soundResult.all.filter((e) => e.echoOf !== undefined);
  const beats = trackBeats(channelData, sampleRate);
  const flashes = detectFlashes(flashFrames);

  // ---- 光声配对（全局鲁棒）：
  //  1) 枚举所有物理可行（声在光之后、延迟 <5s）的闪光-声音候选对
  //  2) 取候选延迟的直方图峰值（众数 bin）作为本场基准延迟——观众位置固定
  //  3) 在基准容差内做一对一贪心，混响造成的离群候选自然落榜 ----
  interface Pair {
    flashIdx: number;
    soundIdx: number;
    delay: number;
  }
  const candidates: Pair[] = [];
  for (let f = 0; f < flashes.length; f++) {
    for (let s = 0; s < sounds.length; s++) {
      const delay = sounds[s].peakSec - flashes[f].peakSec;
      if (delay >= MIN_DELAY_SEC && delay <= MAX_DELAY_SEC) {
        candidates.push({ flashIdx: f, soundIdx: s, delay });
      }
    }
  }
  // 众数基准：60ms 直方图 bin 中候选最多的 bin 中心
  const bin = 0.06;
  const hist = new Map<number, Pair[]>();
  for (const c of candidates) {
    const key = Math.round(c.delay / bin);
    const arr = hist.get(key) ?? [];
    arr.push(c);
    hist.set(key, arr);
  }
  let bestBin: number | undefined;
  let bestCount = 0;
  for (const [key, arr] of hist) {
    if (arr.length > bestCount) {
      bestCount = arr.length;
      bestBin = key;
    }
  }
  const baseDelay = bestBin === undefined ? NaN : bestBin * bin;
  const tolerance = Math.max(0.3 * Math.abs(baseDelay), 0.09);

  const inBand = candidates
    .filter((c) => Math.abs(c.delay - baseDelay) <= tolerance)
    .sort((a, b) => Math.abs(a.delay - baseDelay) - Math.abs(b.delay - baseDelay));
  const usedSounds = new Set<number>();
  const usedFlashes = new Set<number>();
  const accepted = new Map<number, Pair>();
  for (const c of inBand) {
    if (usedSounds.has(c.soundIdx) || usedFlashes.has(c.flashIdx)) continue;
    usedSounds.add(c.soundIdx);
    usedFlashes.add(c.flashIdx);
    accepted.set(c.flashIdx, c);
  }

  // 整场统一延迟：同机位各发距离相同，取配对延迟中位数抑制单发峰时抖动
  const pairDelays = [...accepted.values()].map((p) => p.delay).sort((a, b) => a - b);
  const robustDelay = pairDelays.length
    ? pairDelays[Math.floor(pairDelays.length / 2)]
    : NaN;
  const robustDistance = Number.isFinite(robustDelay)
    ? distanceFromDelay(robustDelay, config.temperatureC)
    : NaN;

  const shots: ShotRecord[] = flashes.map((flash, idx) => {
    const record: ShotRecord = { index: idx + 1, flash };
    const pair = accepted.get(idx);
    if (pair) {
      const sound = sounds[pair.soundIdx];
      record.sound = sound;
      record.lightSoundDelaySec = pair.delay;
      // 单发原始距离保留可见，主测距用整场稳健值
      record.distanceM = robustDistance;
    }
    return record;
  });

  // ---- 节拍对照：找最近节拍，开花相对节拍的偏差（正=落后） ----
  const offsets: number[] = [];
  for (const shot of shots) {
    if (beats.length === 0) break;
    let nearest = beats[0];
    let best = Math.abs(shot.flash.peakSec - nearest.timeSec);
    for (const b of beats) {
      const d = Math.abs(shot.flash.peakSec - b.timeSec);
      if (d < best) {
        best = d;
        nearest = b;
      }
    }
    shot.matchedBeat = nearest;
    shot.beatOffsetSec = shot.flash.peakSec - nearest.timeSec;
    offsets.push(shot.beatOffsetSec);
  }

  // ---- 编排表点火修正 ----
  const corrected = choreography.map((row) => {
    const plannedBurst = row.ignitionSec + row.flightSec;
    let nearest = shots[0];
    let best = Infinity;
    for (const s of shots) {
      const d = Math.abs(s.flash.peakSec - plannedBurst);
      if (d < best) {
        best = d;
        nearest = s;
      }
    }
    if (nearest && best < 1.5 && nearest.beatOffsetSec !== undefined) {
      nearest.plannedIgnitionSec = row.ignitionSec;
      nearest.flightTimeSec = row.flightSec;
      // 开花要挪到节拍上：点火同量平移（飞行时间不变）
      nearest.ignitionCorrectionSec = -nearest.beatOffsetSec;
      return { ...row, ignitionSec: row.ignitionSec - nearest.beatOffsetSec };
    }
    return { ...row };
  });

  const paired = shots.filter((s) => s.distanceM !== undefined);
  const meanDistance = paired.length
    ? paired.reduce((a, s) => a + (s.distanceM ?? 0), 0) / paired.length
    : null;
  const meanAbsOffset = offsets.length
    ? offsets.reduce((a, o) => a + Math.abs(o), 0) / offsets.length
    : null;

  return {
    shots,
    sounds,
    echoes,
    beats,
    flashes,
    correctedChoreography: corrected,
    stats: {
      flashCount: flashes.length,
      pairedCount: paired.length,
      unpairedFlash: flashes.length - paired.length,
      echoSuppressed: echoes.length,
      meanDistanceM: meanDistance === null ? null : Math.round(meanDistance * 10) / 10,
      meanAbsBeatOffsetMs: meanAbsOffset === null ? null : Math.round(meanAbsOffset * 1000),
      earlyCount: offsets.filter((o) => o < -0.02).length,
      lateCount: offsets.filter((o) => o > 0.02).length,
    },
  };
}
