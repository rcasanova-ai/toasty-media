#!/usr/bin/env node
// Automated loudness check for exported or recorded files. Measures each file with ffmpeg's EBU R128 meter and fails (exit 1)
// when the audio is missing, unexpectedly quiet, too far from the speech target or peaks too close to full scale.
//
//   node scripts/audio-check-export.mjs clip.mp4 [more files]            export check: -16 LUFS +/- 1.5, true peak <= -1.0 dBTP
//   node scripts/audio-check-export.mjs --recording studio.mp4           raw Studio recording check: not silent, not below -30 LUFS
//   options: --target -16  --tolerance 1.5  --max-peak -1.0  --min-lufs -30  --json report.json
//
// A file with no audio stream, digital silence, a long dead stretch, or a leading silence of several seconds is reported too.
import { writeFileSync } from "node:fs";
import { analyzeFile, ffmpegLoudness } from "./lib/audio-file-analysis.mjs";
import { analyseSpeechLevel, classifyLevel } from "../js/loudness-plan.js";
import { loadMono } from "./lib/audio-file-analysis.mjs";
import { WARNING_TEXT } from "../js/clip-loudness.js";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 ? Number(args[i + 1]) : d; };
const jsonPath = args.includes("--json") ? args[args.indexOf("--json") + 1] : null;
const valued = new Set(["target", "tolerance", "max-peak", "min-lufs", "json"]);
const files = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--") && valued.has(args[i - 1].slice(2))));
if (!files.length) { console.error("usage: audio-check-export.mjs [--recording] [--target -16] [--tolerance 1.5] [--max-peak -1.0] [--min-lufs -30] [--json out.json] <file...>"); process.exit(2); }

const recording = flag("recording");
const target = value("target", -16), tolerance = value("tolerance", 1.5), maxPeak = value("max-peak", -1.0), minLufs = value("min-lufs", -30);
const report = [];
let failed = false;

for (const file of files) {
  const row = { file, problems: [], notes: [] };
  try {
    const a = await analyzeFile(file, { seconds: null });
    if (!a.probe?.audio) { row.problems.push("The file has no audio stream."); }
    else {
      const m = await ffmpegLoudness(file);
      const mono = await loadMono(file, { seconds: 1800 });
      const level = analyseSpeechLevel([mono.samples], mono.sampleRate), verdict = classifyLevel(level);
      Object.assign(row, { integratedLufs: m.integratedLufs, loudnessRangeLu: m.loudnessRangeLu, truePeakDbtp: m.truePeakDbfs, durationSeconds: a.probe.audio.duration ?? null, state: verdict.state, leadingSilenceSeconds: Math.round(level.leadingSilenceSeconds * 10) / 10 });
      if (verdict.state === "silent" || m.integratedLufs == null) row.problems.push(WARNING_TEXT["no-audio"]);
      else if (recording) {
        if (m.integratedLufs < minLufs) row.problems.push(`The recording is unexpectedly quiet (${m.integratedLufs} LUFS, minimum ${minLufs}).`);
        if (m.truePeakDbfs != null && m.truePeakDbfs > -0.5) row.problems.push(`The recording peaks at ${m.truePeakDbfs} dBTP and may be clipped.`);
      } else {
        if (Math.abs(m.integratedLufs - target) > tolerance) row.problems.push(`Loudness ${m.integratedLufs} LUFS is outside ${target} +/- ${tolerance}.`);
        if (m.truePeakDbfs != null && m.truePeakDbfs > maxPeak) row.problems.push(`True peak ${m.truePeakDbfs} dBTP is above ${maxPeak}.`);
      }
      if (verdict.warnings.includes("leading-silence")) row.notes.push(`The audio starts with ${row.leadingSilenceSeconds} s of silence.`);
      if (verdict.warnings.includes("noisy")) row.notes.push("The noise floor is high compared with the voice.");
    }
  } catch (error) { row.problems.push(`Could not measure the file: ${error.message}`); }
  row.ok = row.problems.length === 0;
  if (!row.ok) failed = true;
  report.push(row);
  console.log(`${row.ok ? "PASS" : "FAIL"}  ${file}`);
  if (row.integratedLufs != null) console.log(`      ${row.integratedLufs} LUFS, true peak ${row.truePeakDbtp} dBTP, range ${row.loudnessRangeLu} LU`);
  for (const p of row.problems) console.log(`      problem: ${p}`);
  for (const n of row.notes) console.log(`      note: ${n}`);
}
if (jsonPath) writeFileSync(jsonPath, JSON.stringify(report, null, 2));
process.exit(failed ? 1 : 0);
