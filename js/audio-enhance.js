// Optional, gentle voice enhancement. Never applied to the original: callers keep the untouched recording and write
// the enhanced result next to it.
//
// Chain (all stages are conservative, speech-safe defaults):
//   high-pass 80 Hz  ->  optional noise reduction (soft downward expander, capped)  ->  gentle compressor (2:1, soft knee)
//   ->  loudness normalisation to the target (default -16 LUFS, the common podcast/online-video level; gain is capped
//   so a quiet noisy room is not boosted into hiss)  ->  look-ahead peak limiter at -1 dBFS (no clipping, no overs).
//
// Two implementations of ONE set of defaults: processChannels() works on decoded samples in the browser/Node,
// and buildFfmpegEnhanceFilters() gives the equivalent streaming ffmpeg chain for hour-long files on the server/CLI.
import { measureLoudness, toDbfs } from "./audio-analysis.js";
import { StreamingLimiter } from "./streaming-limiter.js";

export const ENHANCE_DEFAULTS = Object.freeze({
  highpassHz: 80,
  compressor: Object.freeze({ thresholdDb: -24, ratio: 2, attackMs: 15, releaseMs: 200, kneeDb: 6 }),
  targetLufs: -16,
  maxBoostDb: 12,        // never amplify a quiet recording by more than this; beyond it you are mostly raising noise
  maxCutDb: 18,
  limiterCeilingDb: -1,
  limiterLookaheadMs: 5,
  limiterReleaseMs: 80,
  noiseReduction: Object.freeze({ enabled: false, maxReductionDb: 8, attackMs: 10, releaseMs: 150 })
});

export function normalizeEnhanceOptions(options = {}) {
  const d = ENHANCE_DEFAULTS;
  const clamp = (v, lo, hi, fallback) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback);
  return {
    highpassHz: clamp(options.highpassHz, 0, 300, d.highpassHz),
    compressor: {
      thresholdDb: clamp(options.compressor?.thresholdDb, -60, 0, d.compressor.thresholdDb),
      ratio: clamp(options.compressor?.ratio, 1, 4, d.compressor.ratio), // above 4:1 stops being "gentle"
      attackMs: clamp(options.compressor?.attackMs, 1, 100, d.compressor.attackMs),
      releaseMs: clamp(options.compressor?.releaseMs, 20, 1000, d.compressor.releaseMs),
      kneeDb: clamp(options.compressor?.kneeDb, 0, 24, d.compressor.kneeDb)
    },
    targetLufs: clamp(options.targetLufs, -30, -10, d.targetLufs),
    maxBoostDb: clamp(options.maxBoostDb, 0, 24, d.maxBoostDb),
    maxCutDb: clamp(options.maxCutDb, 0, 40, d.maxCutDb),
    limiterCeilingDb: clamp(options.limiterCeilingDb, -6, -0.1, d.limiterCeilingDb),
    limiterLookaheadMs: clamp(options.limiterLookaheadMs, 1, 20, d.limiterLookaheadMs),
    limiterReleaseMs: clamp(options.limiterReleaseMs, 10, 500, d.limiterReleaseMs),
    noiseReduction: {
      enabled: Boolean(options.noiseReduction?.enabled),
      maxReductionDb: clamp(options.noiseReduction?.maxReductionDb, 0, 15, d.noiseReduction.maxReductionDb), // capped: more sounds artificial
      attackMs: clamp(options.noiseReduction?.attackMs, 1, 100, d.noiseReduction.attackMs),
      releaseMs: clamp(options.noiseReduction?.releaseMs, 20, 1000, d.noiseReduction.releaseMs)
    }
  };
}

const dbToLin = (db) => 10 ** (db / 20);

// RBJ 2nd-order Butterworth high-pass.
function highpassCoefficients(freq, sampleRate) {
  const w0 = 2 * Math.PI * freq / sampleRate, cos = Math.cos(w0), alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return { b0: (1 + cos) / 2 / a0, b1: -(1 + cos) / a0, b2: (1 + cos) / 2 / a0, a1: -2 * cos / a0, a2: (1 - alpha) / a0 };
}

export function highpass(samples, sampleRate, freq) {
  if (!freq) return samples;
  const c = highpassCoefficients(freq, sampleRate);
  const out = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = c.b0 * x + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

// Per-sample linked level detector (max across channels), returned as a smoothed envelope in linear amplitude.
function linkedPeak(channels) {
  const n = channels[0].length, env = new Float32Array(n);
  for (let i = 0; i < n; i++) { let m = 0; for (const ch of channels) { const a = Math.abs(ch[i]); if (a > m) m = a; } env[i] = m; }
  return env;
}

// Soft-knee downward compressor on a linked level, gain computed in dB and smoothed with attack/release.
export function compress(channels, sampleRate, { thresholdDb, ratio, attackMs, releaseMs, kneeDb }) {
  if (ratio <= 1) return channels;
  const n = channels[0].length;
  const level = linkedPeak(channels);
  const attack = Math.exp(-1 / (sampleRate * attackMs / 1000)), release = Math.exp(-1 / (sampleRate * releaseMs / 1000));
  const gains = new Float32Array(n);
  let smoothed = 0, env = 0;
  const slope = 1 - 1 / ratio;
  for (let i = 0; i < n; i++) {
    // Peak-hold-with-decay detector so the gain does not chatter on individual waveform cycles.
    env = level[i] > env ? level[i] : level[i] + (env - level[i]) * release;
    const levelDb = toDbfs(env);
    const over = levelDb - thresholdDb;
    let reduction = 0;
    if (kneeDb > 0 && over > -kneeDb / 2 && over < kneeDb / 2) reduction = slope * ((over + kneeDb / 2) ** 2) / (2 * kneeDb);
    else if (over >= kneeDb / 2) reduction = slope * over;
    const target = -reduction;
    smoothed = target < smoothed ? target + (smoothed - target) * attack : target + (smoothed - target) * release;
    gains[i] = dbToLin(smoothed);
  }
  return channels.map((ch) => { const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = ch[i] * gains[i]; return out; });
}

// Gentle noise reduction: a soft downward expander. Estimates the noise floor from the quietest 10 % of 50 ms windows,
// then attenuates only what sits near that floor, by at most `maxReductionDb`. Speech passes untouched; room hiss
// between words drops. Spectral subtraction is deliberately not used: it is what makes voices sound underwater.
export function reduceNoise(channels, sampleRate, { maxReductionDb, attackMs, releaseMs }) {
  const n = channels[0].length;
  if (!maxReductionDb || n < sampleRate) return channels;
  const win = Math.round(sampleRate * 0.05), levels = [];
  for (let s = 0; s + win <= n; s += win) {
    let sum = 0;
    for (const ch of channels) for (let i = s; i < s + win; i++) sum += ch[i] * ch[i];
    levels.push(toDbfs(Math.sqrt(sum / (win * channels.length))));
  }
  const sorted = levels.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length < 10) return channels;
  const floorDb = sorted[Math.floor(sorted.length * 0.1)];
  const openDb = floorDb + 12; // fully open 12 dB above the floor
  const closeDb = floorDb + 3;
  const attack = Math.exp(-1 / (sampleRate * attackMs / 1000)), release = Math.exp(-1 / (sampleRate * releaseMs / 1000));
  const level = linkedPeak(channels);
  const gains = new Float32Array(n);
  let env = 0, smoothed = 0;
  for (let i = 0; i < n; i++) {
    env = level[i] > env ? level[i] : level[i] + (env - level[i]) * release;
    const db = toDbfs(env);
    const t = Math.min(1, Math.max(0, (db - closeDb) / (openDb - closeDb)));
    const target = -maxReductionDb * (1 - t * t * (3 - 2 * t)); // smoothstep: 0 dB when open, -max when at the floor
    smoothed = target > smoothed ? target + (smoothed - target) * attack : target + (smoothed - target) * release;
    gains[i] = dbToLin(smoothed);
  }
  return channels.map((ch) => { const out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = ch[i] * gains[i]; return out; });
}

// Look-ahead peak limiter: the result never exceeds the ceiling (see js/streaming-limiter.js, shared with live recording).
export function limit(channels, sampleRate, { ceilingDb, lookaheadMs, releaseMs }) {
  return StreamingLimiter.processBuffer(channels, sampleRate, { ceilingDb, lookaheadMs, releaseMs }).channels.map((c) => Float32Array.from(c));
}

// Full chain over decoded channels. Returns { channels, report } where report states what was done and measured.
export function enhanceChannels(channels, sampleRate, options = {}) {
  const o = normalizeEnhanceOptions(options);
  const before = measureLoudness(channels, sampleRate);
  let work = channels.map((ch) => highpass(ch, sampleRate, o.highpassHz));
  if (o.noiseReduction.enabled) work = reduceNoise(work, sampleRate, o.noiseReduction);
  work = compress(work, sampleRate, o.compressor);
  const afterDynamics = measureLoudness(work, sampleRate);
  let gainDb = 0;
  if (Number.isFinite(afterDynamics.integratedLufs)) {
    gainDb = Math.min(o.maxBoostDb, Math.max(-o.maxCutDb, o.targetLufs - afterDynamics.integratedLufs));
    const g = dbToLin(gainDb);
    work = work.map((ch) => { const out = new Float32Array(ch.length); for (let i = 0; i < ch.length; i++) out[i] = ch[i] * g; return out; });
  }
  work = limit(work, sampleRate, { ceilingDb: o.limiterCeilingDb, lookaheadMs: o.limiterLookaheadMs, releaseMs: o.limiterReleaseMs });
  const after = measureLoudness(work, sampleRate);
  return {
    channels: work,
    report: {
      options: o,
      inputLufs: before.integratedLufs,
      outputLufs: after.integratedLufs,
      appliedGainDb: gainDb,
      boostCapped: Number.isFinite(afterDynamics.integratedLufs) && o.targetLufs - afterDynamics.integratedLufs > o.maxBoostDb
    }
  };
}

// Equivalent streaming ffmpeg filters, up to (not including) loudness normalisation, which the caller runs as a
// two-pass loudnorm in linear mode so level is changed by one constant gain rather than a pumping dynamic filter.
export function buildFfmpegEnhanceFilters(options = {}) {
  const o = normalizeEnhanceOptions(options);
  const filters = [];
  if (o.highpassHz) filters.push(`highpass=f=${o.highpassHz}:poles=2`);
  if (o.noiseReduction.enabled) {
    // afftdn with a small, capped reduction and noise tracking; far gentler than its default.
    filters.push(`afftdn=nr=${Math.round(o.noiseReduction.maxReductionDb)}:nf=-45:tn=1`);
  }
  if (o.compressor.ratio > 1) {
    const c = o.compressor;
    filters.push(`acompressor=threshold=${dbToLin(c.thresholdDb).toFixed(5)}:ratio=${c.ratio}:attack=${c.attackMs}:release=${c.releaseMs}:knee=${Math.max(1, Math.min(8, 1 + c.kneeDb / 3)).toFixed(2)}:makeup=1`);
  }
  return filters;
}

export function buildFfmpegLimiter(options = {}) {
  const o = normalizeEnhanceOptions(options);
  return `alimiter=limit=${dbToLin(o.limiterCeilingDb).toFixed(5)}:attack=${o.limiterLookaheadMs}:release=${o.limiterReleaseMs}:level=disabled`;
}
