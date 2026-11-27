/**
 * 合成测试录像生成器：在一份 PCM 音轨里混合
 *   1) 带节拍的配乐（鼓点 + 和声垫 + 高频装饰，BPM 可漂移）
 *   2) 人群欢呼（缓变滤波噪声 + 偶发尖峰）
 *   3) 礼花爆炸声（低频冲击 + 宽带噪声，指数衰减）
 *   4) 按场地生成的回声（开阔 0~1 次、街道两排楼 3 次、山谷 2~3 次长延迟）
 * 同时生成 30fps 的亮度帧序列（含舞台灯光闪烁与开花闪光）。
 * 全部确定性（seed 决定），无 DOM 依赖，Node 与浏览器均可运行。
 */
import { delayFromDistance } from './physics.ts';
import type { SyntheticClip, SyntheticClipOptions, GroundTruth, VenueId } from './types.ts';

/** mulberry32 确定性随机数。 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 一阶低通滤波的单样本步进（用于回声与爆炸塑形）。 */
class Lowpass {
  private z = 0;
  private readonly cutoffNorm: number;
  constructor(cutoffNorm: number) {
    this.cutoffNorm = cutoffNorm;
  }
  step(x: number): number {
    this.z += this.cutoffNorm * (x - this.z);
    return this.z;
  }
}

interface EchoSpec {
  delaySec: number;
  gain: number;
}

function venueEchoes(venue: VenueId, rng: () => number): EchoSpec[] {
  switch (venue) {
    case 'open':
      // 开阔地：偶尔一次远处弱反射（物理上衰减很大，增益 <0.18）
      return rng() < 0.5 ? [{ delaySec: 0.14 + rng() * 0.12, gain: 0.08 + rng() * 0.08 }] : [];
    case 'street': {
      // 两排楼之间来回反射：固定三次回声，逐次衰减
      const base = 0.16 + rng() * 0.05;
      return [
        { delaySec: base, gain: 0.42 + rng() * 0.08 },
        { delaySec: base * 2.05, gain: 0.27 + rng() * 0.06 },
        { delaySec: base * 3.1, gain: 0.16 + rng() * 0.05 },
      ];
    }
    case 'valley': {
      // 山谷：长延迟、缓慢衰减的 2~3 次回声
      const list: EchoSpec[] = [
        { delaySec: 0.55 + rng() * 0.2, gain: 0.32 + rng() * 0.08 },
        { delaySec: 0.95 + rng() * 0.25, gain: 0.2 + rng() * 0.06 },
      ];
      if (rng() < 0.7) list.push({ delaySec: 1.35 + rng() * 0.2, gain: 0.12 + rng() * 0.05 });
      return list;
    }
  }
}

/** 生成一发爆炸的单位波形（起点 t=0），含低频 thump 与持续的宽带爆轰。 */
function explosionWaveform(lenSamples: number, sampleRate: number, rng: () => number): Float32Array {
  const out = new Float32Array(lenSamples);
  const lp = new Lowpass(0.4);
  const thumpDecay = sampleRate * 0.25;
  const noiseDecay = sampleRate * 0.7;
  const thumpFreq = 55 + rng() * 25;
  for (let i = 0; i < lenSamples; i++) {
    const t = i / sampleRate;
    const envThump = Math.exp(-i / thumpDecay);
    const envNoise = Math.exp(-i / noiseDecay);
    const white = rng() * 2 - 1;
    const noise = lp.step(white);
    const thump = Math.sin(2 * Math.PI * thumpFreq * t) * envThump;
    // 起振极快（<4ms），宽带噪声是爆炸区别于鼓点的关键，持续 300ms 以上
    const attack = Math.min(1, i / (sampleRate * 0.003));
    out[i] = attack * (0.5 * thump + 1.1 * noise * envNoise);
  }
  return out;
}

function addTo(buf: Float32Array, src: Float32Array, startSample: number, gain: number): void {
  for (let i = 0; i < src.length; i++) {
    const j = startSample + i;
    if (j >= 0 && j < buf.length) buf[j] += src[i] * gain;
  }
}

/** 配乐节拍时间线：BPM 可在段落间缓慢漂移。 */
function buildBeatTimes(durationSec: number, bpm0: number, drift: boolean, rng: () => number): number[] {
  const beats: number[] = [];
  let t = 0.5;
  let bpm = bpm0;
  while (t < durationSec - 0.5) {
    beats.push(t);
    if (drift) {
      // 每 32 拍缓慢变速一次，幅度 ±4%
      if (beats.length % 32 === 0) bpm = bpm0 * (1 + (rng() - 0.5) * 0.08);
    }
    t += 60 / bpm;
  }
  return beats;
}

export function generateSyntheticClip(opts: SyntheticClipOptions): SyntheticClip {
  const { durationSec, sampleRate, venue, temperatureC, distanceM, shotCount, bpm, tempoDrift, seed } = opts;
  const rng = makeRng(seed);
  const total = Math.floor(durationSec * sampleRate);
  const audio = new Float32Array(total);

  // ---- 1. 配乐 -----------------------------------------------------------
  const beatTimes = buildBeatTimes(durationSec, bpm, tempoDrift, rng);
  // 和声垫：两个失谐正弦 + 慢颤音
  const padFreqs = [110, 164.81, 220];
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const trem = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.18 * t);
    let v = 0;
    for (const f of padFreqs) v += Math.sin(2 * Math.PI * f * t + 0.3 * Math.sin(t));
    audio[i] += 0.05 * trem * (v / padFreqs.length);
  }
  // 鼓点：每拍一个低频 kick（pitch drop 衰减正弦），高频只有极短的鼓皮 click
  for (const bt of beatTimes) {
    const start = Math.floor(bt * sampleRate);
    const len = Math.floor(0.15 * sampleRate);
    for (let k = 0; k < len; k++) {
      const env = Math.exp(-k / (sampleRate * 0.045));
      const kick = Math.sin(2 * Math.PI * (72 - 35 * (k / len)) * (k / sampleRate)) * env;
      // click 仅存在于前 6ms，能量占比很小（真实鼓槌敲击声）
      const clickEnv = k < sampleRate * 0.006 ? Math.exp(-k / (sampleRate * 0.002)) : 0;
      const click = (rng() * 2 - 1) * clickEnv * 0.12;
      if (start + k < total) audio[start + k] += 0.4 * kick + click;
    }
  }
  // 高频装饰乐器（每隔 4 拍）
  for (let bi = 0; bi < beatTimes.length; bi += 4) {
    const start = Math.floor(beatTimes[bi] * sampleRate);
    const len = Math.floor(0.12 * sampleRate);
    for (let k = 0; k < len; k++) {
      const env = Math.exp(-k / (sampleRate * 0.04));
      if (start + k < total) audio[start + k] += 0.1 * env * Math.sin(2 * Math.PI * 880 * (k / sampleRate));
    }
  }

  // ---- 2. 人群欢呼 -------------------------------------------------------
  const cheerLp = new Lowpass(0.08);
  const cheerHp: number[] = [];
  let prev = 0;
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const swell = 0.5 + 0.5 * Math.sin(2 * Math.PI * 0.07 * t + 1.7) * Math.sin(2 * Math.PI * 0.031 * t);
    const raw = (rng() * 2 - 1) * (0.5 + 0.5 * swell);
    const low = cheerLp.step(raw);
    // 简单高通去直流
    const hp = raw - low;
    const dc = hp - prev;
    prev = hp;
    cheerHp.push(dc);
    audio[i] += 0.06 * dc;
    // 偶发欢呼尖峰
    if (rng() < 0.00002) {
      const len = Math.floor((0.2 + rng() * 0.4) * sampleRate);
      for (let k = 0; k < len && i + k < total; k++) {
        audio[i + k] += 0.1 * Math.exp(-k / (sampleRate * 0.25)) * (rng() * 2 - 1);
      }
    }
  }

  // ---- 3. 礼花爆炸（含场地回声） ----------------------------------------
  const acousticDelay = delayFromDistance(distanceM, temperatureC);
  const explosionTimes: number[] = [];
  const flashTimes: number[] = [];
  const heardTimes: number[] = [];
  const minGap = 2.2;
  let placed = 0;
  let guard = 0;
  while (placed < shotCount && guard++ < shotCount * 40) {
    // 从节拍附近挑时刻，施加 -300~+300ms 的“演出误差”
    const beat = beatTimes[4 + Math.floor(rng() * (beatTimes.length - 8))];
    const flashT = beat + (rng() - 0.5) * 0.6;
    if (flashT < 2 || flashT > durationSec - 2) continue;
    if (flashTimes.some((x) => Math.abs(x - flashT) < minGap)) continue;
    flashTimes.push(flashT);
    explosionTimes.push(flashT); // 光速传播时间可忽略
    const heardT = flashT + acousticDelay;
    heardTimes.push(heardT);

    const waveLen = Math.floor(1.8 * sampleRate);
    const wave = explosionWaveform(waveLen, sampleRate, rng);
    const mainGain = 0.75 + rng() * 0.2;
    addTo(audio, wave, Math.floor(heardT * sampleRate), mainGain);
    for (const echo of venueEchoes(venue, rng)) {
      addTo(audio, wave, Math.floor((heardT + echo.delaySec) * sampleRate), mainGain * echo.gain);
    }
    placed++;
  }
  flashTimes.sort((a, b) => a - b);
  heardTimes.sort((a, b) => a - b);
  explosionTimes.sort((a, b) => a - b);

  // 软限幅，避免削波（仍保留爆炸的瞬态优势）
  let peak = 0;
  for (let i = 0; i < total; i++) peak = Math.max(peak, Math.abs(audio[i]));
  const norm = peak > 0.98 ? 0.98 / peak : 1;
  for (let i = 0; i < total; i++) audio[i] = Math.tanh(audio[i] * norm * 1.05);

  // ---- 4. 30fps 亮度帧：舞台灯慢闪 + 开花闪光 ---------------------------
  const fps = 30;
  const frameCount = Math.floor(durationSec * fps);
  const flashFrames: { timeSec: number; luminance: number }[] = [];
  for (let f = 0; f < frameCount; f++) {
    const t = f / fps;
    let lum = 0.08 + 0.03 * Math.sin(2 * Math.PI * 1.3 * t) + 0.02 * Math.sin(2 * Math.PI * 0.7 * t + 2);
    for (const ft of flashTimes) {
      const dt = (t - ft) * 1000;
      // 快速起亮、约 120ms 回落的高斯形闪光
      lum += 0.85 * Math.exp(-(dt * dt) / (2 * 45 * 45));
    }
    lum += (rng() - 0.5) * 0.01;
    flashFrames.push({ timeSec: t, luminance: Math.max(0, Math.min(1, lum)) });
  }

  const truth: GroundTruth = {
    explosionTimes,
    flashTimes,
    heardTimes,
    beatTimes,
    distanceM,
    venue,
    temperatureC,
  };
  return { channelData: audio, sampleRate, durationSec, flashFrames, truth };
}
