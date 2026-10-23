// Loudness for Toasty Clips: measure the source before a render so the right gain is applied, and measure the exported file
// afterwards so a bad result is corrected or at least reported instead of shipped silently.
//
//   planClipAudio    decode the source (16 kHz mono is plenty for loudness), take the clip's part, return the level analysis, a
//                    plain-language verdict ("very quiet", "no audio") and the gain plan toward -16 LUFS.
//   measureRendered  decode the exported file at 48 kHz and measure its integrated loudness and true peak.
//   judgeRendered    compare the measurement with the target and list problems.
import { decodeMono16k } from "./clip-analysis.js";
import { measureLoudness, truePeakDbtp } from "./audio-analysis.js";
import { ClipMixer } from "./clip-mixer.js";
import { limiterWorkDb } from "./audio-enhance.js";
import { analyseSpeechLevel, classifyLevel, planSpeechGain, SPEECH_TARGET_LUFS, TRUE_PEAK_TARGET_DBTP } from "./loudness-plan.js";

export const LOUDNESS_TOLERANCE_LU = 1.5;     // an export further than this from the target is corrected
export const TRUE_PEAK_LIMIT_DBTP = -1.0;     // an export with a true peak above this is corrected

// The render's voice chain is deterministic DSP, so the gain it needs can be found BEFORE rendering by running that same chain over
// the measured segment (at the decode rate) and adjusting the static gain until its output lands on the target. Loudness is held to
// +/-0.3 LU, the true-peak ceiling is the mixer's own, and the last dB of loudness is not bought with heavy limiting: when 90% of the
// speech would be limited by more than `maxLimiterWorkDb`, the search stops and the clip settles a little under the target
// (`peakLimited`). This is what makes the exported file land on the target the first time, with the post-render check as the backstop.
export function calibrateMixerGain(segment, sampleRate, { startGainDb, speechRefDb = null, targetLufs = SPEECH_TARGET_LUFS, noiseReduction = false, maxGainDb = 48, minGainDb = -18, maxLimiterWorkDb = 4, simulate = null } = {}) {
  // The export is stereo (the mono voice on both channels), and BS.1770 sums channel power, so the exported file measures 3 LU louder
  // than the same mono signal: the simulation runs the real stereo layout so its number is the one a loudness meter will read on the file.
  const run = simulate || ((gainDb) => {
    const mixer = new ClipMixer(sampleRate, { channels: 2, enhance: true, musicGainDb: -200, preGainDb: gainDb, noiseReduction, ...(Number.isFinite(speechRefDb) ? { targetRmsDb: speechRefDb + gainDb } : {}) });
    const n = segment.length, out = [new Float32Array(n), new Float32Array(n)], dry = [new Float32Array(n), new Float32Array(n)], silent = new Float32Array(n);
    for (let i = 0; i < n; i += 128) {
      const e = Math.min(n, i + 128);
      mixer.process([segment.subarray(i, e)], [silent.subarray(i, e)], [out[0].subarray(i, e), out[1].subarray(i, e)], [dry[0].subarray(i, e), dry[1].subarray(i, e)]);
    }
    const lag = mixer.latencySamples, aligned = out.map((c) => c.subarray(lag)), cut = dry.map((c, k) => c.subarray(0, aligned[k].length));
    return { lufs: measureLoudness(aligned, sampleRate).integratedLufs, work: limiterWorkDb(cut, aligned, sampleRate) };
  });
  let gain = startGainDb, best = null, peakLimited = false, iterations = 0;
  for (; iterations < 8; iterations++) {
    const r = run(gain);
    best = { gainDb: gain, ...r };
    const error = targetLufs - r.lufs;
    if (!Number.isFinite(error) || Math.abs(error) <= 0.3) break;
    if (error > 0 && r.work > maxLimiterWorkDb) { peakLimited = true; break; }
    const next = Math.max(minGainDb, Math.min(maxGainDb, gain + error * 0.9));
    if (Math.abs(next - gain) < 0.05) break;
    gain = next;
  }
  return { gainDb: best.gainDb, predictedLufs: best.lufs, limiterWorkDb: best.work, peakLimited, iterations: iterations + 1 };
}

export async function planClipAudio(blob, clip, { targetLufs = SPEECH_TARGET_LUFS, decode = decodeMono16k, noiseReduction = undefined } = {}) {
  let decoded;
  try { decoded = await decode(blob); } catch (error) { return { available: false, note: error?.message || "The audio could not be measured." }; }
  const sr = decoded.sampleRate, from = Math.max(0, Math.floor(clip.start * sr)), to = Math.min(decoded.samples.length, Math.ceil(clip.end * sr));
  const segment = decoded.samples.subarray(from, to);
  const analysis = analyseSpeechLevel([segment], sr);
  const verdict = classifyLevel(analysis);
  const plan = planSpeechGain(analysis, { targetLufs });
  if (plan.reason === "no-signal") return { available: true, analysis, verdict, plan, targetLufs };
  const nr = noiseReduction === undefined ? plan.noiseReduction : noiseReduction;
  const cal = calibrateMixerGain(segment, sr, { startGainDb: plan.gainDb, speechRefDb: analysis.speechRefDb, targetLufs, noiseReduction: nr, maxGainDb: plan.maxAllowedBoostDb + 10 });
  plan.measuredGainDb = plan.gainDb;
  plan.gainDb = cal.gainDb;
  plan.calibration = cal;
  plan.levelerTargetDb = Number.isFinite(analysis.speechRefDb) ? analysis.speechRefDb + cal.gainDb : null;
  if (cal.peakLimited) plan.reason = "limited-by-peaks";
  return { available: true, analysis, verdict, plan, targetLufs, noiseReduction: nr };
}

export async function measureRendered(blob, { AudioContextImpl = globalThis.AudioContext } = {}) {
  const ctx = new AudioContextImpl({ sampleRate: 48000 });
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c));
    const a = analyseSpeechLevel(channels, decoded.sampleRate);
    return { ...a, truePeakDbtp: truePeakDbtp(channels) };
  } finally { try { await ctx.close(); } catch (_) {} }
}

export function judgeRendered(m, { targetLufs = SPEECH_TARGET_LUFS, expectTarget = true } = {}) {
  const warnings = [];
  const verdict = classifyLevel(m);
  if (verdict.state === "silent") return { ok: false, warnings: ["silent-output"], verdict, deltaLu: null };
  const deltaLu = Number.isFinite(m.integratedLufs) ? targetLufs - m.integratedLufs : null;
  if (expectTarget && deltaLu !== null && Math.abs(deltaLu) > LOUDNESS_TOLERANCE_LU) warnings.push(deltaLu > 0 ? "output-too-quiet" : "output-too-loud");
  if (!expectTarget && (verdict.state === "low" || verdict.state === "very-quiet")) warnings.push("output-quiet");
  if (m.truePeakDbtp > TRUE_PEAK_LIMIT_DBTP) warnings.push("peak-high");
  return { ok: warnings.length === 0, warnings, verdict, deltaLu };
}

export const WARNING_TEXT = Object.freeze({
  "silent-output": "The exported clip has no usable audio.",
  "output-too-quiet": "The exported clip is quieter than the target.",
  "output-too-loud": "The exported clip is louder than the target.",
  "output-quiet": "The exported clip is quiet.",
  "peak-high": "The exported clip peaks close to full scale.",
  "no-audio": "The source has no usable audio in this clip.",
  "very-quiet": "The source audio is very quiet.",
  "low": "The source audio is quieter than normal.",
  "noisy": "The source is noisy, so the boost was limited.",
  "leading-silence": "The clip starts with several seconds of silence."
});
export { TRUE_PEAK_TARGET_DBTP };
