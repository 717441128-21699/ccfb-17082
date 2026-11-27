import { store, venueOptions } from '../store.js';
import { decodeAudio, extractLuminance } from '../video-decoder.js';
import type { VenueId } from '../../core/types.js';

/** 录像导入页：视频文件解码 + 合成测试生成 + 分析参数设置。 */
export function renderImportPage(root: HTMLElement): void {
  root.innerHTML = `
    <div class="card">
      <h2>① 导入录像</h2>
      <div class="dropzone" id="dropzone">
        <div class="big">点击选择或拖拽手机录像到此处</div>
        <div>支持 MP4 / MOV / WebM，音轨将被解码为 PCM，画面逐帧抽取亮度</div>
        <input type="file" id="fileInput" accept="video/*" />
      </div>
      <div id="importProgress" style="display:none">
        <div class="progress"><div id="progressBar"></div></div>
        <div class="muted" id="progressText">准备中…</div>
      </div>
      <div class="video-meta" id="videoMeta"></div>
    </div>

    <div class="card">
      <h2>② 分析参数</h2>
      <div class="field-row">
        <div class="field">
          <label>场地类型（决定回声抑制窗口）</label>
          <select id="venueSelect">
            ${venueOptions().map((v) => `<option value="${v.id}">${v.label}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>现场气温（℃，用于声速校正，范围 -10 ~ 30）</label>
          <input type="number" id="tempInput" value="15" min="-20" max="40" step="0.5" />
        </div>
      </div>
      <div class="field">
        <label>编排表默认飞行时间（秒，表内未注明口径时使用）</label>
        <input type="number" id="flightInput" value="3" min="0.5" max="15" step="0.1" />
      </div>
      <button class="btn" id="runBtn" disabled>开始核查</button>
      <span class="muted" id="runHint" style="margin-left:12px"></span>
    </div>

    <div class="card">
      <h2>③ 合成测试录像（无真实录像时验证算法）</h2>
      <p class="muted">在浏览器本地合成含配乐、人群欢呼、礼花爆炸与场地回声的测试片段，自带真实值可对照。</p>
      <div class="synth-grid">
        <div class="field"><label>场地</label>
          <select id="synVenue">${venueOptions().map((v) => `<option value="${v.id}">${v.label}</option>`).join('')}</select>
        </div>
        <div class="field"><label>气温 ℃</label><input type="number" id="synTemp" value="10" step="1" /></div>
        <div class="field"><label>爆点距离 m</label><input type="number" id="synDist" value="400" step="10" /></div>
        <div class="field"><label>时长 秒</label><input type="number" id="synDur" value="90" step="10" /></div>
        <div class="field"><label>礼花发数</label><input type="number" id="synShots" value="24" step="1" /></div>
        <div class="field"><label>配乐 BPM</label><input type="number" id="synBpm" value="96" step="1" /></div>
      </div>
      <button class="btn secondary" id="synBtn" style="margin-top:10px">生成合成录像并核查</button>
    </div>
  `;

  const s = store.getState();
  const venueSelect = root.querySelector('#venueSelect') as HTMLSelectElement;
  const tempInput = root.querySelector('#tempInput') as HTMLInputElement;
  const flightInput = root.querySelector('#flightInput') as HTMLInputElement;
  venueSelect.value = s.config.venue;
  tempInput.value = String(s.config.temperatureC);
  flightInput.value = String(s.config.defaultFlightSec);

  const syncConfig = () => {
    store.set({
      config: {
        venue: venueSelect.value as VenueId,
        temperatureC: parseFloat(tempInput.value) || 15,
        defaultFlightSec: parseFloat(flightInput.value) || 3,
      },
    });
  };
  venueSelect.onchange = syncConfig;
  tempInput.oninput = syncConfig;
  flightInput.oninput = syncConfig;

  const dropzone = root.querySelector('#dropzone') as HTMLDivElement;
  const fileInput = root.querySelector('#fileInput') as HTMLInputElement;
  const runBtn = root.querySelector('#runBtn') as HTMLButtonElement;
  const runHint = root.querySelector('#runHint') as HTMLElement;
  const progressBox = root.querySelector('#importProgress') as HTMLElement;
  const progressBar = root.querySelector('#progressBar') as HTMLElement;
  const progressText = root.querySelector('#progressText') as HTMLElement;
  const videoMeta = root.querySelector('#videoMeta') as HTMLElement;

  dropzone.onclick = () => fileInput.click();
  dropzone.ondragover = (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  };
  dropzone.ondragleave = () => dropzone.classList.remove('drag');
  dropzone.ondrop = (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  };
  fileInput.onchange = () => {
    const f = fileInput.files?.[0];
    if (f) handleFile(f);
  };

  async function handleFile(file: File): Promise<void> {
    progressBox.style.display = 'block';
    progressText.textContent = '解码音轨…';
    progressBar.style.width = '20%';
    try {
      const video = document.createElement('video');
      video.src = URL.createObjectURL(file);
      video.muted = true;
      video.preload = 'auto';
      await new Promise<void>((res, rej) => {
        video.onloadedmetadata = () => res();
        video.onerror = () => rej(new Error('视频无法加载'));
      });
      const audio = await decodeAudio(file);
      progressBar.style.width = '45%';
      progressText.textContent = '逐帧抽取画面亮度…';
      const flashFrames = await extractLuminance(video, audio.durationSec, (pct) => {
        progressBar.style.width = `${45 + pct * 50}%`;
        progressText.textContent = `逐帧抽取画面亮度… ${(pct * 100).toFixed(0)}%`;
      });
      store.set({
        videoName: file.name,
        videoDurationSec: audio.durationSec,
        sampleRate: audio.sampleRate,
        channelData: audio.channelData,
        flashFrames,
        source: 'video',
        syntheticTruth: undefined,
        result: null,
      });
      progressBar.style.width = '100%';
      progressText.textContent = '导入完成';
      videoMeta.innerHTML = `
        <span>文件：<b>${file.name}</b></span>
        <span>时长：<b>${audio.durationSec.toFixed(1)}s</b></span>
        <span>采样率：<b>${audio.sampleRate}Hz</b></span>
        <span>亮度帧：<b>${flashFrames.length}</b></span>
      `;
      runBtn.disabled = false;
      runHint.textContent = '就绪，可开始核查';
    } catch (err) {
      progressText.textContent = `导入失败：${(err as Error).message}`;
    }
  }

  if (store.getState().channelData) {
    runBtn.disabled = false;
    runHint.textContent = '已加载数据，可重新核查';
    const st = store.getState();
    videoMeta.innerHTML = `<span>当前：<b>${st.videoName}</b></span><span>时长：<b>${st.videoDurationSec.toFixed(1)}s</b></span>`;
  }

  runBtn.onclick = async () => {
    runBtn.disabled = true;
    runHint.textContent = '分析中…';
    await store.runAnalysis();
    runBtn.disabled = false;
    runHint.textContent = '核查完成，可切换到各事件页查看';
  };

  const synBtn = root.querySelector('#synBtn') as HTMLButtonElement;
  synBtn.onclick = () => {
    const venue = (root.querySelector('#synVenue') as HTMLSelectElement).value as VenueId;
    const temperatureC = parseFloat((root.querySelector('#synTemp') as HTMLInputElement).value);
    const distanceM = parseFloat((root.querySelector('#synDist') as HTMLInputElement).value);
    const durationSec = parseFloat((root.querySelector('#synDur') as HTMLInputElement).value);
    const shotCount = parseInt((root.querySelector('#synShots') as HTMLInputElement).value, 10);
    const bpm = parseFloat((root.querySelector('#synBpm') as HTMLInputElement).value);
    store.loadSynthetic({
      durationSec,
      sampleRate: 48000,
      venue,
      temperatureC,
      distanceM,
      shotCount,
      bpm,
      tempoDrift: true,
      seed: Math.floor(performance.now()) % 100000,
    });
    runBtn.disabled = false;
    runHint.textContent = '合成录像已生成，点击开始核查';
  };
}
