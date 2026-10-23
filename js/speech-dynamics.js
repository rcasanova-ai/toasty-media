// Speech-safe dynamics, written once and used three ways: live in the Studio recorder (js/recording-leveler.js), live in the
// Clips mixer (js/clip-mixer.js) and offline over decoded audio (js/audio-enhance.js). Pure sample maths with no Web Audio
// dependency, so the same code runs inside an AudioWorklet and in Node tests.
//
// The rules that keep speech natural:
//   - Gain only moves while someone is talking. Pauses hold the last gain, so room noise is never "ridden up" between words.
//   - "Talking" is judged against the room, not an absolute level: the level must sit well above the tracked noise floor AND
//     within a window of the recent speech level (a quiet room tone that is merely louder than digital silence is not speech).
//   - Gain moves slowly (a few dB per second) so it is not heard as pumping. The one exception is a sudden burst well above the
//     target (laughter, a bump), which pulls the gain down fast so a boosted quiet voice cannot slam the limiter.
//   - Compression is gentle (2:1, soft knee) and only touches peaks above a threshold set relative to the target level.

export const dbOf = (x) => (x > 1e-12 ? 20 * Math.log10(x) : -240);
export const linOf = (db) => 10 ** (db / 20);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Noise floor: follows the quietest recent level down instantly and drifts back up slowly, so it settles on the room tone
// between words and sentences without needing a silent lead-in.
export class FloorTracker {
  constructor({ riseDbPerSec = 0.5 } = {}) { this.riseDbPerSec = riseDbPerSec; this.floorDb = null; }
  update(levelDb, dt) {
    if (this.floorDb === null) this.floorDb = levelDb;
    else if (levelDb < this.floorDb) this.floorDb = levelDb;
    else this.floorDb = Math.min(levelDb, this.floorDb + this.riseDbPerSec * dt);
    return this.floorDb;
  }
}

export class SpeechLeveler {
  constructor(sampleRate, options = {}) {
    this.sampleRate = sampleRate;
    this.o = {
      targetDb: -20,            // speech level (400 ms RMS) the leveler steers toward
      maxBoostDb: 12, maxCutDb: 12,
      gateAboveFloorDb: 12,     // speech must be at least this far above the noise floor
      speechWindowDb: 15,       // ...and within this far below the recent speech level
      absGateDb: -66,           // never treat anything quieter than this as speech
      floorCeilDb: -48,         // a "floor" above this is the content itself (a take with no pauses), not room tone
      upDbPerSec: 3, downDbPerSec: 6,
      fastUpDbPerSec: 12, fastSeconds: 0,   // optional quicker lift during the first seconds of speech (a recording that starts quiet)
      fastDownDbPerSec: 80, burstAboveTargetDb: 12,   // burst protection
      rmsMs: 400, shortMs: 60, floorRiseDbPerSec: 0.5, speechRefDecayDbPerSec: 0.4,
      ...options
    };
    this.floor = new FloorTracker({ riseDbPerSec: this.o.floorRiseDbPerSec });
    this.ms = null; this.msShort = null;
    this.gainDb = 0; this.speechRefDb = -Infinity; this.speechSeconds = 0;
    this.stats = { seconds: 0, speechSeconds: 0, maxGainDb: 0, gainTimeSumDb: 0, gainTimeSeconds: 0, minLevelDb: Infinity };
  }

  get speaking() { return this._speaking === true; }

  // ins/outs: arrays of Float32Array, one per channel, same length (a worklet block, or any slice). outs may alias ins.
  processBlock(ins, outs) {
    const o = this.o, n = ins[0].length, ch = ins.length, dt = n / this.sampleRate;
    let energy = 0;
    for (let c = 0; c < ch; c++) { const a = ins[c]; for (let i = 0; i < n; i++) energy += a[i] * a[i]; }
    const blockMs = energy / (n * ch);
    const aLong = Math.exp(-dt / (o.rmsMs / 1000)), aShort = Math.exp(-dt / (o.shortMs / 1000));
    this.ms = this.ms === null ? blockMs : aLong * this.ms + (1 - aLong) * blockMs;
    this.msShort = this.msShort === null ? blockMs : aShort * this.msShort + (1 - aShort) * blockMs;
    const levelDb = 10 * Math.log10(this.ms + 1e-24), shortDb = 10 * Math.log10(this.msShort + 1e-24);
    const floorDb = this.floor.update(shortDb, dt);
    const gate = Math.max(o.absGateDb, Math.min(floorDb, o.floorCeilDb) + o.gateAboveFloorDb, this.speechRefDb - o.speechWindowDb);
    const speaking = levelDb > gate;
    this._speaking = speaking;
    if (speaking) {
      this.speechRefDb = Math.max(levelDb, this.speechRefDb === -Infinity ? levelDb : this.speechRefDb - o.speechRefDecayDbPerSec * dt);
      this.speechSeconds += dt;
      const want = clamp(o.targetDb - levelDb, -o.maxCutDb, o.maxBoostDb);
      if (want > this.gainDb) {
        const up = this.speechSeconds < o.fastSeconds ? o.fastUpDbPerSec : o.upDbPerSec;
        this.gainDb = Math.min(want, this.gainDb + up * dt);
      } else this.gainDb = Math.max(want, this.gainDb - o.downDbPerSec * dt);
    }
    // Burst protection (laughter, a bump, someone leaning into the mic) runs whether or not the slow estimate calls it speech: a
    // short-term level far above the target means any boost is wrong right now, so the gain drops quickly toward what that level needs.
    // Ordinary loud syllables sit well under this threshold, so it does not chop normal speech.
    if (shortDb > o.targetDb + o.burstAboveTargetDb) {
      const burstWant = clamp(o.targetDb - shortDb, -o.maxCutDb, o.maxBoostDb);
      if (this.gainDb > burstWant) this.gainDb = Math.max(burstWant, this.gainDb - o.fastDownDbPerSec * dt);
    }
    const g0 = this._lastGain ?? linOf(this.gainDb), g1 = linOf(this.gainDb);
    this._lastGain = g1;
    for (let c = 0; c < ch; c++) {
      const a = ins[c], b = outs[c];
      if (g0 === g1) for (let i = 0; i < n; i++) b[i] = a[i] * g1;
      else for (let i = 0; i < n; i++) b[i] = a[i] * (g0 + (g1 - g0) * (i + 1) / n);
    }
    const s = this.stats;
    s.seconds += dt; if (speaking) s.speechSeconds += dt;
    if (this.gainDb > s.maxGainDb) s.maxGainDb = this.gainDb;
    if (speaking) { s.gainTimeSumDb += this.gainDb * dt; s.gainTimeSeconds += dt; }
    if (levelDb < s.minLevelDb) s.minLevelDb = levelDb;
    return this.gainDb;
  }

  get averageSpeechGainDb() { return this.stats.gainTimeSeconds ? this.stats.gainTimeSumDb / this.stats.gainTimeSeconds : 0; }
}

// Gentle feed-forward compressor. The detector is a short RMS (20 ms), not a peak hold: a peak detector with a release treats every
// plosive as a reason to turn the following vowel down (audible pumping, and it costs far more loudness than it saves in peaks).
// Gain is computed in dB (2:1, soft knee by default) and smoothed with attack/release; transient peaks that the RMS view lets through are
// left to the look-ahead limiter. `thresholdDb` is a short-term RMS level in dBFS.
export class SpeechCompressor {
  constructor(sampleRate, { thresholdDb = -22, ratio = 2, kneeDb = 6, attackMs = 10, releaseMs = 150, rmsMs = 20 } = {}) {
    Object.assign(this, { sampleRate, thresholdDb, ratio, kneeDb, attackMs, releaseMs, rmsMs });
    this.grDb = 0; this._last = 1; this.maxReductionDb = 0; this.ms = null;
  }
  processBlock(ins, outs) {
    const n = ins[0].length, ch = ins.length, dt = n / this.sampleRate;
    let energy = 0;
    for (let c = 0; c < ch; c++) { const a = ins[c]; for (let i = 0; i < n; i++) energy += a[i] * a[i]; }
    const a = Math.exp(-dt / (this.rmsMs / 1000)), block = energy / (n * ch);
    this.ms = this.ms === null ? block : a * this.ms + (1 - a) * block;
    const over = 10 * Math.log10(this.ms + 1e-24) - this.thresholdDb, slope = 1 - 1 / this.ratio, k = this.kneeDb;
    let target = 0;
    if (this.ratio > 1) {
      if (k > 0 && over > -k / 2 && over < k / 2) target = -slope * ((over + k / 2) ** 2) / (2 * k);
      else if (over >= k / 2) target = -slope * over;
    }
    const coef = Math.exp(-dt / ((target < this.grDb ? this.attackMs : this.releaseMs) / 1000));
    this.grDb = target + (this.grDb - target) * coef;
    if (this.grDb < this.maxReductionDb) this.maxReductionDb = this.grDb;
    const g0 = this._last, g1 = linOf(this.grDb);
    this._last = g1;
    for (let c = 0; c < ch; c++) { const x = ins[c], y = outs[c]; for (let i = 0; i < n; i++) y[i] = x[i] * (g0 + (g1 - g0) * (i + 1) / n); }
  }
}

// Downward expander for noise reduction that cannot eat quiet speech: reduction is zero once the level is `openAboveFloorDb`
// over the tracked floor, scales smoothly down to `maxReductionDb` only for material sitting AT the floor, and never exceeds
// that cap (default 8 dB). It is relative to the measured floor, so a quiet voice is only affected if it is almost as quiet as the room.
export class NoiseExpander {
  constructor(sampleRate, { maxReductionDb = 8, closeAboveFloorDb = 3, openAboveFloorDb = 12, attackMs = 10, releaseMs = 150, floor = null } = {}) {
    Object.assign(this, { sampleRate, maxReductionDb, closeAboveFloorDb, openAboveFloorDb, attackMs, releaseMs });
    this.floor = floor || new FloorTracker();
    this.ownFloor = !floor;
    this.ms = null; this.redDb = 0; this._last = 1;
  }
  processBlock(ins, outs) {
    const n = ins[0].length, ch = ins.length, dt = n / this.sampleRate;
    let energy = 0;
    for (let c = 0; c < ch; c++) { const a = ins[c]; for (let i = 0; i < n; i++) energy += a[i] * a[i]; }
    const a30 = Math.exp(-dt / 0.03);
    this.ms = this.ms === null ? energy / (n * ch) : a30 * this.ms + (1 - a30) * energy / (n * ch);
    const levelDb = 10 * Math.log10(this.ms + 1e-24);
    const floorDb = this.ownFloor ? this.floor.update(levelDb, dt) : (this.floor.floorDb ?? levelDb);
    const t = clamp((levelDb - (floorDb + this.closeAboveFloorDb)) / (this.openAboveFloorDb - this.closeAboveFloorDb), 0, 1);
    const target = -this.maxReductionDb * (1 - t * t * (3 - 2 * t));
    const coef = Math.exp(-dt / ((target > this.redDb ? this.attackMs : this.releaseMs) / 1000));
    this.redDb = target + (this.redDb - target) * coef;
    const g0 = this._last, g1 = linOf(this.redDb);
    this._last = g1;
    for (let c = 0; c < ch; c++) { const x = ins[c], y = outs[c]; for (let i = 0; i < n; i++) y[i] = x[i] * (g0 + (g1 - g0) * (i + 1) / n); }
  }
}

// Run a block processor over whole channels (Node tests and the offline chain). Returns new Float32Arrays.
export function processChannels(processor, channels, block = 128) {
  const n = channels[0].length, out = channels.map(() => new Float32Array(n));
  for (let s = 0; s < n; s += block) {
    const e = Math.min(n, s + block);
    processor.processBlock(channels.map((c) => c.subarray(s, e)), out.map((c) => c.subarray(s, e)));
  }
  return out;
}
