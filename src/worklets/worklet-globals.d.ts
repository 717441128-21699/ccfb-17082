/// <reference types="vite/client" />

/** AudioWorklet 全局作用域声明（worklet 文件由 esbuild 单独打包，不在 DOM lib 内）。 */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
}
declare function registerProcessor(name: string, processorCtor: typeof AudioWorkletProcessor): void;
declare const sampleRate: number;
declare const currentFrame: number;
declare const currentTime: number;
