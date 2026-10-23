// AudioWorklet wrapper around StreamingLimiter (see js/capture-audio-guard.js). Runs on the audio thread.
import { StreamingLimiter } from "./streaming-limiter.js";

class ToastySafetyLimiter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.channels = Math.max(1, Math.min(2, o.channels || 2));
    this.limiter = new StreamingLimiter(sampleRate, this.channels, { ceilingDb: o.ceilingDb ?? -1, lookaheadMs: o.lookaheadMs ?? 5, releaseMs: o.releaseMs ?? 80 });
    this.zero = new Float32Array(128);
    this.sinceReport = 0;
    this.port.onmessage = (event) => { if (event.data?.type === "stats") this._report(); };
  }
  _report() {
    this.port.postMessage({ type: "stats", maxReductionDb: this.limiter.maxReductionDb, activeSeconds: this.limiter.activeSamples / sampleRate, seconds: this.limiter.n / sampleRate });
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
    this.limiter.process(ins, outs);
    this.sinceReport += frames;
    if (this.sinceReport >= sampleRate) { this.sinceReport = 0; this._report(); }
    return true;
  }
}
registerProcessor("toasty-safety-limiter", ToastySafetyLimiter);
