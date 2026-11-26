// 极简全局状态 + 发布订阅。

import type { AnalysisResult, BenchmarkMetrics, ChoreographyRow } from '../core/types';
import { buildDefaultChoreography, enrichReports, withTemperature } from '../core/correction';

export type TabId = 'import' | 'events' | 'beats' | 'correction';

export interface StoreState {
  tab: TabId;
  result: AnalysisResult | null;
  engine: 'audio-worklet' | 'main-thread-fallback' | null;
  workletError?: string;
  choreography: ChoreographyRow[];
  tempC: number;
  busy: boolean;
  progress: number;
  stage: string;
  fileName: string;
  videoUrl?: string;
  benchmark: BenchmarkMetrics | null;
}

type Listener = (s: StoreState) => void;

class Store {
  state: StoreState = {
    tab: 'import',
    result: null,
    engine: null,
    choreography: [],
    tempC: 20,
    busy: false,
    progress: 0,
    stage: '',
    fileName: '',
    benchmark: null,
  };
  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn(this.state);
  }
  set(patch: Partial<StoreState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }
  navigate(tab: TabId): void {
    this.set({ tab });
  }
  setBusy(busy: boolean, stage = '', progress = busy ? this.state.progress : 0): void {
    this.set({ busy, stage, progress });
  }
  setProgress(progress: number, stage?: string): void {
    this.set({ progress, ...(stage ? { stage } : {}) });
  }
  setResult(result: AnalysisResult, engine: StoreState['engine'], workletError?: string): void {
    const tempC = result.options.temperatureC;
    const rows = buildDefaultChoreography(result.reports);
    const reports = enrichReports(result.reports, rows);
    this.set({
      result: { ...result, reports },
      engine,
      workletError,
      tempC,
      choreography: rows,
      busy: false,
      progress: 1,
      stage: '核查完成',
    });
  }
  setTemp(tempC: number): void {
    if (!this.state.result) {
      this.set({ tempC });
      return;
    }
    const rescaled = withTemperature(this.state.result, tempC);
    const reports = enrichReports(rescaled.reports, this.state.choreography);
    this.set({ tempC, result: { ...rescaled, reports } });
  }
  updateRow(row: ChoreographyRow): void {
    const rows = this.state.choreography.map((r) => (r.id === row.id ? row : r));
    if (this.state.result) {
      const reports = enrichReports(this.state.result.reports, rows);
      this.set({ choreography: rows, result: { ...this.state.result, reports } });
    } else {
      this.set({ choreography: rows });
    }
  }
  shiftAllCorrections(deltaMs: number): void {
    const rows = this.state.choreography.map((r) => ({
      ...r,
      plannedIgnition: Math.max(0, r.plannedIgnition + deltaMs / 1000),
    }));
    if (this.state.result) {
      const reports = enrichReports(this.state.result.reports, rows);
      this.set({ choreography: rows, result: { ...this.state.result, reports } });
    } else this.set({ choreography: rows });
  }
}

export const store = new Store();
