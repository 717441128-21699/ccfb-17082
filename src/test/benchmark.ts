// 合成测试基准：跨场地/气温/速度/随机种子量化
//  - 爆炸声检出率
//  - 回声被误判为另一发的比例
//  - 光声测距误差（相对距离）
//  - 节拍跟踪误差
//  - 4 分钟场景核查耗时（<=30s）
// 运行：npm run verify

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { synthesizeScene, type SynthOptions } from '../core/synth/sceneSynth';
import { runAnalysisCore } from '../core/pipeline';
import { speedOfSound, percentile, median } from '../core/physics';
import type { BenchmarkMetrics, SceneMetricRow, ShotReport } from '../core/types';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');

const DETECT_TOL = 0.2; // 声达匹配容差 s
const ECHO_TOL = 0.14;
const LIGHT_TOL = 0.28;

interface Scored {
  row: SceneMetricRow;
  distanceErrs: number[];
  correctionErrsMs: number[];
}

function scoreScene(
  name: string,
  opts: SynthOptions,
): { metrics: Scored; aggregate: Agg } {
  const scene = synthesizeScene(opts);
  const t0 = performance.now();
  const result = runAnalysisCore({
    audio: scene.audio,
    sampleRate: scene.sampleRate,
    durationSec: scene.durationSec,
    luma: scene.luma,
    options: { temperatureC: opts.temperatureC ?? 20, venue: opts.venue ?? 'canyon' },
    truth: scene.truth,
  });
  const elapsedMs = performance.now() - t0;

  const truth = scene.truth;

  // hit id -> 角色
  const roleById = new Map<number, { shotId: number; primary: boolean }>();
  for (const s of result.soundShots) {
    roleById.set(s.primary.id, { shotId: s.id, primary: true });
    for (const e of s.echoes) roleById.set(e.id, { shotId: s.id, primary: false });
  }

  let detected = 0;
  let echoEvents = 0;
  let echoFalseShots = 0;
  let echoRawDetected = 0;
  let echoLeakPrimaries = 0;
  let musicFalseShots = 0;

  const primaryTimes = result.soundShots.map((s) => s.primary.time);

  for (const shot of truth.shots) {
    const hit = nearest(primaryTimes, shot.soundArrival);
    if (hit !== null && Math.abs(hit - shot.soundArrival) <= DETECT_TOL) detected++;

    for (const et of shot.echoArrivals) {
      echoEvents++;
      // 该回声是否被原始检测器抓到
      const raw = nearest(result.rawHits.map((h) => h.time), et, ECHO_TOL);
      if (raw !== null) {
        echoRawDetected++;
        const rawHit = result.rawHits.find((h) => Math.abs(h.time - raw!) < 1e-9)!;
        const role = roleById.get(rawHit.id);
        if (role?.primary) echoLeakPrimaries++;
      }
    }
  }

  // 每个 SoundShot primary 的身份判定
  for (const s of result.soundShots) {
    const t = s.primary.time;
    const trueArrival = nearest(truth.shots.map((x) => x.soundArrival), t, DETECT_TOL);
    if (trueArrival !== null) continue;
    const echoT = nearest(truth.shots.flatMap((x) => x.echoArrivals), t, ECHO_TOL);
    if (echoT !== null) echoFalseShots++;
    else musicFalseShots++;
  }

  // 测距误差：用真值开花时刻找到对应 report/pair
  const distanceErrs: number[] = [];
  const correctionErrsMs: number[] = [];
  for (const ts of truth.shots) {
    const rep = findReportByLightTruth(result.reports, ts.bloomTime);
    if (rep?.pair) {
      distanceErrs.push((Math.abs(rep.pair.distanceM - ts.distanceM) / ts.distanceM) * 100);
    }
    if (rep?.beatOffsetMs !== undefined) {
      const trueOffsetMs = (ts.bloomTime - ts.targetBeat) * 1000;
      correctionErrsMs.push(rep.beatOffsetMs - trueOffsetMs);
    }
  }

  // 节拍误差
  const beatErrs: number[] = [];
  if (result.beatGrid) {
    for (const bt of truth.beatTimes) {
      const nb = nearest(result.beatGrid.beats, bt, 0.4);
      if (nb !== null) beatErrs.push(Math.abs(nb - bt) * 1000);
    }
  }

  const row: SceneMetricRow = {
    name,
    venue: truth.venue,
    tempC: truth.temperatureC,
    bpm: truth.bpm,
    shots: truth.shots.length,
    detected,
    echoFalseShots,
    distanceMedianErrPct: median(distanceErrs),
    distanceMaxErrPct: distanceErrs.length ? Math.max(...distanceErrs) : 0,
    beatMedianErrMs: median(beatErrs),
    elapsedMs: Math.round(elapsedMs),
  };

  return {
    metrics: { row, distanceErrs, correctionErrsMs },
    aggregate: {
      detected,
      shots: truth.shots.length,
      echoEvents,
      echoFalseShots,
      echoRawDetected,
      echoLeakPrimaries,
      musicFalseShots,
      distanceErrs,
      beatErrs,
      correctionErrsMs,
      elapsedMs,
    },
  };
}

interface Agg {
  detected: number;
  shots: number;
  echoEvents: number;
  echoFalseShots: number;
  echoRawDetected: number;
  echoLeakPrimaries: number;
  musicFalseShots: number;
  distanceErrs: number[];
  beatErrs: number[];
  correctionErrsMs: number[];
  elapsedMs: number;
}

function nearest(xs: number[], t: number, tol?: number): number | null {
  if (!xs.length) return null;
  let best: number | null = null;
  let bd = Infinity;
  for (const x of xs) {
    const d = Math.abs(x - t);
    if (d < bd) {
      bd = d;
      best = x;
    }
  }
  if (tol !== undefined && bd > tol) return null;
  return best;
}

function findReportByLightTruth(reports: ShotReport[], bloomT: number): ShotReport | null {
  let best: ShotReport | null = null;
  let bd = LIGHT_TOL;
  for (const r of reports) {
    if (!r.light) continue;
    const d = Math.abs(r.light.time - bloomT);
    if (d < bd) {
      bd = d;
      best = r;
    }
  }
  return best;
}

function main(): void {
  // 声速温度校正自检
  const cm10 = speedOfSound(-10);
  const c30 = speedOfSound(30);
  console.log(`声速校正: c(-10°C)=${cm10.toFixed(2)} m/s, c(20°C)=${speedOfSound(20).toFixed(2)}, c(30°C)=${c30.toFixed(2)}`);

  const matrix: { name: string; opts: SynthOptions }[] = [
    { name: '楼群峡谷 20°C 120BPM s101', opts: { seed: 101, durationSec: 80, bpm: 120, temperatureC: 20, venue: 'canyon' } },
    { name: '楼群峡谷 -10°C 96BPM s202', opts: { seed: 202, durationSec: 80, bpm: 96, temperatureC: -10, venue: 'canyon' } },
    { name: '山谷 30°C 128BPM s303', opts: { seed: 303, durationSec: 84, bpm: 128, temperatureC: 30, venue: 'valley' } },
    { name: '单侧楼群 0°C 110BPM s404', opts: { seed: 404, durationSec: 76, bpm: 110, temperatureC: 0, venue: 'square' } },
    { name: '开阔广场 20°C 140BPM s505', opts: { seed: 505, durationSec: 72, bpm: 140, temperatureC: 20, venue: 'open' } },
    { name: '楼群峡谷 30°C 100BPM s606', opts: { seed: 606, durationSec: 80, bpm: 100, temperatureC: 30, venue: 'canyon' } },
    { name: '山谷 -10°C 120BPM s707', opts: { seed: 707, durationSec: 84, bpm: 120, temperatureC: -10, venue: 'valley' } },
    { name: '单侧楼群 20°C 124BPM s808', opts: { seed: 808, durationSec: 76, bpm: 124, temperatureC: 20, venue: 'square' } },
  ];

  const rows: SceneMetricRow[] = [];
  const aggs: Agg[] = [];
  for (const m of matrix) {
    process.stdout.write(`基准场景: ${m.name} ... `);
    const { metrics, aggregate } = scoreScene(m.name, m.opts);
    rows.push(metrics.row);
    aggs.push(aggregate);
    console.log(
      `检出 ${metrics.row.detected}/${metrics.row.shots} | 回声误发 ${metrics.row.echoFalseShots} | 距离中位误差 ${metrics.row.distanceMedianErrPct.toFixed(2)}% | 节拍 ${metrics.row.beatMedianErrMs.toFixed(1)}ms | ${metrics.row.elapsedMs}ms`,
    );
  }

  // 4 分钟性能场景（最恶劣：canyon 三回声 + 完整配乐）
  console.log('运行 4 分钟性能场景 ...');
  const perf = scoreScene('四分钟峡谷演出', {
    seed: 999,
    durationSec: 240,
    bpm: 120,
    temperatureC: 15,
    venue: 'canyon',
  });
  rows.push(perf.metrics.row);
  aggs.push(perf.aggregate);
  console.log(
    `性能场景: 检出 ${perf.metrics.row.detected}/${perf.metrics.row.shots}, 分析耗时 ${perf.metrics.row.elapsedMs}ms`,
  );

  // 汇总
  const totalShots = aggs.reduce((a, g) => a + g.shots, 0);
  const totalDetected = aggs.reduce((a, g) => a + g.detected, 0);
  const totalEchoEvents = aggs.reduce((a, g) => a + g.echoEvents, 0);
  const totalEchoFalse = aggs.reduce((a, g) => a + g.echoFalseShots, 0);
  const totalEchoRaw = aggs.reduce((a, g) => a + g.echoRawDetected, 0);
  const totalEchoLeak = aggs.reduce((a, g) => a + g.echoLeakPrimaries, 0);
  const totalMusicFalse = aggs.reduce((a, g) => a + g.musicFalseShots, 0);
  const allDist = aggs.flatMap((g) => g.distanceErrs);
  const allBeat = aggs.flatMap((g) => g.beatErrs);
  const allCorr = aggs.flatMap((g) => g.correctionErrsMs);
  const perfElapsed = perf.aggregate.elapsedMs;

  const detectionRatePct = (100 * totalDetected) / totalShots;
  const echoFalseRatePct = (100 * totalEchoFalse) / Math.max(1, totalEchoEvents);
  const audioOnlyLeakPct = (100 * totalEchoLeak) / Math.max(1, totalEchoRaw);
  const within5 = allDist.filter((x) => x <= 5).length;

  const metrics: BenchmarkMetrics = {
    scenes: matrix.length + 1,
    totalShots,
    detectedShots: totalDetected,
    detectionRatePct,
    rawHitPrecisionPct: 100 * (1 - totalMusicFalse / Math.max(1, totalShots + totalMusicFalse)),
    echoEventsTotal: totalEchoEvents,
    echoFalseShots: totalEchoFalse,
    echoFalseRatePct,
    audioOnlyEchoLeakPct: audioOnlyLeakPct,
    pairedDistances: allDist.length,
    distanceMeanErrPct: allDist.reduce((a, b) => a + b, 0) / Math.max(1, allDist.length),
    distanceMedianErrPct: median(allDist),
    distanceP95ErrPct: percentile(allDist, 95),
    distanceMaxErrPct: allDist.length ? Math.max(...allDist) : 0,
    distanceWithin5Pct: (100 * within5) / Math.max(1, allDist.length),
    beatMedianErrMs: median(allBeat),
    beatP95ErrMs: percentile(allBeat, 95),
    perfDurationSec: 240,
    perfElapsedMs: Math.round(perfElapsed),
    perfPass30s: perfElapsed < 30000,
    gatePass: false,
    details: rows,
    ranAt: new Date().toISOString(),
  };

  const gate =
    metrics.detectionRatePct >= 95 &&
    metrics.echoFalseRatePct <= 2 &&
    metrics.distanceP95ErrPct <= 5 &&
    metrics.distanceWithin5Pct >= 95 &&
    metrics.perfPass30s;
  metrics.gatePass = gate;

  console.log('\n================ 基准汇总 ================');
  console.log(`爆炸声检出率        : ${metrics.detectionRatePct.toFixed(2)}%  (${totalDetected}/${totalShots})  门槛 >=95%`);
  console.log(`回声事件总数        : ${totalEchoEvents}（原始检测到 ${totalEchoRaw}）`);
  console.log(`回声误判为另一发    : ${totalEchoFalse} 发, ${metrics.echoFalseRatePct.toFixed(2)}%  门槛 <=2%`);
  console.log(`音频分组回声泄漏率  : ${metrics.audioOnlyEchoLeakPct.toFixed(2)}%（被抓到的回声中成为主声的比例）`);
  console.log(`音乐/噪声假发       : ${totalMusicFalse}`);
  console.log(`配对测距数          : ${allDist.length}`);
  console.log(`测距误差 中位/均值  : ${metrics.distanceMedianErrPct.toFixed(2)}% / ${metrics.distanceMeanErrPct.toFixed(2)}%`);
  console.log(`测距误差 P95/最大   : ${metrics.distanceP95ErrPct.toFixed(2)}% / ${metrics.distanceMaxErrPct.toFixed(2)}%`);
  console.log(`测距 <=5% 占比      : ${metrics.distanceWithin5Pct.toFixed(1)}%  门槛 >=95%`);
  console.log(`节拍误差 中位/P95   : ${metrics.beatMedianErrMs.toFixed(1)}ms / ${metrics.beatP95ErrMs.toFixed(1)}ms`);
  console.log(`偏差反推误差 MAE    : ${(allCorr.reduce((a, b) => a + Math.abs(b), 0) / Math.max(1, allCorr.length)).toFixed(1)}ms`);
  console.log(`4 分钟场景分析耗时  : ${(perfElapsed / 1000).toFixed(2)}s  门槛 <=30s (${metrics.perfPass30s ? 'PASS' : 'FAIL'})`);
  console.log(`总判定              : ${gate ? '✅ PASS' : '❌ FAIL'}`);

  const outPath = resolve(root, 'public/benchmark-report.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(metrics, null, 2), 'utf8');
  console.log(`\n报告已写入 ${outPath}`);

  if (!gate) process.exitCode = 1;
}

main();
