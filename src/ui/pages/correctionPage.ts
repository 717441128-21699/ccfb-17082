// 点火修正页：编排表可编辑，实时关联实测开花与节拍偏差，
// 给出每发点火修正量与建议新点火时刻，支持整体平移与导出。

import { h, clear, badge, fmtMs } from '../dom';
import { store } from '../store';
import { CALIBERS } from '../../core/venues';
import { beatStats } from '../../core/pipeline';
import { correctionsCsv, choreographyJson } from '../../core/correction';
import type { ChoreographyRow } from '../../core/types';

export function renderCorrectionPage(root: HTMLElement): void {
  clear(root);
  const { result, choreography: rows } = store.state;
  if (!result || !rows.length) {
    root.append(emptyState());
    return;
  }

  const stats = beatStats(result.reports);
  const rowReport = new Map<number, (typeof result.reports)[number]>();
  for (const r of result.reports) if (r.choreography) rowReport.set(r.choreography.id, r);

  // ---- 顶部操作 ----
  const exportCsvBtn = h('button', { class: 'btn btn-primary' }, '导出核查 CSV');
  exportCsvBtn.addEventListener('click', () => download('firework-corrections.csv', correctionsCsv(result), 'text/csv;charset=utf-8'));
  const exportJsonBtn = h('button', { class: 'btn' }, '导出编排 JSON');
  exportJsonBtn.addEventListener('click', () => download('choreography-suggested.json', choreographyJson(rows), 'application/json'));
  const copyBtn = h('button', { class: 'btn' }, '复制 CSV');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(correctionsCsv(result));
      copyBtn.textContent = '已复制 ✓';
      setTimeout(() => (copyBtn.textContent = '复制 CSV'), 1500);
    } catch {
      copyBtn.textContent = '复制失败';
    }
  });

  const avgBtn = h('button', { class: 'btn btn-small btn-primary' }, `按平均偏差修正 (${fmtMs(-stats.meanMs)})`);
  avgBtn.addEventListener('click', () => {
    store.shiftAllCorrections(-stats.meanMs);
    renderCorrectionPage(root);
  });

  const shiftBox = h('div', { class: 'shift-box' },
    h('span', { class: 'muted small' }, '整体移动计划点火：'),
    ...[-100, -50, -25].map((ms) => shiftBtn(`提前 ${-ms}ms`, ms)),
    ...[25, 50, 100].map((ms) => shiftBtn(`延后 ${ms}ms`, ms)),
    avgBtn,
  );

  function shiftBtn(label: string, deltaMs: number): HTMLButtonElement {
    const b = h('button', { class: 'btn btn-small' }, label);
    b.addEventListener('click', () => {
      store.shiftAllCorrections(deltaMs);
      renderCorrectionPage(root);
    });
    return b;
  }

  const headCard = h('section', { class: 'card correction-head' },
    h('div', {},
      h('h2', {}, '点火时刻修正'),
      h('p', { class: 'muted' },
        '偏差 δ = 看到开花时刻 − 配乐节拍（正=落后）。要让下一朵花回到拍上，点火时刻修正 Δ = −δ：δ=+80ms（开花晚了）就把点火提前 80ms。建议新点火 = 原计划点火 + Δ。',
      ),
    ),
    h('div', { class: 'row gap wrap' }, exportCsvBtn, exportJsonBtn, copyBtn),
    shiftBox,
  );

  // ---- 可编辑表格 ----
  const tbody = h('tbody');
  for (const row of rows) {
    const rep = rowReport.get(row.id);
    const tr = h('tr', { dataset: { id: String(row.id) } });

    const idxTd = h('td', { class: 'mono' }, String(row.id));

    const caliberSelect = h('select', { class: 'input-small' },
      ...CALIBERS.map((c) => h('option', { value: c.id, selected: c.id === row.caliberId }, c.label)),
    ) as HTMLSelectElement;
    caliberSelect.addEventListener('change', () => {
      const flight = CALIBERS.find((c) => c.id === caliberSelect.value)?.flightSec ?? row.flightSec;
      commit({ ...row, caliberId: caliberSelect.value, flightSec: flight });
      flightInput.value = flight.toFixed(2);
      refreshComputed(row.id);
    });

    const flightInput = h('input', { type: 'number', step: '0.1', min: '0.5', max: '6', value: row.flightSec.toFixed(2), class: 'input-small' }) as HTMLInputElement;
    flightInput.addEventListener('change', () => {
      commit({ ...row, flightSec: Number(flightInput.value) || row.flightSec });
      refreshComputed(row.id);
    });

    const ignInput = h('input', { type: 'number', step: '0.01', min: '0', value: row.plannedIgnition.toFixed(3), class: 'input-small' }) as HTMLInputElement;
    ignInput.addEventListener('change', () => {
      commit({ ...row, plannedIgnition: Math.max(0, Number(ignInput.value) || 0) });
      refreshComputed(row.id);
    });

    tr.append(
      idxTd,
      h('td', {}, caliberSelect),
      h('td', {}, flightInput),
      h('td', {}, ignInput),
      h('td', { class: 'mono c-expected' }, (row.plannedIgnition + row.flightSec).toFixed(2)),
      h('td', { class: 'mono c-bloom' }, rep?.light ? rep.light.time.toFixed(3) : '—'),
      h('td', { class: `mono strong c-offset ${tone(rep?.beatOffsetMs)}` }, rep ? fmtMs(rep.beatOffsetMs) : '—'),
      h('td', { class: `mono strong c-corr ${tone(rep?.correctionMs)}` }, rep ? fmtMs(rep.correctionMs) : '—'),
      h('td', { class: 'mono c-newign' }, rep?.suggestedIgnition !== undefined ? rep.suggestedIgnition.toFixed(3) : '—'),
      h('td', {}, rep ? badge(rep.status === 'matched' ? '声光配对' : rep.status === 'light-only' ? '仅画面' : '仅声音', rep.status === 'matched' ? 'good' : 'warn') : '—'),
    );
    tbody.append(tr);
  }

  function commit(updated: ChoreographyRow): void {
    store.updateRow(updated);
  }

  function refreshComputed(id: number): void {
    const r = store.state.result?.reports.find((x) => x.choreography?.id === id);
    const tr = tbody.querySelector(`tr[data-id="${id}"]`);
    if (!tr || !r?.choreography) return;
    const q = (sel: string) => tr.querySelector(sel);
    q('.c-expected')!.textContent = (r.choreography.plannedIgnition + r.choreography.flightSec).toFixed(2);
    q('.c-bloom')!.textContent = r.light ? r.light.time.toFixed(3) : '—';
    const off = q('.c-offset') as HTMLElement;
    off.textContent = fmtMs(r.beatOffsetMs);
    off.className = `mono strong c-offset ${tone(r.beatOffsetMs)}`;
    const corr = q('.c-corr') as HTMLElement;
    corr.textContent = fmtMs(r.correctionMs);
    corr.className = `mono strong c-corr ${tone(r.correctionMs)}`;
    q('.c-newign')!.textContent = r.suggestedIgnition !== undefined ? r.suggestedIgnition.toFixed(3) : '—';
  }

  const tableCard = h('section', { class: 'card' },
    h('h2', {}, '编排表与逐发建议'),
    h('div', { class: 'table-wrap' },
      h('table', { class: 'data-table correction-table' },
        h('thead', {}, h('tr', {},
          h('th', {}, '#'), h('th', {}, '口径'), h('th', {}, '飞行 s'), h('th', {}, '计划点火 s'),
          h('th', {}, '期望开花'), h('th', {}, '实测开花'), h('th', {}, '节拍偏差'), h('th', {}, '修正 Δ'), h('th', {}, '建议新点火'), h('th', {}, '状态'),
        )),
        tbody,
      ),
    ),
    h('p', { class: 'muted small' }, '提示：口径决定升空飞行时间；修改口径会自动带出典型飞行秒数，也可按实际产品手册覆盖。所有计算在本机完成。'),
  );

  root.append(headCard, tableCard);
}

function tone(v: number | undefined): string {
  if (v === undefined) return 'muted-text';
  const a = Math.abs(v);
  return a <= 25 ? 'good-text' : a <= 80 ? 'warn-text' : 'bad-text';
}

function download(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function emptyState(): HTMLElement {
  return h('div', { class: 'empty-state card' },
    h('div', { class: 'empty-icon' }, '🎇'),
    h('h2', {}, '还没有编排表'),
    h('p', { class: 'muted' }, '先完成一次核查，系统会按“目标节拍 − 飞行时间”自动生成编排行。'),
    h('button', { class: 'btn btn-primary', onclick: () => store.navigate('import') }, '去导入 / 合成'),
  );
}
