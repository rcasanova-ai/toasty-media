#!/usr/bin/env node
// Unit tests for the audio measurement and enhancement code (js/audio-analysis.js, js/audio-enhance.js).
// Synthetic, deterministic signals with known answers: a -20 dBFS sine must measure -20 dBFS RMS-ish and about -23 LUFS,
// clipped audio must be flagged, a dropout must be located, enhancement must hit its target without exceeding the ceiling.
import {
  analyzeChannels, compareSignals, compareStages, detectRecorderGaps, kWeightingCoefficients,
  measureLoudness, summarizeRtcAudioStats, rtcQualityVerdict, toDbfs, StreamingAnalyzer
} from "../js/audio-analysis.js";
import { enhanceChannels, ENHANCE_DEFAULTS, normalizeEnhanceOptions, buildFfmpegEnhanceFilters, buildFfmpegLimiter, limit, highpass } from "../js/audio-enhance.js";
import { classifyMicLevel, normalizeMicProcessing, cleanMicAudioConstraint, vdoMicProcessingParams, readMicProcessing, writeMicProcessing, MIC_PROCESSING_STORAGE_KEY } from "../js/microphone-capture.js";

const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const near = (a, b, tol, m) => ok(Math.abs(a - b) <= tol, `${m} (got ${a}, want ${b} ±${tol})`);
const SR = 48000;
const sine = (freq, seconds, amp, sr = SR) => { const o = new Float32Array(Math.round(sr * seconds)); for (let i = 0; i < o.length; i++) o[i] = amp * Math.sin(2 * Math.PI * freq * i / sr); return o; };
// Deterministic pseudo-random noise (no Math.random so results are reproducible).
const noise = (seconds, amp, seed = 1, sr = SR) => { let s = seed; const o = new Float32Array(Math.round(sr * seconds)); for (let i = 0; i < o.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; o[i] = amp * ((s / 2 ** 32) * 2 - 1); } return o; };
const dbToLin = (d) => 10 ** (d / 20);

console.log("\nSample statistics");
{
  const a = analyzeChannels([sine(1000, 5, dbToLin(-20))], SR);
  near(a.peakDbfs, -20, 0.1, "-20 dBFS sine peaks at -20 dBFS");
  near(a.rmsDbfs, -23, 0.1, "-20 dBFS sine has RMS -23 dBFS");
  near(a.integratedLufs, -23.0, 0.15, "K-weighted loudness of a 1 kHz -20 dBFS sine is -23.0 LUFS (a 0 dBFS sine is -3.01 LUFS in BS.1770)");
  ok(a.clippedSamples === 0 && a.dropouts.length === 0, "a clean sine has no clipping and no dropouts");
  const loud = sine(1000, 3, 1.5).map((v) => Math.max(-1, Math.min(1, v)));
  const c = analyzeChannels([loud], SR);
  ok(c.clippedSamples > 1000 && c.clipRuns > 10, `a hard-clipped sine is flagged (${c.clippedSamples} samples, ${c.clipRuns} runs)`);
  const gap = sine(300, 4, 0.3); gap.fill(0, SR * 2, SR * 2 + 2400); // 50 ms of digital silence mid-signal
  const g = analyzeChannels([gap], SR);
  ok(g.dropouts.length === 1 && Math.abs(g.dropouts[0].atSec - 2) < 0.01 && Math.abs(g.dropouts[0].durationMs - 50) < 2, "a 50 ms dropout is located at 2.0 s");
  const dc = Float32Array.from(sine(500, 2, 0.1), (v) => v + 0.05);
  near(analyzeChannels([dc], SR).dcOffset, 0.05, 0.002, "DC offset is measured");
  const stereo = analyzeChannels([sine(440, 2, 0.2), sine(440, 2, 0.05)], SR);
  ok(stereo.channels === 2 && stereo.channelPeaksDbfs[0] > stereo.channelPeaksDbfs[1] + 10, "per-channel peaks are reported for stereo");
}

console.log("\nLoudness consistency and range");
{
  const steady = analyzeChannels([noise(20, 0.1)], SR);
  const varying = (() => { const parts = []; for (let i = 0; i < 6; i++) parts.push(noise(4, i % 2 ? 0.02 : 0.2, i + 3)); const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return analyzeChannels([out], SR); })();
  ok(steady.shortTermStdDevLu < 1 && varying.shortTermStdDevLu > 3, `steady audio is consistent (${steady.shortTermStdDevLu} LU) and alternating loud/quiet is not (${varying.shortTermStdDevLu} LU)`);
  ok(varying.loudnessRangeLu > 10, `loudness range reports the swing (${varying.loudnessRangeLu} LU)`);
  const k = kWeightingCoefficients(44100);
  ok(Number.isFinite(k.shelf.b[0]) && Number.isFinite(k.highpass.a[1]), "K-weighting coefficients exist for 44.1 kHz too");
  const parts = [noise(10, 0.1, 9)]; const whole = measureLoudness(parts, SR).integratedLufs;
  const s = new StreamingAnalyzer(SR, 1); for (let i = 0; i < parts[0].length; i += 4801) s.push([parts[0].subarray(i, i + 4801)]);
  near(s.result().integratedLufs, whole, 0.6, "streaming analysis (odd block size) matches one-shot loudness");
}

console.log("\nStage comparison finds where degradation appears");
{
  const mk = (x) => analyzeChannels([x], SR);
  const clean = mk(sine(440, 5, 0.2));
  const clipped = mk(sine(440, 5, 1.6).map((v) => Math.max(-1, Math.min(1, v))));
  const findings = compareStages([{ name: "raw mic", analysis: clean }, { name: "webrtc", analysis: clean }, { name: "recorded", analysis: clipped }]);
  ok(findings.some((f) => f.stage === "recorded" && f.code === "clipping"), "clipping is attributed to the stage that introduced it");
  ok(findings.some((f) => f.stage === "recorded" && f.code === "peak-rise"), "a peak rise between stages is reported");
  ok(!findings.some((f) => f.stage === "webrtc"), "an unchanged stage reports nothing");
  const resampled = compareStages([{ name: "a", analysis: { ...clean } }, { name: "b", analysis: { ...clean, sampleRate: 44100, channels: 2 } }]);
  ok(resampled.some((f) => f.code === "resampled") && resampled.some((f) => f.code === "channel-change"), "sample-rate and channel changes are reported");
}

console.log("\nDelay and similarity between a reference and a processed copy");
{
  const ref = noise(6, 0.2, 5);
  const delayed = new Float32Array(ref.length); delayed.set(ref.subarray(0, ref.length - 2400), 2400); // 50 ms later
  const r = compareSignals(ref, Float32Array.from(delayed, (v) => v * 0.5), SR);
  near(r.delayMs, 50, 1.5, "a 50 ms delay is measured");
  near(r.gainDb, -6, 0.3, "a 0.5x gain is measured as -6 dB");
  ok(r.waveformCorrelation > 0.99, "an exact delayed copy correlates at waveform level");
  const extra = noise(6, 0.02, 11);
  const noisy = Float32Array.from(ref, (v, i) => v + extra[i]);
  ok(compareSignals(ref, noisy, SR).signalToErrorDb < compareSignals(ref, ref, SR).signalToErrorDb, "added noise lowers signal-to-error");
}

console.log("\nWebRTC stats and recorder gaps");
{
  const base = [{ type: "inbound-rtp", kind: "audio", packetsReceived: 1000, packetsLost: 10, jitter: 0.012, concealedSamples: 4800, totalSamplesReceived: 480000 }];
  const s1 = summarizeRtcAudioStats(base);
  near(s1.inbound.packetLossPct, 0.99, 0.02, "packet loss percentage");
  near(s1.inbound.jitterMs, 12, 0.1, "jitter in ms");
  const s2 = summarizeRtcAudioStats([{ ...base[0], packetsReceived: 1100, packetsLost: 30, concealedSamples: 4800 + 48000, totalSamplesReceived: 480000 + 96000 }], s1);
  near(s2.inbound.intervalPacketLossPct, 16.7, 0.2, "per-interval loss reflects a bad stretch, not the lifetime average");
  ok(rtcQualityVerdict(s1).state === "good" && rtcQualityVerdict(s2).state === "poor", "verdicts: clean = good, lossy/concealed = poor");
  const g = detectRecorderGaps([0, 1000, 2010, 6000, 7000], 1000);
  ok(g.gaps.length === 1 && g.gaps[0].lateByMs === 2990, "a recorder slice that arrives 3 s late is reported as a gap");
}

console.log("\nEnhancement: gentle, bounded, never clips");
{
  // Quiet speech-like programme: bursts of 200 Hz+harmonics with a -60 dBFS noise floor between.
  const sr = SR, len = sr * 20, floor = noise(20, dbToLin(-60), 21);
  const programme = (ampDb) => { const out = new Float32Array(len); for (let i = 0; i < len; i++) { const t = i / sr, gate = (t % 2) < 1.2 ? 1 : 0; out[i] = floor[i] + gate * dbToLin(ampDb) * (Math.sin(2 * Math.PI * 200 * t) + 0.5 * Math.sin(2 * Math.PI * 400 * t) + 0.25 * Math.sin(2 * Math.PI * 800 * t)); } return out; };
  const sig = programme(-22);
  const before = analyzeChannels([sig], sr);
  const { channels, report } = enhanceChannels([sig], sr);
  const after = analyzeChannels(channels, sr);
  near(after.integratedLufs, ENHANCE_DEFAULTS.targetLufs, 1.0, `quiet material is normalised to ${ENHANCE_DEFAULTS.targetLufs} LUFS`);
  ok(after.peakDbfs <= ENHANCE_DEFAULTS.limiterCeilingDb + 0.05, `peaks stay under the ${ENHANCE_DEFAULTS.limiterCeilingDb} dBFS ceiling (${after.peakDbfs})`);
  ok(after.clippedSamples === 0, "no clipped samples after enhancement");
  ok(report.appliedGainDb > 0 && report.appliedGainDb <= ENHANCE_DEFAULTS.maxBoostDb, `boost stays within the ceiling (${report.appliedGainDb.toFixed(1)} dB, max ${ENHANCE_DEFAULTS.maxBoostDb})`);
  ok(before.integratedLufs < after.integratedLufs, "output is louder than the quiet original");
  // A quiet take is raised by the MEASURED distance to the target (a 22 dB boost here), not by a fixed amount, and a quiet take in a
  // noisy room is capped by its signal-to-noise ratio so the noise is not brought up as loud as the voice.
  const quietClean = enhanceChannels([programme(-42)], sr);
  ok(quietClean.report.appliedGainDb > 15, `a clean, very quiet take is raised by the distance it needs (${quietClean.report.appliedGainDb.toFixed(1)} dB)`);
  const noisyFloor = noise(20, dbToLin(-52), 22);
  const noisyQuiet = programme(-42).map((v, i) => v - floor[i] + noisyFloor[i]);
  const capped = enhanceChannels([noisyQuiet], sr);
  ok(capped.report.boostCapped && capped.report.capReason === "limited-by-noise" && capped.report.plannedGainDb < capped.report.verdict.state.length * 0 + 20, `a quiet take in a noisy room is capped by its noise (${capped.report.plannedGainDb.toFixed(1)} dB planned)`);

  // Hot material with sudden spikes: limiter must hold the ceiling and the loud spike must not drag everything down.
  const hot = noise(10, 0.05, 31).map((v, i) => v + (i > sr * 4 && i < sr * 4 + 200 ? 0.98 : 0));
  const h = enhanceChannels([hot], sr).channels;
  ok(analyzeChannels(h, sr).peakDbfs <= ENHANCE_DEFAULTS.limiterCeilingDb + 0.05, "a sudden spike (laughter, a bump) is held under the ceiling");
  const direct = limit([Float32Array.from({ length: 4800 }, (_, i) => (i === 2400 ? 1.4 : 0.1 * Math.sin(i / 20)))], sr, { ceilingDb: -1, lookaheadMs: 5, releaseMs: 80 })[0];
  ok(Math.max(...direct.map(Math.abs)) <= dbToLin(-1) + 1e-6, "the limiter guarantees no sample exceeds the ceiling");

  // High-pass removes rumble but leaves speech frequencies.
  const rumble = sine(30, 2, 0.3), voice = sine(500, 2, 0.3);
  const rr = analyzeChannels([highpass(rumble, SR, 80)], SR), vv = analyzeChannels([highpass(voice, SR, 80)], SR);
  ok(rr.rmsDbfs < -22.6 - 6 && vv.rmsDbfs > -13.6 - 0.5, `80 Hz high-pass attenuates 30 Hz rumble (${rr.rmsDbfs}) and keeps 500 Hz speech (${vv.rmsDbfs})`);

  // Silence in, silence out (no NaN, no gain applied to nothing).
  const silent = enhanceChannels([new Float32Array(SR * 2)], SR);
  ok(silent.channels[0].every((v) => v === 0) && silent.report.appliedGainDb === 0, "silence stays silence");

  // Noise reduction is optional and capped.
  const nr = enhanceChannels([sig], sr, { noiseReduction: { enabled: true, maxReductionDb: 30 } });
  ok(nr.report.options.noiseReduction.maxReductionDb === 15, "noise reduction depth is capped so voices do not sound processed");
  const nrAfter = analyzeChannels(nr.channels, sr);
  ok(nrAfter.peakDbfs <= ENHANCE_DEFAULTS.limiterCeilingDb + 0.05, "noise reduction path still respects the ceiling");
}

console.log("\nOptions and ffmpeg parity");
{
  const o = normalizeEnhanceOptions({ compressor: { ratio: 20 }, targetLufs: -3, limiterCeilingDb: 2 });
  ok(o.compressor.ratio === 4 && o.targetLufs === -10 && o.limiterCeilingDb === -0.1, "out-of-range options are clamped to safe bounds");
  const chain = buildFfmpegEnhanceFilters().join(",");
  ok(/highpass=f=80/.test(chain) && /acompressor=/.test(chain) && !/afftdn/.test(chain), "default ffmpeg chain: high-pass + gentle compressor, no noise reduction");
  ok(/afftdn/.test(buildFfmpegEnhanceFilters({ noiseReduction: { enabled: true } }).join(",")), "noise reduction is added only when asked for");
  ok(/alimiter=limit=0\.841/.test(buildFfmpegLimiter()), "ffmpeg limiter ceiling matches -1.5 dBFS");
  ok(/volume=12\.00dB,acompressor/.test(buildFfmpegEnhanceFilters({}, { preGainDb: 12 }).join(",")), "the measured gain goes in front of the compressor");
}

console.log("\nMicrophone processing configuration");
{
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const d = readMicProcessing(storage);
  ok(d.preset === "speakers" && d.echoCancellation && d.noiseSuppression && !d.autoGainControl, "default keeps echo cancellation ON (people use speakers) and AGC OFF");
  writeMicProcessing("headphones", storage);
  const h = readMicProcessing(storage);
  ok(h.preset === "headphones" && !h.echoCancellation && h.noiseSuppression, "headphones preset drops only echo cancellation");
  ok(JSON.stringify(vdoMicProcessingParams(h)) === JSON.stringify({ aec: "0", denoise: "1", autogain: "0" }), "VDO publisher params mirror the chosen processing");
  ok(JSON.stringify(vdoMicProcessingParams(normalizeMicProcessing("speakers"))) === JSON.stringify({ aec: "1", denoise: "1", autogain: "0" }), "speakers preset publishes aec=1 denoise=1 autogain=0");
  const c = cleanMicAudioConstraint("dev", normalizeMicProcessing("studio"));
  ok(!c.echoCancellation && !c.noiseSuppression && !c.autoGainControl && c.deviceId.exact === "dev", "studio preset: all processing off, device kept");
  store.set(MIC_PROCESSING_STORAGE_KEY, "garbage");
  ok(readMicProcessing(storage).preset === "speakers", "an unknown stored value falls back to the safe default");
  ok(readMicProcessing({ getItem() { throw new Error("blocked"); } }).preset === "speakers", "blocked storage falls back to the safe default");
  ok(classifyMicLevel({ peakDbfs: -0.1 }).state === "clipping" && classifyMicLevel({ peakDbfs: -12 }).state === "good" && classifyMicLevel({ peakDbfs: -30 }).state === "quiet" && classifyMicLevel(null).state === "silent", "level monitor classifies silent / quiet / good / clipping");
}
console.log("\nALL PASSED — audio measurement and enhancement behave as specified.");
