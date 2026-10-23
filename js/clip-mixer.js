// Clip audio mixer: voice (optionally enhanced) + background music ducked under the voice, then a peak limiter at -3 dBFS (AAC encoding can overshoot its input by 1 to 2 dB, measured).
// Pure DSP on blocks of Float32Array, so the same code runs in an AudioWorklet during a render and in Node tests.
//
// Enhancement is a LIVE chain because a render plays the clip in real time and the source can be an hour long (it cannot be
// decoded whole): 80 Hz high-pass, then a slow leveler that moves the voice toward a steady level (never boosting silence or
// room noise, capped at +12 dB), then the limiter. Ducking follows the processed voice: music drops by `duckDb` within ~80 ms
// of speech starting and comes back over ~0.5 s after it stops.
import { StreamingLimiter } from "./streaming-limiter.js";

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
  constructor(sampleRate, { channels = 2, enhance = true, musicGainDb = -20, duckDb = -14, targetRmsDb = -20, maxBoostDb = 12, ceilingDb = -3 } = {}) {
    Object.assign(this, { sampleRate, channels, enhance, musicGainDb, duckDb, targetRmsDb, maxBoostDb });
    this.hp = Array.from({ length: channels }, () => new Highpass(sampleRate, 80));
    this.limiter = new StreamingLimiter(sampleRate, channels, { ceilingDb, lookaheadMs: 5, releaseMs: 90 });
    this.voiceRms = 0;            // short RMS (about 400 ms)
    this.levelDb = 0;             // current leveler gain in dB
    this.env = -120;              // voice envelope for ducking (dB)
    this.duckNow = 0;             // current duck amount in dB (0 = none, negative = reduced)
    this.musicBoostDb = 0;        // set by the render for intro/outro, where there is no voice
    this.lastDuckDb = 0; this.minDuckDb = 0;
    this._inF = new Float32Array(channels); this._outF = new Float32Array(channels);
  }

  setMusicBoost(db) { this.musicBoostDb = db; }

  // voice: array of Float32Array (null/empty allowed), music: same, out: array of Float32Array to fill.
  process(voice, music, out) {
    const frames = out[0].length, sr = this.sampleRate;
    const rmsCoef = Math.exp(-1 / (0.4 * sr)), envA = Math.exp(-1 / (0.08 * sr)), envR = Math.exp(-1 / (0.5 * sr));
    const upPerSample = 3 / sr, downPerSample = 6 / sr;       // leveler slew: dB per second / sr
    const musicBase = this.musicGainDb + this.musicBoostDb;
    const lim = this.limiter, inF = this._inF, outF = this._outF;
    for (let i = 0; i < frames; i++) {
      let vmax = 0;
      const v = new Array(this.channels);
      for (let c = 0; c < this.channels; c++) {
        let x = voice?.[c]?.[i] ?? voice?.[0]?.[i] ?? 0;
        if (this.enhance) x = this.hp[c].run(x);
        v[c] = x;
        const a = Math.abs(x); if (a > vmax) vmax = a;
      }
      this.voiceRms = rmsCoef * this.voiceRms + (1 - rmsCoef) * vmax * vmax;
      const rmsDb = linToDb(Math.sqrt(this.voiceRms));
      if (this.enhance) {
        // Level toward the target only while there is speech; hold the gain through pauses and never lift room noise.
        if (rmsDb > -48) {
          const want = Math.max(-12, Math.min(this.maxBoostDb, this.targetRmsDb - rmsDb));
          if (want > this.levelDb) this.levelDb = Math.min(want, this.levelDb + upPerSample); else this.levelDb = Math.max(want, this.levelDb - downPerSample);
        }
      }
      const g = this.enhance ? dbToLin(this.levelDb) : 1;
      // Envelope of the processed voice drives the music duck.
      const vdb = linToDb(vmax * g);
      this.env = vdb > this.env ? this.env * envA + vdb * (1 - envA) : this.env * envR + vdb * (1 - envR);
      const targetDuck = this.env > -46 ? this.duckDb : 0;
      this.duckNow += (targetDuck - this.duckNow) * (targetDuck < this.duckNow ? 1 - envA : 1 - envR);
      const mg = dbToLin(musicBase + this.duckNow);
      for (let c = 0; c < this.channels; c++) {
        const m = music?.[c]?.[i] ?? music?.[0]?.[i] ?? 0;
        inF[c] = v[c] * g + m * mg;
      }
      lim._step(inF, outF);
      for (let c = 0; c < this.channels; c++) out[c][i] = outF[c];
    }
    this.lastDuckDb = this.duckNow; this.minDuckDb = Math.min(this.minDuckDb, this.duckNow);
  }

  get latencySamples() { return this.limiter.latencySamples; }
}
