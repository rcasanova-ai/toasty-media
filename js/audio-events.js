// Audio events for clip detection: laughter, sudden loud reactions and long silences, found from 20 ms frame features.
// The same detector runs live (frames from an AudioWorklet on the microphone) and in batch (decoded samples of an upload).
//
// Laughter heuristic: a run of at least 5 energy bursts spanning a second or more at a steady 3 to 8 per second ("ha ha ha"), clearly above the room
// floor. Speech also has syllables, but at an irregular pace (high interval variation), which is what separates them here.
// It is a heuristic and will miss quiet or single-breath laughs; it is tuned to avoid false positives rather than catch all.

export const FRAME_SECONDS = 0.02;

export function frameFeatures(samples) {
  let sum = 0, crossings = 0, prev = samples[0] || 0;
  for (let i = 0; i < samples.length; i++) { const v = samples[i]; sum += v * v; if ((v >= 0) !== (prev >= 0)) crossings++; prev = v; }
  const rms = Math.sqrt(sum / (samples.length || 1));
  return { rmsDb: rms > 0 ? 20 * Math.log10(rms) : -120, zcr: crossings / (samples.length || 1) };
}

export class AudioEventDetector {
  constructor({ onEvent, minLaughBursts = 5 } = {}) {
    this.onEvent = onEvent;
    this.minLaughBursts = minLaughBursts;
    this.t = 0;
    this.env = new Float32Array(64);   // ring of the most recent smoothed envelope values (dB)
    this._envN = 0;
    this.floorDb = -60;            // slowly tracked room floor
    this.speechDb = -30;           // slowly tracked speech level
    this.events = [];
    this._silenceFrom = null;
    this._spikeCooldown = 0;
    this._laugh = null;            // { start, lastBurst, bursts: [times] }
    this._lastPeakAt = -1;
    this._lastEnv = -120; this._rising = false; this._risePeak = -120;
    this._frame = 0;
  }

  pushFrames(frames, t0 = this._frame * FRAME_SECONDS) { for (let i = 0; i < frames.length; i++) this.pushFrame(frames[i], t0 + i * FRAME_SECONDS); }

  _emit(ev) { this.events.push(ev); this.onEvent?.(ev); }

  pushFrame({ rmsDb, zcr }, t = this._frame * FRAME_SECONDS) {
    this._frame++;
    this.t = t;
    const db = Number.isFinite(rmsDb) ? rmsDb : -120;
    const smooth = this._envN ? 0.5 * this.env[(this._envN - 1) % 64] + 0.5 * db : db;
    this.env[this._envN % 64] = smooth;
    this._envN++;
    // Floor falls fast, rises slowly; speech level is the slowly tracked loud end.
    this.floorDb = db < this.floorDb ? this.floorDb * 0.9 + db * 0.1 : this.floorDb + (db - this.floorDb) * 0.0005;
    if (db > this.speechDb) this.speechDb = this.speechDb * 0.8 + db * 0.2; else this.speechDb += (db - this.speechDb) * 0.0004;

    // Silence: below the floor margin for 3 s or more.
    const quiet = db < this.floorDb + 4 || db < -62;
    if (quiet) { if (this._silenceFrom == null) this._silenceFrom = t; }
    else if (this._silenceFrom != null) { if (t - this._silenceFrom >= 3) this._emit({ type: "silence", t: this._silenceFrom, end: t }); this._silenceFrom = null; }

    // Sudden loud reaction: well above the usual speech level.
    this._spikeCooldown = Math.max(0, this._spikeCooldown - FRAME_SECONDS);
    if (db > this.speechDb + 9 && db > -20 && !this._spikeCooldown) { this._emit({ type: "spike", t, end: t + 0.4, level: db }); this._spikeCooldown = 3; }

    // Burst train: local maxima of the envelope that rise at least 5 dB out of the preceding dip.
    const cur = smooth;
    if (cur > this._lastEnv) { if (!this._rising) { this._rising = true; this._risePeak = cur; } this._risePeak = Math.max(this._risePeak, cur); }
    else if (this._rising && cur < this._lastEnv) {
      this._rising = false;
      const peakDb = this._lastEnv;
      let dip = Infinity;
      for (let k = 1; k <= 14 && k <= this._envN; k++) { const v = this.env[(this._envN - k) % 64]; if (v < dip) dip = v; }
      if (peakDb - dip >= 5 && peakDb > this.floorDb + 10) this._onBurst(t - FRAME_SECONDS, peakDb, zcr);
    }
    this._lastEnv = cur;
    if (this._laugh && t - this._laugh.lastBurst > 0.7) this._closeLaugh(t);
  }

  _onBurst(t, peakDb, zcr) {
    const L = this._laugh;
    if (L && t - L.lastBurst <= 0.5) { L.bursts.push(t); L.levels.push(peakDb); L.lastBurst = t; }
    else { if (L) this._closeLaugh(t); this._laugh = { start: t, lastBurst: t, bursts: [t], levels: [peakDb] }; }
  }

  _closeLaugh(t) {
    const L = this._laugh; this._laugh = null;
    if (!L || L.bursts.length < this.minLaughBursts) return;
    const gaps = L.bursts.slice(1).map((b, i) => b - L.bursts[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const cv = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / gaps.length) / mean;
    const rate = 1 / mean;
    const span = L.lastBurst - L.start;
    // Real laughs last about a second or more; shorter bursts (a cough, a clap, a noise burst) are not reported.
    if (rate >= 3 && rate <= 8 && cv <= 0.25 && span >= 1) this._emit({ type: "laughter", t: L.start - 0.1, end: L.lastBurst + 0.3, bursts: L.bursts.length, rate: Math.round(rate * 10) / 10, regularity: Math.round((1 - cv) * 100) / 100 });
  }

  finish(t = this.t) {
    if (this._silenceFrom != null && t - this._silenceFrom >= 3) this._emit({ type: "silence", t: this._silenceFrom, end: t });
    this._silenceFrom = null;
    if (this._laugh) this._closeLaugh(t);
    return this.events;
  }
}

// Batch: decoded mono samples -> events. Frames are 20 ms.
export function detectAudioEvents(samples, sampleRate) {
  const hop = Math.round(sampleRate * FRAME_SECONDS);
  const det = new AudioEventDetector();
  for (let i = 0; i + hop <= samples.length; i += hop) det.pushFrame(frameFeatures(samples.subarray(i, i + hop)), i / sampleRate);
  return det.finish(samples.length / sampleRate);
}
