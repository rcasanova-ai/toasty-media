#!/usr/bin/env node
// Measure one or more audio/video files and (with --stages) trace where quality changed between them.
//   node scripts/audio-analyze.mjs recording.mp4
//   node scripts/audio-analyze.mjs --stages "raw mic=raw.wav" "recorded=take.webm" "exported=final.mp4"
//   node scripts/audio-analyze.mjs --json file.mp4
// Reports: codec, bitrate, sample rate, channels, peak/clipping, loudness (LUFS), loudness range and consistency,
// dropouts, silence, DC offset, and A/V start/duration offsets. --stages adds per-stage findings and delay/similarity
// against the first stage.
import { analyzeFile, loadMono, ffmpegLoudness } from "./lib/audio-file-analysis.mjs";
import { compareStages, compareSignals } from "../js/audio-analysis.js";

const args = process.argv.slice(2);
const json = args.includes("--json");
const stagesMode = args.includes("--stages");
const verifyFfmpeg = args.includes("--verify-loudness");
const inputs = args.filter((a) => !a.startsWith("--"));
if (!inputs.length) { console.error("usage: audio-analyze.mjs [--json] [--stages] [--verify-loudness] file | \"name=file\" ..."); process.exit(2); }

const targets = inputs.map((entry) => { const i = entry.indexOf("="); return i > 0 && !entry.slice(0, i).includes("/") ? { name: entry.slice(0, i), path: entry.slice(i + 1) } : { name: entry, path: entry }; });
const results = [];
for (const t of targets) {
  const r = await analyzeFile(t.path);
  if (verifyFfmpeg && r.analysis) r.ffmpegLoudness = await ffmpegLoudness(t.path);
  results.push({ ...t, ...r });
}
const out = { files: results.map(({ name, path, probe, analysis, ffmpegLoudness: fl, error }) => ({ name, path, probe, analysis, ffmpegLoudness: fl, error })) };
if (stagesMode) {
  const withAudio = results.filter((r) => r.analysis);
  out.findings = compareStages(withAudio.map((r) => ({ name: r.name, analysis: r.analysis })));
  const ref = withAudio[0] && await loadMono(withAudio[0].path);
  out.similarity = [];
  for (const r of withAudio.slice(1)) {
    const test = await loadMono(r.path);
    // Compare at the reference rate; when rates differ the comparison is skipped rather than resampled-and-guessed.
    out.similarity.push(test.sampleRate === ref.sampleRate
      ? { stage: r.name, ...compareSignals(ref.samples, test.samples, ref.sampleRate) }
      : { stage: r.name, skipped: `sample rates differ (${ref.sampleRate} vs ${test.sampleRate})` });
  }
}
if (json) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const f = (v, unit = "") => (v == null || v === "" ? "n/a" : `${v}${unit}`);
for (const r of out.files) {
  console.log(`\n${r.name}${r.name !== r.path ? `  (${r.path})` : ""}`);
  if (r.error) { console.log(`  ${r.error}`); continue; }
  const a = r.probe.audio, v = r.probe.video, m = r.analysis;
  console.log(`  container ${f(r.probe.container)}  duration ${f(r.probe.durationSec, "s")}  size ${f(r.probe.sizeBytes ? (r.probe.sizeBytes / 1e6).toFixed(2) : null, " MB")}`);
  console.log(`  audio     ${a.codec}${a.profile ? ` (${a.profile})` : ""}  ${a.sampleRate} Hz  ${a.channels} ch ${a.channelLayout || ""}  ${f(a.bitrateKbps, " kbps")}`);
  if (v) console.log(`  video     ${v.codec} ${v.width}x${v.height} @ ${f(v.fps && v.fps.toFixed(2), " fps")}   A/V start offset ${f(r.probe.avStartOffsetMs, " ms")}, A/V duration delta ${f(r.probe.avDurationDeltaMs, " ms")}`);
  console.log(`  levels    peak ${m.peakDbfs} dBFS   rms ${m.rmsDbfs} dBFS   crest ${m.crestDb} dB   dc ${m.dcOffset}`);
  console.log(`  loudness  ${m.integratedLufs} LUFS   range ${m.loudnessRangeLu} LU   short-term std dev ${m.shortTermStdDevLu} LU` + (r.ffmpegLoudness ? `   [ffmpeg ebur128: ${r.ffmpegLoudness.integratedLufs} LUFS, LRA ${r.ffmpegLoudness.loudnessRangeLu}, TP ${r.ffmpegLoudness.truePeakDbfs}]` : ""));
  console.log(`  integrity clipped samples ${m.clippedSamples} (${m.clipRuns} runs)   dropouts ${m.dropouts.length}${m.dropouts.length ? ` (first ${m.dropouts[0].atSec}s, ${m.dropouts[0].durationMs} ms)` : ""}   silence ${(m.silenceRatio * 100).toFixed(1)}% (longest ${m.longestSilenceSec}s)`);
}
if (stagesMode) {
  console.log("\nFindings");
  if (!out.findings.length) console.log("  none: no measurable degradation between the stages");
  for (const x of out.findings) console.log(`  [${x.severity}] ${x.stage}: ${x.code}: ${x.detail}`);
  console.log("\nAgainst the first stage");
  for (const s of out.similarity) console.log("  " + (s.skipped ? `${s.stage}: ${s.skipped}` : `${s.stage}: delay ${s.delayMs} ms, gain ${s.gainDb} dB, waveform correlation ${s.waveformCorrelation}, signal-to-error ${s.signalToErrorDb} dB`));
}
