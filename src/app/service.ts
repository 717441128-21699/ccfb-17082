// 应用层分析编排：优先走 AudioWorklet（OfflineAudioContext），
// 失败则回退到主线程直接调用同一套核心算法。

import { runAnalysisCore } from '../core/pipeline';
import { runShowWorklet, decodeAudioFile } from './audioWorkletRunner';
import { extractVideoLuma } from './videoFrames';
import type { LumaSample } from '../core/dsp/lightDetector';
import type { AnalysisOptions, AnalysisResult, ChoreographyRow, SceneTruth } from '../core/types';

export interface AnalyzeParams {
  channelData: Float32Array;
  sampleRate: number;
  luma: LumaSample[];
  durationSec: number;
  options: AnalysisOptions;
  choreography?: ChoreographyRow[];
  truth?: SceneTruth;
}

export interface AnalyzeOutcome {
  result: AnalysisResult;
  engine: 'audio-worklet' | 'main-thread-fallback';
  workletError?: string;
}

export async function analyzeMedia(params: AnalyzeParams): Promise<AnalyzeOutcome> {
  const { channelData, sampleRate, luma, durationSec, options, choreography, truth } = params;
  try {
    const w = await runShowWorklet(channelData, sampleRate);
    const result = runAnalysisCore({
      audio: channelData,
      sampleRate,
      durationSec,
      luma,
      options,
      choreography,
      truth,
      precomputedHits: w.hits,
      precomputedBeats: w.grid ?? undefined,
    });
    (result as AnalysisResult & { engine?: string }).engine = 'audio-worklet';
    return { result, engine: 'audio-worklet' };
  } catch (e) {
    const result = runAnalysisCore({
      audio: channelData,
      sampleRate,
      durationSec,
      luma,
      options,
      choreography,
      truth,
    });
    return {
      result,
      engine: 'main-thread-fallback',
      workletError: e instanceof Error ? e.message : String(e),
    };
  }
}

export interface ImportedMedia {
  audioBuffer: AudioBuffer;
  luma: LumaSample[];
  durationSec: number;
  width: number;
  height: number;
}

/** 导入录像：解码音轨 + 顺序抽帧取亮度 */
export async function importVideoFile(
  file: File,
  fps: number,
  onProgress: (ratio: number, stage: string) => void,
): Promise<ImportedMedia> {
  onProgress(0.02, '解码音轨');
  const audioBuffer = await decodeAudioFile(file);
  onProgress(0.12, '读取画面帧');
  const video = await extractVideoLuma(file, {
    fps,
    onProgress: (r, s) => onProgress(0.12 + r * 0.86, s),
  });
  return {
    audioBuffer,
    luma: video.luma,
    durationSec: Math.max(video.durationSec, audioBuffer.duration),
    width: video.width,
    height: video.height,
  };
}

export function bufferToMono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice();
  const a = buffer.getChannelData(0);
  const b = buffer.getChannelData(1);
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (a[i] + b[i]) * 0.5;
  return out;
}
