"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
  var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);

  // src/core/dsp/filters.ts
  var Biquad = class {
    constructor(type, freq, sampleRate, q = 0.707) {
      this.type = type;
      this.freq = freq;
      this.sampleRate = sampleRate;
      this.q = q;
      __publicField(this, "b0", 1);
      __publicField(this, "b1", 0);
      __publicField(this, "b2", 0);
      __publicField(this, "a1", 0);
      __publicField(this, "a2", 0);
      __publicField(this, "x1", 0);
      __publicField(this, "x2", 0);
      __publicField(this, "y1", 0);
      __publicField(this, "y2", 0);
      this.coeff();
    }
    coeff() {
      const w0 = 2 * Math.PI * this.freq / this.sampleRate;
      const cosw = Math.cos(w0);
      const sinw = Math.sin(w0);
      const alpha = sinw / (2 * this.q);
      let b0, b1, b2, a0, a1, a2;
      if (this.type === "lowpass") {
        b0 = (1 - cosw) / 2;
        b1 = 1 - cosw;
        b2 = (1 - cosw) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosw;
        a2 = 1 - alpha;
      } else if (this.type === "highpass") {
        b0 = (1 + cosw) / 2;
        b1 = -(1 + cosw);
        b2 = (1 + cosw) / 2;
        a0 = 1 + alpha;
        a1 = -2 * cosw;
        a2 = 1 - alpha;
      } else {
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cosw;
        a2 = 1 - alpha;
      }
      this.b0 = b0 / a0;
      this.b1 = b1 / a0;
      this.b2 = b2 / a0;
      this.a1 = a1 / a0;
      this.a2 = a2 / a0;
    }
    process(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1;
      this.x1 = x;
      this.y2 = this.y1;
      this.y1 = y;
      return y;
    }
    reset() {
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
    }
  };

  // src/core/dsp/explosionDetector.ts
  var HOP = 128;
  var ExplosionDetector = class {
    constructor(sampleRate, params = {}) {
      __publicField(this, "sampleRate");
      __publicField(this, "hopSize", HOP);
      __publicField(this, "lp");
      __publicField(this, "hp");
      __publicField(this, "inputGain");
      __publicField(this, "accAll", 0);
      __publicField(this, "accLow", 0);
      __publicField(this, "accHigh", 0);
      __publicField(this, "peak", 0);
      __publicField(this, "accCount", 0);
      __publicField(this, "totalHops", 0);
      __publicField(this, "hist", []);
      // 长时非对称底噪
      __publicField(this, "floorAll", 0.02);
      __publicField(this, "floorLow", 0.02);
      __publicField(this, "floorHigh", 8e-3);
      __publicField(this, "floorFluxHigh", 2e-3);
      __publicField(this, "floorsInit", false);
      __publicField(this, "pending", null);
      __publicField(this, "pendingAge", 0);
      __publicField(this, "idSeq", 1);
      __publicField(this, "lastEmitTime", -10);
      __publicField(this, "refractory");
      __publicField(this, "sensitivity");
      __publicField(this, "confirmHops", 52);
      // ~150ms
      __publicField(this, "diag", { triggers: 0, emitted: 0, reject: {} });
      this.sampleRate = sampleRate;
      this.lp = new Biquad("lowpass", 170, sampleRate, 0.8);
      this.hp = new Biquad("highpass", 850, sampleRate, 0.7);
      this.refractory = params.refractorySec ?? 0.2;
      this.sensitivity = params.sensitivity ?? 0.55;
      this.inputGain = params.inputGain ?? 1;
    }
    process(input) {
      const out = [];
      for (let i = 0; i < input.length; i++) {
        const x = input[i] * this.inputGain;
        const lo = this.lp.process(x);
        const hi = this.hp.process(x);
        this.accAll += x * x;
        this.accLow += lo * lo;
        this.accHigh += hi * hi;
        const ax = x < 0 ? -x : x;
        if (ax > this.peak) this.peak = ax;
        this.accCount++;
        if (this.accCount === this.hopSize) {
          const hop = this.buildHop();
          this.accAll = this.accLow = this.accHigh = 0;
          this.peak = 0;
          this.accCount = 0;
          this.handleHop(hop, out);
        }
      }
      return out;
    }
    detectAll(samples) {
      const hits = [];
      const block = 128;
      for (let i = 0; i < samples.length; i += block) {
        hits.push(...this.process(samples.subarray(i, Math.min(i + block, samples.length))));
      }
      if (this.pending) {
        const hit = this.confirm(this.pending);
        if (hit) hits.push(hit);
        this.pending = null;
      }
      return hits;
    }
    buildHop() {
      const n = this.hopSize;
      const all = Math.sqrt(this.accAll / n);
      const low = Math.sqrt(this.accLow / n);
      const high = Math.sqrt(this.accHigh / n);
      const t = this.totalHops * this.hopSize / this.sampleRate;
      const prev = this.hist[this.hist.length - 1];
      let flux = 0;
      let fluxHigh = 0;
      if (prev) {
        flux += Math.max(0, all - prev.all) * 1;
        flux += Math.max(0, low - prev.low) * 1.4;
        flux += Math.max(0, high - prev.high) * 1.1;
        fluxHigh = Math.max(0, high - prev.high);
      }
      const hop = { t, all, low, high, peak: this.peak, flux, fluxHigh };
      this.totalHops++;
      return hop;
    }
    /** 非对称底噪：低于底噪时快速下跟，高于时缓慢上抬 */
    adaptFloor(f, v) {
      const a = v < f ? 0.06 : 4e-3;
      return f + a * (v - f);
    }
    trace(...args) {
      const g = globalThis;
      if (g.__TRACE_T) {
        const t = args[0];
        if (t >= g.__TRACE_T[0] && t <= g.__TRACE_T[1]) console.log(...args.slice(1));
      }
    }
    handleHop(hop, out) {
      if (!this.floorsInit && this.totalHops > 4) {
        this.floorAll = Math.max(0.01, hop.all);
        this.floorLow = Math.max(0.01, hop.low);
        this.floorHigh = Math.max(4e-3, hop.high);
        this.floorsInit = true;
      }
      this.floorAll = this.adaptFloor(this.floorAll, hop.all);
      this.floorLow = this.adaptFloor(this.floorLow, hop.low);
      this.floorHigh = this.adaptFloor(this.floorHigh, hop.high);
      this.floorFluxHigh = this.adaptFloor(this.floorFluxHigh, hop.fluxHigh);
      if (this.pending) {
        const trigFlux = this.pending.trigFlux ?? 0;
        const preempted = this.pending.preempted ?? false;
        const preempt = !preempted && hop.fluxHigh > trigFlux * 1.6 && hop.high > this.pending.floorHigh * 2.8 && this.pendingAge < this.confirmHops;
        if (preempt) {
          this.trace(hop.t, `PREEMPT at ${hop.t.toFixed(4)} flux=${hop.fluxHigh.toFixed(3)} trigFlux=${trigFlux.toFixed(3)} age=${this.pendingAge}`);
          let onsetIndex = this.hist.length;
          for (let back = 1; back <= 6; back++) {
            const idx = this.hist.length - back;
            if (idx < 0) break;
            const cur = this.hist[idx];
            const nxt = this.hist[idx + 1] ?? hop;
            if (nxt.high >= cur.high * 1.3) onsetIndex = idx + 1;
            else break;
          }
          const onsetHop = onsetIndex < this.hist.length ? this.hist[onsetIndex] : hop;
          this.pending.onsetIndex = onsetIndex;
          this.pending.triggerIndex = this.hist.length;
          this.pending.onsetTime = onsetHop.t;
          this.pending.trigFlux = hop.fluxHigh;
          this.pending.preempted = true;
          this.pendingAge = 0;
        } else {
          this.pendingAge++;
          if (this.pendingAge >= this.confirmHops) {
            const hit = this.confirm(this.pending);
            if (hit) {
              out.push(hit);
              this.lastEmitTime = hit.time;
            }
            this.pending = null;
          }
        }
      }
      const highRatio = hop.high / (this.floorHigh + 1e-4);
      const fluxGate = hop.fluxHigh > (2.2 - this.sensitivity) * (this.floorFluxHigh + 4e-3);
      const highGate = highRatio >= 2.1 - this.sensitivity * 0.4;
      const energyGate = hop.all > Math.max(0.05, this.floorAll * 1.5);
      const timeOk = hop.t - this.lastEmitTime > this.refractory;
      if (!this.pending && fluxGate && highGate && energyGate && timeOk) {
        this.diag.triggers++;
        this.trace(hop.t, `TRIGGER t=${hop.t.toFixed(4)} fH=${hop.fluxHigh.toFixed(3)} hR=${highRatio.toFixed(1)} timeOk=${timeOk}`);
        let onsetIndex = this.hist.length;
        for (let back = 1; back <= 8; back++) {
          const idx = this.hist.length - back;
          if (idx < 0) break;
          const cur = this.hist[idx];
          const nxt = this.hist[idx + 1] ?? hop;
          if (nxt.high >= cur.high * 1.35 || nxt.all >= cur.all * 1.22) {
            onsetIndex = idx + 1;
          } else {
            break;
          }
        }
        const onsetHop = onsetIndex < this.hist.length ? this.hist[onsetIndex] : hop;
        this.pending = {
          onsetIndex,
          triggerIndex: this.hist.length,
          onsetTime: onsetHop.t,
          floorAll: this.floorAll,
          floorLow: this.floorLow,
          floorHigh: this.floorHigh
        };
        this.pending.trigFlux = hop.fluxHigh;
        this.pendingAge = 0;
      }
      this.hist.push(hop);
    }
    confirm(p) {
      const start = Math.max(0, p.onsetIndex);
      const end = Math.min(this.hist.length, p.triggerIndex + this.confirmHops);
      const win = this.hist.slice(start, end + 1);
      if (win.length < 6) return null;
      let lowPeak = 0;
      let highPeak = 0;
      let allPeak = 0;
      let peakSample = 0;
      let tailHighSum = 0;
      let tailHighN = 0;
      let tailAllSum = 0;
      let tailAllN = 0;
      let first40HighSq = 0;
      for (let i = 0; i < win.length; i++) {
        const h = win[i];
        if (h.low > lowPeak) lowPeak = h.low;
        if (h.high > highPeak) highPeak = h.high;
        if (h.all > allPeak) allPeak = h.all;
        if (h.peak > peakSample) peakSample = h.peak;
        if (i <= 42) first40HighSq += h.high * h.high;
        if (i >= 12 && i <= 50) {
          tailHighSum += h.high;
          tailHighN++;
        }
        if (i >= 18 && i <= 50) {
          tailAllSum += h.all;
          tailAllN++;
        }
      }
      const rHigh = highPeak / (p.floorHigh + 1e-4);
      const rLow = lowPeak / (p.floorLow + 1e-4);
      const rAll = allPeak / (p.floorAll + 1e-4);
      const tailHigh = tailHighN ? tailHighSum / tailHighN / (p.floorHigh + 1e-4) : 0;
      const tailAll = tailAllN ? tailAllSum / tailAllN / (p.floorAll + 1e-4) : 0;
      const highRms = Math.sqrt(first40HighSq / Math.max(1, Math.min(43, win.length)));
      const highReq = 3.4 - this.sensitivity * 1.2;
      const lowReq = 1.9 - this.sensitivity * 0.5;
      const tailReq = 2.4 - this.sensitivity * 0.8;
      const absHighReq = 0.075 - this.sensitivity * 0.04;
      const checks = [
        ["rHigh", rHigh >= highReq],
        ["rLow", rLow >= lowReq],
        ["tailHigh", tailHigh >= tailReq],
        ["allPeak", allPeak >= 0.07],
        ["rAll", rAll >= 1.8],
        ["absHigh", highRms >= absHighReq]
      ];
      const failed = checks.filter(([, ok]) => !ok).map(([k]) => k);
      if (failed.length) {
        for (const f of failed) this.diag.reject[f] = (this.diag.reject[f] ?? 0) + 1;
        const dbg = globalThis.process?.env?.DEBUG_DETECT;
        if (dbg) {
          console.log(
            `reject t=${p.onsetTime.toFixed(3)} rH=${rHigh.toFixed(1)} rL=${rLow.toFixed(1)} rA=${rAll.toFixed(1)} tailH=${tailHigh.toFixed(1)} tailA=${tailAll.toFixed(1)} peak=${allPeak.toFixed(2)} fail=${failed.join(",")}`
          );
        }
        return null;
      }
      const score = Math.min(
        1,
        0.3 + Math.min(rHigh / 12, 1) * 0.3 + Math.min(rLow / 7, 1) * 0.18 + Math.min(tailHigh / 8, 1) * 0.17 + Math.min(rAll / 6, 1) * 0.05
      );
      this.diag.emitted++;
      const refinedTime = this.estimateOnset(p, start, end);
      return {
        id: this.idSeq++,
        time: refinedTime,
        triggerTime: p.onsetTime,
        peak: peakSample,
        rms: allPeak,
        lowEnergy: lowPeak,
        highEnergy: highRms,
        score
      };
    }
    /**
     * 稳健起振估计：确认窗内找高频能量主峰，再在其前方 ~90ms 找“最大高频通量峰”
     * 作为真正的炸裂起点（爆炸 crack 的通量远大于其前几十毫秒的鼓/军鼓），
     * 最后做抛物线亚 hop 插值。不依赖触发锚点，避免弱前驱/内部调制尖峰带偏。
     */
    estimateOnset(p, start, end) {
      const hopDur = this.hopSize / this.sampleRate;
      let highPeakIdx = start;
      let highPeak = 0;
      for (let i = start; i <= end && i < this.hist.length; i++) {
        if (this.hist[i].high > highPeak) {
          highPeak = this.hist[i].high;
          highPeakIdx = i;
        }
      }
      const from = Math.max(start, highPeakIdx - 32);
      const to = Math.min(this.hist.length - 1, highPeakIdx + 2);
      let fluxIdx = highPeakIdx;
      let fluxPeak = -1;
      for (let i = from; i <= to; i++) {
        const f = this.hist[i].fluxHigh + 0.15 * Math.max(0, this.hist[i].high - p.floorHigh);
        if (f > fluxPeak) {
          fluxPeak = f;
          fluxIdx = i;
        }
      }
      if (fluxIdx - 1 >= start && this.hist[fluxIdx - 1].fluxHigh >= this.hist[fluxIdx].fluxHigh * 0.6) {
        fluxIdx -= 1;
      }
      const h0 = this.hist[fluxIdx - 1];
      const h1 = this.hist[fluxIdx];
      const h2 = this.hist[fluxIdx + 1];
      let shift = 0;
      if (h0 && h1 && h2) {
        const y0 = h0.fluxHigh;
        const y1 = h1.fluxHigh;
        const y2 = h2.fluxHigh;
        const denom = y0 - 2 * y1 + y2;
        if (denom < 0) shift = 0.5 * (y0 - y2) / denom;
        shift = Math.max(-0.5, Math.min(0.5, shift));
      }
      let t = (this.hist[fluxIdx]?.t ?? p.onsetTime) + shift * hopDur;
      t = Math.max(p.onsetTime - 0.12, Math.min(p.onsetTime + 0.08, t));
      return t;
    }
  };

  // src/core/dsp/beatTracker.ts
  var HOP2 = 256;
  var BeatTracker = class {
    constructor(sampleRate) {
      __publicField(this, "sampleRate");
      __publicField(this, "lp");
      __publicField(this, "accLow", 0);
      __publicField(this, "accAll", 0);
      __publicField(this, "count", 0);
      __publicField(this, "hopIndex", 0);
      __publicField(this, "prevLow", 0);
      __publicField(this, "prevAll", 0);
      __publicField(this, "lowFlux", []);
      __publicField(this, "onset", []);
      __publicField(this, "lowEnv", []);
      this.sampleRate = sampleRate;
      this.lp = new Biquad("lowpass", 160, sampleRate, 0.7);
    }
    process(input) {
      for (let i = 0; i < input.length; i++) {
        const x = input[i];
        const lo = this.lp.process(x);
        this.accLow += lo * lo;
        this.accAll += x * x;
        this.count++;
        if (this.count === HOP2) {
          const low = Math.sqrt(this.accLow / HOP2);
          const e = Math.sqrt(this.accAll / HOP2);
          const lf = Math.max(0, low - this.prevLow);
          const flux = lf * 1.5 + Math.max(0, e - this.prevAll) * 0.5;
          this.lowFlux.push(lf);
          this.onset.push(flux);
          this.lowEnv.push(low);
          this.prevLow = low;
          this.prevAll = e;
          this.accLow = 0;
          this.accAll = 0;
          this.count = 0;
          this.hopIndex++;
        }
      }
    }
    /** 掩蔽爆炸时刻附近的低频通量，避免巨大的离网低频 onset 拉偏网格 */
    maskTimes(times, guardSec = 0.34) {
      const hopRate = this.sampleRate / HOP2;
      const g = Math.round(guardSec * hopRate);
      for (const t of times) {
        const ci = Math.round(t * hopRate);
        for (let i = Math.max(0, ci - g); i <= Math.min(this.lowFlux.length - 1, ci + g); i++) {
          this.lowFlux[i] = 0;
          this.onset[i] = 0;
        }
      }
    }
    finalize(durationSec) {
      const hopRate = this.sampleRate / HOP2;
      const env0 = this.lowFlux;
      const dur = durationSec ?? this.hopIndex / hopRate;
      if (env0.length < hopRate * 8) {
        return { bpm: 0, confidence: 0, beats: [], periodSec: 0, phaseSec: 0 };
      }
      const env = env0.map((_, i) => {
        let s = 0;
        let n = 0;
        for (let k = -1; k <= 1; k++) {
          const j = i + k;
          if (j >= 0 && j < env0.length) {
            s += env0[j];
            n++;
          }
        }
        return s / n;
      });
      const mean = env.reduce((a, b) => a + b, 0) / env.length;
      const x = env.map((v) => Math.max(0, v - mean * 0.4));
      const minLag = Math.round(60 / 168 * hopRate);
      const maxLag = Math.round(60 / 76 * hopRate);
      const corrAt = (lag) => {
        let c = 0;
        let n = 0;
        for (let i = lag; i < x.length; i++) {
          c += x[i] * x[i - lag];
          n++;
        }
        return n ? c / n : 0;
      };
      let bestLag = minLag;
      let bestCorr = -Infinity;
      for (let lag = minLag; lag <= maxLag; lag++) {
        const c = corrAt(lag);
        if (c > bestCorr) {
          bestCorr = c;
          bestLag = lag;
        }
      }
      const candidates = [bestLag, bestLag * 2, Math.round(bestLag / 2)].filter(
        (l) => l >= minLag && l <= maxLag
      );
      let chosenLag = bestLag;
      let chosenScore = bestCorr;
      for (const lag of candidates) {
        if (lag === bestLag) continue;
        const c = corrAt(lag);
        const bpm2 = 60 / (lag / hopRate);
        const prior = 1 - Math.min(0.3, Math.abs(Math.log2(bpm2 / 120)) * 0.45);
        const score = c * (0.85 + 0.3 * prior);
        if (score > chosenScore) {
          chosenScore = score;
          chosenLag = lag;
        }
      }
      const p0 = chosenLag / hopRate;
      const valueAt = (timeSec) => {
        const i = Math.round(timeSec * hopRate);
        let v = 0;
        for (let k = -1; k <= 1; k++) {
          const j = i + k;
          if (j >= 0 && j < env.length && env[j] > v) v = env[j];
        }
        return v;
      };
      const scoreGrid = (P, phi) => {
        let s = 0;
        let n = 0;
        for (let t = phi; t <= dur + 0.02; t += P) {
          s += valueAt(t);
          n++;
        }
        return n ? s / Math.sqrt(n) : 0;
      };
      let best = { P: p0, phi: 0, score: -Infinity };
      for (let dP = -5e-3; dP <= 501e-5; dP += 25e-5) {
        const P = p0 + dP;
        for (let phi = 0; phi < P; phi += 5e-3) {
          const s = scoreGrid(P, phi);
          if (s > best.score) best = { P, phi, score: s };
        }
      }
      const bp = best.phi;
      for (let dP = -4e-4; dP <= 401e-6; dP += 5e-5) {
        const P = best.P + dP;
        for (let dphi = -8e-3; dphi <= 801e-5; dphi += 1e-3) {
          let phi = bp + dphi;
          phi = (phi % P + P) % P;
          const s = scoreGrid(P, phi);
          if (s > best.score) best = { P, phi, score: s };
        }
      }
      const periodSec = best.P;
      const phaseSec = best.phi;
      const bpm = 60 / periodSec;
      const beats = [];
      const firstK = Math.ceil((0 - phaseSec) / periodSec);
      for (let k = firstK; ; k++) {
        const t = phaseSec + k * periodSec;
        if (t > dur + 0.05) break;
        if (t >= -0.02) beats.push(Math.max(0, t));
      }
      let on = 0;
      let off = 0;
      let onN = 0;
      let offN = 0;
      for (const b of beats) {
        on += valueAt(b);
        onN++;
        off += valueAt(b + periodSec / 2);
        offN++;
      }
      const ratio = onN && offN ? on / onN / (off / offN + 1e-6) : 1;
      const confidence = Math.max(0.25, Math.min(1, 0.35 + (ratio - 1) * 0.5));
      return { bpm, confidence, beats, periodSec, phaseSec };
    }
  };

  // src/worklets/show-worklet.ts
  function toMono(inputs) {
    const ch = inputs[0];
    if (!ch || ch.length === 0) return null;
    if (ch.length === 1) return ch[0];
    const a = ch[0];
    const b = ch[1];
    const out = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) out[i] = (a[i] + (b ? b[i] : a[i])) * 0.5;
    return out;
  }
  var ShowProcessor = class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      __publicField(this, "detector");
      __publicField(this, "beats");
      __publicField(this, "totalFrames");
      __publicField(this, "gain");
      __publicField(this, "hits", []);
      __publicField(this, "gridSent", false);
      const o = options?.processorOptions ?? {};
      const sr = o.sampleRate ?? 44100;
      this.totalFrames = o.totalFrames ?? 0;
      this.gain = o.gain ?? 1;
      this.detector = new ExplosionDetector(sr, { sensitivity: o.sensitivity ?? 0.55, inputGain: 1 });
      this.beats = new BeatTracker(sr);
    }
    process(inputs) {
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
          this.port.postMessage({ kind: "hits", hits: newHits });
        }
        this.beats.process(block);
      }
      if (this.totalFrames && currentFrame + 128 >= this.totalFrames && !this.gridSent) {
        this.gridSent = true;
        this.beats.maskTimes(this.hits.map((h) => h.time));
        const grid = this.beats.finalize(this.totalFrames / (this.detector.sampleRate || 44100));
        this.port.postMessage({ kind: "grid", grid });
        this.port.postMessage({ kind: "done", hitCount: this.hits.length });
      }
      return true;
    }
  };
  var ExplosionProcessor = class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      __publicField(this, "detector");
      const o = options?.processorOptions ?? {};
      this.detector = new ExplosionDetector(o.sampleRate ?? 44100, {
        sensitivity: o.sensitivity ?? 0.55,
        inputGain: o.gain ?? 1
      });
    }
    process(inputs) {
      const mono = toMono(inputs);
      if (mono) {
        const hits = this.detector.process(mono);
        for (const h of hits) this.port.postMessage({ kind: "hit", hit: h });
      }
      return true;
    }
  };
  var BeatProcessor = class extends AudioWorkletProcessor {
    constructor(options) {
      super();
      __publicField(this, "beats");
      __publicField(this, "totalFrames");
      __publicField(this, "sent", false);
      __publicField(this, "hitTimes", []);
      const o = options?.processorOptions ?? {};
      this.beats = new BeatTracker(o.sampleRate ?? 44100);
      this.totalFrames = o.totalFrames ?? 0;
      this.port.onmessage = (ev) => {
        const msg = ev.data;
        if (msg.kind === "mask" && msg.times) this.hitTimes = msg.times;
      };
    }
    process(inputs) {
      const mono = toMono(inputs);
      if (mono) this.beats.process(mono);
      if (this.totalFrames && currentFrame + 128 >= this.totalFrames && !this.sent) {
        this.sent = true;
        this.beats.maskTimes(this.hitTimes);
        this.port.postMessage({ kind: "grid", grid: this.beats.finalize() });
      }
      return true;
    }
  };
  registerProcessor("show-processor", ShowProcessor);
  registerProcessor("explosion-detector", ExplosionProcessor);
  registerProcessor("beat-tracker", BeatProcessor);
})();
