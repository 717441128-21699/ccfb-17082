// 编排表与修正量的纯逻辑：默认编排生成、关联、按气温重算距离、CSV 导出。

import { caliberFlight } from './venues';
import { speedOfSound } from './physics';
import type { AnalysisResult, ChoreographyRow, ShotReport } from './types';

/** 依据核查结果生成默认编排：计划点火 = 目标节拍 - 飞行时间 */
export function buildDefaultChoreography(reports: ShotReport[]): ChoreographyRow[] {
  return reports
    .filter((r) => r.light)
    .map((r, i) => {
      const caliberId = '4inch';
      const flightSec = caliberFlight(caliberId);
      const beat = r.beatTime;
      const plannedIgnition = beat !== undefined ? beat - flightSec : r.light!.time - flightSec;
      return {
        id: i + 1,
        plannedIgnition: Math.max(0, plannedIgnition),
        caliberId,
        flightSec,
        targetBeat: beat,
        note: '',
      };
    });
}

/** 把编排行关联到报告并计算 planOffset / suggestedIgnition / correction */
export function enrichReports(reports: ShotReport[], rows: ChoreographyRow[]): ShotReport[] {
  const sortedRows = [...rows].sort(
    (a, b) => a.plannedIgnition + a.flightSec - (b.plannedIgnition + b.flightSec),
  );
  const used = new Set<number>();
  return reports.map((r0) => {
    const r: ShotReport = { ...r0 };
    if (!r.light) return r;
    let best: ChoreographyRow | null = null;
    let bestD = 2.0;
    for (const row of sortedRows) {
      if (used.has(row.id)) continue;
      const expectedBloom = row.plannedIgnition + row.flightSec;
      const d = Math.abs(expectedBloom - r.light.time);
      if (d < bestD) {
        bestD = d;
        best = row;
      }
    }
    if (best) {
      used.add(best.id);
      r.choreography = best;
      r.planOffsetMs = (r.light.time - (best.plannedIgnition + best.flightSec)) * 1000;
      if (r.correctionMs === undefined) r.correctionMs = -r.planOffsetMs;
      r.suggestedIgnition = best.plannedIgnition + (r.correctionMs ?? 0) / 1000;
    }
    return r;
  });
}

/** 改变气温后用存储的延迟重算声速与距离，无需重新检测 */
export function withTemperature(result: AnalysisResult, tempC: number): AnalysisResult {
  const c = speedOfSound(tempC);
  const pairs = result.pairs.map((p) => ({ ...p, speedOfSound: c, distanceM: p.delaySec * c }));
  const pairById = new Map(pairs.map((p) => [p.lightId, p]));
  const reports = result.reports.map((r) =>
    r.pair ? { ...r, pair: pairById.get(r.light!.id) ?? r.pair } : r,
  );
  return { ...result, pairs, reports, options: { ...result.options, temperatureC: tempC } };
}

export function correctionsCsv(result: AnalysisResult): string {
  const head = [
    '序号',
    '开花时刻s',
    '最近节拍s',
    '节拍偏差ms(正落后)',
    '建议点火修正ms(负提前)',
    '距离m',
    '气温C',
    '口径',
    '飞行s',
    '原计划点火s',
    '建议新点火s',
    '回声数',
    '状态',
  ];
  const lines = [head.join(',')];
  for (const r of result.reports) {
    lines.push(
      [
        r.index,
        r.light?.time.toFixed(3) ?? '',
        r.beatTime?.toFixed(3) ?? '',
        r.beatOffsetMs?.toFixed(0) ?? '',
        r.correctionMs?.toFixed(0) ?? '',
        r.pair?.distanceM.toFixed(1) ?? '',
        result.options.temperatureC,
        r.choreography?.caliberId ?? '',
        r.choreography?.flightSec.toFixed(2) ?? '',
        r.choreography?.plannedIgnition.toFixed(3) ?? '',
        r.suggestedIgnition?.toFixed(3) ?? '',
        r.soundShot?.echoes.length ?? 0,
        r.status,
      ].join(','),
    );
  }
  return '﻿' + lines.join('\n');
}

export function choreographyJson(rows: ChoreographyRow[]): string {
  return JSON.stringify(
    rows.map((r) => ({
      id: r.id,
      plannedIgnitionSec: Number(r.plannedIgnition.toFixed(3)),
      caliber: r.caliberId,
      flightSec: r.flightSec,
      targetBeat: r.targetBeat !== undefined ? Number(r.targetBeat.toFixed(3)) : undefined,
    })),
    null,
    2,
  );
}
