// AudioWorklet wrapper for ClipMixer. Input 0 = the clip's own audio, input 1 = background music, output 0 = the mix.
import { ClipMixer } from "./clip-mixer.js";

class ToastyClipMixer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options?.processorOptions || {};
    this.mixer = new ClipMixer(sampleRate, {
      channels: 2, enhance: o.enhance !== false, musicGainDb: o.musicGainDb ?? -20, duckDb: o.duckDb ?? -14,
      preGainDb: Number.isFinite(o.preGainDb) ? o.preGainDb : null, noiseReduction: o.noiseReduction === true,
      ...(Number.isFinite(o.targetRmsDb) ? { targetRmsDb: o.targetRmsDb } : {}), ...(Number.isFinite(o.ceilingDb) ? { ceilingDb: o.ceilingDb } : {})
    });
    this.silence = new Float32Array(128);
    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (typeof d.musicBoostDb === "number") this.mixer.setMusicBoost(d.musicBoostDb);
      if (d.type === "stats") this.port.postMessage({ type: "stats", minDuckDb: this.mixer.minDuckDb, levelDb: this.mixer.levelDb, limiterMaxReductionDb: this.mixer.limiter.maxReductionDb, compressorMaxReductionDb: this.mixer.compressor?.maxReductionDb ?? 0, speechGainAvgDb: this.mixer.leveler.averageSpeechGainDb });
    };
  }
  process(inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (this.silence.length < n) this.silence = new Float32Array(n);
    const voice = inputs[0]?.length ? inputs[0] : [this.silence, this.silence];
    const music = inputs[1]?.length ? inputs[1] : [this.silence, this.silence];
    const fx = inputs[2]?.length ? inputs[2] : null;
    this.mixer.process([voice[0], voice[1] || voice[0]], [music[0], music[1] || music[0]], [out[0], out[1] || out[0]], null, fx ? [fx[0], fx[1] || fx[0]] : null);
    return true;
  }
}
registerProcessor("toasty-clip-mixer", ToastyClipMixer);
