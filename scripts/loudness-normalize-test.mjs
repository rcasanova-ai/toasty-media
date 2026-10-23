#!/usr/bin/env node
// Loudness handling end to end on decoded audio: measured gain planning, the quiet-voice recording safety net, the offline
// enhancement chain, the Clips mixer and the quiet/missing-audio checks. Uses synthetic speech at quiet, normal and loud levels,
// and, when it is available, the real recording that exposed the problem (TOASTY_QUIET_SAMPLE, or ~/Downloads/toastyaudiotest.mp4).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";
import { analyzeChannels, measureLoudness, toDbfs, truePeakDbtp } from "../js/audio-analysis.js";
import { enhanceChannels } from "../js/audio-enhance.js";
import { analyseSpeechLevel, classifyLevel, planSpeechGain } from "../js/loudness-plan.js";
import { RecordingLeveler, levelAdvice } from "../js/recording-leveler.js";
import { SpeechLeveler, processChannels } from "../js/speech-dynamics.js";
import { ClipMixer } from "../js/clip-mixer.js";
import { calibrateMixerGain, judgeRendered } from "../js/clip-loudness.js";
import { synthProgramme } from "./lib/synth-programme.mjs";

const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (${a.toFixed(2)}, wanted ${b} ± ${tol})`);
const SR = 48000, dB = (x) => 10 ** (x / 20);
const peakOf = (x) => { let m = 0; for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > m) m = a; } return m; };
const lufsOf = (x) => measureLoudness([x], SR).integratedLufs;
const scaleBy = (x, db) => { const g = dB(db), o = new Float32Array(x.length); for (let i = 0; i < x.length; i++) o[i] = x[i] * g; return o; };
const programme = synthProgramme({ seconds: 36 }).samples;                 // -23.4 LUFS, floor -60 dBFS, peak -4 dBFS
const at = (targetLufs) => scaleBy(programme, targetLufs - lufsOf(programme));  // the same speech at any loudness (floor scales with it)

console.log("\nTrue peak");
{
  const x = new Float32Array(4800);
  for (let i = 0; i < x.length; i++) x[i] = Math.sin(2 * Math.PI * (SR / 4) * i / SR + Math.PI / 4);   // samples at +-0.707, waveform peaks at 1.0
  const sample = peakOf(x);
  near(toDbfs(sample), -3.01, 0.1, "the sample peak of a fs/4 sine at 45 degrees is -3 dBFS");
  near(truePeakDbtp([x]), 0, 0.15, "its true peak is 0 dBTP, which a sample-peak meter misses");
}

console.log("\nGain is measured, not fixed");
{
  const gains = {};
  for (const [name, level] of [["very quiet", -45], ["quiet", -32], ["normal", -23], ["loud", -12], ["at target", -16]]) {
    const plan = planSpeechGain(analyseSpeechLevel([at(level)], SR));
    gains[name] = plan.gainDb;
  }
  near(gains["very quiet"], 29, 0.6, "a -45 LUFS take is raised by about 29 dB");
  near(gains.quiet, 16, 0.6, "a -32 LUFS take by about 16 dB");
  near(gains.normal, 7, 0.6, "a -23 LUFS take by about 7 dB");
  near(gains.loud, -4, 0.6, "a -12 LUFS take is brought DOWN by about 4 dB");
  near(gains["at target"], 0, 0.6, "a take already at -16 LUFS gets about 0 dB");
  const silent = planSpeechGain(analyseSpeechLevel([new Float32Array(SR * 5)], SR));
  ok(silent.gainDb === 0 && silent.reason === "no-signal", "silence is never amplified");
  // The same quiet speech in a noisy room: the allowance shrinks with the signal-to-noise ratio.
  const noisy = at(-40).map((v, i) => v + (Math.sin(i * 12.9898) * 43758.5453 % 1) * dB(-50));
  const noisyPlan = planSpeechGain(analyseSpeechLevel([noisy], SR));
  ok(noisyPlan.capped && noisyPlan.reason === "limited-by-noise" && noisyPlan.gainDb < noisyPlan.wantedDb - 3, `a noisy quiet take is not boosted the full distance (${noisyPlan.gainDb.toFixed(1)} of ${noisyPlan.wantedDb.toFixed(1)} dB)`);
}

console.log("\nQuiet and missing audio are detected");
{
  const state = (x) => classifyLevel(analyseSpeechLevel([x], SR)).state;
  ok(state(at(-45)) === "very-quiet", "-45 LUFS is reported as very quiet");
  ok(state(at(-30)) === "low", "-30 LUFS is reported as quieter than normal");
  ok(state(at(-20)) === "ok", "-20 LUFS is fine");
  ok(state(new Float32Array(SR * 6)) === "silent", "digital silence is reported as missing audio");
  ok(state(Float32Array.from({ length: SR * 6 }, () => (Math.random() - 0.5) * dB(-80))) === "silent", "a dead line with only converter noise is reported as missing audio");
  const lead = new Float32Array(SR * 6 + programme.length); lead.set(at(-30), SR * 6);
  const a = analyseSpeechLevel([lead], SR);
  ok(a.leadingSilenceSeconds >= 5 && classifyLevel(a).warnings.includes("leading-silence"), `a take that starts with ${a.leadingSilenceSeconds.toFixed(1)} s of silence is flagged`);
  const j = judgeRendered({ ...analyseSpeechLevel([at(-45)], SR), truePeakDbtp: -20 });
  ok(!j.ok && j.warnings.includes("output-too-quiet"), "an exported file at -45 LUFS fails the automated check");
  ok(judgeRendered({ ...analyseSpeechLevel([at(-16)], SR), truePeakDbtp: -2 }).ok, "an exported file at -16 LUFS / -2 dBTP passes it");
  ok(judgeRendered({ ...analyseSpeechLevel([at(-16)], SR), truePeakDbtp: -0.2 }).warnings.includes("peak-high"), "and one that peaks near full scale does not");
}

console.log("\nStudio recorder safety net (boost only)");
{
  const run = (x, opts = {}) => {
    const rec = new RecordingLeveler(SR, 1, opts), out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i += 128) { const e = Math.min(x.length, i + 128); rec.process([x.subarray(i, e)], [out.subarray(i, e)]); }
    return { out, rec };
  };
  const quiet = run(at(-45)), qLufs = lufsOf(quiet.out);
  ok(qLufs > -30 && qLufs < -18, `a -45 LUFS microphone is recorded at ${qLufs.toFixed(1)} LUFS`);
  ok(quiet.rec.stats().maxGainDb > 15 && quiet.rec.stats().maxGainDb <= 30.01, `by raising it ${quiet.rec.stats().maxGainDb.toFixed(0)} dB, never more than 30`);
  ok(toDbfs(peakOf(quiet.out)) <= -1.99, "and the limiter keeps it under -2 dBFS");
  const normal = at(-18), nr = run(normal);
  const lag = nr.rec.latencySamples;
  let worst = 0; for (let i = SR; i < SR * 6; i++) worst = Math.max(worst, Math.abs(nr.out[i + lag] - normal[i]));
  ok(worst < 0.01, `a normal-level microphone is left alone while it is at a healthy level (samples differ by at most ${worst.toFixed(4)})`);
  const typical = run(at(-23));
  ok(typical.rec.stats().maxGainDb <= 4, `typical speech (-23 LUFS, with a quiet speaker in it) is lifted only where it dips (${typical.rec.stats().maxGainDb.toFixed(1)} dB at most)`);
  const loud = at(-12), lr = run(loud);
  ok(lr.rec.stats().maxGainDb < 0.5 && lufsOf(lr.out) > -15, `loud speech is never turned down by the leveler; only the limiter holds its peaks under the ceiling (${lufsOf(lr.out).toFixed(1)} LUFS from -12)`);
  const stats = quiet.rec.finalStats();
  ok(stats.quietSpeechSeconds > 10 && Number.isFinite(stats.integratedLufs) && levelAdvice(stats)?.state === "quiet", "the recorder reports the quiet voice and advises the host");
  const dead = run(new Float32Array(SR * 20));
  ok(levelAdvice(dead.rec.stats())?.state === "silent" && dead.rec.stats().gainDb === 0, "a dead line is reported, and silence is never amplified");
  ok(levelAdvice(nr.rec.stats()) === null, "a healthy microphone produces no advice");
  // Laughter after quiet speech: the boosted gain must come down within a fraction of a second, not squash for seconds.
  const burst = new Float32Array(SR * 30);
  burst.set(at(-45).subarray(0, SR * 20), 0);
  for (let i = SR * 20; i < SR * 20 + SR * 0.6; i++) burst[i] = (Math.random() * 2 - 1) * dB(-6);
  const b = run(burst);
  let max = 0, over = 0; for (let i = 0; i < b.out.length; i++) { const a = Math.abs(b.out[i]); if (a > max) max = a; }
  ok(max <= dB(-1.99), `a sudden loud burst on a boosted voice stays under the ceiling (${toDbfs(max).toFixed(2)} dBFS)`);
  const tail = b.out.subarray(SR * 20 + Math.round(SR * 0.35), SR * 20 + SR * 0.6);
  const tailRms = 20 * Math.log10(Math.sqrt(tail.reduce((s, v) => s + v * v, 0) / tail.length));
  ok(tailRms < -9.5, `and the boost is pulled off within a third of a second (the burst's tail sits at ${tailRms.toFixed(1)} dBFS RMS against -10.8 going in)`);
}

console.log("\nEnhancement chain: quiet, normal and loud speech all land at -16 LUFS");
{
  for (const level of [-45, -34, -23, -12]) {
    const x = at(level), before = analyseSpeechLevel([x], SR);
    const { channels, report } = enhanceChannels([x], SR);
    const out = channels[0], after = analyseSpeechLevel([out], SR), tp = truePeakDbtp([out]);
    // The programme includes a 0.6 s laughter burst 19 dB above its speech: reaching -16 LUFS with a -1.5 dBTP ceiling is bounded by it.
    ok(Math.abs(after.integratedLufs + 16) <= 1.0 || (report.peakLimited && after.integratedLufs >= -18.6 && after.integratedLufs <= -15), `${level} LUFS in -> ${after.integratedLufs.toFixed(2)} LUFS${report.peakLimited ? " (settled under the target rather than limit the speech hard)" : ""}`);
    ok(tp <= -1.45, `  true peak ${tp.toFixed(2)} dBTP (limit -1.5)`);
    ok(analyzeChannels([out], SR).clippedSamples === 0, "  no clipped samples");
    ok(after.loudnessRangeLu <= before.loudnessRangeLu + 0.5, `  speech dynamics not widened (loudness range ${before.loudnessRangeLu.toFixed(1)} -> ${after.loudnessRangeLu.toFixed(1)} LU)`);
    ok(after.snrDb >= Math.min(before.snrDb, 30) - 14, `  noise not lifted out of proportion (SNR ${before.snrDb.toFixed(1)} -> ${after.snrDb.toFixed(1)} dB)`);
    ok(report.appliedGainDb !== 29 || level === -45, "  the gain is whatever the measurement says, not a constant");
  }
  const gainAt = (level) => enhanceChannels([at(level)], SR).report.appliedGainDb;
  ok(gainAt(-45) > gainAt(-34) + 5 && gainAt(-34) > gainAt(-23) + 3 && gainAt(-12) < gainAt(-23), "gain falls as the input gets louder, and goes negative when it is louder than the target");
}

console.log("\nNoise reduction keeps quiet speech");
{
  // Quiet speech (-52 dBFS) with 0.8 s pauses over a -72 dBFS room. Reduction must lower the room between words by about its cap and leave the words alone.
  const n = SR * 30, x = new Float32Array(n);
  let seed = 7; const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
  for (let i = 0; i < n; i++) {
    const t = i / SR, on = (t % 2) < 1.2 ? Math.sin(Math.PI * (t % 2) / 1.2) ** 0.5 : 0;
    x[i] = dB(-52) * on * (Math.sin(2 * Math.PI * 180 * t) + 0.6 * Math.sin(2 * Math.PI * 360 * t) + 0.3 * Math.sin(2 * Math.PI * 900 * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t))) + rnd() * dB(-72) * 1.7;
  }
  const plain = enhanceChannels([x], SR, { noiseReduction: { enabled: false } }), nr = enhanceChannels([x], SR, { noiseReduction: { enabled: true } });
  const speechLoud = (c) => analyseSpeechLevel(c, SR).speechDb;
  const delta = speechLoud(nr.channels) - speechLoud(plain.channels);
  ok(Math.abs(delta) < 1.5, `speech level is unchanged by noise reduction (${delta.toFixed(2)} dB difference in the 90th percentile level)`);
  const f = (c) => analyseSpeechLevel(c, SR).noiseFloorDb;
  ok(f(nr.channels) < f(plain.channels) - 4, `while the room tone between words drops (${f(plain.channels).toFixed(1)} -> ${f(nr.channels).toFixed(1)} dBFS)`);
  ok(f(nr.channels) > f(plain.channels) - 10, "by no more than the cap (it never gates the room to silence, which sounds artificial)");
  ok(nr.report.options.noiseReduction.maxReductionDb <= 8 && nr.report.noiseReduced && !plain.report.noiseReduced, "and the reduction is capped at 8 dB and reported");
  const auto = enhanceChannels([x], SR);
  ok(auto.report.noiseReduced, "by default it switches itself on when the boost is large (here +30 dB)");
  const normal = enhanceChannels([at(-18)], SR);
  ok(!normal.report.noiseReduced, "and stays off for a recording that needs no boost");
}

console.log("\nClips mixer with a measured, calibrated gain");
{
  const music = Float32Array.from({ length: programme.length }, (_, i) => 0.3 * (Math.sin(2 * Math.PI * 330 * i / SR) + 0.6 * Math.sin(2 * Math.PI * 495 * i / SR)));
  for (const level of [-45, -30, -23, -12]) {
    const voice = at(level), a = analyseSpeechLevel([voice], SR), plan = planSpeechGain(a);
    const cal = calibrateMixerGain(voice, SR, { startGainDb: plan.gainDb, speechRefDb: a.speechRefDb, noiseReduction: plan.noiseReduction, maxGainDb: plan.maxAllowedBoostDb + 10 });
    const run = (m, opts = {}) => { const mixer = new ClipMixer(SR, { enhance: true, musicGainDb: -22, duckDb: -14, preGainDb: cal.gainDb, noiseReduction: plan.noiseReduction, targetRmsDb: a.speechRefDb + cal.gainDb, ...opts }), out = [new Float32Array(voice.length), new Float32Array(voice.length)]; for (let i = 0; i < voice.length; i += 128) { const e = Math.min(voice.length, i + 128); mixer.process([voice.subarray(i, e)], [m.subarray(i, e)], [out[0].subarray(i, e), out[1].subarray(i, e)]); } return { mixer, out }; };
    const voiceOnly = run(new Float32Array(voice.length));
    const m = measureLoudness(voiceOnly.out, SR).integratedLufs;
    near(m, -16, 1.6, `${level} LUFS clip -> rendered voice (stereo export) (measured gain ${plan.gainDb.toFixed(1)} dB, calibrated to ${cal.gainDb.toFixed(1)} dB)`);
    near(m, cal.predictedLufs, 0.3, "  and it lands where the offline calibration predicted");
    ok(truePeakDbtp(voiceOnly.out) <= -2.0, `  true peak ${truePeakDbtp(voiceOnly.out).toFixed(2)} dBTP before encoding (AAC adds up to about 1 dB)`);
    if (level === -45) {
      const withMusic = run(music);
      ok(withMusic.mixer.minDuckDb < -10, `  music ducks under the speech (${withMusic.mixer.minDuckDb.toFixed(1)} dB)`);
      near(measureLoudness(withMusic.out, SR).integratedLufs, m, 1.5, "  and adding the music does not move the loudness much");
    }
  }
  const quiet = at(-45), unplanned = new ClipMixer(SR, { enhance: true, musicGainDb: -200 }), out = [new Float32Array(quiet.length), new Float32Array(quiet.length)], silent = new Float32Array(quiet.length);
  for (let i = 0; i < quiet.length; i += 128) { const e = Math.min(quiet.length, i + 128); unplanned.process([quiet.subarray(i, e)], [silent.subarray(i, e)], [out[0].subarray(i, e), out[1].subarray(i, e)]); }
  ok(measureLoudness(out, SR).integratedLufs < -30, "WITHOUT the plan, the old behaviour (a +12 dB leveler) left this clip far too quiet: that was the Clips bug");
}

console.log("\nThe recording worklet fails open");
{
  // Run the real worklet class in Node with the AudioWorklet globals stubbed; make its processing throw; the audio must pass through, not go silent.
  let registered = null;
  globalThis.sampleRate = 48000;
  globalThis.AudioWorkletProcessor = class { constructor() { this.port = { posted: [], postMessage(m) { this.posted.push(m); }, onmessage: null }; } };
  globalThis.registerProcessor = (name, cls) => { registered = { name, cls }; };
  await import("../js/limiter-worklet.js");
  ok(registered?.name === "toasty-safety-limiter", "the worklet registers under its usual name");
  const node = new registered.cls({ processorOptions: { channels: 1, leveler: true, ceilingDb: -2 } });
  const input = Float32Array.from({ length: 128 }, (_, i) => 0.2 * Math.sin(i / 5)), out = new Float32Array(128);
  node.process([[input]], [[out]]);
  node.process([[input]], [[out]]);   // warm-up; limiter latency means the first blocks are delayed
  node.rec.process = () => { throw new Error("simulated failure"); };
  node.process([[input]], [[out]]);
  let same = true; for (let i = 0; i < 128; i++) if (out[i] !== input[i]) same = false;
  ok(same && node.failed && node.port.posted.some((m) => m.type === "error"), "a processing error hands the input straight through and reports it, instead of recording silence");
  node.process([[input]], [[out]]);
  ok(out.every((v, i) => v === input[i]), "and keeps passing it through afterwards");
}

const sample = process.env.TOASTY_QUIET_SAMPLE || `${homedir()}/Downloads/toastyaudiotest.mp4`;
if (existsSync(sample)) {
  console.log("\nThe recording that exposed the problem");
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", sample, "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const x = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 4)));
  const before = analyseSpeechLevel([x], SR);
  ok(classifyLevel(before).state === "very-quiet", `it is detected as very quiet (${before.integratedLufs.toFixed(1)} LUFS)`);
  const { channels, report } = enhanceChannels([x], SR);
  const after = analyseSpeechLevel(channels, SR), tp = truePeakDbtp(channels);
  near(after.integratedLufs, -16, 1.2, "enhanced to the speech target");
  ok(tp <= -1.45, `true peak ${tp.toFixed(2)} dBTP`);
  const rec = new RecordingLeveler(SR, 1), out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i += 128) { const e = Math.min(x.length, i + 128); rec.process([x.subarray(i, e)], [out.subarray(i, e)]); }
  console.log(`     as recorded now: ${before.integratedLufs.toFixed(1)} LUFS; Studio safety net: ${lufsOf(out).toFixed(1)} LUFS (gain up to +${rec.stats().maxGainDb.toFixed(0)} dB); Clips/enhanced: ${after.integratedLufs.toFixed(1)} LUFS, ${tp.toFixed(1)} dBTP (planned +${report.plannedGainDb.toFixed(1)} dB)`);
  ok(lufsOf(out) > -30, "the Studio safety net alone would have recorded it above -30 LUFS");
} else console.log("\n(the real quiet recording is not on this machine; skipped)");
console.log("\nALL PASSED — loudness is measured, corrected to the target without clipping, and quiet or missing audio is detected.");
