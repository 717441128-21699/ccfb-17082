// 把合成场景的前若干秒渲染到 Canvas，并用 MediaRecorder 录成带音轨的 WebM，
// 这样“合成测试录像”也能走真实的文件导入 -> 解码 -> 抽帧 -> Worklet 分析链路。

import type { SynthScene } from '../core/synth/sceneSynth';

export function isRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof HTMLCanvasElement !== 'undefined' &&
    !!HTMLCanvasElement.prototype.captureStream
  );
}

export function recordSynthClip(
  scene: SynthScene,
  clipSec = 12,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!isRecordingSupported()) {
      reject(new Error('当前浏览器不支持 Canvas/MediaRecorder 合成录像'));
      return;
    }
    const W = 640;
    const H = 360;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d')!;

    const AC: typeof AudioContext = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ac = new AC();
    const buffer = ac.createBuffer(1, Math.floor(clipSec * scene.sampleRate), scene.sampleRate);
    buffer.copyToChannel(scene.audio.subarray(0, buffer.length) as Float32Array<ArrayBuffer>, 0);
    const src = ac.createBufferSource();
    src.buffer = buffer;
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    src.connect(ac.destination);

    const canvasStream = canvas.captureStream(30);
    const stream = new MediaStream([...canvasStream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2_500_000 });
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => {
      ac.close();
      resolve(new Blob(chunks, { type: 'video/webm' }));
    };
    rec.onerror = () => reject(new Error('录像失败'));

    const stars = Array.from({ length: 70 }, (_, i) => ({
      x: ((i * 73) % W) / W,
      y: ((i * 41) % Math.floor(H * 0.6)) / H,
      r: (i % 3) * 0.5 + 0.4,
    }));
    const buildings = Array.from({ length: 14 }, (_, i) => ({
      x: i / 14,
      w: 0.05 + ((i * 13) % 5) * 0.012,
      h: 0.18 + ((i * 29) % 10) * 0.018,
    }));

    const t0 = performance.now();
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      // 夜空
      const grad = ctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, '#070b1c');
      grad.addColorStop(0.7, '#101a3a');
      grad.addColorStop(1, '#1b2347');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      // 星星
      ctx.fillStyle = 'rgba(255,255,255,.7)';
      for (const s of stars) {
        ctx.globalAlpha = 0.3 + 0.5 * Math.abs(Math.sin(t * 1.5 + s.x * 20));
        ctx.beginPath();
        ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      // 开花闪光
      for (const sh of scene.truth.shots) {
        const dt = t - sh.bloomTime;
        if (dt < 0 || dt > 1.6) continue;
        const a = Math.exp(-dt / 0.5) * Math.min(1, dt < 0.03 ? dt / 0.03 : 1);
        // 全天空抬亮，保证缩到 192px 抽帧后 ROI 平均亮度仍越过检测门限
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(255,214,140,${0.16 * a})`;
        ctx.fillRect(0, 0, W, H * 0.78);
        ctx.globalCompositeOperation = 'source-over';
        const x = (0.3 + ((sh.id * 0.137 + 0.13) % 0.4)) * W;
        const y = (0.22 + ((sh.id * 0.071) % 0.2)) * H;
        const R = 60 + (sh.id % 4) * 18;
        const rg = ctx.createRadialGradient(x, y, 0, x, y, R * (1 + dt * 0.4));
        rg.addColorStop(0, `rgba(255,236,170,${0.9 * a})`);
        rg.addColorStop(0.35, `rgba(255,150,70,${0.5 * a})`);
        rg.addColorStop(1, 'rgba(255,120,40,0)');
        ctx.fillStyle = rg;
        ctx.beginPath();
        ctx.arc(x, y, R * (1 + dt * 0.4), 0, Math.PI * 2);
        ctx.fill();
      }
      // 楼群剪影
      ctx.fillStyle = '#05070f';
      for (const b of buildings) ctx.fillRect(b.x * W, H - b.h * H, b.w * W, b.h * H);
      // 时间码
      ctx.fillStyle = 'rgba(255,255,255,.85)';
      ctx.font = '16px ui-monospace, monospace';
      ctx.fillText(`SYNTH ${t.toFixed(2)}s`, 14, 24);
      onProgress?.(Math.min(1, t / clipSec));
      if (t < clipSec + 0.2) requestAnimationFrame(draw);
    };

    rec.start(200);
    void ac.resume();
    src.start();
    requestAnimationFrame(draw);
    setTimeout(() => {
      try {
        rec.stop();
      } catch {
        /* noop */
      }
    }, clipSec * 1000 + 300);
  });
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
