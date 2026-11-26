// 声光时间线 Canvas 渲染：上方亮度曲线与开花标记，下方音频包络、
// 主声/回声标记和节拍刻度；支持悬停显示时刻。

import type { AnalysisResult } from '../core/types';

const C = {
  bg: '#0d1430',
  grid: 'rgba(148,163,255,.12)',
  luma: '#f5c451',
  lumaFill: 'rgba(245,196,81,.18)',
  env: '#5b8cff',
  envFill: 'rgba(91,140,255,.22)',
  beat: 'rgba(120,220,170,.55)',
  light: '#ffd166',
  sound: '#5ec8ff',
  echo: '#8a93b8',
  pair: 'rgba(255,255,255,.25)',
  text: '#aab4d8',
};

export interface TimelineHandle {
  destroy(): void;
}

export function renderTimeline(
  canvas: HTMLCanvasElement,
  result: AnalysisResult,
  onHover?: (time: number | null, mx: number, my: number) => void,
): TimelineHandle {
  const ctx = canvas.getContext('2d')!;
  let cssW = 800;
  let cssH = 260;

  const fit = () => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    cssW = Math.max(320, rect.width);
    cssH = Math.max(220, rect.height || 260);
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };

  const D = result.durationSec;
  const x = (t: number) => 46 + (t / D) * (cssW - 58);
  const tAtX = (mx: number) => ((mx - 46) / (cssW - 58)) * D;

  function draw(): void {
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, cssW, cssH);
    const topH = cssH * 0.46;
    const bot0 = cssH * 0.56;
    const botH = cssH * 0.34;

    // 网格 + 时间刻度
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.text;
    ctx.font = '10px ui-monospace, monospace';
    ctx.lineWidth = 1;
    const tickStep = D > 150 ? 20 : D > 60 ? 10 : 5;
    for (let t = 0; t <= D; t += tickStep) {
      const xx = x(t);
      ctx.beginPath();
      ctx.moveTo(xx, 8);
      ctx.lineTo(xx, cssH - 18);
      ctx.stroke();
      ctx.fillText(`${t}s`, xx + 3, cssH - 5);
    }

    // 节拍竖线（贯穿）
    if (result.beatGrid) {
      ctx.strokeStyle = C.beat;
      ctx.lineWidth = 1;
      for (const b of result.beatGrid.beats) {
        ctx.beginPath();
        ctx.moveTo(x(b), 8);
        ctx.lineTo(x(b), cssH - 18);
        ctx.stroke();
      }
    }

    // ---- 亮度曲线 ----
    ctx.strokeStyle = C.luma;
    ctx.fillStyle = C.lumaFill;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let first = true;
    for (const s of result.lumaSeries) {
      const xx = x(s.t);
      const yy = topH - s.v * topH * 1.6 + 6;
      if (first) {
        ctx.moveTo(xx, yy);
        first = false;
      } else ctx.lineTo(xx, yy);
    }
    ctx.save();
    ctx.lineTo(x(D), topH + 6);
    ctx.lineTo(x(0), topH + 6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.fillText('画面亮度', 8, 16);

    // 开花标记
    for (const l of result.lightEvents) {
      const xx = x(l.time);
      ctx.fillStyle = C.light;
      ctx.beginPath();
      ctx.moveTo(xx, 4);
      ctx.lineTo(xx - 4, 12);
      ctx.lineTo(xx + 4, 12);
      ctx.closePath();
      ctx.fill();
    }

    // ---- 音频包络 ----
    ctx.fillStyle = C.envFill;
    ctx.beginPath();
    ctx.moveTo(x(0), bot0 + botH);
    for (const e of result.envelope) {
      const xx = x(e.t);
      const yy = bot0 + botH - Math.min(1, e.all * 2.2) * botH;
      ctx.lineTo(xx, yy);
    }
    ctx.lineTo(x(D), bot0 + botH);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = C.env;
    ctx.lineWidth = 1;
    ctx.beginPath();
    result.envelope.forEach((e, i) => {
      const xx = x(e.t);
      const yy = bot0 + botH - Math.min(1, e.all * 2.2) * botH;
      if (i === 0) ctx.moveTo(xx, yy);
      else ctx.lineTo(xx, yy);
    });
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.fillText('声音包络', 8, bot0 + 12);

    // 配对连线
    ctx.strokeStyle = C.pair;
    ctx.setLineDash([3, 3]);
    for (const p of result.pairs) {
      ctx.beginPath();
      ctx.moveTo(x(p.lightTime), topH + 2);
      ctx.lineTo(x(p.soundTime), bot0 - 4);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // 主声 / 回声标记
    for (const s of result.soundShots) {
      const xx = x(s.primary.time);
      ctx.fillStyle = C.sound;
      ctx.beginPath();
      ctx.arc(xx, bot0 - 8, 4, 0, Math.PI * 2);
      ctx.fill();
      for (const e of s.echoes) {
        const ex = x(e.time);
        ctx.fillStyle = C.echo;
        ctx.beginPath();
        ctx.arc(ex, bot0 - 8, 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  const onMove = (ev: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const t = tAtX(mx);
    if (t < 0 || t > D) onHover?.(null, mx, ev.clientY - rect.top);
    else onHover?.(t, mx, ev.clientY - rect.top);
  };
  const onLeave = () => onHover?.(null, 0, 0);
  canvas.addEventListener('mousemove', onMove);
  canvas.addEventListener('mouseleave', onLeave);

  const ro = new ResizeObserver(fit);
  ro.observe(canvas);
  fit();

  return {
    destroy() {
      ro.disconnect();
      canvas.removeEventListener('mousemove', onMove);
      canvas.removeEventListener('mouseleave', onLeave);
    },
  };
}
