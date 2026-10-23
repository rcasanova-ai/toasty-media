// AudioWorklet wrapper around StreamingLimiter (see js/capture-audio-guard.js). Runs on the audio thread.
import { StreamingLimiter } from "./streaming-limiter.js";
import { RecordingLeveler } from "./recording-leveler.js";

class ToastySafetyLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.channels = Math.max(1, Math.min(2, o.channels || 2));
    // The limiter, optionally preceded by the quiet-voice leveler (js/recording-leveler.js) and always with loudness figures.
    this.rec = new RecordingLeveler(sampleRate, this.channels, { enabled: o.leveler !== false, ceilingDb: o.ceilingDb ?? -1, lookaheadMs: o.lookaheadMs ?? 5, releaseMs: o.releaseMs ?? 80, ...(o.levelerOptions || {}) });
    this.limiter = this.rec.limiter;
    this.zero = new Float32Array(128);
    this.sinceReport = 0;
    this.port.onmessage = (event) => { if (event.data?.type === "stats") this._report(); else if (event.data?.type === "final") this.port.postMessage({ type: "final", ...this.rec.finalStats() }); };
  }
  _report() {
    this.port.postMessage({ type: "stats", maxReductionDb: this.limiter.maxReductionDb, activeSeconds: this.limiter.activeSamples / sampleRate, seconds: this.limiter.n / sampleRate, level: this.rec.stats() });
  }
  process(inputs, outputs) {
    const input = inputs[0], output = outputs[0];
    const frames = output[0]?.length || 128;
    if (this.zero.length < frames) this.zero = new Float32Array(frames);
    const ins = [], outs = [];
    for (let c = 0; c < this.channels; c++) {
      ins.push(input[c] || input[0] || this.zero.subarray(0, frames));
      outs.push(output[c] || output[0]);
    }
    // Fail open: if the processing ever throws, hand the input through unchanged rather than record silence.
    if (!this.failed) {
      try { this.rec.process(ins, outs); } catch (error) { this.failed = true; this.port.postMessage({ type: "error", message: String(error?.message || error) }); }
    }
    if (this.failed) for (let c = 0; c < outs.length; c++) { const src = ins[c] || ins[0]; for (let i = 0; i < frames; i++) outs[c][i] = src[i]; }
    this.sinceReport += frames;
    if (this.sinceReport >= sampleRate) { this.sinceReport = 0; this._report(); }
    return true;
  }
}
registerProcessor("toasty-safety-limiter", ToastySafetyLimiter);
