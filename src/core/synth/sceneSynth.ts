// 合成测试场景：确定性生成配乐、人群声、礼花爆炸声、几种场地回声，
// 以及摄像机帧亮度序列和完整真值（点火/开花/距离/声达/回声/节拍）。
// Node 基准与浏览器“合成演示”共用同一套数学模型。

import { makeRng, speedOfSound } from '../physics';
import { VENUES } from '../venues';
import type { SceneTruth, ShotTruth, VenueId } from '../types';
import type { LumaSample } from '../dsp/lightDetector';

export interface SynthOptions {
  seed?: number;
  durationSec?: number;
  bpm?: number;
  temperatureC?: number;
  venue?: VenueId;
  sampleRate?: number;
  /** 礼花数量；不传则按节拍密度自动 */
  shotCount?: number;
  /** 每发相对节拍的偏差幅度（ms，高斯 sigma） */
  jitterMs?: number;
  /** 全场景系统偏差（ms），模拟导演能感觉到的整体偏晚/偏早 */
  biasMs?: number;
  distanceMin?: number;
  distanceMax?: number;
  /** 配乐音量 0..1 */
  musicLevel?: number;
  /** 人群音量 0..1 */
  crowdLevel?: number;
  videoFps?: number;
  name?: string;
}

export interface SynthScene {
  audio: Float32Array;
  sampleRate: number;
  durationSec: number;
  luma: LumaSample[];
  truth: SceneTruth;
  name: string;
}

/** 高斯随机 */
function gauss(rng: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 一阶低通系数 */
function lpCoef(cutoff: number, sr: number): number {
  return 1 - Math.exp(-2 * Math.PI * cutoff / sr);
}

export function synthesizeScene(opts: SynthOptions = {}): SynthScene {
  const sr = opts.sampleRate ?? 44100;
  const seed = opts.seed ?? 1;
  const rng = makeRng(seed);
  const durationSec = opts.durationSec ?? 72;
  const bpm = opts.bpm ?? 120;
  const tempC = opts.temperatureC ?? 20;
  const venueId = opts.venue ?? 'canyon';
  const venue = VENUES[venueId];
  const musicLevel = opts.musicLevel ?? 0.9;
  const crowdLevel = opts.crowdLevel ?? 0.8;
  const fps = opts.videoFps ?? 30;
  const dMin = opts.distanceMin ?? 120;
  const dMax = opts.distanceMax ?? 280;
  const jitterMs = opts.jitterMs ?? 42;
  const biasMs = opts.biasMs ?? 35;

  const n = Math.floor(durationSec * sr);
  const track = new Float32Array(n);

  const beat0 = 0.5;
  const period = 60 / bpm;
  const beatTimes: number[] = [];
  for (let t = beat0; t < durationSec - 1; t += period) beatTimes.push(t);

  // ---------- 配乐 ----------
  const chords = [
    [110.0, 130.81, 164.81], // Am
    [87.31, 110.0, 130.81], // F
    [98.0, 123.47, 146.83], // G
    [130.81, 164.81, 196.0], // C
  ];
  const bassRoots = [55, 43.65, 49, 65.41];

  const addKick = (t0: number, gain: number) => {
    const s0 = Math.floor(t0 * sr);
    const len = Math.floor(0.32 * sr);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const tt = i / sr;
      const phase = 2 * Math.PI * (45 * tt + 120 * 0.03 * (1 - Math.exp(-tt / 0.03)));
      const env = Math.exp(-tt / 0.11);
      track[s0 + i] += Math.sin(phase) * env * gain * 0.9;
    }
  };

  const addSnare = (t0: number, gain: number) => {
    const s0 = Math.floor(t0 * sr);
    const len = Math.floor(0.22 * sr);
    let lp = 0;
    const a = lpCoef(2200, sr);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const tt = i / sr;
      const noise = rng() * 2 - 1;
      lp += a * (noise - lp);
      const env = Math.exp(-tt / 0.09);
      const tone = Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt / 0.06);
      track[s0 + i] += (lp * 0.8 + tone * 0.5) * env * gain;
    }
  };

  const addHat = (t0: number, gain: number, open = false) => {
    const s0 = Math.floor(t0 * sr);
    const len = Math.floor((open ? 0.18 : 0.05) * sr);
    let hp = 0;
    let prev = 0;
    for (let i = 0; i < len && s0 + i < n; i++) {
      const tt = i / sr;
      const x = rng() * 2 - 1;
      hp = x - prev + 0.82 * hp; // 简易高通
      prev = x;
      const env = Math.exp(-tt / (open ? 0.07 : 0.018));
      track[s0 + i] += hp * 0.25 * env * gain;
    }
  };

  const addNote = (t0: number, dur: number, freq: number, gain: number, type: 'bass' | 'pluck' | 'pad') => {
    const s0 = Math.floor(t0 * sr);
    const len = Math.floor(dur * sr);
    for (let i = 0; i < len && s0 + i < n; i++) {
      const tt = i / sr;
      let v: number;
      if (type === 'bass') {
        v = Math.sin(2 * Math.PI * freq * tt) + 0.3 * Math.sin(4 * Math.PI * freq * tt);
        const env = Math.min(1, tt / 0.01) * Math.exp(-tt / (dur * 0.9));
        track[s0 + i] += v * env * gain;
      } else if (type === 'pluck') {
        v =
          Math.sin(2 * Math.PI * freq * tt) +
          0.5 * Math.sin(2 * Math.PI * 2 * freq * tt) +
          0.25 * Math.sin(3 * Math.PI * freq * tt);
        const env = Math.exp(-tt / 0.22);
        track[s0 + i] += v * env * gain;
      } else {
        // pad：两个失谐锯齿近似（低通由慢起音弱化高频）
        const ph1 = (freq * tt) % 1;
        const ph2 = (freq * 1.005 * tt) % 1;
        v = (ph1 * 2 - 1) * 0.5 + (ph2 * 2 - 1) * 0.5;
        const atk = Math.min(1, tt / 0.5);
        const rel = Math.min(1, (dur - tt) / 0.6);
        const env = atk * Math.max(0, Math.min(1, rel));
        track[s0 + i] += v * env * gain * 0.16;
      }
    }
  };

  beatTimes.forEach((bt, bi) => {
    addKick(bt, 0.85 * musicLevel);
    // 军鼓在 2、4 拍
    if (bi % 4 === 1 || bi % 4 === 3) addSnare(bt, 0.5 * musicLevel);
    // 踩镲八分音符
    addHat(bt, 0.5 * musicLevel);
    addHat(bt + period / 2, 0.32 * musicLevel);
    // 贝斯八分律动
    const bar = Math.floor(bi / 4) % 4;
    addNote(bt, period * 0.9, bassRoots[bar], 0.32 * musicLevel, 'bass');
    if (bi % 2 === 0) addNote(bt + period / 2, period * 0.45, bassRoots[bar] * 2, 0.2 * musicLevel, 'bass');
    // 琶音
    const chord = chords[bar];
    addNote(bt + period / 2, 0.3, chord[bi % 3] * 2, 0.12 * musicLevel, 'pluck');
  });
  // 长音 pad，每小节一个和弦
  for (let b = 0; b * 4 * period < durationSec; b++) {
    const t0 = beat0 + b * 4 * period;
    const chord = chords[b % 4];
    chord.forEach((f) => addNote(t0, 4 * period, f, 0.5 * musicLevel, 'pad'));
  }

  // ---------- 人群声 ----------
  {
    let pink = 0;
    let lp1 = 0;
    const aMid = lpCoef(900, sr);
    // 欢呼事件
    const cheers: { t0: number; dur: number; g: number }[] = [];
    const cheerCount = Math.floor(durationSec / 14);
    for (let i = 0; i < cheerCount; i++) {
      cheers.push({ t0: 4 + rng() * (durationSec - 10), dur: 1.6 + rng() * 2.4, g: 0.5 + rng() * 0.5 });
    }
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const white = rng() * 2 - 1;
      pink = 0.96 * pink + 0.04 * white;
      lp1 += aMid * (pink * 3 - lp1);
      let cheer = 0;
      for (const c of cheers) {
        const dt = t - c.t0;
        if (dt > 0 && dt < c.dur) {
          const env = Math.min(1, dt / 0.5) * Math.min(1, (c.dur - dt) / 0.8);
          cheer += env * c.g;
        }
      }
      const swell = 0.7 + 0.3 * Math.sin(2 * Math.PI * t / 11 + seed) + 0.15 * Math.sin(2 * Math.PI * t / 4.7);
      const bed = lp1 * 0.16 * swell * crowdLevel;
      const cheerV = lp1 * cheer * 0.34 * crowdLevel;
      track[i] += bed + cheerV;
    }
  }

  // ---------- 礼花真值与声音 ----------
  const c = speedOfSound(tempC);
  const shots: ShotTruth[] = [];

  // 选择目标节拍：保证间隔 >= 2.8s
  const targetBeats: number[] = [];
  const stepBeats = Math.max(4, Math.ceil(3.4 / period));
  const autoCount = Math.max(6, Math.floor(beatTimes.length / stepBeats) - 1);
  const count = opts.shotCount ?? autoCount;
  for (let k = 0; k < count; k++) {
    const bi = 6 + k * stepBeats + Math.floor(rng() * 2);
    if (bi < beatTimes.length - 2) targetBeats.push(beatTimes[bi]);
  }

  const calibers = [
    { id: '3inch', flight: 1.5, scale: 0.75, tau: 0.55 },
    { id: '4inch', flight: 1.9, scale: 0.9, tau: 0.7 },
    { id: '6inch', flight: 2.6, scale: 1.05, tau: 0.9 },
    { id: '8inch', flight: 3.3, scale: 1.2, tau: 1.15 },
  ];

  /** 在 t0 混入一发爆炸；echoCutoff 存在时对整条爆炸做低通（模拟反射） */
  const mixBoom = (t0: number, gain: number, scale: number, tau: number, echoCutoff?: number) => {
    const s0 = Math.floor(t0 * sr);
    const dur = 1.9 * scale + 0.6;
    const len = Math.floor(dur * sr);
    let lpState = 0;
    const a = echoCutoff ? lpCoef(echoCutoff, sr) : 1;
    for (let i = 0; i < len; i++) {
      if (s0 + i >= n) break;
      const tt = i / sr;
      // 初始炸裂高频 crack
      const crackEnv = Math.exp(-tt / 0.012);
      const crack = (rng() * 2 - 1) * crackEnv * 0.7;
      // 低频轰击：音高下滑
      const phase = 2 * Math.PI * (40 * tt + 90 * 0.05 * (1 - Math.exp(-tt / 0.05)));
      const boom = Math.sin(phase) * Math.exp(-tt / (0.34 * scale)) * 1.0;
      // 低频噪声隆隆
      const rumble = (rng() * 2 - 1) * Math.exp(-tt / tau) * 0.8;
      // 零星噼啪（低密度，避免形成连续二次 onset）
      let crackle = 0;
      if (rng() < 0.0009 && tt < 0.9) {
        crackle = (rng() * 2 - 1) * Math.exp(-((tt % 0.05) / 0.01)) * 0.5;
      }
      let v = (crack + boom * 1.1 + rumble * 0.7 + crackle) * gain;
      if (echoCutoff) {
        lpState += a * (v - lpState);
        v = lpState;
      }
      track[s0 + i] += v;
    }
  };

  targetBeats.forEach((tb, idx) => {
    const cal = calibers[Math.floor(rng() * calibers.length)];
    const offsetSec = (biasMs + gauss(rng) * jitterMs) / 1000;
    const bloomTime = tb + offsetSec;
    const distanceM = dMin + rng() * (dMax - dMin);
    const soundArrival = bloomTime + distanceM / c;
    const plannedIgnition = tb - cal.flight;
    const actualIgnition = bloomTime - cal.flight;
    const echoArrivals = venue.echoDelays.map((d) => soundArrival + d);

    shots.push({
      id: idx + 1,
      targetBeat: tb,
      plannedIgnition,
      actualIgnition,
      flightSec: cal.flight,
      bloomTime,
      distanceM,
      soundArrival,
      echoArrivals,
      caliberId: cal.id,
    });

    const amp = cal.scale * (0.85 + rng() * 0.3);
    // 直达声
    mixBoom(soundArrival, 0.85 * amp, cal.scale, cal.tau);
    // 场地回声
    venue.echoDelays.forEach((d, ei) => {
      mixBoom(soundArrival + d, 0.85 * amp * venue.echoGains[ei], cal.scale * 0.8, cal.tau * 0.8, venue.echoCutoff[ei]);
    });
  });

  // ---------- 母带：软削波 + 峰值归一 ----------
  let peak = 0;
  for (let i = 0; i < n; i++) {
    track[i] = Math.tanh(track[i] * 0.85);
    const a = Math.abs(track[i]);
    if (a > peak) peak = a;
  }
  const norm = peak > 0 ? 0.95 / peak : 1;
  for (let i = 0; i < n; i++) track[i] *= norm;

  // ---------- 摄像机亮度序列（30fps，曝光盒式积分 + 噪声） ----------
  // 帧时间戳取曝光区间中心，闪光模型为“瞬时起亮 + 指数衰减”，
  // 与 detectLightFlashes 的亚帧拟合模型严格一致。
  const luma: LumaSample[] = [];
  const frameDt = 1 / fps;
  const frames = Math.floor(durationSec * fps);
  for (let f = 0; f < frames; f++) {
    const tCenter = (f + 0.5) * frameDt;
    const tA = f * frameDt - tCenter; // = -dt/2
    const tB = (f + 1) * frameDt - tCenter; // = +dt/2
    // 夜空底亮 + 轻微大气闪烁
    let lum = 0.045 + 0.008 * Math.sin(tCenter * 0.7 + seed) + 0.004 * Math.sin(tCenter * 2.3);
    let cx = 0.5;
    let cy = 0.34;
    for (const s of shots) {
      const t0 = s.bloomTime - tCenter; // 相对帧中心
      const cal = calibers.find((cc) => cc.id === s.caliberId)!;
      const tau = 0.55 + cal.scale * 0.28;
      const A = 0.5;
      // 该帧曝光区间 [tA,tB] 相对 t0 的盒式积分均值
      const lo = Math.max(tA, t0);
      let m = 0;
      if (tB > t0) {
        m = (tau / frameDt) * (Math.exp(-(lo - t0) / tau) - Math.exp(-(tB - t0) / tau));
      }
      lum += A * m;
      cx = 0.3 + ((s.id * 0.137 + seed * 0.013) % 0.4);
      cy = 0.22 + ((s.id * 0.071) % 0.2);
    }
    // 舞台/城市灯光随拍微弱脉动（干扰项，幅度低于开花）
    const beatPhase = ((tCenter - beat0) % period + period) % period;
    lum += 0.026 * Math.exp(-beatPhase / 0.12) * musicLevel;
    // 摄像机噪声
    lum += gauss(rng) * 0.01;
    lum = Math.max(0, Math.min(1, lum));
    luma.push({ t: tCenter, v: lum, x: cx, y: cy, ratio: Math.max(0, lum - 0.1) });
  }

  const truth: SceneTruth = {
    bpm,
    temperatureC: tempC,
    venue: venueId,
    sampleRate: sr,
    durationSec,
    shots,
    beatTimes,
  };

  return { audio: track, sampleRate: sr, durationSec, luma, truth, name: opts.name ?? `${venue.name} ${bpm}BPM ${tempC}°C` };
}
