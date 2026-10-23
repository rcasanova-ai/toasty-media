// Decide how much gain a piece of speech needs, and say plainly when its level is a problem.
//
// Measure first, then correct: the gain is the distance between the measured speech loudness (BS.1770 gated integrated
// loudness, so pauses and room tone do not count) and the target, not a fixed number. A voice already at the target gets
// ~0 dB; a recording 29 dB too quiet gets ~29 dB. The boost is capped by the signal-to-noise ratio of the take, because
// raising a noisy recording by the full distance only makes the noise as loud as the voice.
import { LoudnessMeter, toDbfs } from "./audio-analysis.js";

export const SPEECH_TARGET_LUFS = -16;
export const TRUE_PEAK_TARGET_DBTP = -1.5;
export const LEVEL_LIMITS = Object.freeze({
  lowLufs: -26,         // below this a speech recording is noticeably quiet next to ordinary online audio
  veryQuietLufs: -34,   // below this it will not be usable without correction
  silentLufs: -60       // below this there is effectively no signal
});

const mix = (channels) => {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) { let s = 0; for (const c of channels) s += c[i]; out[i] = s / channels.length; }
  return out;
};

// RMS level (dBFS) of consecutive windows.
export function windowLevelsDb(samples, sampleRate, windowMs = 50) {
  const win = Math.max(1, Math.round(sampleRate * windowMs / 1000)), out = [];
  for (let s = 0; s + win <= samples.length; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += samples[i] * samples[i];
    out.push(10 * Math.log10(e / win + 1e-24));
  }
  return out;
}

// Typical level of the speech itself: the median 400 ms RMS (dBFS) over the windows that carry speech. This is where a leveler should
// aim to stay: a fixed target would pull a take made of short loud words down toward continuous-speech levels and cost it loudness.
export function speechReferenceDb(levels50ms) {
  const energy = levels50ms.map((l) => 10 ** (l / 10));
  const w = 8, windows = [];
  let sum = 0;
  for (let i = 0; i < energy.length; i++) {
    sum += energy[i];
    if (i >= w) sum -= energy[i - w];
    if (i >= w - 1) windows.push(10 * Math.log10(sum / w + 1e-24));
  }
  const top = percentile(windows, 0.9);
  const speaking = windows.filter((l) => l > top - 20);
  return speaking.length ? percentile(speaking, 0.5) : -Infinity;
}

export function percentile(values, p) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  return v.length ? v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))] : -Infinity;
}

// Everything the planner and the warnings need, from decoded channels.
export function analyseSpeechLevel(channels, sampleRate) {
  const n = channels[0]?.length || 0;
  const meter = new LoudnessMeter(sampleRate, channels.length);
  meter.push(channels);
  const loud = meter.result();
  const mono = mix(channels), levels = windowLevelsDb(mono, sampleRate, 50);
  let peak = 0;
  for (const c of channels) for (let i = 0; i < c.length; i++) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
  const integratedLufs = loud.integratedLufs;
  const noiseFloorDb = percentile(levels, 0.1);
  const speechDb = percentile(levels, 0.9);
  // The take's speech starts at the first window within 25 dB of the loud material (a lead-in of silence or room tone before it is flagged).
  const startThreshold = Number.isFinite(speechDb) ? speechDb - 25 : -Infinity;
  const firstSpeech = levels.findIndex((l) => l > startThreshold);
  const activeRatio = levels.length ? levels.filter((l) => l > startThreshold).length / levels.length : 0;
  return {
    durationSeconds: n / sampleRate,
    integratedLufs,
    loudnessRangeLu: loud.loudnessRangeLu,
    peakDbfs: toDbfs(peak),
    noiseFloorDb,
    speechDb,
    speechRefDb: speechReferenceDb(levels),
    snrDb: Number.isFinite(integratedLufs) && Number.isFinite(noiseFloorDb) ? integratedLufs - noiseFloorDb : null,
    leadingSilenceSeconds: firstSpeech > 0 ? firstSpeech * 0.05 : 0,
    speechActiveRatio: activeRatio
  };
}

// Plain-language verdict about the level of a piece of speech. `state` is one of ok | low | very-quiet | silent.
export function classifyLevel(a, limits = LEVEL_LIMITS) {
  const warnings = [];
  if (!a || !Number.isFinite(a.integratedLufs) || a.integratedLufs < limits.silentLufs || a.peakDbfs < -70) {
    return { state: "silent", message: "No usable audio was found. The microphone may be muted, unplugged or set to a very low input level.", warnings: ["no-audio"] };
  }
  if (a.leadingSilenceSeconds >= 3) warnings.push("leading-silence");
  if (a.snrDb !== null && a.snrDb < 12) warnings.push("noisy");
  if (a.integratedLufs < limits.veryQuietLufs) {
    return { state: "very-quiet", message: "Very quiet: normal speech measures about -16 to -23 LUFS.", warnings: ["very-quiet", ...warnings] };
  }
  if (a.integratedLufs < limits.lowLufs) {
    return { state: "low", message: "Quieter than normal speech.", warnings: ["low", ...warnings] };
  }
  return { state: "ok", message: "", warnings };
}

// Gain plan toward `targetLufs`. Returns the gain, whether it was capped, and whether background noise should be reduced
// along with it (a large boost lifts the room tone too).
export function planSpeechGain(a, { targetLufs = SPEECH_TARGET_LUFS, maxBoostDb = 36, maxCutDb = 18, minBoostDb = 6 } = {}) {
  if (!a || !Number.isFinite(a.integratedLufs) || a.integratedLufs < LEVEL_LIMITS.silentLufs) {
    return { gainDb: 0, wantedDb: 0, capped: false, noiseReduction: false, reason: "no-signal", maxAllowedBoostDb: 0 };
  }
  const wanted = targetLufs - a.integratedLufs;
  // SNR 20 dB or better: allow the full boost. Worse: shrink the allowance linearly toward minBoostDb at 8 dB SNR.
  const snr = a.snrDb;
  let allowed = maxBoostDb;
  if (snr !== null && snr < 20) allowed = snr <= 8 ? minBoostDb : minBoostDb + (snr - 8) / 12 * (maxBoostDb - minBoostDb);
  const gainDb = Math.max(-maxCutDb, Math.min(allowed, wanted));
  return {
    gainDb,
    wantedDb: wanted,
    capped: wanted > allowed + 0.05,
    noiseReduction: gainDb >= 12 || (snr !== null && snr < 25 && gainDb > 3),
    reason: wanted > allowed + 0.05 ? (snr !== null && snr < 20 ? "limited-by-noise" : "limited-by-maximum") : "target",
    maxAllowedBoostDb: allowed
  };
}
