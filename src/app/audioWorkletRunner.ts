// 通过 OfflineAudioContext 让 AudioWorklet 跑爆炸声检测与节拍跟踪。
// 离线渲染比实时快得多，满足 4 分钟音频快速核查；不可用时由调用方回退到主线程核心。

import type { BeatGrid, SoundHit } from '../core/types';

export interface WorkletAudioResult {
  hits: SoundHit[];
  grid: BeatGrid | null;
  via: 'audio-worklet';
}

function workletUrl(): string {
  const base = import.meta.env.BASE_URL || './';
  return `${base}worklets/show-worklet.js`;
}

export async function runShowWorklet(
  channelData: Float32Array,
  sampleRate: number,
): Promise<WorkletAudioResult> {
  const length = channelData.length;
  const Ctor: typeof OfflineAudioContext =
    window.OfflineAudioContext ??
    (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Ctor(1, length, sampleRate);

  let maxAbs = 1e-6;
  for (let i = 0; i < channelData.length; i++) {
    const a = channelData[i] < 0 ? -channelData[i] : channelData[i];
    if (a > maxAbs) maxAbs = a;
  }
  const gain = Math.min(6, Math.max(0.6, 0.95 / maxAbs));

  await ctx.audioWorklet.addModule(workletUrl());
  const buffer = ctx.createBuffer(1, length, sampleRate);
  buffer.copyToChannel(channelData as Float32Array<ArrayBuffer>, 0);
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const node = new AudioWorkletNode(ctx, 'show-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    processorOptions: { sampleRate, totalFrames: length, gain, sensitivity: 0.55 },
  });

  const hits: SoundHit[] = [];
  let grid: BeatGrid | null = null;
  const settled = new Promise<void>((resolve) => {
    node.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as
        | { kind: 'hits'; hits: SoundHit[] }
        | { kind: 'grid'; grid: BeatGrid }
        | { kind: 'done' };
      if (msg.kind === 'hits') hits.push(...msg.hits);
      if (msg.kind === 'grid') grid = msg.grid;
      if (msg.kind === 'done') resolve();
    };
  });

  src.connect(node);
  node.connect(ctx.destination);
  src.start(0);
  await ctx.startRendering();
  // 给 port 消息一个微任务/任务冲刷窗口
  await Promise.race([settled, new Promise((r) => setTimeout(r, 300))]);
  if (!grid) {
    // 某些浏览器离线渲染结束前最后一块未触发收尾，等待消息
    await new Promise((r) => setTimeout(r, 200));
  }
  return { hits, grid, via: 'audio-worklet' };
}

/** 解码用户选择的视频/音频文件 */
export async function decodeAudioFile(file: Blob): Promise<AudioBuffer> {
  const ab = await file.arrayBuffer();
  const tmp = new AudioContext();
  try {
    return await tmp.decodeAudioData(ab.slice(0));
  } finally {
    void tmp.close();
  }
}
