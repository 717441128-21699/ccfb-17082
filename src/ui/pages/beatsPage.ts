// 节拍对照页：BPM/置信度、提前落后统计、偏差发散条形图与明细表。

import { h, clear, badge, fmtMs } from '../dom';
import { store } from '../store';
import { beatStats } from '../../core/pipeline';
import { mean, std } from '../../core/physics';

export function renderBeatsPage(root: HTMLElement): void {
  clear(root);
  const result = store.state.result;
  if (!result) {
    root.append(emptyState());
    return;
  }
  const stats = beatStats(result.reports);
  const grid = result.beatGrid;
  const offsets = result.reports
    .filter((r) => r.beatOffsetMs !== undefined)
    .sort((a, b) => a.light!.time - b.light!.time);
  const maxAbs = Math.max(120, ...offsets.map((r) => Math.abs(r.beatOffsetMs!)));

  const statGrid = h('div', { class: 'stat-grid' },
    statCard('跟踪 BPM', grid ? grid.bpm.toFixed(1) : '—', 'accent'),
    statCard('置信度', grid ? `${(grid.confidence * 100).toFixed(0)}%` : '—', 'good'),
    statCard('平均偏差', `${stats.meanMs >= 0 ? '+' : ''}${stats.meanMs.toFixed(1)} ms`, Math.abs(stats.meanMs) < 25 ? 'good' : 'warn'),
    statCard('中位偏差', `${stats.medianMs >= 0 ? '+' : ''}${stats.medianMs.toFixed(0)} ms`, Math.abs(stats.medianMs) < 25 ? 'good' : 'warn'),
    statCard('标准差', `${stats.stdMs.toFixed(1)} ms`, 'muted'),
    statCard('提前 / 正拍 / 落后', `${stats.early} / ${stats.onBeat} / ${stats.late}`, 'accent'),
  );

  // 发散条形图
  const chart = h('section', { class: 'card' },
    h('div', { class: 'card-head' },
      h('h2', {}, '每发开花相对最近节拍的偏差'),
      h('div', { class: 'legend' },
        h('span', {}, h('i', { class: 'sw early' }), '提前（负）'),
        h('span', {}, h('i', { class: 'sw late' }), '落后（正）'),
      ),
    ),
    h('div', { class: 'offset-chart' },
      h('div', { class: 'offset-axis' },
        h('span', {}, `-${maxAbs.toFixed(0)}ms`), h('span', {}, '0'), h('span', {}, `+${maxAbs.toFixed(0)}ms`),
      ),
      ...offsets.map((r) => offsetRow(r.index, r.beatOffsetMs!, maxAbs)),
    ),
  );

  // 汇总曲线数据（均值 ±std）
  const summary = h('section', { class: 'card insight-card' },
    h('h2', {}, '导演结论'),
    h('p', {},
      stats.count
        ? `共 ${stats.count} 发可与节拍比较。整体平均${stats.meanMs >= 0 ? '落后' : '提前'} ${Math.abs(stats.meanMs).toFixed(0)} ms，建议把编排表所有点火时间统一${stats.meanMs >= 0 ? '提前' : '延后'} ${Math.abs(stats.meanMs).toFixed(0)} ms；逐发差异标准差 ${stats.stdMs.toFixed(0)} ms 由口径飞行时间与燃放误差造成，可在点火修正页逐发微调。`
        : '没有可比较的节拍。',
    ),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn btn-primary', onclick: () => store.navigate('correction') }, '前往点火修正'),
      h('button', { class: 'btn', onclick: () => store.shiftAllCorrections(-stats.meanMs) }, `按平均偏差整体移动点火（${fmtMs(-stats.meanMs)}）`),
    ),
  );

  const tbody = h('tbody');
  for (const r of offsets) {
    tbody.append(h('tr', {},
      h('td', { class: 'mono' }, String(r.index)),
      h('td', { class: 'mono' }, r.light!.time.toFixed(3)),
      h('td', { class: 'mono' }, r.beatTime!.toFixed(3)),
      h('td', { class: `mono strong ${tone(r.beatOffsetMs!)}` }, fmtMs(r.beatOffsetMs)),
      h('td', {}, badge(Math.abs(r.beatOffsetMs!) <= 25 ? '正拍' : r.beatOffsetMs! < 0 ? '提前' : '落后',
        Math.abs(r.beatOffsetMs!) <= 25 ? 'good' : r.beatOffsetMs! < 0 ? 'accent' : 'bad')),
      h('td', { class: 'mono' }, fmtMs(r.correctionMs)),
    ));
  }
  const table = h('section', { class: 'card' },
    h('h2', {}, '节拍对照明细'),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'data-table' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, '开花 s'), h('th', {}, '节拍 s'), h('th', {}, '偏差'), h('th', {}, '判定'), h('th', {}, '点火修正'))),
        tbody,
      ),
    ),
  );

  root.append(statGrid, chart, summary, table);
}

function offsetRow(index: number, v: number, maxAbs: number): HTMLElement {
  const pct = (Math.abs(v) / maxAbs) * 50; // 半宽 50%
  const late = v >= 0;
  const bar = h('div', {
    class: `offset-bar ${late ? 'late' : 'early'}`,
    style: late ? `left:50%;width:${pct}%` : `right:50%;width:${pct}%`,
  });
  return h('div', { class: 'offset-row' },
    h('span', { class: 'offset-idx mono' }, `#${index}`),
    h('div', { class: 'offset-track' }, h('div', { class: 'offset-zero' }), bar),
    h('span', { class: `offset-val mono ${tone(v)}` }, fmtMs(v)),
  );
}

function tone(v: number): string {
  const a = Math.abs(v);
  return a <= 25 ? 'good-text' : a <= 80 ? 'warn-text' : 'bad-text';
}
function statCard(label: string, value: string, toneName: 'good' | 'bad' | 'warn' | 'muted' | 'accent'): HTMLElement {
  return h('div', { class: `stat-card tone-${toneName}` }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label));
}
function emptyState(): HTMLElement {
  return h('div', { class: 'empty-state card' },
    h('div', { class: 'empty-icon' }, '🥁'),
    h('h2', {}, '还没有节拍分析'),
    h('p', { class: 'muted' }, '先导入录像或运行合成场景核查。'),
    h('button', { class: 'btn btn-primary', onclick: () => store.navigate('import') }, '去导入 / 合成'),
  );
}

// 保持 mean/std 引用（未来扩展分布展示）
void mean;
void std;
