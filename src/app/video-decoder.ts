/**
 * 视频解码：用 OfflineAudioContext 解码音轨得到单声道 PCM，
 * 用 video 元素 + canvas 逐帧抽取亮度（requestVideoFrameCallback 可用时
 * 按精确呈现帧回调，否则回退到 requestAnimationFrame 轮询 seek）。
 */

export interface DecodedVideo {
  channelData: Float32Array;
  sampleRate: number;
  durationSec: number;
  flashFrames: { timeSec: number; luminance: number }[];
}

/** 解码音轨为单声道 Float32 PCM。 */
export async function decodeAudio(file: File): Promise<{ channelData: Float32Array; sampleRate: number; durationSec: number }> {
  const arrayBuffer = await file.arrayBuffer();
  // OfflineAudioContext 仅用于解码，不实时播放
  const probe = new OfflineAudioContext(1, 1, 48000);
  const buffer = await probe.decodeAudioData(arrayBuffer.slice(0));
  const ch0 = buffer.getChannelData(0);
  let mono: Float32Array;
  if (buffer.numberOfChannels === 1) {
    mono = ch0;
  } else {
    mono = new Float32Array(ch0.length);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
    }
  }
  return { channelData: mono, sampleRate: buffer.sampleRate, durationSec: buffer.duration };
}

/** 逐帧抽取亮度序列。抽帧间隔约 33ms（30fps 等效）。 */
export async function extractLuminance(
  video: HTMLVideoElement,
  durationSec: number,
  onProgress?: (pct: number) => void,
): Promise<{ timeSec: number; luminance: number }[]> {
  const canvas = document.createElement('canvas');
  const targetW = 160;
  const targetH = 90;
  canvas.width = targetW;
  canvas.height = targetH;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('无法创建 canvas 2d 上下文');

  const frames: { timeSec: number; luminance: number }[] = [];
  const framePeriod = 1 / 30;
  const useRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;

  await new Promise<void>((resolve, reject) => {
    let cancelled = false;
    video.onerror = () => {
      cancelled = true;
      reject(new Error('视频解码失败'));
    };

    const sampleAt = (t: number) => {
      if (cancelled) return;
      if (t >= durationSec) {
        resolve();
        return;
      }
      const capture = () => {
        try {
          ctx!.drawImage(video, 0, 0, targetW, targetH);
          const img = ctx!.getImageData(0, 0, targetW, targetH).data;
          // 平均亮度（Rec.601 加权），下采样步长 4 提速
          let lum = 0;
          let n = 0;
          for (let i = 0; i < img.length; i += 16) {
            lum += 0.299 * img[i] + 0.587 * img[i + 1] + 0.114 * img[i + 2];
            n++;
          }
          frames.push({ timeSec: t, luminance: lum / n / 255 });
          onProgress?.(Math.min(1, t / durationSec));
          if (useRVFC) {
            seekTo(t + framePeriod);
          } else {
            setTimeout(() => seekTo(t + framePeriod), 0);
          }
        } catch {
          // seek 未就绪，重试
          setTimeout(() => sampleAt(t), 20);
        }
      };
      if (useRVFC) {
        (video as any).requestVideoFrameCallback(capture);
      } else {
        capture();
      }
    };

    const seekTo = (t: number) => {
      if (cancelled) return;
      video.currentTime = Math.min(t, durationSec - 0.001);
    };

    video.onseeked = () => {
      if (!cancelled) sampleAt(video.currentTime);
    };
    seekTo(0);
  });

  return frames.sort((a, b) => a.timeSec - b.timeSec);
}
