/**
 * AudioWorklet 引擎：加载爆炸检测与节拍跟踪两个 worklet，
 * 通过 MediaElementSource / AudioBufferSource 把音频送入处理图，
 * flush 后回收 worklet 计算出的事件。
 * 离线批量分析则直接调用 core 里的同构类（runAnalysis），二者算法一致。
 */
import type { BeatEvent, SoundEvent, VenueId } from '../core/types.ts';

export interface WorkletResults {
  explosions: { primary: SoundEvent[]; all: SoundEvent[] };
  beats: BeatEvent[];
}

export class WorkletEngine {
  private ctx: AudioContext | null = null;
  private explosionNode: AudioWorkletNode | null = null;
  private beatNode: AudioWorkletNode | null = null;

  /** 加载 worklet 模块（vite 构建后位于 /worklets/）。 */
  async init(sampleRate?: number): Promise<void> {
    this.ctx = new AudioContext(sampleRate ? { sampleRate } : undefined);
    const base = import.meta.env.BASE_URL;
    await this.ctx.audioWorklet.addModule(`${base}worklets/explosion-worklet.js`);
    await this.ctx.audioWorklet.addModule(`${base}worklets/beat-worklet.js`);
  }

  /**
   * 实时分析：接入一个媒体元素源，worklet 边播放边处理。
   * 返回停止函数，停止时 flush 并取回结果。
   */
  attachMedia(
    media: HTMLMediaElement,
    venue: VenueId,
    onProgress?: (pct: number) => void,
  ): () => Promise<WorkletResults> {
    if (!this.ctx) throw new Error('WorkletEngine 未初始化');
    const source = this.ctx.createMediaElementSource(media);
    this.explosionNode = new AudioWorkletNode(this.ctx, 'explosion-processor');
    this.beatNode = new AudioWorkletNode(this.ctx, 'beat-processor');
    this.explosionNode.port.postMessage({ type: 'config', venue });

    let blocks = 0;
    this.explosionNode.port.onmessage = (ev: MessageEvent) => {
      if (ev.data.type === 'progress') {
        blocks++;
        onProgress?.(Math.min(1, blocks / 500));
      }
    };

    source.connect(this.explosionNode);
    source.connect(this.beatNode);
    // 静音输出到分析节点即可，避免回放干扰现场
    const silentGain = this.ctx.createGain();
    silentGain.gain.value = 0;
    this.explosionNode.connect(silentGain).connect(this.ctx.destination);
    this.beatNode.connect(silentGain);

    return async () => {
      const explosions = await this.collect<{ primary: SoundEvent[]; all: SoundEvent[] }>(
        this.explosionNode!,
        'events',
      );
      const beats = await this.collect<{ beats: BeatEvent[] }>(this.beatNode!, 'beats');
      try {
        source.disconnect();
        this.explosionNode?.disconnect();
        this.beatNode?.disconnect();
        silentGain.disconnect();
      } catch {
        // 节点可能已断开，忽略
      }
      return { explosions, beats: beats.beats };
    };
  }

  private collect<T>(node: AudioWorkletNode, expected: string): Promise<T> {
    return new Promise((resolve) => {
      const handler = (ev: MessageEvent) => {
        if (ev.data.type === expected) {
          node.port.removeEventListener('message', handler);
          resolve(ev.data as T);
        }
      };
      node.port.addEventListener('message', handler);
      node.port.postMessage({ type: 'flush' });
    });
  }

  async close(): Promise<void> {
    if (this.ctx) {
      await this.ctx.close();
      this.ctx = null;
      this.explosionNode = null;
      this.beatNode = null;
    }
  }
}
