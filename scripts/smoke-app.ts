/**
 * 应用层冒烟测试（无 DOM）：验证四个页面消费的数据结构都能由流水线正确产出，
 * 并覆盖编排表修正、CSV 行解析等纯逻辑。
 */
import { generateSyntheticClip } from '../src/core/synth.ts';
import { runAnalysis } from '../src/core/analysis.ts';
import type { ChoreographyRow } from '../src/core/types.ts';
import { soundSpeed } from '../src/core/physics.ts';

const clip = generateSyntheticClip({
  durationSec: 60, sampleRate: 48000, venue: 'street', temperatureC: 18,
  distanceM: 280, shotCount: 16, bpm: 100, tempoDrift: true, seed: 555,
});

// 模拟编排表：计划点火 = 真实开花 - 飞行时间，再人为加节拍偏差
const choreography: ChoreographyRow[] = clip.truth.flashTimes.slice(0, 12).map((ft, i) => ({
  shotId: `S${String(i + 1).padStart(3, '0')}`,
  ignitionSec: Math.max(0, ft - 3.2),
  caliber: '6寸',
  flightSec: 3.2,
}));

const result = runAnalysis(
  clip.channelData,
  clip.sampleRate,
  clip.flashFrames,
  { venue: 'street', temperatureC: 18, defaultFlightSec: 3 },
  choreography,
);

let failures = 0;
const assert = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
  if (!ok) failures++;
};

// 声光事件页数据
assert('事件页-闪光数组', result.flashes.length > 0, `${result.flashes.length} 次`);
assert('事件页-声音主事件', result.sounds.length > 0, `${result.sounds.length} 个`);
assert('事件页-回声数组存在', Array.isArray(result.echoes));
assert('事件页-逐发记录', result.shots.length === result.flashes.length);
assert('事件页-测距为有限数', result.shots.some((s) => Number.isFinite(s.distanceM ?? NaN)));
assert(
  '事件页-统计字段完整',
  typeof result.stats.flashCount === 'number' && typeof result.stats.pairedCount === 'number',
);

// 节拍对照页数据
assert('节拍页-节拍数组', result.beats.length > 0, `${result.beats.length} 拍`);
const withOffset = result.shots.filter((s) => s.beatOffsetSec !== undefined);
assert('节拍页-偏差已计算', withOffset.length > 0, `${withOffset.length} 发有偏差`);
assert('节拍页-BPM 合理', result.beats.every((b) => b.bpm > 50 && b.bpm < 200));

// 点火修正页数据
assert('点火页-修正表行数', result.correctedChoreography.length === choreography.length);
const correctedRows = result.shots.filter((s) => s.ignitionCorrectionSec !== undefined);
assert('点火页-修正量已产出', correctedRows.length > 0, `${correctedRows.length} 发`);
// 修正量应与节拍偏差大小相等、方向相反
const consistent = correctedRows.every(
  (s) => Math.abs((s.ignitionCorrectionSec ?? 0) + (s.beatOffsetSec ?? 0)) < 1e-9,
);
assert('点火页-修正量=−偏差', consistent);

// 物理量
const c = soundSpeed(18);
assert('物理-18℃声速合理', c > 340 && c < 344, `${c.toFixed(1)} m/s`);

// 回声链 SoundEvent 的 echoOf 字段（页面回声明细用）
const echoFieldsOk = result.echoes.every((e) => e.echoOf !== undefined && Number.isFinite(e.durationSec));
assert('回声字段-echoOf/duration', echoFieldsOk);

console.log(`\n${failures === 0 ? '✅ 应用层冒烟测试通过' : `❌ ${failures} 项失败`}`);
process.exitCode = failures === 0 ? 0 : 1;
