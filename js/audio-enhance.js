// Optional, gentle voice enhancement. Never applied to the original: callers keep the untouched recording and write
// the enhanced result next to it.
//
// Chain (all stages are conservative, speech-safe defaults):
//   high-pass 80 Hz  ->  noise reduction (soft downward expander relative to the measured floor, capped; automatic when the
//   boost is large)  ->  MEASURED static gain to the target (default -16 LUFS, the common podcast/online-video level)  ->  slow
//   speech leveler (evens out quiet and loud passages)  ->  gentle compressor (2:1, soft knee, peaks only)  ->  final trim to the
//   target  ->  look-ahead peak limiter that keeps the true peak at or under -1.5 dBTP (no clipping, no overs).
//
// The gain is the distance between the measured speech loudness and the target (js/loudness-plan.js), never a fixed number. It
// is capped by the take's signal-to-noise ratio, so a noisy room is not boosted into hiss, but a clean recording that is 30 dB
// quiet is raised by 30 dB.
//
// Two implementations of ONE set of defaults: processChannels() works on decoded samples in the browser/Node,
// and buildFfmpegEnhanceFilters() gives the equivalent streaming ffmpeg chain for hour-long files on the server/CLI.
import { measureLoudness, toDbfs, truePeakDbtp } from "./audio-analysis.js";
import { StreamingLimiter } from "./streaming-limiter.js";
import { SpeechCompressor, SpeechLeveler, processChannels } from "./speech-dynamics.js";
import { analyseSpeechLevel, classifyLevel, planSpeechGain, TRUE_PEAK_TARGET_DBTP } from "./loudness-plan.js";

export const ENHANCE_DEFAULTS = Object.freeze({
  highpassHz: 80,
  compressor: Object.freeze({ thresholdDb: -20, ratio: 2, attackMs: 10, releaseMs: 150, kneeDb: 6 }), // 20 ms RMS threshold: syllables well above the speech body, never a peak hold
  leveler: Object.freeze({ enabled: true }),
  targetLufs: -16,
  maxBoostDb: 36,        // an upper bound; the real cap is derived from the take's signal-to-noise ratio (loudness-plan.js)
  maxCutDb: 18,
  limiterCeilingDb: -1.5,
  limiterLookaheadMs: 5,
  limiterReleaseMs: 80,
  maxLimiterWorkDb: 4,   // stop raising the level when 90% of the speech is already being limited by more than this (the take settles a little under the target instead)
  noiseReduction: Object.freeze({ enabled: "auto", maxReductionDb: 8, attackMs: 10, releaseMs: 150 }) // true | false | "auto" (on when the boost is large)
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
    leveler: { enabled: options.leveler?.enabled ?? d.leveler.enabled },
    maxBoostDb: clamp(options.maxBoostDb, 0, 48, d.maxBoostDb),
    maxCutDb: clamp(options.maxCutDb, 0, 40, d.maxCutDb),
    limiterCeilingDb: clamp(options.limiterCeilingDb, -12, -0.1, d.limiterCeilingDb),
    limiterLookaheadMs: clamp(options.limiterLookaheadMs, 1, 20, d.limiterLookaheadMs),
    limiterReleaseMs: clamp(options.limiterReleaseMs, 10, 500, d.limiterReleaseMs),
    maxLimiterWorkDb: clamp(options.maxLimiterWorkDb, 1, 12, d.maxLimiterWorkDb),
    noiseReduction: {
      enabled: options.noiseReduction?.enabled === undefined ? d.noiseReduction.enabled : options.noiseReduction.enabled === "auto" ? "auto" : Boolean(options.noiseReduction.enabled),
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
export function limit(channels, sampleRate, { ceilingDb, lookaheadMs, releaseMs, truePeak = false }) {
  return StreamingLimiter.processBuffer(channels, sampleRate, { ceilingDb, lookaheadMs, releaseMs, truePeak }).channels.map((c) => Float32Array.from(c));
}

// 90th-percentile gain reduction (dB) the limiter applied over the frames that carry signal: how hard the limiter is working on the speech.
export function limiterWorkDb(before, after, sampleRate) {
  const win = Math.round(sampleRate * 0.02), reductions = [];
  for (let s = 0; s + win <= before[0].length; s += win) {
    let a = 0, b = 0;
    for (let c = 0; c < before.length; c++) for (let i = s; i < s + win; i++) { a += before[c][i] * before[c][i]; b += after[c][i] * after[c][i]; }
    const da = 10 * Math.log10(a / (win * before.length) + 1e-18);
    if (da > -50) reductions.push(da - 10 * Math.log10(b / (win * before.length) + 1e-18));
  }
  reductions.sort((x, y) => x - y);
  return reductions.length ? reductions[Math.floor(reductions.length * 0.9)] : 0;
}

const scale = (channels, db) => { const g = dbToLin(db); return channels.map((ch) => { const out = new Float32Array(ch.length); for (let i = 0; i < ch.length; i++) out[i] = ch[i] * g; return out; }); };

// Full chain over decoded channels. Returns { channels, report } where report states what was done and measured.
export function enhanceChannels(channels, sampleRate, options = {}) {
  const o = normalizeEnhanceOptions(options);
  const before = analyseSpeechLevel(channels, sampleRate);
  const verdict = classifyLevel(before);
  let work = channels.map((ch) => highpass(ch, sampleRate, o.highpassHz));
  if (verdict.state === "silent") {
    return { channels: work, report: { options: o, inputLufs: before.integratedLufs, outputLufs: before.integratedLufs, appliedGainDb: 0, boostCapped: false, skipped: "no-signal", verdict, before, after: before, truePeakDbtp: truePeakDbtp(work) } };
  }
  const levelRef = analyseSpeechLevel(work, sampleRate);
  const plan = planSpeechGain(levelRef, { targetLufs: o.targetLufs, maxBoostDb: o.maxBoostDb, maxCutDb: o.maxCutDb });
  const noiseReduced = o.noiseReduction.enabled === true || (o.noiseReduction.enabled === "auto" && plan.noiseReduction);
  if (noiseReduced) work = reduceNoise(work, sampleRate, o.noiseReduction);
  work = scale(work, plan.gainDb);
  let totalGainDb = plan.gainDb;
  // The leveler holds speech around its OWN typical level (the median 400 ms level of the speech windows) so it evens out words and
  // sentences without pulling a take made of short loud words down toward the level of continuous speech.
  if (o.leveler.enabled) work = processChannels(new SpeechLeveler(sampleRate, { targetDb: Number.isFinite(levelRef.speechRefDb) ? levelRef.speechRefDb + plan.gainDb : o.targetLufs - 6.6, maxBoostDb: 6, maxCutDb: 6, upDbPerSec: 3, downDbPerSec: 6 }), work);
  if (o.compressor.ratio > 1) work = processChannels(new SpeechCompressor(sampleRate, o.compressor), work);
  // The dynamics stages and the limiter move loudness: close the gap by measuring what comes OUT of the limiter. The signal ahead of
  // the limiter stays fixed; only a trim gain and the limiter ceiling change between passes, and the loop stops as soon as the
  // output is within 0.4 LU of the target with its true peak at or under -1.5 dBTP. A very peaky take can settle a little under the
  // target rather than being crushed to reach it (the trim is bounded).
  const pre = work, preLufs = measureLoudness(pre, sampleRate).integratedLufs;
  let peakLimited = false, ceilingDb = o.limiterCeilingDb, trimDb = Number.isFinite(preLufs) ? Math.max(-12, Math.min(12, o.targetLufs - preLufs)) : 0, tp = null, passes = 0;
  const trimLimit = Math.max(0, plan.maxAllowedBoostDb + 8 - plan.gainDb);
  for (; passes < 8; passes++) {
    const limited = limit(scale(pre, trimDb), sampleRate, { ceilingDb, lookaheadMs: o.limiterLookaheadMs, releaseMs: o.limiterReleaseMs, truePeak: true });
    tp = truePeakDbtp(limited);
    const lufs = measureLoudness(limited, sampleRate).integratedLufs;
    work = limited;
    const overshoot = tp - TRUE_PEAK_TARGET_DBTP;
    if (globalThis.__TOASTY_ENH_DEBUG) console.error(`pass ${passes} trim ${trimDb.toFixed(2)} ceil ${ceilingDb.toFixed(2)} lufs ${lufs.toFixed(2)} tp ${tp.toFixed(2)} work ${limiterWorkDb(scale(pre, trimDb), limited, sampleRate).toFixed(2)}`);
    if (overshoot > 0.05) { ceilingDb -= overshoot + 0.02; continue; }
    const error = o.targetLufs - lufs;
    if (!Number.isFinite(error) || Math.abs(error) <= 0.4) break;
    // Quality guard: do not buy the last dB of loudness with heavy limiting. Nine tenths of the speech limited by more than the cap is
    // where a limiter starts to be heard, so stop here and report the take as limited by its peaks.
    if (error > 0 && limiterWorkDb(scale(pre, trimDb), limited, sampleRate) > o.maxLimiterWorkDb) { peakLimited = true; break; }
    const next = Math.max(-12, Math.min(trimLimit, trimDb + error * 0.9));
    if (Math.abs(next - trimDb) < 0.05) break;
    trimDb = next;
  }
  totalGainDb += trimDb;
  const after = analyseSpeechLevel(work, sampleRate);
  return {
    channels: work,
    report: {
      options: o,
      inputLufs: before.integratedLufs,
      outputLufs: after.integratedLufs,
      appliedGainDb: totalGainDb,
      plannedGainDb: plan.gainDb,
      boostCapped: plan.capped,
      capReason: peakLimited && !plan.capped ? "limited-by-peaks" : plan.reason,
      peakLimited,
      noiseReduced,
      verdict,
      before,
      after,
      truePeakDbtp: truePeakDbtp(work)
    }
  };
}

// Equivalent streaming ffmpeg filters, up to (not including) loudness normalisation, which the caller runs as a
// two-pass loudnorm in linear mode so level is changed by one constant gain rather than a pumping dynamic filter.
export function buildFfmpegEnhanceFilters(options = {}, { preGainDb = 0, noiseReduction = null } = {}) {
  const o = normalizeEnhanceOptions(options);
  const filters = [];
  if (o.highpassHz) filters.push(`highpass=f=${o.highpassHz}:poles=2`);
  const nr = noiseReduction === null ? o.noiseReduction.enabled === true : noiseReduction;
  if (nr) {
    // afftdn with a small, capped reduction and noise tracking; far gentler than its default.
    filters.push(`afftdn=nr=${Math.round(o.noiseReduction.maxReductionDb)}:nf=-45:tn=1`);
  }
  // The measured gain goes BEFORE the compressor so the compressor works at speech level (a 29 dB too quiet take would sit entirely below its threshold).
  if (preGainDb) filters.push(`volume=${preGainDb.toFixed(2)}dB`);
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
