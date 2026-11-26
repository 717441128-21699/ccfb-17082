# 焰拍核查 · 音乐焰火声光节拍与点火修正系统

用观众席上**一部手机录下的视频声音和画面**，核查音乐焰火是否在重拍上炸开：

- 画面里每一次开花的**亮度突变** → 看到开花的时刻（亚帧拟合）；
- 声音里每一声爆炸 → 从配乐、底鼓、军鼓和人群欢呼中检出（**AudioWorklet / Web Audio API**）；
- 同一发的光、声配对，`Δt × c(T)` → 观众到爆点的距离，声速按现场气温 **−10~30°C 校正**；
- 楼群/山谷的多次反射按“幅度衰减 + 高频阻尼 + 等间隔周期性”归并，**三次回声只算一发**；
- 开花时刻与配乐节拍对照，给出每发提前/落后毫秒数，并反推编排表点火时间该往前/后挪多少。

四个页面：**录像导入 · 声光事件 · 节拍对照 · 点火修正**。除 AudioWorklet 处理器与 Web Audio 接线外，其余全部 TypeScript。

---

## 快速开始

```bash
npm install
npm run dev          # 先自动用 esbuild 打包 AudioWorklet，再启动 Vite
# 打开终端提示的地址（本机 127.0.0.1:5173，端口占用时会顺延）
```

其他命令：

```bash
npm run verify       # 合成场景量化基准（验收指标），写入 public/benchmark-report.json
npm run build        # tsc 类型检查 + 打包 Worklet + vite 生产构建
npm run preview      # 预览生产包
npm run e2e          # 用系统 Chrome 跑合成核查 + 四页签冒烟（需 playwright-core）
npm run e2e:import   # 额外验证“录制 12s 合成 WebM -> 真实文件导入/抽帧/分析”全链路
```

> 浏览器建议 Chrome / Edge（完整支持 AudioWorklet、OfflineAudioContext、MediaRecorder）。
> 所有媒体只在本机浏览器处理，不上传。

打开应用后，在「录像导入」页右侧可一键**合成场景并核查**（可选场地、BPM、气温、种子、40s/80s/4 分钟），
也可以**录制 12 秒合成测试录像（WebM）**再拖入导入区，走真实的“文件 → 解码音轨 → seek 抽帧 → AudioWorklet”链路。

---

## 验收指标（合成测试，`npm run verify` 实测）

基准跨 4 种场地 × −10/0/20/30°C × 96~140 BPM × 8 个固定种子，再加一个 4 分钟三回声恶劣场景，共 **226 发**、**506 个回声事件**：

| 指标 | 门槛 | 实测 |
| --- | --- | --- |
| 合成测试爆炸声检出率 | ≥ 95% | **100%**（226/226） |
| 回声被误检为另一发 | ≤ 2% | **0.00%**（0/506） |
| 音乐/噪声假发 | 越低越好 | **0** |
| 声光测距中位 / 平均相对误差 | — | **0.22% / 0.44%** |
| 测距 P95 误差 | ≤ 5% | **1.03%** |
| 测距误差 ≤ 5% 的发数占比 | ≥ 95% | **98.2%** |
| 节拍跟踪中位 / P95 误差 | — | **2.8 ms / 8.0 ms** |
| 节拍偏差反推误差 MAE | — | **3.7 ms** |
| 4 分钟配乐场景核查耗时 | ≤ 30 s | **≈ 0.5 s** 核心算法（浏览器 OfflineAudioContext 另计离线渲染，通常数秒） |

终端会打印逐场景结果，并把完整 JSON 写到 `public/benchmark-report.json`，应用导入页会读取并展示这些数字。

---

## 它是怎么工作的

### 1. 合成测试场景（自己合成场地回声与配乐）

`src/core/synth/sceneSynth.ts` 用确定性随机数（固定种子可复现）生成：

- **配乐**：四四拍底鼓、2/4 拍军鼓、八分踩镲、贝斯律动、和弦 Pad 与琶音；
- **人群**：滤波噪声底 + 慢速起伏 + 随机欢呼事件；
- **礼花爆炸**：高频 crack、音高下滑的低频 boom、宽带隆隆声与零星噼啪；
- **四种场地声学**（`src/core/venues.ts`）：
  - `open` 开阔广场：无回声；
  - `square` 单侧楼群：0.42s 单回声；
  - `canyon` 两排楼之间：**0.31 / 0.62 / 0.93s 三次来回反射**，能量递减且低通变暗；
  - `valley` 山谷：0.8s / 1.5s 两次更长更弥散的回声；
- **摄像机亮度序列**：30fps、曝光盒式积分 + 读出噪声，时间戳取帧中心；
- **完整真值**：目标节拍、计划/实际点火、飞行时间、开花时刻、距离、声达时刻与各回声时刻。

气温决定声速 `c(T)=331.297·√(1+T/273.15)` m/s：−10°C≈325.2，30°C≈349.0。

### 2. 爆炸声检测（AudioWorklet）

`src/core/dsp/explosionDetector.ts` 是与运行环境无关的流式检测器（128 样本/hop）：

- 170Hz 低通与 850Hz 高通分别提取**低频轰击**和**高频碎裂**能量；
- 非对称自适应底噪（低于底噪快速下跟、高于底噪缓慢上抬）；
- 触发从宽、确认从严：低频突增 + 高频突增 + 高频长尾 + 归一化绝对高频 RMS 门限，
  用来区分“底鼓 + 踩镲/军鼓”与真正的礼花；
- 弱前驱声建立候选后，更强的 onset 可**抢占一次**重新锚定；
- 确认后用“高频主峰 → 峰前短窗波谷 → 45% 越限持续点 + 通量抛物线插值”做稳健起振时刻估计。

### 3. 回声只算一发

`src/core/dsp/echoGrouper.ts` 在约 1.75s 窗内聚类，簇内取“强度达到最大强度 60% 的最早 hit”为直达主声，
其余（二次脉冲、楼群/山谷反射）全部记为回声；`splitEchoForLight` 还能用未配对亮光把误并的一发拆回来。

### 4. 画面开花与声光测距

`src/core/dsp/lightDetector.ts`：

- 真实视频由 canvas 缩到 192 宽，对天空 ROI（12%~72% 高度）抽亮度与亮斑质心；
- 自适应基线 + MAD 标准化的正向亮度通量找开花；
- 亚帧时刻用“瞬时起亮 + 指数衰减 + 曝光积分”模型做 2ms 网格拟合。

`src/core/dsp/matcher.ts` 在气温对应的合理距离窗（50~450m）内做**保序全局 DP 一一配对**，
代价优先高置信事件并轻微偏向更早的直达声。距离 `D=(t声−t光)·c(T)`。

### 5. 节拍跟踪（AudioWorklet）

`src/core/dsp/beatTracker.ts`：低频 onset 通量自相关估 BPM（含倍频程校正），
再对 **(周期, 相位)** 做小范围连续联合搜索，直接最大化网格点通量，
消除整格速度误差在 4 分钟长度上的累计漂移；拟合前用已检出的爆炸时刻掩蔽低频轰鸣。

### 6. 点火修正

开花相对最近节拍：`δ = t开花 − t节拍`（ms，**正=落后，负=提前**）。
要让下一朵回到拍上，点火修正量 `Δ = −δ`：落后 80ms 就把点火**提前 80ms**。
建议新点火时刻 `= 原计划点火 + Δ/1000`。修正页可改口径/飞行时间/计划点火、整体平移、导出 CSV/JSON。

---

## AudioWorklet 接线

- Worklet 源码：`src/worklets/show-worklet.ts`，注册 `show-processor`（爆炸+节拍一体，结束时掩蔽并输出网格）、
  `explosion-detector`、`beat-tracker`；
- `scripts/bundle-worklets.mjs` 用 esbuild 把它和核心类打成
  `public/worklets/show-worklet.js`（IIFE，可直接 `audioWorklet.addModule`）；
- `predev` / `prebuild` 会自动打包；
- 浏览器分析走 `OfflineAudioContext`，离线渲染远快于实时
  （`src/app/audioWorkletRunner.ts`）；若环境不支持，`src/app/service.ts` 自动回退到主线程调用同一套核心类。
- Node 基准 `src/test/benchmark.ts` 也直接调用同一套核心类，因此“被测算法 = App 内 Worklet 算法”。

---

## 目录结构

```
src/
  core/
    types.ts                 # 全部领域类型
    physics.ts               # 声速-气温、统计/时间工具
    venues.ts                # 4 种场地回声模型 + 口径飞行时间
    pipeline.ts              # 核查流水线总装 + beatStats
    correction.ts            # 编排生成/关联、气温重算、CSV/JSON
    dsp/
      filters.ts             # Biquad / 包络
      explosionDetector.ts   # 爆炸声检测（Worklet 与 Node 共用）
      beatTracker.ts         # 节拍跟踪（Worklet 与 Node 共用）
      lightDetector.ts       # 画面亮度/开花检测 + 亚帧拟合 + RGBA 提取
      echoGrouper.ts         # 回声聚类/主声选择/光声拆分
      matcher.ts             # 光-声保序 DP 配对与测距
    synth/sceneSynth.ts      # 场地/配乐/人群/礼花/摄像机合成 + 真值
    test/benchmark.ts        # npm run verify
  worklets/show-worklet.ts   # AudioWorklet 处理器
  app/
    audioWorkletRunner.ts    # OfflineAudioContext + addModule
    videoFrames.ts           # 录像 seek 抽帧 / Infinity 时长探测
    service.ts               # 分析编排与文件导入
    synthVideo.ts            # Canvas + MediaRecorder 合成测试 WebM
  ui/
    dom.ts charts.ts store.ts
    pages/{importPage,eventsPage,beatsPage,correctionPage}.ts
  main.ts styles.css
scripts/
  bundle-worklets.mjs        # esbuild 打包 Worklet
  e2e-smoke.mjs e2e-import.mjs
```

## 说明与边界

- 手机录像通常音画已同步；若封装/蓝牙等带来固定 AV 偏移，可在导入参数中补偿（匹配窗会扣除该值）。
- PA 音响到观众席的传播延迟是另一个系统偏差源，表现为全曲整体提前/落后，
  用节拍页的平均偏差与修正页“整体移动点火”即可一次性补偿。
- 顺序 seek 抽帧对短视频/MP4 精确且兼容性好；超长录像建议用 15fps 档。
- 指标来自确定性合成测试（含与真实摄像机一致的曝光积分/噪声模型）；真实复杂录音的阈值可在
  `ExplosionDetector` 的 sensitivity 与各距离窗上进一步校准。
