/**
 * 节拍跟踪 AudioWorklet 节点。
 * 逐渲染块推进 BeatTrackerStream，flush 时输出全部节拍。
 */
import { BeatTrackerStream } from '../core/beat-tracker';

class BeatProcessor extends AudioWorkletProcessor {
  private tracker: BeatTrackerStream;
  private blockCount = 0;

  constructor() {
    super();
    this.tracker = new BeatTrackerStream(sampleRate);
    this.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { type: string };
      if (msg.type === 'flush') {
        this.port.postMessage({ type: 'beats', beats: this.tracker.getBeats() });
      }
    };
  }

  process(inputs: Float32Array[][]): boolean {
    const input = inputs[0];
    if (input && input.length > 0) {
      const mono = new Float32Array(input[0].length);
      for (let ch = 0; ch < input.length; ch++) {
        for (let i = 0; i < mono.length; i++) mono[i] += input[ch][i] / input.length;
      }
      this.tracker.pushSamples(mono);
      if (++this.blockCount % 256 === 0) {
        this.port.postMessage({ type: 'progress', blocks: this.blockCount });
      }
    }
    return true;
  }
}

registerProcessor('beat-processor', BeatProcessor);
