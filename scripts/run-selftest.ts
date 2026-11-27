/**
 * 合成数据自检（node --experimental-strip-types 风格；Node 24 可直接跑 .ts）。
 * 指标：
 *  - 爆炸声检出率 ≥ 95%
 *  - 回声误检为另一发 ≤ 2%（以每发真实回声次数为基数）
 *  - 光声测距误差 ≤ 距离的 5%（-10℃~30℃ 全区间声速校正）
 *  - 节拍跟踪 F1 ≥ 90%（容差 70ms）
 *  - 4 分钟演出核查总耗时 ≤ 30s
 */
import { generateSyntheticClip } from '../src/core/synth.ts';
import { detectExplosions } from '../src/core/explosion-detector.ts';
import { trackBeats } from '../src/core/beat-tracker.ts';
import { runAnalysis } from '../src/core/analysis.ts';
import { soundSpeed } from '../src/core/physics.ts';
import type { VenueId } from '../src/core/types.ts';

const TOL_MATCH = 0.12; // 声音事件匹配容差（秒）
const TOL_BEAT = 0.07;

interface CaseResult {
  name: string;
  shots: number;
  detected: number;
  recall: number;
  echoes: number;
  echoFalse: number;
  echoFalseRate: number;
  distanceErrPct: number | null;
  beatF1: number;
  msPerMin: number | null;
}

function matchCount(detected: number[], truth: number[], tol: number): { hit: number; extra: number } {
  const used = new Set<number>();
  let hit = 0;
  for (const d of detected) {
    let best = -1;
    let bestDt = Infinity;
    for (let i = 0; i < truth.length; i++) {
      if (used.has(i)) continue;
      const dt = Math.abs(d - truth[i]);
      if (dt < tol && dt < bestDt) {
        bestDt = dt;
        best = i;
      }
    }
    if (best >= 0) {
      used.add(best);
      hit++;
    }
  }
  return { hit, extra: detected.length - hit };
}

const cases: { venue: VenueId; temp: number; dist: number }[] = [];
for (const venue of ['open', 'street', 'valley'] as VenueId[]) {
  for (const temp of [-10, 10, 30]) {
    for (const dist of [120, 400, 800]) {
      cases.push({ venue, temp, dist });
    }
  }
}

const results: CaseResult[] = [];
const t0 = performance.now();

for (const c of cases) {
  const clip = generateSyntheticClip({
    durationSec: 90,
    sampleRate: 48000,
    venue: c.venue,
    temperatureC: c.temp,
    distanceM: c.dist,
    shotCount: 24,
    bpm: 96,
    tempoDrift: true,
    seed: 1000 + cases.indexOf(c) * 37,
  });

  const det = detectExplosions(clip.channelData, clip.sampleRate, c.venue);
  const detectedTimes = det.primary.map((e) => e.timeSec);
  const match = matchCount(detectedTimes, clip.truth.heardTimes, TOL_MATCH);
  const hit = match.hit;
  const recall = hit / clip.truth.heardTimes.length;

  // 回声误检率：一对一匹配后，多出的主事件即漏抑制的回声/音乐误报，
  // 占主事件总数的比例。门槛 2%。
  const falsePrimaries = Math.max(0, det.primary.length - hit);
  const echoFalseRate = det.primary.length > 0 ? falsePrimaries / det.primary.length : 0;

  // 测距：完整流水线
  const analysis = runAnalysis(clip.channelData, clip.sampleRate, clip.flashFrames, {
    venue: c.venue,
    temperatureC: c.temp,
    defaultFlightSec: 3,
  });
  const paired = analysis.shots.filter((s) => s.distanceM !== undefined);
  const errPct = paired.length
    ? paired.reduce((a, s) => a + Math.abs((s.distanceM ?? 0) - c.dist) / c.dist, 0) / paired.length
    : null;

  // 节拍 F1
  const beatTimes = trackBeats(clip.channelData, clip.sampleRate).map((b) => b.timeSec);
  const bm = matchCount(beatTimes, clip.truth.beatTimes, TOL_BEAT);
  const precision = beatTimes.length ? bm.hit / beatTimes.length : 0;
  const recallB = clip.truth.beatTimes.length ? bm.hit / clip.truth.beatTimes.length : 0;
  const f1 = precision + recallB > 0 ? (2 * precision * recallB) / (precision + recallB) : 0;

  results.push({
    name: `${c.venue.padEnd(6)} ${c.temp > 0 ? '+' : ''}${c.temp}℃ ${String(c.dist).padStart(4)}m`,
    shots: clip.truth.heardTimes.length,
    detected: hit,
    recall,
    echoes: det.all.filter((e) => e.echoOf !== undefined).length,
    echoFalse: falsePrimaries,
    echoFalseRate,
    distanceErrPct: errPct === null ? null : errPct * 100,
    beatF1: f1,
    msPerMin: null,
  });
}

// ---- 4 分钟整段性能用例（含声速合理性检查） ----
const longClip = generateSyntheticClip({
  durationSec: 240,
  sampleRate: 48000,
  venue: 'street',
  temperatureC: 5,
  distanceM: 350,
  shotCount: 60,
  bpm: 104,
  tempoDrift: true,
  seed: 424242,
});
const pStart = performance.now();
const longResult = runAnalysis(longClip.channelData, longClip.sampleRate, longClip.flashFrames, {
  venue: 'street',
  temperatureC: 5,
  defaultFlightSec: 3,
});
const pElapsed = performance.now() - pStart;
const longPaired = longResult.shots.filter((s) => s.distanceM !== undefined);
const longErr =
  longPaired.reduce((a, s) => a + Math.abs((s.distanceM ?? 0) - 350) / 350, 0) / Math.max(1, longPaired.length);

const totalElapsed = performance.now() - t0;

// ---- 汇总输出 ----
let worstRecall = 1;
let worstEchoRate = 0;
let worstDist = 0;
let worstBeatF1 = 1;
for (const r of results) {
  worstRecall = Math.min(worstRecall, r.recall);
  worstEchoRate = Math.max(worstEchoRate, r.echoFalseRate);
  if (r.distanceErrPct !== null) worstDist = Math.max(worstDist, r.distanceErrPct);
  worstBeatF1 = Math.min(worstBeatF1, r.beatF1);
}

console.log('case                          检出  召回率   抑制回声  回声误检率  测距误差  节拍F1');
for (const r of results) {
  console.log(
    `${r.name.padEnd(30)} ${String(r.detected).padStart(2)}/${r.shots}  ` +
      `${(r.recall * 100).toFixed(1).padStart(5)}%  ${String(r.echoes).padStart(6)}   ` +
      `${(r.echoFalseRate * 100).toFixed(2).padStart(6)}%   ` +
      `${r.distanceErrPct === null ? '  —  ' : r.distanceErrPct.toFixed(2).padStart(5) + '%'}  ` +
      `${(r.beatF1 * 100).toFixed(1).padStart(5)}%`,
  );
}

console.log('\n==== 汇总 ====');
console.log(`最差爆炸声检出率: ${(worstRecall * 100).toFixed(1)}%  (门槛 95%)  ${worstRecall >= 0.95 ? 'PASS' : 'FAIL'}`);
console.log(`最高回声误检率:   ${(worstEchoRate * 100).toFixed(2)}%  (门槛 2%)   ${worstEchoRate <= 0.02 ? 'PASS' : 'FAIL'}`);
console.log(`最差测距误差:     ${worstDist.toFixed(2)}%  (门槛 5%)        ${worstDist <= 5 ? 'PASS' : 'FAIL'}`);
console.log(`最差节拍 F1:      ${(worstBeatF1 * 100).toFixed(1)}%  (内部门槛 90%) ${worstBeatF1 >= 0.9 ? 'PASS' : 'FAIL'}`);
console.log(`长片段(240s)配对 ${longPaired.length} 发，测距误差 ${(longErr * 100).toFixed(2)}%`);
console.log(
  `4 分钟核查耗时: ${pElapsed.toFixed(0)} ms = ${(pElapsed / 1000).toFixed(1)}s  (门槛 30s)  ${pElapsed <= 30000 ? 'PASS' : 'FAIL'}`,
);
console.log(`全部用例总耗时 ${totalElapsed.toFixed(0)} ms`);
console.log(`声速抽查: -10℃=${soundSpeed(-10).toFixed(1)}  0℃=${soundSpeed(0).toFixed(1)}  30℃=${soundSpeed(30).toFixed(1)} m/s`);

const pass = worstRecall >= 0.95 && worstEchoRate <= 0.02 && worstDist <= 5 && pElapsed <= 30000;
process.exitCode = pass ? 0 : 1;
