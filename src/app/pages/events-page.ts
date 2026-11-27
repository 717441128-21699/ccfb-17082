import { store } from '../store.js';
import { fmtMs, fmtTime } from '../../core/physics.js';
import type { AnalysisResult } from '../../core/analysis.js';

/** 声光事件页：闪光、爆炸（含回声）、配对与测距结果。 */
export function renderEventsPage(root: HTMLElement): void {
  const s = store.getState();
  if (!s.result) {
    root.innerHTML = `<div class="empty">请先在「录像导入」页加载录像并完成核查</div>`;
    return;
  }
  const r: AnalysisResult = s.result;
  const duration = s.videoDurationSec || 1;

  const pos = (t: number) => `${(t / duration) * 100}%`;
  const flashMarks = r.flashes.map((f) => `<div class="mark flash" style="left:${pos(f.peakSec)}" title="闪光 ${fmtTime(f.peakSec)}"></div>`).join('');
  const soundMarks = r.sounds.map((e) => `<div class="mark sound" style="left:${pos(e.peakSec)}" title="爆炸 ${fmtTime(e.peakSec)}"></div>`).join('');

  root.innerHTML = `
    <div class="card">
      <h2>声光事件总览</h2>
      <div class="stat-grid">
        <div class="stat"><div class="label">闪光（开花）</div><div class="value">${r.stats.flashCount}</div></div>
        <div class="stat"><div class="label">爆炸声（主事件）</div><div class="value">${r.sounds.length}</div></div>
        <div class="stat"><div class="label">被抑制回声</div><div class="value warn">${r.stats.echoSuppressed}</div></div>
        <div class="stat"><div class="label">成功配对</div><div class="value good">${r.stats.pairedCount}</div></div>
        <div class="stat"><div class="label">平均测距</div><div class="value">${r.stats.meanDistanceM ?? '—'}<span style="font-size:13px"> m</span></div></div>
        <div class="stat"><div class="label">当前声速</div><div class="value">${Math.round(331.3 + 0.606 * s.config.temperatureC)}<span style="font-size:13px"> m/s</span></div></div>
      </div>
      <div class="section-title">时间轴（橙=开花闪光，蓝=爆炸声，绿=节拍）</div>
      <div class="timeline">${flashMarks}${soundMarks}${r.beats.map((b) => `<div class="mark beat" style="left:${pos(b.timeSec)}"></div>`).join('')}</div>
      <div class="legend"><span class="l-flash">开花闪光</span><span class="l-sound">爆炸声</span><span class="l-beat">配乐节拍</span></div>
    </div>

    <div class="card">
      <h2>逐发配对与光声测距</h2>
      <p class="muted">距离 = 声速(${s.config.temperatureC}℃) × (听到时刻 − 看到时刻)；未配对的开花通常因回声掩蔽或漏检。</p>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>#</th><th>看到开花</th><th>听到爆炸</th><th class="num">光声延迟</th>
            <th class="num">测距 (m)</th><th>状态</th>
          </tr></thead>
          <tbody>
            ${r.shots
              .map((sh) => `<tr>
                <td>${sh.index}</td>
                <td class="num">${fmtTime(sh.flash.peakSec)}</td>
                <td class="num">${sh.sound ? fmtTime(sh.sound.peakSec) : '—'}</td>
                <td class="num">${sh.lightSoundDelaySec !== undefined ? fmtMs(sh.lightSoundDelaySec) : '—'}</td>
                <td class="num">${sh.distanceM !== undefined ? sh.distanceM.toFixed(1) : '—'}</td>
                <td>${sh.distanceM !== undefined ? '<span class="badge good">已测距</span>' : '<span class="badge warn">未配对</span>'}</td>
              </tr>`)
              .join('')}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h2>回声抑制明细（不计入独立发数）</h2>
      <div class="table-wrap">
        <table>
          <thead><tr><th>回声时刻</th><th>归属主爆</th><th class="num">持续 (ms)</th><th class="num">置信度</th><th>类型</th></tr></thead>
          <tbody>
            ${
              r.echoes.length === 0
                ? '<tr><td colspan="5" class="muted">本片段未检出需抑制的回声</td></tr>'
                : r.echoes
                    .map(
                      (e) => `<tr>
                        <td class="num">${fmtTime(e.timeSec)}</td>
                        <td class="num">${fmtTime(e.echoOf)}</td>
                        <td class="num">${(e.durationSec * 1000).toFixed(0)}</td>
                        <td class="num">${e.score.toFixed(2)}</td>
                        <td><span class="badge echo">回声</span></td>
                      </tr>`,
                    )
                    .join('')
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}
