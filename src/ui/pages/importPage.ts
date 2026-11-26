// 录像导入页：真实视频文件导入、参数（气温）、合成场景与合成测试录像、指标报告。

import { h, clear, badge } from '../dom';
import { store } from '../store';
import { VENUE_LIST } from '../../core/venues';
import { soundSpeedNote } from '../../core/physics';
import { synthesizeScene, type SynthOptions } from '../../core/synth/sceneSynth';
import { analyzeMedia, bufferToMono, importVideoFile } from '../../app/service';
import { isRecordingSupported, recordSynthClip, downloadBlob } from '../../app/synthVideo';
import type { BenchmarkMetrics, VenueId } from '../../core/types';

export function renderImportPage(root: HTMLElement): void {
  clear(root);
  root.append(buildBenchmarkBanner(), buildMainGrid());
}

function metricChip(label: string, value: string, ok: boolean): HTMLElement {
  return h('div', { class: `metric-chip ${ok ? 'ok' : 'bad'}` },
    h('div', { class: 'metric-value' }, value),
    h('div', { class: 'metric-label' }, label),
  );
}

function buildBenchmarkBanner(): HTMLElement {
  const box = h('section', { class: 'card benchmark-card' }, h('div', { class: 'benchmark-loading' }, '正在读取合成测试指标…'));
  fetch(`${import.meta.env.BASE_URL || './'}benchmark-report.json`)
    .then((r) => (r.ok ? r.json() : null))
    .then((m: BenchmarkMetrics | null) => {
      clear(box);
      if (!m) {
        box.append(h('div', { class: 'muted' }, '暂无基准报告，运行 ', h('code', {}, 'npm run verify'), ' 生成。'));
        return;
      }
      store.state.benchmark = m;
      box.append(
        h('div', { class: 'benchmark-head' },
          h('h2', {}, '合成测试指标'),
          badge(m.gatePass ? '全部达标' : '存在未达标项', m.gatePass ? 'good' : 'bad'),
          h('span', { class: 'muted small' }, `${m.scenes} 个场景 · ${m.totalShots} 发礼花`),
        ),
        h('div', { class: 'metric-grid' },
          metricChip('爆炸声检出率', `${m.detectionRatePct.toFixed(1)}%`, m.detectionRatePct >= 95),
          metricChip('回声误判另一发', `${m.echoFalseRatePct.toFixed(2)}%`, m.echoFalseRatePct <= 2),
          metricChip('测距 P95 误差', `${m.distanceP95ErrPct.toFixed(2)}%`, m.distanceP95ErrPct <= 5),
          metricChip('测距≤5%占比', `${m.distanceWithin5Pct.toFixed(1)}%`, m.distanceWithin5Pct >= 95),
          metricChip('节拍中位误差', `${m.beatMedianErrMs.toFixed(1)} ms`, m.beatMedianErrMs < 30),
          metricChip('4分钟核查耗时', `${(m.perfElapsedMs / 1000).toFixed(2)} s`, m.perfPass30s),
        ),
      );
    })
    .catch(() => {
      clear(box);
      box.append(h('div', { class: 'muted' }, '未找到 benchmark-report.json，可运行 npm run verify。'));
    });
  return box;
}

function buildMainGrid(): HTMLElement {
  // ---- 文件导入 ----
  const fileInput = h('input', { type: 'file', accept: 'video/*,audio/*,.webm,.mp4,.mov,.m4v', style: 'display:none' }) as HTMLInputElement;
  const fpsSelect = h('select', {},
    h('option', { value: '15' }, '15 fps（推荐，快）'),
    h('option', { value: '24' }, '24 fps（更精细）'),
    h('option', { value: '30', selected: true }, '30 fps（最精细，较慢）'),
  ) as HTMLSelectElement;
  const progressWrap = h('div', { class: 'progress-wrap hidden' },
    h('div', { class: 'progress-bar' }, h('div', { class: 'progress-fill' })),
    h('div', { class: 'progress-stage muted small' }, ''),
  );
  const video = h('video', { class: 'preview-video', controls: true, muted: true, playsInline: true }) as HTMLVideoElement;
  const previewWrap = h('div', { class: 'preview-wrap hidden' }, video);

  const setProgress = (r: number, stage: string) => {
    progressWrap.classList.remove('hidden');
    (progressWrap.querySelector('.progress-fill') as HTMLElement).style.width = `${Math.round(r * 100)}%`;
    progressWrap.querySelector('.progress-stage')!.textContent = stage;
  };

  const handleFile = async (file: File) => {
    if (store.state.videoUrl) URL.revokeObjectURL(store.state.videoUrl);
    const url = URL.createObjectURL(file);
    store.set({ videoUrl: url, fileName: file.name });
    video.src = url;
    previewWrap.classList.remove('hidden');
    store.setBusy(true, '导入录像');
    try {
      const fps = Number(fpsSelect.value);
      const media = await importVideoFile(file, fps, setProgress);
      setProgress(0.97, 'AudioWorklet 分析中');
      const mono = bufferToMono(media.audioBuffer);
      const outcome = await analyzeMedia({
        channelData: mono,
        sampleRate: media.audioBuffer.sampleRate,
        luma: media.luma,
        durationSec: media.durationSec,
        options: { temperatureC: store.state.tempC, venue: 'auto' },
      });
      store.setResult(outcome.result, outcome.engine, outcome.workletError);
      setProgress(1, '完成');
      progressWrap.classList.add('hidden');
      showDone(outcome.engine);
    } catch (e) {
      store.setBusy(false);
      progressWrap.classList.add('hidden');
      errorBox.classList.remove('hidden');
      errorBox.textContent = `分析失败：${e instanceof Error ? e.message : String(e)}`;
    }
  };

  const errorBox = h('div', { class: 'error-box hidden' });
  const doneBox = h('div', { class: 'done-box hidden' },
    h('span', {}, '核查完成，前往：'),
    h('button', { class: 'btn btn-small', onclick: () => store.navigate('events') }, '声光事件'),
    h('button', { class: 'btn btn-small', onclick: () => store.navigate('beats') }, '节拍对照'),
    h('button', { class: 'btn btn-small btn-primary', onclick: () => store.navigate('correction') }, '点火修正'),
  );

  const drop = h('div', { class: 'dropzone', tabIndex: 0, role: 'button' },
    h('div', { class: 'drop-icon' }, '🎆'),
    h('div', { class: 'drop-title' }, '点击或拖入观众席手机录像'),
    h('div', { class: 'muted small' }, '支持 WebM / MP4 / MOV，音画同一文件；视频仅在本机浏览器处理，不上传'),
    fileInput,
  );
  drop.addEventListener('click', () => fileInput.click());
  drop.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') fileInput.click();
  });
  fileInput.addEventListener('change', () => fileInput.files?.[0] && handleFile(fileInput.files[0]));
  ['dragover', 'dragenter'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
  drop.addEventListener('drop', (e) => {
    const f = (e as DragEvent).dataTransfer?.files?.[0];
    if (f) handleFile(f);
  });

  const fileCard = h('section', { class: 'card' },
    h('h2', {}, '① 录像导入'),
    drop,
    h('div', { class: 'row gap' }, h('label', { class: 'field' }, h('span', {}, '抽帧帧率'), fpsSelect)),
    progressWrap,
    errorBox,
    doneBox,
    previewWrap,
  );

  // ---- 参数 + 合成 ----
  const tempValue = h('span', { class: 'temp-value' }, `${store.state.tempC}°C`);
  const tempNote = h('div', { class: 'muted small temp-note' }, soundSpeedNote(store.state.tempC));
  const tempSlider = h('input', { type: 'range', min: '-10', max: '30', step: '1', value: String(store.state.tempC) }) as HTMLInputElement;
  tempSlider.addEventListener('input', () => {
    const t = Number(tempSlider.value);
    tempValue.textContent = `${t}°C`;
    tempNote.textContent = soundSpeedNote(t);
    store.setTemp(t);
  });

  const venueSelect = h('select', {}, ...VENUE_LIST.map((v) => h('option', { value: v.id }, v.name))) as HTMLSelectElement;
  const bpmInput = h('input', { type: 'number', min: '70', max: '160', value: '120', class: 'input-num' }) as HTMLInputElement;
  const seedInput = h('input', { type: 'number', value: String(Math.floor(Math.random() * 900) + 100), class: 'input-num' }) as HTMLInputElement;
  let duration: 40 | 80 | 240 = 80;
  const durChips = h('div', { class: 'chip-row' },
    ...constArr.map((d) => {
      const chip = h('button', { class: `chip ${d === 80 ? 'active' : ''}`, type: 'button' }, d === 240 ? '4 分钟性能' : `${d}s`);
      chip.addEventListener('click', () => {
        duration = d as 40 | 80 | 240;
        durChips.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
      });
      return chip;
    }),
  );

  const synthStatus = h('div', { class: 'muted small synth-status' }, '');
  const synthBtn = h('button', { class: 'btn btn-primary' }, '合成场景并核查');
  synthBtn.addEventListener('click', async () => {
    synthBtn.setAttribute('disabled', 'true');
    synthStatus.textContent = '正在合成音频与摄像机亮度…';
    await new Promise((r) => setTimeout(r, 30));
    const opts: SynthOptions = {
      seed: Number(seedInput.value) || 1,
      durationSec: duration,
      bpm: Number(bpmInput.value) || 120,
      temperatureC: store.state.tempC,
      venue: venueSelect.value as VenueId,
    };
    const scene = synthesizeScene(opts);
    synthStatus.textContent = `已合成 ${scene.truth.shots.length} 发、${scene.truth.beatTimes.length} 拍，AudioWorklet 分析中…`;
    await new Promise((r) => setTimeout(r, 30));
    const outcome = await analyzeMedia({
      channelData: scene.audio,
      sampleRate: scene.sampleRate,
      luma: scene.luma,
      durationSec: scene.durationSec,
      options: { temperatureC: opts.temperatureC!, venue: opts.venue! },
      truth: scene.truth,
    });
    store.setResult(outcome.result, outcome.engine, outcome.workletError);
    synthStatus.textContent = `完成：${outcome.engine === 'audio-worklet' ? '检测在 AudioWorklet 中运行' : '使用主线程回退'}，耗时 ${(outcome.result.elapsedMs ?? 0).toFixed(0)}ms（核心）`;
    synthBtn.removeAttribute('disabled');
    showDone(outcome.engine);
  });

  const recordBtn = h('button', { class: 'btn' }, '录制 12s 合成测试录像(WebM)');
  if (!isRecordingSupported()) recordBtn.setAttribute('disabled', 'true');
  recordBtn.addEventListener('click', async () => {
    recordBtn.setAttribute('disabled', 'true');
    synthStatus.textContent = '实时录制 12 秒…';
    const clip = synthesizeScene({ seed: Number(seedInput.value) || 7, durationSec: 12, bpm: Number(bpmInput.value) || 120, temperatureC: store.state.tempC, venue: venueSelect.value as VenueId, shotCount: 3 });
    try {
      const blob = await recordSynthClip(clip, 12, (r) => { synthStatus.textContent = `录制中 ${(r * 100).toFixed(0)}%`; });
      downloadBlob(blob, 'synth-fireworks-test.webm');
      synthStatus.textContent = '已下载 synth-fireworks-test.webm，可直接拖入上方导入。';
    } catch (e) {
      synthStatus.textContent = e instanceof Error ? e.message : String(e);
    } finally {
      recordBtn.removeAttribute('disabled');
    }
  });

  const paramCard = h('section', { class: 'card' },
    h('h2', {}, '② 核查参数与合成自检'),
    h('div', { class: 'temp-row' }, h('label', { class: 'field grow' }, h('span', {}, '现场气温（声速校正 -10~30°C）'), tempSlider), tempValue),
    tempNote,
    h('div', { class: 'form-grid' },
      h('label', { class: 'field' }, h('span', {}, '场地/回声'), venueSelect),
      h('label', { class: 'field' }, h('span', {}, 'BPM'), bpmInput),
      h('label', { class: 'field' }, h('span', {}, '随机种子'), seedInput),
    ),
    h('label', { class: 'field' }, h('span', {}, '合成时长'), durChips),
    h('div', { class: 'row gap wrap' }, synthBtn, recordBtn),
    synthStatus,
    h('p', { class: 'muted small' }, '基准指标由 ', h('code', {}, 'npm run verify'), ' 在 Node 中用同一套 DSP 核心跑出；浏览器里爆炸声检测与节拍跟踪运行于 AudioWorklet（OfflineAudioContext 加速）。'),
  );

  function showDone(engine: string): void {
    doneBox.classList.remove('hidden');
    const engineNote = doneBox.querySelector('.engine-note');
    if (engineNote) engineNote.remove();
    doneBox.append(h('span', { class: 'badge badge-accent engine-note' }, engine === 'audio-worklet' ? 'AudioWorklet' : '主线程回退'));
  }

  return h('div', { class: 'grid-2' }, fileCard, paramCard);
}

// 小工具：固定数组类型
const constArr = [40, 80, 240] as const;
