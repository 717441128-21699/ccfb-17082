import type { AnalysisConfig, ChoreographyRow, SyntheticClip, SyntheticClipOptions, VenueId } from '../core/types.ts';
import { runAnalysis } from '../core/analysis.ts';
import { generateSyntheticClip } from '../core/synth.ts';

/** 全局应用状态，简单的发布订阅 store。 */
export interface AppState {
  videoName: string | null;
  videoDurationSec: number;
  sampleRate: number;
  channelData: Float32Array | null;
  flashFrames: { timeSec: number; luminance: number }[];
  config: AnalysisConfig;
  choreography: ChoreographyRow[];
  result: import('../core/analysis.ts').AnalysisResult | null;
  analyzing: boolean;
  /** 数据来源：真实视频或合成测试。 */
  source: 'video' | 'synthetic' | null;
  syntheticTruth?: SyntheticClip['truth'];
}

type Listener = (state: AppState) => void;

const initialState: AppState = {
  videoName: null,
  videoDurationSec: 0,
  sampleRate: 48000,
  channelData: null,
  flashFrames: [],
  config: {
    venue: 'street',
    temperatureC: 15,
    defaultFlightSec: 3,
  },
  choreography: [],
  result: null,
  analyzing: false,
  source: null,
};

class Store {
  private state: AppState = { ...initialState };
  private listeners = new Set<Listener>();

  getState(): AppState {
    return this.state;
  }

  set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l(this.state));
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async runAnalysis(): Promise<void> {
    if (!this.state.channelData) return;
    this.set({ analyzing: true });
    // 让 UI 有机会渲染“分析中”状态
    await new Promise((r) => setTimeout(r, 30));
    const t0 = performance.now();
    const result = runAnalysis(
      this.state.channelData,
      this.state.sampleRate,
      this.state.flashFrames,
      this.state.config,
      this.state.choreography,
    );
    const elapsed = performance.now() - t0;
    this.set({ result, analyzing: false });
    // eslint-disable-next-line no-console
    console.log(`核查完成，耗时 ${elapsed.toFixed(0)}ms`);
  }

  loadSynthetic(options: SyntheticClipOptions): void {
    const clip = generateSyntheticClip(options);
    this.set({
      videoName: `合成测试·${clip.truth.venue}·${options.temperatureC}℃·${options.distanceM}m`,
      videoDurationSec: clip.durationSec,
      sampleRate: clip.sampleRate,
      channelData: clip.channelData,
      flashFrames: clip.flashFrames,
      source: 'synthetic',
      syntheticTruth: clip.truth,
      result: null,
      config: {
        venue: options.venue,
        temperatureC: options.temperatureC,
        defaultFlightSec: 3,
      },
    });
  }

  reset(): void {
    this.state = { ...initialState };
    this.listeners.forEach((l) => l(this.state));
  }
}

export const store = new Store();

export function venueOptions(): { id: VenueId; label: string }[] {
  return [
    { id: 'open', label: '开阔场地' },
    { id: 'street', label: '楼群街道（两排楼）' },
    { id: 'valley', label: '山谷' },
  ];
}
