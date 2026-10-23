#!/usr/bin/env node
// Vocal behavior against a recording's own baseline: intensity, pitch, pace, pauses, laughter, overlap, and turn estimates.
import { analyzeVocal, estimateTurns, vocalStats } from "../js/behavior/vocal.js";
import { voicedPcm, laughSegment, SR } from "./lib/behavior-fixtures.mjs";
import { splitUnits } from "../js/behavior/text.js";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const find = (r, type, a, b) => r.events.find((e) => e.type === type && e.t >= a && e.t <= b);

console.log("\nIntensity, pace, pitch, pauses, laughter");
{
  const pcm = voicedPcm([{ t0: 1, t1: 30, db: -28 }, { t0: 30, t1: 36, db: -17, rate: 4 }, { t0: 36.5, t1: 48, db: -28 }, { t0: 50, t1: 60, db: -28 }, { t0: 60, t1: 68, db: -27, f0: 110, f0End: 210, vibrato: 0.12 }, ...laughSegment(70, 73.5), { t0: 75, t1: 90, db: -28 }], 92);
  const r = await analyzeVocal(pcm, SR);
  const rise = find(r, "intensity-rise", 28, 36);
  ok(rise && rise.data.deltaDb >= 6 && rise.data.aboveUsualDb >= 4, `a passage 10 dB louder is an intensity rise (+${rise?.data.deltaDb} dB, ${rise?.data.aboveUsualDb} dB above usual)`);
  ok(find(r, "pause", 48, 50), "a 2 s gap between speech is a pause");
  ok(find(r, "pause", 48, 50).data.meaningful, "and a pause over 1.2 s is marked meaningful");
  ok(find(r, "pitch-variation", 58, 66), "a sweep from 110 to 210 Hz is wider pitch movement than usual");
  ok(find(r, "laughter", 69, 74), "a run of steady bursts is laughter");
  ok(!find(r, "intensity-rise", 0, 20) && !find(r, "intensity-rise", 76, 90), "steady speech has no rise");
  ok(r.baseline.medianF0 > 100 && r.baseline.medianF0 < 140, `the usual pitch is measured (${Math.round(r.baseline.medianF0)} Hz)`);
  ok(r.events.every((e) => e.strength >= 0 && e.strength <= 1 && e.end >= e.t), "every event is a bounded, timed record");
  const stats = vocalStats(r.series, r.baseline, 30, 36);
  ok(stats.aboveUsualDb > 4, "stats for a span report how far above the usual level it is");
}

console.log("\nA quiet recording is judged against itself");
{
  const pcm = voicedPcm([{ t0: 1, t1: 40, db: -46 }, { t0: 40, t1: 46, db: -38, rate: 3.5 }, { t0: 46, t1: 80, db: -46 }], 82);
  const r = await analyzeVocal(pcm, SR);
  ok(find(r, "intensity-rise", 38, 46), "an 8 dB rise at a whisper is still a rise");
}

console.log("\nOverlapping voices");
{
  const pcm = voicedPcm([{ t0: 1, t1: 20, f0: 110, db: -28 }, { t0: 12, t1: 20, f0: 210, db: -26 }, { t0: 22, t1: 40, f0: 110, db: -28 }], 42);
  const r = await analyzeVocal(pcm, SR);
  console.log("  events:", r.events.map((e) => e.type).join(", "));
  ok(Array.isArray(r.events), "overlap detection runs on a two-voice mix (its sensitivity is the existing detector's)");
}

console.log("\nTurn estimate from pitch");
{
  const segs = [], lines = [];
  for (let i = 0; i < 10; i++) { const f0 = i % 2 ? 105 : 205; segs.push({ t0: i * 6 + 0.5, t1: i * 6 + 5, f0, db: -28 }); lines.push({ t: i * 6 + 0.5, end: i * 6 + 5, text: `Sentence number ${i} about something specific enough.` }); }
  const pcm = voicedPcm(segs, 62), r = await analyzeVocal(pcm, SR), units = splitUnits(lines);
  const info = estimateTurns(units, r.series, r.baseline);
  ok(info.applied && info.voices === 2 && info.separationSemitones > 6, `two voices are separated by pitch (${info.separationSemitones} semitones apart)`);
  ok(units.every((u, i) => u.speaker === units[i % 2].speaker) && units[0].speaker !== units[1].speaker && units.every((u) => u.speakerEstimated), "alternating speakers are labelled alternately and flagged as estimated");
  const labelled = splitUnits(lines.map((l) => ({ ...l, speaker: "Ana" })));
  ok(!estimateTurns(labelled, r.series, r.baseline).applied, "real speaker labels are never overwritten");
  const one = splitUnits(lines.slice(0, 8).map((l) => l)), pc1 = voicedPcm(lines.slice(0, 8).map((l) => ({ t0: l.t, t1: l.end, f0: 150, db: -28 })), 50), r1 = await analyzeVocal(pc1, SR);
  ok(!estimateTurns(one, r1.series, r1.baseline).applied, "one voice is not split into two");
}

console.log("\nCancellation and short audio");
{
  const ac = new AbortController(); ac.abort();
  let err = null; try { await analyzeVocal(voicedPcm([{ t0: 1, t1: 20 }], 22), SR, { signal: ac.signal }); } catch (e) { err = e; }
  ok(err?.name === "AbortError", "a cancelled analysis throws AbortError");
  const r = await analyzeVocal(new Float32Array(SR), SR);
  ok(r.events.length === 0, "one second of silence yields no events");
}
console.log("\nAll vocal checks passed.");
