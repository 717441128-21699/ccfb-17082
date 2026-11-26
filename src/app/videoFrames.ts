// 从导入的录像中按固定帧率抽帧，计算天空 ROI 亮度序列。
// 用顺序 seek 换取帧精确；短视频足够快，长视频给出进度。

import { extractLuma, type LumaSample } from '../core/dsp/lightDetector';

export interface ExtractedVideo {
  luma: LumaSample[];
  durationSec: number;
  width: number;
  height: number;
}

export function extractVideoLuma(
  file: Blob,
  opts: { fps?: number; onProgress?: (ratio: number, stage: string) => void } = {},
): Promise<ExtractedVideo> {
  const fps = opts.fps ?? 15;
  const onProgress = opts.onProgress;
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';

    const canvas = document.createElement('canvas');
    const W = 192;
    let Wc = W;
    let Hc = 108;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      URL.revokeObjectURL(url);
      reject(new Error('无法创建 2D 画布上下文'));
      return;
    }

    const cleanup = () => {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      video.load();
    };

    video.addEventListener('error', () => {
      cleanup();
      reject(new Error('视频解码失败，请尝试 MP4(H.264) 或 WebM 格式'));
    });

    video.addEventListener('loadedmetadata', async () => {
      try {
        // MediaRecorder 产出的 WebM 常给出 Infinity 时长，用一次“跳到极大值”探测真实时长
        if (!Number.isFinite(video.duration) || video.duration <= 0) {
          await new Promise<void>((res) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              video.removeEventListener('seeked', onSeeked);
              clearTimeout(timer);
              res();
            };
            const onSeeked = () => finish();
            video.addEventListener('seeked', onSeeked);
            video.currentTime = 1e101;
            const timer = setTimeout(finish, 2000);
          });
        }
        const duration = Number.isFinite(video.duration) ? video.duration : 0;
        if (!(duration > 0.1)) {
          cleanup();
          reject(new Error('无法读取视频时长，请改用 MP4(H.264) 或另存后重试'));
          return;
        }
        Wc = W;
        Hc = Math.max(2, Math.round((W * video.videoHeight) / Math.max(1, video.videoWidth)));
        canvas.width = Wc;
        canvas.height = Hc;
        const out: LumaSample[] = [];
        const step = 1 / fps;
        let t = 0;

        const seekOnce = (time: number) =>
          new Promise<void>((res) => {
            // 已经在目标时刻（例如首帧 0）时不会再触发 seeked
            if (Math.abs(video.currentTime - time) < 0.02) return res();
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              video.removeEventListener('seeked', onSeeked);
              clearTimeout(timer);
              res();
            };
            const onSeeked = () => finish();
            video.addEventListener('seeked', onSeeked);
            video.currentTime = Math.min(time, Math.max(0, duration - 0.01));
            // 兜底：个别编码 seek 不发事件，超时后用当前帧继续而不是整体失败
            const timer = setTimeout(finish, 1500);
          });

        // 先停在第 0 帧
        video.pause();
        let guard = 0;
        while (t < duration - 0.02 && guard < duration * fps + 5) {
          await seekOnce(t);
          ctx.drawImage(video, 0, 0, Wc, Hc);
          const img = ctx.getImageData(0, 0, Wc, Hc).data;
          const l = extractLuma(img, Wc, Hc);
          out.push({ t: video.currentTime, v: l.v, x: l.x, y: l.y, ratio: l.ratio });
          t += step;
          guard++;
          if (onProgress && guard % 4 === 0) {
            onProgress(Math.min(1, t / duration), '抽帧读取画面亮度');
          }
        }
        onProgress?.(1, '画面亮度提取完成');
        cleanup();
        resolve({ luma: out, durationSec: duration, width: video.videoWidth, height: video.videoHeight });
      } catch (e) {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}
