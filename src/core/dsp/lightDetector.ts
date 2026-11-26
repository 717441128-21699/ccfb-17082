// 画面开花（亮度突变）检测。
// 输入是逐帧亮度采样（真实视频由 canvas 抽帧得到，合成测试由摄像机模型直接生成），
// 输出亚帧精度的开花时刻：在粗检之后用“指数衰减闪光 + 曝光积分”模型做局部拟合。

import type { LightEvent } from '../types';

export interface LumaSample {
  t: number;
  /** 归一化天空区域平均亮度 0..1 */
  v: number;
  /** 亮斑质心（归一化坐标，可选） */
  x?: number;
  y?: number;
  /** 亮像素占比 */
  ratio?: number;
}

export interface LightDetectParams {
  /** 同一朵花的不应期（秒） */
  refractorySec?: number;
  sensitivity?: number;
}

/** 从一帧 RGBA 像素提取天空 ROI 亮度与亮斑质心（供真实视频抽帧使用） */
export function extractLuma(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): { v: number; x: number; y: number; ratio: number } {
  // 取画面上方 12%..72% 作为天空 ROI，避开底部人群与顶部黑边
  const y0 = Math.floor(height * 0.12);
  const y1 = Math.floor(height * 0.72);
  let sum = 0;
  let n = 0;
  let bright = 0;
  let cx = 0;
  let cy = 0;
  let wsum = 0;
  const step = Math.max(1, Math.floor(width / 160)); // 降采样加速
  for (let y = y0; y < y1; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      const lum = (0.2126 * data[idx] + 0.7152 * data[idx + 1] + 0.0722 * data[idx + 2]) / 255;
      sum += lum;
      n++;
      if (lum > 0.45) {
        bright++;
        const w = lum * lum;
        cx += x * w;
        cy += y * w;
        wsum += w;
      }
    }
  }
  return {
    v: n ? sum / n : 0,
    ratio: n ? bright / n : 0,
    x: wsum ? cx / wsum / width : 0.5,
    y: wsum ? cy / wsum / height : 0.35,
  };
}

/** 中位数 */
function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * 用指数衰减闪光模型对单个事件做亚帧时刻拟合。
 * 摄像机一帧的测量值 ≈ A * (1/Δ) ∫ exp(-(t-t0)/τ) dt，t>=t0。
 */
function fitOnset(
  samples: LumaSample[],
  baseline: number,
  coarseIndex: number,
  frameDt: number,
): number {
  const i0 = Math.max(1, coarseIndex - 3);
  const i1 = Math.min(samples.length - 1, coarseIndex + Math.round(1.6 / frameDt));
  if (i1 - i0 < 4) return samples[coarseIndex]?.t ?? 0;

  const ts: number[] = [];
  const ys: number[] = [];
  for (let i = i0; i <= i1; i++) {
    ts.push(samples[i].t);
    ys.push(Math.max(0, samples[i].v - baseline));
  }
  const tBase = ts[0];

  // 粗 onset 邻域（±0.09s），tau 网格
  const coarseT = samples[coarseIndex].t;
  let bestT0 = coarseT;
  let bestErr = Infinity;

  for (let tau = 0.22; tau <= 1.5; tau += 0.16) {
    // t0 以 2ms 网格搜索
    const lo = coarseT - 0.1;
    for (let t0 = lo; t0 <= coarseT + 0.06; t0 += 0.004) {
      // 最优幅度 A = Σ y m / Σ m²，m 为曝光积分模型
      let mtm = 0;
      let mty = 0;
      const models: number[] = new Array(ts.length);
      for (let k = 0; k < ts.length; k++) {
        const ta = ts[k] - frameDt / 2 - t0;
        const tb = ts[k] + frameDt / 2 - t0;
        let m = 0;
        if (tb > 0) {
          const a = Math.max(0, ta);
          // (1/dt) ∫_a^tb exp(-u/tau) du
          m = (tau / frameDt) * (Math.exp(-a / tau) - Math.exp(-Math.max(a, tb) / tau));
          if (ta < 0 && tb > 0) {
            m = (tau / frameDt) * (1 - Math.exp(-tb / tau));
          }
        }
        models[k] = m;
        mtm += m * m;
        mty += m * ys[k];
      }
      if (mtm < 1e-9) continue;
      const A = mty / mtm;
      if (A <= 0) continue;
      let err = 0;
      for (let k = 0; k < ts.length; k++) {
        const d = ys[k] - A * models[k];
        err += d * d;
      }
      if (err < bestErr) {
        bestErr = err;
        bestT0 = t0;
      }
    }
  }
  // 防止拟合跑出合理范围
  return Math.max(coarseT - 0.12, Math.min(coarseT + 0.08, bestT0));
}

export function detectLightFlashes(samples: LumaSample[], params: LightDetectParams = {}): LightEvent[] {
  if (samples.length < 8) return [];
  const refractory = params.refractorySec ?? 1.0;
  const sens = params.sensitivity ?? 0.55;

  const dt = samples.length > 1 ? median(samples.slice(1, 20).map((s, i) => s.t - samples[i].t)) || 1 / 30 : 1 / 30;

  // 慢基线：滚动窗口最小值与中位数的折中（夜空基本恒定，闪光会衰减）
  const baseWin = Math.max(15, Math.round(2.5 / dt));
  const baseline: number[] = samples.map((_, i) => {
    const lo = Math.max(0, i - baseWin);
    const slice = samples.slice(lo, i + 1).map((s) => s.v).sort((a, b) => a - b);
    return slice[Math.floor(slice.length * 0.25)];
  });

  // 正向亮度通量
  const flux: number[] = samples.map((s, i) => {
    if (i === 0) return 0;
    const d = s.v - samples[i - 1].v;
    return d > 0 ? d : 0;
  });
  const fluxMed = median(flux);
  const absDev = median(flux.map((f) => Math.abs(f - fluxMed))) || 0.01;
  const zThresh = 5.2 - sens * 2.2; // 灵敏度越高阈值越低

  const events: LightEvent[] = [];
  let lastEventT = -10;
  let id = 1;

  for (let i = 2; i < samples.length - 2; i++) {
    const z = (flux[i] - fluxMed) / (1.4826 * absDev + 1e-6);
    const excess = samples[i].v - baseline[i];
    if (z < zThresh || excess < 0.05) continue;
    if (samples[i].t - lastEventT < refractory) continue;

    // 局部通量峰值（NMS）
    if (flux[i] < flux[i - 1] || flux[i] < flux[i + 1]) continue;

    // 抛物线亚帧插值定位通量峰
    const y0 = flux[i - 1];
    const y1 = flux[i];
    const y2 = flux[i + 1];
    let shift = 0;
    const denom = y0 - 2 * y1 + y2;
    if (denom < 0) shift = (0.5 * (y0 - y2)) / denom; // -0.5..0.5 帧
    const fluxT = samples[i].t + shift * dt;

    // 模型拟合 onset，失败则用通量峰回推小半个上升沿
    let onset = fitOnset(samples, baseline[i], i, dt);
    if (!Number.isFinite(onset) || Math.abs(onset - samples[i].t) > 0.12) {
      onset = fluxT - dt * 0.6;
    }

    // 峰值亮度
    let peak = excess;
    for (let k = i; k < Math.min(samples.length, i + Math.round(0.5 / dt)); k++) {
      const e = samples[k].v - baseline[k];
      if (e > peak) peak = e;
    }

    const score = Math.min(1, 0.4 + Math.min(z / 12, 1) * 0.4 + Math.min(peak / 0.5, 1) * 0.2);
    events.push({
      id: id++,
      time: onset,
      peak,
      score,
      x: samples[i].x,
      y: samples[i].y,
    });
    lastEventT = onset;
  }

  return events;
}
