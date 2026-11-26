// 声光事件页：时间线、配对/距离、回声归并与筛选明细表。

import { h, clear, badge, fmtMs } from '../dom';
import { store } from '../store';
import { renderTimeline, type TimelineHandle } from '../charts';
import { median } from '../../core/physics';
import type { ShotReport } from '../../core/types';

let handle: TimelineHandle | null = null;

export function renderEventsPage(root: HTMLElement): void {
  handle?.destroy();
  handle = null;
  clear(root);
  const result = store.state.result;
  if (!result) {
    root.append(emptyState());
    return;
  }

  const echoCount = result.soundShots.reduce((a, s) => a + s.echoes.length, 0);
  const distances = result.pairs.map((p) => p.distanceM);
  const truthErrs = result.truth
    ? result.reports
        .map((r) => {
          if (!r.pair || !r.light) return null;
          const t = result.truth!.shots.find((ts) => Math.abs(ts.bloomTime - r.light!.time) < 0.28);
          return t ? (Math.abs(r.pair.distanceM - t.distanceM) / t.distanceM) * 100 : null;
        })
        .filter((v): v is number => v !== null)
    : [];

  const stats = h('div', { class: 'stat-grid' },
    statCard('开花（画面亮度）', String(result.lightEvents.length), 'accent'),
    statCard('爆炸主声', String(result.soundShots.length), 'good'),
    statCard('归并回声/二次脉冲', String(echoCount), 'muted'),
    statCard('光声配对', String(result.pairs.length), 'good'),
    statCard('距离中位', distances.length ? `${median(distances).toFixed(0)} m` : '—', 'accent'),
    truthErrs.length
      ? statCard('测距误差 P95', `${truthErrs.sort((a, b) => a - b)[Math.floor(truthErrs.length * 0.95)]?.toFixed(2)}%`, 'good')
      : statCard('声速', `${result.pairs[0]?.speedOfSound.toFixed(1) ?? '343'} m/s`, 'muted'),
  );

  const tooltip = h('div', { class: 'chart-tooltip hidden' });
  const canvas = h('canvas', { class: 'timeline-canvas' }) as HTMLCanvasElement;
  const chartCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '声光时间线'), legend()),
    h('div', { class: 'chart-wrap' }, canvas, tooltip),
  );
  // 等待 canvas 挂载后再渲染
  setTimeout(() => {
    if (!canvas.isConnected) return;
    handle = renderTimeline(canvas, result, (t, mx, my) => {
      if (t === null) {
        tooltip.classList.add('hidden');
        return;
      }
      tooltip.classList.remove('hidden');
      tooltip.style.left = `${mx + 12}px`;
      tooltip.style.top = `${Math.max(8, my - 10)}px`;
      const light = result.lightEvents.find((l) => Math.abs(l.time - t) < 0.12);
      const sound = result.soundShots.find((s) => Math.abs(s.primary.time - t) < 0.12);
      tooltip.innerHTML = `t=${t.toFixed(2)}s` +
        (light ? `<br><span style="color:var(--gold)">开花 #${light.id}</span>` : '') +
        (sound ? `<br><span style="color:var(--cyan)">主声 #${sound.id} · 回声×${sound.echoes.length}</span>` : '');
    });
  }, 0);

  // ---- 筛选 + 表格 ----
  type Filter = 'all' | 'matched' | 'light-only' | 'sound-only';
  let filter: Filter = 'all';
  const tbody = h('tbody');
  const renderRows = () => {
    clear(tbody);
    const rows = result.reports.filter((r) => filter === 'all' || r.status === filter);
    for (const r of rows) tbody.append(rowEl(r, !!result.truth));
    if (!rows.length) tbody.append(h('tr', {}, h('td', { colSpan: 9, class: 'muted center' }, '当前筛选无记录')));
  };
  const filterBar = h('div', { class: 'chip-row' },
    ...([
      ['all', `全部 ${result.reports.length}`],
      ['matched', `已配对 ${result.pairs.length}`],
      ['light-only', `仅亮光 ${result.reports.filter((r) => r.status === 'light-only').length}`],
      ['sound-only', `仅声音 ${result.reports.filter((r) => r.status === 'sound-only').length}`],
    ] as [Filter, string][]).map(([id, label]) => {
      const c = h('button', { class: `chip ${id === 'all' ? 'active' : ''}`, type: 'button' }, label);
      c.addEventListener('click', () => {
        filter = id;
        filterBar.querySelectorAll('.chip').forEach((x) => x.classList.remove('active'));
        c.classList.add('active');
        renderRows();
      });
      return c;
    }),
  );

  const tableCard = h('section', { class: 'card' },
    h('div', { class: 'card-head' }, h('h2', {}, '事件明细'), filterBar),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'data-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, '#'), h('th', {}, '开花时刻'), h('th', {}, '主声时刻'), h('th', {}, '延迟 s'),
          h('th', {}, '距离 m'), h('th', {}, '回声'), h('th', {}, '节拍偏差'), h('th', {}, '置信度'), h('th', {}, '状态'),
        )),
        tbody,
      ),
    ),
  );
  renderRows();

  root.append(stats, chartCard, tableCard);
}

function rowEl(r: ShotReport, hasTruth: boolean): HTMLTableRowElement {
  const truth = hasTruth && r.light ? store.state.result?.truth?.shots.find((t) => Math.abs(t.bloomTime - r.light!.time) < 0.28) : undefined;
  const distErr = truth && r.pair ? ((r.pair.distanceM - truth.distanceM) / truth.distanceM) * 100 : null;
  const statusBadge =
    r.status === 'matched' ? badge('已配对', 'good') :
    r.status === 'light-only' ? badge('仅亮光', 'warn') : badge('仅声音', 'muted');
  return h('tr', {},
    h('td', { class: 'mono' }, String(r.index)),
    h('td', { class: 'mono' }, r.light ? r.light.time.toFixed(3) : '—'),
    h('td', { class: 'mono' }, r.soundShot ? r.soundShot.primary.time.toFixed(3) : '—'),
    h('td', { class: 'mono' }, r.pair ? r.pair.delaySec.toFixed(3) : '—'),
    h('td', { class: 'mono' },
      r.pair ? `${r.pair.distanceM.toFixed(1)}` : '—',
      distErr !== null ? h('span', { class: `sub ${Math.abs(distErr) <= 5 ? 'good-text' : 'bad-text'}` }, ` (${distErr >= 0 ? '+' : ''}${distErr.toFixed(1)}%)`) : null,
    ),
    h('td', {}, r.soundShot?.echoes.length ? badge(`×${r.soundShot.echoes.length}`, 'muted') : '—'),
    h('td', { class: `mono ${toneClass(r.beatOffsetMs)}` }, fmtMs(r.beatOffsetMs)),
    h('td', {}, r.soundShot ? (r.soundShot.primary.score * 100).toFixed(0) + '%' : '—'),
    h('td', {}, statusBadge),
  );
}

function toneClass(v: number | undefined): string {
  if (v === undefined) return 'muted-text';
  const a = Math.abs(v);
  return a <= 25 ? 'good-text' : a <= 80 ? 'warn-text' : 'bad-text';
}

function statCard(label: string, value: string, tone: 'good' | 'bad' | 'warn' | 'muted' | 'accent'): HTMLElement {
  return h('div', { class: `stat-card tone-${tone}` }, h('div', { class: 'stat-value' }, value), h('div', { class: 'stat-label' }, label));
}

function legend(): HTMLElement {
  return h('div', { class: 'legend' },
    h('span', {}, h('i', { class: 'dot gold' }), '开花'),
    h('span', {}, h('i', { class: 'dot cyan' }), '主声'),
    h('span', {}, h('i', { class: 'dot gray' }), '回声'),
    h('span', {}, h('i', { class: 'bar beat' }), '节拍'),
  );
}

function emptyState(): HTMLElement {
  return h('div', { class: 'empty-state card' },
    h('div', { class: 'empty-icon' }, '🎞️'),
    h('h2', {}, '还没有核查结果'),
    h('p', { class: 'muted' }, '先到录像导入页导入手机录像，或一键合成测试场景。'),
    h('button', { class: 'btn btn-primary', onclick: () => store.navigate('import') }, '去导入 / 合成'),
  );
}
