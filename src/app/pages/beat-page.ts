import { store } from '../store.js';
import { fmtTime } from '../../core/physics.js';
import type { AnalysisResult } from '../../core/analysis.js';

/** 节拍对照页：开花时刻与配乐节拍的偏差，提前/落后毫秒数。 */
export function renderBeatPage(root: HTMLElement): void {
  const s = store.getState();
  if (!s.result) {
    root.innerHTML = `<div class="empty">请先完成核查</div>`;
    return;
  }
  const r: AnalysisResult = s.result;
  const early = r.stats.earlyCount;
  const late = r.stats.lateCount;
  const onTime = r.shots.filter((sh) => sh.beatOffsetSec !== undefined && Math.abs(sh.beatOffsetSec) <= 0.02).length;

  const offsetBadge = (off: number | undefined) => {
    if (off === undefined) return '<span class="badge echo">无节拍</span>';
    const ms = off * 1000;
    if (Math.abs(ms) <= 20) return '<span class="badge good">准点</span>';
    if (ms < 0) return `<span class="badge warn">提前 ${Math.abs(ms).toFixed(0)}ms</span>`;
    return `<span class="badge bad">落后 ${ms.toFixed(0)}ms</span>`;
  };

  root.innerHTML = `
    <div class="card">
      <h2>节拍对照汇总</h2>
      <div class="stat-grid">
        <div class="stat"><div class="label">跟踪节拍数</div><div class="value">${r.beats.length}</div></div>
        <div class="stat"><div class="label">准点（±20ms）</div><div class="value good">${onTime}</div></div>
        <div class="stat"><div class="label">提前开花</div><div class="value warn">${early}</div></div>
        <div class="stat"><div class="label">落后开花</div><div class="value bad">${late}</div></div>
        <div class="stat"><div class="label">平均绝对偏差</div><div class="value">${r.stats.meanAbsBeatOffsetMs ?? '—'}<span style="font-size:13px"> ms</span></div></div>
      </div>
      <p class="muted" style="margin-top:12px">
        偏差 = 开花时刻 − 最近节拍时刻。负值表示这一发在重拍之前炸开，正值表示滞后。
      </p>
    </div>

    <div class="card">
      <h2>逐发节拍偏差</h2>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>开花时刻</th><th>最近节拍</th><th class="num">偏差</th>
            <th class="num">节拍 BPM</th><th>强拍</th><th>判定</th>
          </tr></thead>
          <tbody>
            ${r.shots
              .map((sh) => {
                const off = sh.beatOffsetSec;
                return `<tr>
                  <td>${sh.index}</td>
                  <td class="num">${fmtTime(sh.flash.peakSec)}</td>
                  <td class="num">${sh.matchedBeat ? fmtTime(sh.matchedBeat.timeSec) : '—'}</td>
                  <td class="num" style="color:${off !== undefined && off < 0 ? 'var(--warn)' : off !== undefined && off > 0 ? 'var(--bad)' : 'var(--good)'}">
                    ${off !== undefined ? `${off > 0 ? '+' : ''}${(off * 1000).toFixed(0)} ms` : '—'}
                  </td>
                  <td class="num">${sh.matchedBeat?.bpm ?? '—'}</td>
                  <td>${sh.matchedBeat?.strong ? '●' : ''}</td>
                  <td>${offsetBadge(off)}</td>
                </tr>`;
              })
              .join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>偏差分布</h2>
      ${renderHistogram(r)}
    </div>
  `;
}

function renderHistogram(r: AnalysisResult): string {
  const offsets = r.shots.map((s) => s.beatOffsetSec).filter((x): x is number => x !== undefined).map((x) => x * 1000);
  if (offsets.length === 0) return '<div class="muted">无偏差数据</div>';
  const binSize = 50;
  const bins = new Map<number, number>();
  for (const ms of offsets) {
    const b = Math.floor(ms / binSize) * binSize;
    bins.set(b, (bins.get(b) ?? 0) + 1);
  }
  const keys = [...bins.keys()].sort((a, b) => a - b);
  const max = Math.max(...bins.values());
  return keys
    .map((k) => {
      const n = bins.get(k) ?? 0;
      const pct = (n / max) * 100;
      const color = k < -20 ? 'var(--warn)' : k > 20 ? 'var(--bad)' : 'var(--good)';
      return `
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:5px">
          <div class="mono muted" style="width:90px;text-align:right">${k}~${k + binSize}ms</div>
          <div style="flex:1;background:var(--panel-2);border-radius:4px;height:18px;position:relative">
            <div style="width:${pct}%;background:${color};height:100%;border-radius:4px"></div>
          </div>
          <div class="mono" style="width:30px">${n}</div>
        </div>`;
    })
    .join('');
}
