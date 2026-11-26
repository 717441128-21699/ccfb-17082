// 全局共享类型定义（核心算法、AudioWorklet、UI 共用）

/** 场地类型：决定回声模式，合成器与回声分组共用 */
export type VenueId = 'open' | 'square' | 'canyon' | 'valley';

export interface VenuePreset {
  id: VenueId;
  name: string;
  desc: string;
  /** 回声相对直达声的延迟（秒），可以是非等间隔 */
  echoDelays: number[];
  /** 每条回声的增益（相对直达声） */
  echoGains: number[];
  /** 回声低通截止频率（Hz），模拟墙面/空气吸收 */
  echoCutoff: number[];
}

/** 口径 -> 飞行时间（秒）等编排参数 */
export interface CaliberInfo {
  id: string;
  label: string;
  flightSec: number;
}

/** 亮度突变（画面开花时刻） */
export interface LightEvent {
  id: number;
  /** 亚帧精度的开花时刻（秒，相对媒体起点） */
  time: number;
  /** 峰值亮度增量 0..1 */
  peak: number;
  /** 检测置信度 0..1 */
  score: number;
  /** 开花在画面中的横向归一化位置 0..1（可选） */
  x?: number;
  y?: number;
}

/** AudioWorklet 检到的原始脉冲声（直达声与回声都可能出现） */
export interface SoundHit {
  id: number;
  /** 精修后的起振时刻（秒） */
  time: number;
  /** 块级触发时刻（秒），用于调试 */
  triggerTime: number;
  peak: number;
  rms: number;
  lowEnergy: number;
  highEnergy: number;
  score: number;
}

/** 经回声分组后的“一发”：主声 + 归并到它的回声 */
export interface SoundShot {
  id: number;
  primary: SoundHit;
  echoes: SoundHit[];
  /** 分组置信度 */
  echoScore: number;
}

export interface BeatGrid {
  bpm: number;
  confidence: number;
  /** 节拍时刻（秒） */
  beats: number[];
  /** 估计的拍周期 */
  periodSec: number;
  phaseSec: number;
}

/** 光-声配对与测距结果 */
export interface LightSoundPair {
  lightId: number;
  soundShotId: number;
  lightTime: number;
  soundTime: number;
  /** soundTime - lightTime（秒），即声音传播时长 */
  delaySec: number;
  /** 声速（m/s，按气温校正） */
  speedOfSound: number;
  /** 距离（米）= delaySec * c */
  distanceM: number;
  matchCost: number;
}

/** 编排表中的一行 */
export interface ChoreographyRow {
  id: number;
  /** 编排表原点火时刻（秒） */
  plannedIgnition: number;
  caliberId: string;
  /** 该口径飞行时间（秒），可手工覆盖 */
  flightSec: number;
  /** 期望卡上的节拍时刻（秒，可空） */
  targetBeat?: number;
  note?: string;
}

/** 一发礼花的完整核查报告 */
export interface ShotReport {
  index: number;
  light?: LightEvent;
  soundShot?: SoundShot;
  pair?: LightSoundPair;
  beatTime?: number;
  /** 开花相对最近节拍：bloom - beat，毫秒；正=落后，负=提前 */
  beatOffsetMs?: number;
  /** 开花相对编排预期开花（点火+飞行）的偏差，毫秒 */
  planOffsetMs?: number;
  /** 建议点火修正（毫秒），负=点火提前 */
  correctionMs?: number;
  /** 建议的新点火时刻（秒） */
  suggestedIgnition?: number;
  choreography?: ChoreographyRow;
  status: 'matched' | 'light-only' | 'sound-only';
  /** 合成场景下的真值（基准测试用） */
  truth?: ShotTruth;
}

/** 合成场景中一发的真值 */
export interface ShotTruth {
  id: number;
  targetBeat: number;
  plannedIgnition: number;
  actualIgnition: number;
  flightSec: number;
  bloomTime: number;
  distanceM: number;
  soundArrival: number;
  echoArrivals: number[];
  caliberId: string;
}

export interface SceneTruth {
  bpm: number;
  temperatureC: number;
  venue: VenueId;
  sampleRate: number;
  durationSec: number;
  shots: ShotTruth[];
  beatTimes: number[];
}

export interface AnalysisOptions {
  temperatureC: number;
  venue?: VenueId | 'auto';
  avOffsetMs?: number;
  /** 麦克风到爆点距离的合理范围（米），用于配对门限 */
  minDistanceM?: number;
  maxDistanceM?: number;
}

export interface AnalysisResult {
  durationSec: number;
  sampleRate: number;
  options: AnalysisOptions;
  lightEvents: LightEvent[];
  rawHits: SoundHit[];
  soundShots: SoundShot[];
  pairs: LightSoundPair[];
  beatGrid: BeatGrid | null;
  reports: ShotReport[];
  /** 亮度采样曲线，供绘图 */
  lumaSeries: { t: number; v: number; x?: number; y?: number }[];
  /** 音频包络降采样，供绘图 */
  envelope: { t: number; low: number; high: number; all: number }[];
  elapsedMs?: number;
  truth?: SceneTruth;
  benchmark?: BenchmarkMetrics;
}

export interface BenchmarkMetrics {
  scenes: number;
  totalShots: number;
  detectedShots: number;
  detectionRatePct: number;
  rawHitPrecisionPct: number;
  echoEventsTotal: number;
  echoFalseShots: number;
  echoFalseRatePct: number;
  audioOnlyEchoLeakPct: number;
  pairedDistances: number;
  distanceMeanErrPct: number;
  distanceMedianErrPct: number;
  distanceP95ErrPct: number;
  distanceMaxErrPct: number;
  distanceWithin5Pct: number;
  beatMedianErrMs: number;
  beatP95ErrMs: number;
  perfDurationSec: number;
  perfElapsedMs: number;
  perfPass30s: boolean;
  gatePass: boolean;
  details: SceneMetricRow[];
  ranAt?: string;
}

export interface SceneMetricRow {
  name: string;
  venue: VenueId;
  tempC: number;
  bpm: number;
  shots: number;
  detected: number;
  echoFalseShots: number;
  distanceMedianErrPct: number;
  distanceMaxErrPct: number;
  beatMedianErrMs: number;
  elapsedMs: number;
}
