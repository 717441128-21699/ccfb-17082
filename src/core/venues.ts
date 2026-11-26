import type { CaliberInfo, VenuePreset } from './types';

/**
 * 几种典型场地的回声模型（合成器与 UI 说明共用）。
 * canyon：两排楼之间来回反射，给出 3 次回声（共 4 个到达：直达 + 3 反射）。
 */
export const VENUES: Record<string, VenuePreset> = {
  open: {
    id: 'open',
    name: '开阔广场',
    desc: '无明显反射面，基本只有直达声',
    echoDelays: [],
    echoGains: [],
    echoCutoff: [],
  },
  square: {
    id: 'square',
    name: '城市广场（单侧楼群）',
    desc: '一声清晰楼群回声，约 0.42s',
    echoDelays: [0.42],
    echoGains: [0.34],
    echoCutoff: [2600],
  },
  canyon: {
    id: 'canyon',
    name: '两排楼之间（三次来回反射）',
    desc: '0.31s 一次的连续三次回声，能量递减，最易被误判成另一发',
    echoDelays: [0.31, 0.62, 0.93],
    echoGains: [0.5, 0.27, 0.14],
    echoCutoff: [3200, 2200, 1500],
  },
  valley: {
    id: 'valley',
    name: '山谷',
    desc: '延迟更长、更弥散的两次回声 0.8s / 1.5s',
    echoDelays: [0.8, 1.5],
    echoGains: [0.42, 0.22],
    echoCutoff: [1800, 1100],
  },
};

export const VENUE_LIST: VenuePreset[] = [VENUES.open, VENUES.square, VENUES.canyon, VENUES.valley];

/** 礼花口径与典型升空飞行时间（秒），用于反推点火时刻 */
export const CALIBERS: CaliberInfo[] = [
  { id: '2inch', label: '2 寸', flightSec: 1.1 },
  { id: '3inch', label: '3 寸', flightSec: 1.5 },
  { id: '4inch', label: '4 寸', flightSec: 1.9 },
  { id: '6inch', label: '6 寸', flightSec: 2.6 },
  { id: '8inch', label: '8 寸', flightSec: 3.3 },
  { id: '12inch', label: '12 寸', flightSec: 4.4 },
];

export function caliberFlight(id: string): number {
  return CALIBERS.find((c) => c.id === id)?.flightSec ?? 2.0;
}
