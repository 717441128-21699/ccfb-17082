import { store } from '../store.js';
import { fmtMs, fmtTime } from '../../core/physics.js';
import type { ChoreographyRow } from '../../core/types.js';
/** 点火修正页：编排表导入/编辑，反推每发点火时间的前移量。 */
export function renderIgnitionPage(root: HTMLElement): void {
  const s = store.getState();
  root.innerHTML = `
    <div class="card">
      <h2>编排表（点火时间 / 口径 / 飞行时间）</h2>
      <p class="muted">
        粘贴 CSV（列：shotId,点火秒,口径,飞行秒）或用下方按钮按检测到的开花时刻生成示例表。
        修正量 = −（开花相对节拍的偏差），新点火时间 = 原点火时间 + 修正量（飞行时间不变）。
      </p>
      <textarea id="choreoText" placeholder="S001,12.30,6寸,3.2&#10;S002,18.50,8寸,4.1"></textarea>
      <div class="pill-row">
        <button class="btn secondary" id="parseBtn">解析 CSV</button>
        <button class="btn secondary" id="genBtn">按检测结果生成示例编排表</button>
        <button class="btn" id="exportBtn" disabled>导出修正后 CSV</button>
      </div>
      <div class="muted" id="choreoMsg" style="margin-top:8px"></div>
    </div>

    <div class="card" id="resultCard" style="display:none">
      <h2>点火修正结果</h2>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>编号</th><th>原点火</th><th class="num">飞行(s)</th>
            <th>实际开花</th><th class="num">节拍偏差</th><th class="num">点火修正</th>
            <th>修正后点火</th>
          </tr></thead>
          <tbody id="correctionBody"></tbody>
        </table>
      </div>
    </div>
  `;

  const textarea = root.querySelector('#choreoText') as HTMLTextAreaElement;
  const msg = root.querySelector('#choreoMsg') as HTMLElement;
  const resultCard = root.querySelector('#resultCard') as HTMLElement;
  const body = root.querySelector('#correctionBody') as HTMLElement;
  const exportBtn = root.querySelector('#exportBtn') as HTMLButtonElement;

  const parseCsv = (): ChoreographyRow[] => {
    const rows: ChoreographyRow[] = [];
    for (const line of textarea.value.split('\n')) {
      const parts = line.trim().split(/[,\t]/).map((x) => x.trim());
      if (parts.length < 2 || parts[0].toLowerCase() === 'shotid') continue;
      const ignitionSec = parseFloat(parts[1]);
      if (!Number.isFinite(ignitionSec)) continue;
      const flightSec = parseFloat(parts[3]) || s.config.defaultFlightSec;
      rows.push({ shotId: parts[0], ignitionSec, caliber: parts[2] ?? '', flightSec });
    }
    return rows;
  };

  const refresh = () => {
    const rows = parseCsv();
    store.set({ choreography: rows });
    if (rows.length === 0) {
      msg.textContent = '未解析到有效行';
      resultCard.style.display = 'none';
      exportBtn.disabled = true;
      return;
    }
    msg.textContent = `已解析 ${rows.length} 行`;
    if (!s.result) {
      msg.textContent += '（尚未核查，先到导入页运行分析）';
      resultCard.style.display = 'none';
      return;
    }
    // 重新跑分析以应用编排表
    void store.runAnalysis().then(() => {
      const r = store.getState().result!;
      body.innerHTML = r.correctedChoreography
        .map((row, i) => {
          const orig = rows[i];
          const matchedShot = r.shots.find(
            (sh) => sh.plannedIgnitionSec !== undefined && Math.abs(sh.plannedIgnitionSec - orig.ignitionSec) < 1e-6,
          );
          const corr = matchedShot?.ignitionCorrectionSec;
          return `<tr>
            <td>${row.shotId}</td>
            <td class="num">${fmtTime(orig.ignitionSec)}</td>
            <td class="num">${row.flightSec.toFixed(1)}</td>
            <td class="num">${matchedShot ? fmtTime(matchedShot.flash.peakSec) : '—'}</td>
            <td class="num">${matchedShot?.beatOffsetSec !== undefined ? fmtMs(matchedShot.beatOffsetSec) : '—'}</td>
            <td class="num" style="color:${corr !== undefined && corr < 0 ? 'var(--warn)' : 'var(--good)'}">
              ${corr !== undefined ? fmtMs(corr) : '—'}
            </td>
            <td class="num">${fmtTime(row.ignitionSec)}</td>
          </tr>`;
        })
        .join('');
      resultCard.style.display = '';
      exportBtn.disabled = false;
    });
  };

  root.querySelector('#parseBtn')!.addEventListener('click', refresh);

  root.querySelector('#genBtn')!.addEventListener('click', () => {
    if (!s.result) {
      msg.textContent = '请先完成核查';
      return;
    }
    // 反推示例计划点火 = 实际开花 − 默认飞行时间
    const lines = s.result.shots.map((sh, i) => {
      const ignition = Math.max(0, sh.flash.peakSec - s.config.defaultFlightSec);
      return `S${String(i + 1).padStart(3, '0')},${ignition.toFixed(2)},默认,${s.config.defaultFlightSec}`;
    });
    textarea.value = lines.join('\n');
    refresh();
  });

  exportBtn.addEventListener('click', () => {
    const r = store.getState().result;
    if (!r) return;
    const csv = [
      'shotId,原点火秒,飞行秒,修正后点火秒,修正量毫秒',
      ...r.correctedChoreography.map((row, i) => {
        const orig = store.getState().choreography[i];
        const corr = orig ? row.ignitionSec - orig.ignitionSec : 0;
        return `${row.shotId},${orig?.ignitionSec.toFixed(3) ?? ''},${row.flightSec.toFixed(2)},${row.ignitionSec.toFixed(3)},${(corr * 1000).toFixed(0)}`;
      }),
    ].join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '点火修正表.csv';
    a.click();
    URL.revokeObjectURL(url);
  });
}
