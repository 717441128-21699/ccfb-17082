// 核查流水线：音频检测 -> 回声分组 -> 画面开花 -> 光声配对测距
// -> 节拍对照 -> 编排表点火修正。浏览器（经 AudioWorklet 或直接）与 Node 基准共用。

import { ExplosionDetector } from './dsp/explosionDetector';
import { BeatTracker } from './dsp/beatTracker';
import { detectLightFlashes, type LumaSample } from './dsp/lightDetector';
import { groupEchoes, splitEchoForLight } from './dsp/echoGrouper';
import { matchLightSound } from './dsp/matcher';
import { speedOfSound } from './physics';
import type {
  AnalysisOptions,
  AnalysisResult,
  ChoreographyRow,
  LightEvent,
  ShotReport,
  SoundHit,
} from './types';

export interface CoreInput {
  audio: Float32Array;
  sampleRate: number;
  durationSec?: number;
  luma: LumaSample[];
  options: AnalysisOptions;
  choreography?: ChoreographyRow[];
  truth?: AnalysisResult['truth'];
  /** 浏览器 Worklet 已检出时直接传入，跳过本地检测 */
  precomputedHits?: SoundHit[];
  precomputedBeats?: AnalysisResult['beatGrid'];
}

/** 计算波形/能量降采样，供事件页绘制 */
export function computeEnvelope(
  audio: Float32Array,
  buckets = 1400,
): AnalysisResult['envelope'] {
  const bucketSize = Math.max(1, Math.floor(audio.length / buckets));
  const sr60 = 1 / 60; // 仅用于占位 t，实际由调用方按 sampleRate 修正
  void sr60;
  const out: AnalysisResult['envelope'] = [];
  for (let b = 0; b < buckets; b++) {
    const s0 = b * bucketSize;
    const s1 = Math.min(audio.length, s0 + bucketSize);
    if (s0 >= audio.length) break;
    let sum = 0;
    let peak = 0;
    for (let i = s0; i < s1; i++) {
      const x = audio[i];
      sum += x * x;
      const a = x < 0 ? -x : x;
      if (a > peak) peak = a;
    }
    const n = Math.max(1, s1 - s0);
    out.push({ t: 0, all: Math.sqrt(sum / n), low: 0, high: peak });
  }
  return out;
}

export function runAnalysisCore(input: CoreInput): AnalysisResult {
  const t0 = nowMs();
  const { audio, sampleRate, luma, options } = input;
  const durationSec = input.durationSec ?? audio.length / sampleRate;

  // 1) 爆炸声检测（先做稳健峰值归一化，使绝对高频门限不受录像电平影响）
  let rawHits: SoundHit[];
  if (input.precomputedHits) {
    rawHits = input.precomputedHits;
  } else {
    let maxAbs = 1e-6;
    for (let i = 0; i < audio.length; i++) {
      const a = audio[i] < 0 ? -audio[i] : audio[i];
      if (a > maxAbs) maxAbs = a;
    }
    const inputGain = Math.min(6, Math.max(0.6, 0.95 / maxAbs));
    const detector = new ExplosionDetector(sampleRate, { sensitivity: 0.55, inputGain });
    rawHits = detector.detectAll(audio);
  }

  // 2) 节拍跟踪
  let beatGrid = input.precomputedBeats ?? null;
  if (!beatGrid) {
    const bt = new BeatTracker(sampleRate);
    const block = 2048;
    for (let i = 0; i < audio.length; i += block) {
      bt.process(audio.subarray(i, Math.min(i + block, audio.length)));
    }
    // 用已检出的爆炸声掩蔽低频节拍拟合，避免礼花低频轰鸣拉偏相位
    bt.maskTimes(rawHits.map((h) => h.time));
    beatGrid = bt.finalize(durationSec);
  }

  // 3) 画面开花
  const lightEvents: LightEvent[] = detectLightFlashes(luma);

  // 4) 回声分组
  let soundShots = groupEchoes(rawHits);

  // 5) 光声配对（先做一次，用未配对亮光拆分被误并的回声，再重做）
  const c = speedOfSound(options.temperatureC);
  const dMin = options.minDistanceM ?? 50;
  const dMax = options.maxDistanceM ?? 450;
  let pairs = matchLightSound(lightEvents, soundShots, { ...options, temperatureC: options.temperatureC });
  const pairedLightIds = new Set(pairs.map((p) => p.lightId));
  const orphanLights = lightEvents.filter((l) => !pairedLightIds.has(l.id)).map((l) => l.time);
  if (orphanLights.length) {
    const resplit = splitEchoForLight(soundShots, orphanLights, c, dMin, dMax);
    if (resplit.length !== soundShots.length) {
      soundShots = resplit;
      pairs = matchLightSound(lightEvents, soundShots, { ...options, temperatureC: options.temperatureC });
    }
  }

  // 6) 生成每发报告
  const pairByLight = new Map(pairs.map((p) => [p.lightId, p]));
  const shotById = new Map(soundShots.map((s) => [s.id, s]));
  const reports: ShotReport[] = [];

  const sortedLights = [...lightEvents].sort((a, b) => a.time - b.time);
  const usedShots = new Set<number>();

  sortedLights.forEach((light, idx) => {
    const pair = pairByLight.get(light.id);
    const soundShot = pair ? shotById.get(pair.soundShotId) : undefined;
    if (pair) usedShots.add(pair.soundShotId);

    // 最近节拍
    let beatTime: number | undefined;
    let beatOffsetMs: number | undefined;
    if (beatGrid && beatGrid.beats.length) {
      let best = beatGrid.beats[0];
      let bd = Math.abs(best - light.time);
      for (const bt of beatGrid.beats) {
        const d = Math.abs(bt - light.time);
        if (d < bd) {
          bd = d;
          best = bt;
        }
      }
      if (bd <= beatGrid.periodSec * 0.55) {
        beatTime = best;
        beatOffsetMs = (light.time - best) * 1000;
      }
    }

    reports.push({
      index: idx + 1,
      light,
      pair,
      soundShot,
      beatTime,
      beatOffsetMs,
      correctionMs: beatOffsetMs === undefined ? undefined : -beatOffsetMs,
      status: pair ? 'matched' : 'light-only',
    });
  });

  // 纯声音事件（没有亮光与之配对）
  for (const shot of soundShots) {
    if (usedShots.has(shot.id)) continue;
    if (pairs.some((p) => p.soundShotId === shot.id)) continue;
    reports.push({
      index: reports.length + 1,
      soundShot: shot,
      status: 'sound-only',
    });
  }
  reports.sort((a, b) => (a.light?.time ?? a.soundShot?.primary.time ?? 0) - (b.light?.time ?? b.soundShot?.primary.time ?? 0));
  reports.forEach((r, i) => (r.index = i + 1));

  // 7) 编排表关联与计划偏差
  if (input.choreography?.length) {
    attachChoreography(reports, input.choreography);
  }

  // 8) 波形降采样（时间轴换算）
  const envelope = computeEnvelope(audio, 1600).map((e, i, arr) => ({
    ...e,
    t: (i / arr.length) * durationSec,
  }));

  return {
    durationSec,
    sampleRate,
    options,
    lightEvents,
    rawHits,
    soundShots,
    pairs,
    beatGrid,
    reports,
    lumaSeries: luma.map((l) => ({ t: l.t, v: l.v, x: l.x, y: l.y })),
    envelope,
    elapsedMs: nowMs() - t0,
    truth: input.truth,
  };
}

function attachChoreography(reports: ShotReport[], choreo: ChoreographyRow[]): void {
  const rows = [...choreo].sort((a, b) => a.plannedIgnition + a.flightSec - (b.plannedIgnition + b.flightSec));
  const lightReports = reports.filter((r) => r.light);
  const usedRows = new Set<number>();

  for (const r of lightReports) {
    const lt = r.light!.time;
    let bestRow: ChoreographyRow | null = null;
    let bestD = 2.0;
    for (const row of rows) {
      if (usedRows.has(row.id)) continue;
      const expectedBloom = row.plannedIgnition + row.flightSec;
      const d = Math.abs(expectedBloom - lt);
      if (d < bestD) {
        bestD = d;
        bestRow = row;
      }
    }
    if (bestRow) {
      usedRows.add(bestRow.id);
      r.choreography = bestRow;
      const plannedBloom = bestRow.plannedIgnition + bestRow.flightSec;
      r.planOffsetMs = (lt - plannedBloom) * 1000;
      // 若没有节拍对照，用计划偏差给修正量
      if (r.correctionMs === undefined) {
        r.correctionMs = -r.planOffsetMs;
      }
      r.suggestedIgnition = bestRow.plannedIgnition + (r.correctionMs ?? 0) / 1000;
    }
  }
}

function nowMs(): number {
  // 兼容 Node 与浏览器
  if (typeof performance !== 'undefined' && performance.now) return performance.now();
  return Date.now();
}

/** 全局统计：平均偏差、标准差、提前/落后数量 */
export function beatStats(reports: ShotReport[]): {
  meanMs: number;
  stdMs: number;
  early: number;
  late: number;
  onBeat: number;
  count: number;
  medianMs: number;
} {
  const xs = reports.map((r) => r.beatOffsetMs).filter((v): v is number => v !== undefined);
  const count = xs.length;
  const meanMs = count ? xs.reduce((a, b) => a + b, 0) / count : 0;
  const variance = count ? xs.reduce((a, b) => a + (b - meanMs) ** 2, 0) / count : 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const medianMs = count ? sorted[count >> 1] : 0;
  return {
    meanMs,
    stdMs: Math.sqrt(variance),
    medianMs,
    count,
    early: xs.filter((x) => x < -25).length,
    late: xs.filter((x) => x > 25).length,
    onBeat: xs.filter((x) => Math.abs(x) <= 25).length,
  };
}
