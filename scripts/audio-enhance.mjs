#!/usr/bin/env node
// Enhance the voice in a recording, on this computer, for any length. The input file is never modified.
//   node scripts/audio-enhance.mjs recording.mp4                      -> recording-enhanced.mp4 (video copied, audio re-encoded)
//   node scripts/audio-enhance.mjs recording.mp4 --audio-only         -> recording-enhanced.m4a
//   node scripts/audio-enhance.mjs recording.mp4 --noise-reduction    -> adds gentle background-noise reduction
//   options: --target -16 (LUFS)  --ceiling -1.5 (dBFS)  --out path  --no-noise-reduction (default is automatic: on when the boost is large)
// Chain: the speech level is MEASURED first (gated loudness and signal-to-noise ratio); 80 Hz high-pass -> noise reduction (automatic
// when the boost is large) -> the measured gain -> gentle 2:1 compressor -> a small trim to land on the target -> look-ahead limiter,
// then a true-peak check that re-renders with more headroom if the encoded file would exceed -1.5 dBTP. Not a fixed gain: a file
// already at -16 LUFS is left alone, one that is 29 dB too quiet is raised 29 dB (unless its noise says otherwise). Requires ffmpeg.
import { basename, dirname, extname, join } from "node:path";
import { enhanceFile } from "./lib/audio-enhance-ffmpeg.mjs";
import { analyzeFile } from "./lib/audio-file-analysis.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const input = args.find((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && ["target", "ceiling", "out"].includes(args[i - 1].slice(2))));
if (!input) { console.error("usage: audio-enhance.mjs <recording> [--audio-only] [--noise-reduction] [--target -16] [--ceiling -1.5] [--out file]"); process.exit(2); }
const audioOnly = flag("audio-only");
const ext = audioOnly ? ".m4a" : (extname(input).toLowerCase() === ".webm" ? ".mkv" : extname(input) || ".mp4");
const out = value("out") || join(dirname(input), `${basename(input, extname(input))}-enhanced${ext}`);
if (out === input) { console.error("refusing to overwrite the input"); process.exit(2); }
const options = {
  ...(value("target") ? { targetLufs: Number(value("target")) } : {}),
  ...(value("ceiling") ? { limiterCeilingDb: Number(value("ceiling")) } : {}),
  ...(flag("noise-reduction") ? { noiseReduction: { enabled: true } } : flag("no-noise-reduction") ? { noiseReduction: { enabled: false } } : {})
};
const before = await analyzeFile(input);
const result = await enhanceFile(input, out, { options, audioOnly });
const after = await analyzeFile(out);
const row = (label, m) => `${label.padEnd(9)} ${String(m.integratedLufs).padStart(7)} LUFS   peak ${String(m.peakDbfs).padStart(6)} dBFS   range ${String(m.loudnessRangeLu).padStart(5)} LU   consistency (std dev) ${m.shortTermStdDevLu} LU   clipped ${m.clippedSamples}`;
console.log(row("original", before.analysis));
console.log(row("enhanced", after.analysis));
if (result.verdict.state !== "ok") console.log(`input check: ${result.verdict.state}${result.verdict.message ? ": " + result.verdict.message : ""}`);
console.log(`applied gain ${result.appliedGainDb} dB (planned ${result.plannedGainDb}${result.noiseReduced ? ", noise reduced" : ""})${result.boostCapped ? ` (capped: ${result.capReason})` : ""}, true peak ${result.truePeakDbtp} dBTP${result.truePeakCorrections ? ` after ${result.truePeakCorrections} headroom correction(s)` : ""}${result.videoCopied ? ", video stream copied untouched" : ""}`);
console.log(`written: ${out}\noriginal untouched: ${input}`);
