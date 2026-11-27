/**
 * 需求条款专项验证（对应验收要求原文）：
 *  A. 同一发在两排楼之间来回反射出三次回声时只能算一发
 *  B. 气温 -10℃ ~ 30℃ 全区间按当时声速校正，测距误差 ≤5%
 *  C. 爆炸声检出率 ≥95%、回声误检为另一发 ≤2%
 *  D. 四分钟演出核查耗时 ≤30s
 */
import { generateSyntheticClip } from '../src/core/synth.ts';
import { detectExplosions } from '../src/core/explosion-detector.ts';
import { runAnalysis } from '../src/core/analysis.ts';
import { soundSpeed, delayFromDistance } from '../src/core/physics.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

// ---- A. 三次回声算一发（街道场地，每发固定 3 次回声）----
{
  const clip = generateSyntheticClip({
    durationSec: 120, sampleRate: 48000, venue: 'street', temperatureC: 15,
    distanceM: 300, shotCount: 20, bpm: 100, tempoDrift: false, seed: 20240,
  });
  const det = detectExplosions(clip.channelData, clip.sampleRate, 'street');
  // 真实主爆 20 发，每发带 3 次回声 = 60 个回声事件；检出主事件应仍为 20 左右
  const truthCount = clip.truth.heardTimes.length;
  const primaryCount = det.primary.length;
  const echoCount = det.all.length - det.primary.length;
  check(
    'A. 三次回声只算一发',
    Math.abs(primaryCount - truthCount) <= Math.ceil(truthCount * 0.05),
    `真实 ${truthCount} 发，回声 ${echoCount} 次，判定主事件 ${primaryCount} 个`,
  );
}

// ---- B. 全温度区间声速校正测距 ----
{
  const temps = [-10, -5, 0, 5, 10, 15, 20, 25, 30];
  const dist = 500;
  let worst = 0;
  for (const T of temps) {
    const clip = generateSyntheticClip({
      durationSec: 90, sampleRate: 48000, venue: 'open', temperatureC: T,
      distanceM: dist, shotCount: 18, bpm: 96, tempoDrift: false, seed: 700 + T,
    });
    const r = runAnalysis(clip.channelData, clip.sampleRate, clip.flashFrames, {
      venue: 'open', temperatureC: T, defaultFlightSec: 3,
    });
    const paired = r.shots.filter((s) => s.distanceM !== undefined);
    const err = paired.reduce((a, s) => a + Math.abs((s.distanceM ?? 0) - dist) / dist, 0) / Math.max(1, paired.length);
    worst = Math.max(worst, err);
  }
  check('B. -10~30℃ 声速校正测距', worst <= 0.05, `全温度区间最差误差 ${(worst * 100).toFixed(2)}%（门槛 5%）`);
  // 声速公式端点合理性
  check(
    'B. 声速随温度单调',
    soundSpeed(-10) < soundSpeed(0) && soundSpeed(0) < soundSpeed(30),
    `c(-10)=${soundSpeed(-10).toFixed(1)} c(0)=${soundSpeed(0).toFixed(1)} c(30)=${soundSpeed(30).toFixed(1)} m/s`,
  );
  // 延迟换算自洽：d = c * t
  const rt = delayFromDistance(340, 20);
  check('B. 距离-延迟互算自洽', Math.abs(soundSpeed(20) * rt - 340) < 1e-6, `340m@20℃ 延迟 ${(rt * 1000).toFixed(1)}ms`);
}

// ---- C. 三场地综合检出/误检 ----
{
  let worstRecall = 1;
  let worstEcho = 0;
  for (const venue of ['open', 'street', 'valley'] as const) {
    const clip = generateSyntheticClip({
      durationSec: 90, sampleRate: 48000, venue, temperatureC: 12,
      distanceM: 350, shotCount: 22, bpm: 104, tempoDrift: true, seed: 31 + venue.length,
    });
    const det = detectExplosions(clip.channelData, clip.sampleRate, venue);
    const used = new Set<number>();
    let hit = 0;
    for (const p of det.primary) {
      let best = -1;
      let bd = 1e9;
      clip.truth.heardTimes.forEach((t, i) => {
        if (!used.has(i)) {
          const d = Math.abs(t - p.timeSec);
          if (d < 0.12 && d < bd) {
            bd = d;
            best = i;
          }
        }
      });
      if (best >= 0) {
        used.add(best);
        hit++;
      }
    }
    worstRecall = Math.min(worstRecall, hit / clip.truth.heardTimes.length);
    worstEcho = Math.max(worstEcho, Math.max(0, det.primary.length - hit) / Math.max(1, det.primary.length));
  }
  check('C. 爆炸声检出率 ≥95%', worstRecall >= 0.95, `三场地最差 ${(worstRecall * 100).toFixed(1)}%`);
  check('C. 回声误检为另一发 ≤2%', worstEcho <= 0.02, `三场地最差 ${(worstEcho * 100).toFixed(2)}%`);
}

// ---- D. 四分钟性能 ----
{
  const clip = generateSyntheticClip({
    durationSec: 240, sampleRate: 48000, venue: 'valley', temperatureC: 8,
    distanceM: 450, shotCount: 50, bpm: 92, tempoDrift: true, seed: 88,
  });
  const t0 = performance.now();
  runAnalysis(clip.channelData, clip.sampleRate, clip.flashFrames, {
    venue: 'valley', temperatureC: 8, defaultFlightSec: 3,
  });
  const elapsed = performance.now() - t0;
  check('D. 四分钟核查 ≤30s', elapsed <= 30000, `实际 ${(elapsed / 1000).toFixed(1)}s`);
}

console.log(`\n${failures === 0 ? '✅ 全部需求条款验证通过' : `❌ ${failures} 项未通过`}`);
process.exitCode = failures === 0 ? 0 : 1;
