// Clip audio mixer: the clip's voice (optionally enhanced) + background music ducked under the voice, then a peak limiter at
// -2.5 dBFS (AAC encoding can overshoot its input by 1 to 2 dB, measured, so the exported file lands near -1.5 dBTP).
// Pure DSP on blocks of Float32Array, so the same code runs in an AudioWorklet during a render and in Node tests.
//
// Voice chain when enhancement is on (js/speech-dynamics.js): 80 Hz high-pass -> optional noise expander (capped, relative to the
// measured noise floor, so quiet speech is not eaten) -> the planned static gain `preGainDb` (the renderer measures the clip's
// loudness first and passes exactly the gain needed to reach the target, js/loudness-plan.js) -> slow speech leveler that evens
// out quiet and loud passages around that level -> gentle compressor on peaks -> limiter. A source that is already at the target
// gets ~0 dB of static gain; a source 29 dB too quiet gets ~29 dB.
//
// Without a plan (preGainDb unset) the leveler alone lifts up to `maxBoostDb` (12 dB), as before.
//
// Ducking follows the processed voice: music drops by `duckDb` within ~80 ms of speech starting and comes back over ~0.5 s after it stops.
import { StreamingLimiter } from "./streaming-limiter.js";
import { FloorTracker, NoiseExpander, SpeechCompressor, SpeechLeveler } from "./speech-dynamics.js";

const dbToLin = (db) => 10 ** (db / 20);
const linToDb = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -180);

class Highpass {
  constructor(sr, freq) {
    const w0 = 2 * Math.PI * freq / sr, cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.SQRT1_2), a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0; this.b1 = -(1 + cos) / a0; this.b2 = this.b0; this.a1 = -2 * cos / a0; this.a2 = (1 - alpha) / a0;
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  run(x) { const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2; this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y; return y; }
}

export class ClipMixer {
  constructor(sampleRate, {
    channels = 2, enhance = true, musicGainDb = -20, duckDb = -14, targetRmsDb = null, maxBoostDb = 12, ceilingDb = -2.5,
    preGainDb = null, noiseReduction = false, compress = null, fxDuckRatio = 0.5
  } = {}) {
    Object.assign(this, { sampleRate, channels, enhance, musicGainDb, duckDb, targetRmsDb, maxBoostDb, fxDuckRatio });
    const planned = Number.isFinite(preGainDb);
    // The leveler's 400 ms RMS (pauses included) sits about 6.6 dB under the gated loudness; with a plan the voice is already at -16 LUFS, so -22.6.
    targetRmsDb = Number.isFinite(targetRmsDb) ? targetRmsDb : (planned ? -22.6 : -20);
    this.targetRmsDb = targetRmsDb;
    this.preGainDb = planned ? preGainDb : 0;
    this.hp = Array.from({ length: channels }, () => new Highpass(sampleRate, 80));
    this.limiter = new StreamingLimiter(sampleRate, channels, { ceilingDb, lookaheadMs: 5, releaseMs: 90, truePeak: true });
    // With a plan the static gain does the heavy lifting and the leveler only rides +/- 8 dB around it; with no plan it works alone.
    this.leveler = new SpeechLeveler(sampleRate, planned
      ? { targetDb: targetRmsDb, maxBoostDb: 8, maxCutDb: 10, upDbPerSec: 3, downDbPerSec: 6 }
      : { targetDb: targetRmsDb, maxBoostDb, maxCutDb: 12, upDbPerSec: 3, downDbPerSec: 6, absGateDb: -48 });
    this.compressor = (compress === false || !planned) ? null : new SpeechCompressor(sampleRate, { thresholdDb: targetRmsDb + 2.6, ratio: 2, kneeDb: 6, ...(compress || {}) });
    this.expander = noiseReduction ? new NoiseExpander(sampleRate, { maxReductionDb: 8, floor: new FloorTracker() }) : null;
    this.env = -120;              // voice envelope for ducking (dB)
    this.duckNow = 0;             // current duck amount in dB (0 = none, negative = reduced)
    this.musicBoostDb = 0;        // set by the render for intro/outro, where there is no voice
    this.lastDuckDb = 0; this.minDuckDb = 0;
    this._inF = new Float32Array(channels); this._outF = new Float32Array(channels);
    this._buf = null; this._tmp = null;
  }

  setMusicBoost(db) { this.musicBoostDb = db; }

  get levelDb() { return this.leveler.gainDb; }

  _ensure(n) {
    if (this._buf && this._buf[0].length >= n) return;
    this._buf = Array.from({ length: this.channels }, () => new Float32Array(n));
    this._tmp = Array.from({ length: this.channels }, () => new Float32Array(n));
  }

  // voice: array of Float32Array (null/empty allowed), music: same, out: array of Float32Array to fill.
  // dry (optional): arrays to receive the mix as it enters the limiter, for measuring how hard the limiter works (js/clip-loudness.js).
  // fx (optional): sound accents. They duck under the voice too, but only by a fraction of the music's duck (fxDuckRatio), so a whoosh
  // stays audible between words and is still pushed well under speech.
  process(voice, music, out, dry = null, fx = null) {
    const frames = out[0].length, sr = this.sampleRate;
    this._ensure(frames);
    const envA = Math.exp(-1 / (0.08 * sr)), envR = Math.exp(-1 / (0.5 * sr));
    const musicBase = this.musicGainDb + this.musicBoostDb;
    const lim = this.limiter, inF = this._inF, outF = this._outF;
    const v = this._buf.map((b) => b.subarray(0, frames)), t = this._tmp.map((b) => b.subarray(0, frames));
    for (let c = 0; c < this.channels; c++) {
      const src = voice?.[c] ?? voice?.[0];
      for (let i = 0; i < frames; i++) v[c][i] = src ? (this.enhance ? this.hp[c].run(src[i]) : src[i]) : 0;
    }
    if (this.enhance) {
      if (this.expander) { this.expander.processBlock(v, t); for (let c = 0; c < this.channels; c++) v[c].set(t[c]); }
      if (this.preGainDb) { const g = dbToLin(this.preGainDb); for (let c = 0; c < this.channels; c++) for (let i = 0; i < frames; i++) v[c][i] *= g; }
      this.leveler.processBlock(v, t);
      for (let c = 0; c < this.channels; c++) v[c].set(t[c]);
      if (this.compressor) { this.compressor.processBlock(v, t); for (let c = 0; c < this.channels; c++) v[c].set(t[c]); }
    }
    for (let i = 0; i < frames; i++) {
      let vmax = 0;
      for (let c = 0; c < this.channels; c++) { const a = Math.abs(v[c][i]); if (a > vmax) vmax = a; }
      // Envelope of the processed voice drives the music duck.
      const vdb = linToDb(vmax);
      this.env = vdb > this.env ? this.env * envA + vdb * (1 - envA) : this.env * envR + vdb * (1 - envR);
      const targetDuck = this.env > -46 ? this.duckDb : 0;
      this.duckNow += (targetDuck - this.duckNow) * (targetDuck < this.duckNow ? 1 - envA : 1 - envR);
      const mg = dbToLin(musicBase + this.duckNow), fg = dbToLin(this.duckNow * this.fxDuckRatio);
      for (let c = 0; c < this.channels; c++) {
        const m = music?.[c]?.[i] ?? music?.[0]?.[i] ?? 0;
        inF[c] = v[c][i] + m * mg + (fx ? (fx[c]?.[i] ?? fx[0]?.[i] ?? 0) * fg : 0);
      }
      if (dry) for (let c = 0; c < this.channels; c++) dry[c][i] = inF[c];
      lim._step(inF, outF);
      for (let c = 0; c < this.channels; c++) out[c][i] = outF[c];
    }
    this.lastDuckDb = this.duckNow; this.minDuckDb = Math.min(this.minDuckDb, this.duckNow);
  }

  get latencySamples() { return this.limiter.latencySamples; }
}
