// AudioWorklet 入口：把爆炸声检测与节拍跟踪都放进 AudioWorklet 线程。
// 由 scripts/bundle-worklets.mjs 用 esbuild 打包成 public/worklets/show-worklet.js。
// 核心算法与 Node 基准、主线程回退完全共用 src/core 下的同一套类。

import { ExplosionDetector } from '../core/dsp/explosionDetector';
import { BeatTracker } from '../core/dsp/beatTracker';
import type { BeatGrid, SoundHit } from '../core/types';

// AudioWorkletGlobalScope 声明（避免依赖 DOM/WebWorker 冲突的内置类型）
declare class AudioWorkletProcessor {
  readonly port: {
    postMessage(msg: unknown): void;
    onmessage: ((ev: MessageEvent) => void) | null;
  };
}
declare function registerProcessor(name: string, ctor: unknown): void;
declare const currentFrame: number;

interface ShowOptions {
  sampleRate?: number;
  totalFrames?: number;
  gain?: number;
  sensitivity?: number;
}

function toMono(inputs: Float32Array[][]): Float32Array | null {
  const ch = inputs[0];
  if (!ch || ch.length === 0) return null;
  if (ch.length === 1) return ch[0];
  const a = ch[0];
  const b = ch[1];
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + (b ? b[i] : a[i])) * 0.5;
  return out;
}

/**
 * 组合处理器：同一块音频同时喂给爆炸检测器与节拍跟踪器；
 * 渲染结束时用爆炸时刻掩蔽节拍低频通量，再输出节拍网格。
 */
class ShowProcessor extends AudioWorkletProcessor {
  private detector: ExplosionDetector;
  private beats: BeatTracker;
  private totalFrames: number;
  private gain: number;
  private hits: SoundHit[] = [];
  private gridSent = false;

  constructor(options?: { processorOptions?: ShowOptions }) {
    super();
    const o: ShowOptions = options?.processorOptions ?? {};
    const sr = o.sampleRate ?? 44100;
    this.totalFrames = o.totalFrames ?? 0;
    this.gain = o.gain ?? 1;
    this.detector = new ExplosionDetector(sr, { sensitivity: o.sensitivity ?? 0.55, inputGain: 1 });
    this.beats = new BeatTracker(sr);
  }

  process(inputs: Float32Array[][]): boolean {
    const mono = toMono(inputs);
    if (mono && mono.length) {
      const g = this.gain;
      let block = mono;
      if (g !== 1) {
        block = new Float32Array(mono.length);
        for (let i = 0; i < mono.length; i++) block[i] = mono[i] * g;
      }
      const newHits = this.detector.process(block);
      if (newHits.length) {
        this.hits.push(...newHits);
        this.port.postMessage({ kind: 'hits', hits: newHits });
      }
      this.beats.process(block);
    }

    if (this.totalFrames && currentFrame + 128 >= this.totalFrames && !this.gridSent) {
      this.gridSent = true;
      this.beats.maskTimes(this.hits.map((h) => h.time));
      const grid: BeatGrid = this.beats.finalize(this.totalFrames / (this.detector.sampleRate || 44100));
      this.port.postMessage({ kind: 'grid', grid });
      this.port.postMessage({ kind: 'done', hitCount: this.hits.length });
    }
    return true;
  }
}

/** 独立爆炸声处理器（可用于实时麦克风监听） */
class ExplosionProcessor extends AudioWorkletProcessor {
  private detector: ExplosionDetector;
  constructor(options?: { processorOptions?: ShowOptions }) {
    super();
    const o = options?.processorOptions ?? {};
    this.detector = new ExplosionDetector(o.sampleRate ?? 44100, {
      sensitivity: o.sensitivity ?? 0.55,
      inputGain: o.gain ?? 1,
    });
  }
  process(inputs: Float32Array[][]): boolean {
    const mono = toMono(inputs);
    if (mono) {
      const hits = this.detector.process(mono);
      for (const h of hits) this.port.postMessage({ kind: 'hit', hit: h });
    }
    return true;
  }
}

/** 独立节拍处理器 */
class BeatProcessor extends AudioWorkletProcessor {
  private beats: BeatTracker;
  private totalFrames: number;
  private sent = false;
  private hitTimes: number[] = [];
  constructor(options?: { processorOptions?: ShowOptions }) {
    super();
    const o = options?.processorOptions ?? {};
    this.beats = new BeatTracker(o.sampleRate ?? 44100);
    this.totalFrames = o.totalFrames ?? 0;
    this.port.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as { kind?: string; times?: number[] };
      if (msg.kind === 'mask' && msg.times) this.hitTimes = msg.times;
    };
  }
  process(inputs: Float32Array[][]): boolean {
    const mono = toMono(inputs);
    if (mono) this.beats.process(mono);
    if (this.totalFrames && currentFrame + 128 >= this.totalFrames && !this.sent) {
      this.sent = true;
      this.beats.maskTimes(this.hitTimes);
      this.port.postMessage({ kind: 'grid', grid: this.beats.finalize() });
    }
    return true;
  }
}

registerProcessor('show-processor', ShowProcessor);
registerProcessor('explosion-detector', ExplosionProcessor);
registerProcessor('beat-tracker', BeatProcessor);
