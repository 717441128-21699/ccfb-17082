/**
 * 爆炸声检测 AudioWorklet 节点。
 * 每渲染块（通常 128 样本）推进一次 ExplosionDetectorStream，
 * 以节流消息上报进度；节点结束（flush）时输出回声抑制后的事件。
 */
import { ExplosionDetectorStream } from '../core/explosion-detector';
import type { VenueId } from '../core/types';

class ExplosionProcessor extends AudioWorkletProcessor {
  private detector: ExplosionDetectorStream;
  private blockCount = 0;

  constructor() {
    super();
    this.detector = new ExplosionDetectorStream(sampleRate, 'street');
    this.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { type: string; venue?: VenueId; flush?: boolean };
      if (msg.type === 'config' && msg.venue) {
        this.detector = new ExplosionDetectorStream(sampleRate, msg.venue);
        this.blockCount = 0;
      }
      if (msg.type === 'flush') {
        const result = this.detector.getEvents();
        this.port.postMessage({ type: 'events', primary: result.primary, all: result.all });
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (input && input.length > 0) {
      // 多声道先简单下混
      const mono = new Float32Array(input[0].length);
      for (let ch = 0; ch < input.length; ch++) {
        for (let i = 0; i < mono.length; i++) mono[i] += input[ch][i] / input.length;
      }
      this.detector.pushSamples(mono);
      if (++this.blockCount % 256 === 0) {
        this.port.postMessage({ type: 'progress', blocks: this.blockCount });
      }
    }
    return true;
  }
}

registerProcessor('explosion-processor', ExplosionProcessor);
