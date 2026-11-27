/** 全应用共享的数据类型。 */

export type VenueId = 'open' | 'street' | 'valley';

export interface VenueProfile {
  id: VenueId;
  label: string;
  /** 回声抑制窗口（秒）：该时间内的弱重复事件按回声处理。 */
  echoWindowSec: number;
  /** 回声判定频谱余弦相似度门槛。 */
  echoSimilarity: number;
  /** 回声相对主事件的最大能量比。 */
  echoEnergyRatio: number;
}

export const VENUES: Record<VenueId, VenueProfile> = {
  open: { id: 'open', label: '开阔场地', echoWindowSec: 0.7, echoSimilarity: 0.85, echoEnergyRatio: 1.4 },
  street: { id: 'street', label: '楼群街道（两排楼）', echoWindowSec: 1.0, echoSimilarity: 0.85, echoEnergyRatio: 1.4 },
  valley: { id: 'valley', label: '山谷', echoWindowSec: 1.6, echoSimilarity: 0.8, echoEnergyRatio: 1.45 },
};

/** 声音侧检出的单发事件（回声抑制前称为候选）。 */
export interface SoundEvent {
  /** 事件起点时间（秒，录像时间轴）。 */
  timeSec: number;
  /** 峰值时间（秒），用于配对。 */
  peakSec: number;
  /** 检测置信度 0~1。 */
  score: number;
  /** 低频段能量（相对值）。 */
  lowEnergy: number;
  /** 频谱平坦度，爆炸接近 1、乐音较低。 */
  flatness: number;
  /** 事件持续时长（秒）：爆炸通常 >150ms，鼓点 <70ms。 */
  durationSec: number;
  /** 低频段幅度谱指纹（回声比对用）。 */
  fingerprint: Float32Array;
  /** 被标记为某主事件的回声（毫秒偏移）。 */
  echoOf?: number;
}

export interface FlashEvent {
  /** 亮度突变起点（秒）。 */
  timeSec: number;
  /** 峰值帧时间（秒）。 */
  peakSec: number;
  /** 突变强度（亮度增量归一化）。 */
  strength: number;
}

export interface BeatEvent {
  timeSec: number;
  /** 该点估计的瞬时 BPM。 */
  bpm: number;
  /** 是否为强拍（小节首拍）。 */
  strong: boolean;
}

/** 光声配对后的一发礼花。 */
export interface ShotRecord {
  index: number;
  flash: FlashEvent;
  sound?: SoundEvent;
  /** 光声延迟（秒）= 听到 − 看到。 */
  lightSoundDelaySec?: number;
  /** 校正声速后反算的观众到爆点距离（米）。 */
  distanceM?: number;
  /** 最近的配乐节拍。 */
  matchedBeat?: BeatEvent;
  /** 开花时刻相对节拍的偏差（秒），正=落后、负=提前。 */
  beatOffsetSec?: number;
  /** 编排表中的点火时间（秒，若有编排表）。 */
  plannedIgnitionSec?: number;
  /** 礼花弹飞行时间（秒，口径决定，编排表提供）。 */
  flightTimeSec?: number;
  /** 点火修正量（秒）：新点火时间 = 原计划 + 本值，通常为负。 */
  ignitionCorrectionSec?: number;
}

export interface AnalysisConfig {
  venue: VenueId;
  /** 现场气温（摄氏度），用于声速校正。 */
  temperatureC: number;
  /** 编排表默认飞行时间（秒），表内未注明口径时使用。 */
  defaultFlightSec: number;
}

export interface ChoreographyRow {
  shotId: string;
  /** 计划点火时间（秒）。 */
  ignitionSec: number;
  /** 口径（英寸/毫米，自由文本），用于查飞行时间。 */
  caliber: string;
  /** 飞行时间（秒）。 */
  flightSec: number;
}

export interface SyntheticClipOptions {
  durationSec: number;
  sampleRate: number;
  venue: VenueId;
  temperatureC: number;
  /** 真实爆点距离（米），决定光声延迟。 */
  distanceM: number;
  shotCount: number;
  /** 配乐基础 BPM。 */
  bpm: number;
  /** BPM 是否在段落间漂移。 */
  tempoDrift: boolean;
  seed: number;
}

export interface GroundTruth {
  /** 真实爆炸（爆点发声）时刻，秒。 */
  explosionTimes: number[];
  /** 录像中应看到开花的时刻，秒。 */
  flashTimes: number[];
  /** 录像中应听到爆炸声的时刻，秒（含气温声速）。 */
  heardTimes: number[];
  /** 真实配乐节拍时刻，秒。 */
  beatTimes: number[];
  distanceM: number;
  venue: VenueId;
  temperatureC: number;
}

export interface SyntheticClip {
  channelData: Float32Array;
  sampleRate: number;
  durationSec: number;
  /** 闪光帧序列（时间秒 + 亮度 0~1）。 */
  flashFrames: { timeSec: number; luminance: number }[];
  truth: GroundTruth;
}
