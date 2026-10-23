#!/usr/bin/env node
// Moxie's moment intelligence end to end on synthetic recordings: the original failure (a transcript with no trigger phrases),
// audio-only, single speaker, two people, no faces, quiet speech, strong visual reactions, a long recording, loudness without
// meaning, and a check that every claimed piece of evidence is a detected event inside the clip.
import { analyzeTimeline } from "../js/behavior/engine.js";
import { detectClips } from "../js/clip-detector.js";
import { voicedPcm, laughSegment, plainTranscript, visualSamples, SR } from "./lib/behavior-fixtures.mjs";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const run = (o) => analyzeTimeline({ embedderOptions: { disableModel: true }, ...o });
const speech = (secs, o = {}) => [{ t0: 1, t1: secs - 1, f0: 120, db: -26, ...o }];

function grounded(r, label) {
  for (const c of r.clips) {
    ok(c.evidence.every((e) => { const ev = r.timeline.get(e.id); return ev && ev.end >= c.start - 0.01 && ev.t <= c.end + 0.01 && ev.type === e.type; }), `${label}: every piece of evidence for "${c.title.slice(0, 30)}" is a detected event inside the clip`);
    const kinds = new Set(c.evidence.map((e) => e.kind));
    ok(c.explanationKinds.every((k) => kinds.has(k)), `${label}: the explanation mentions only evidence that exists (${c.explanationKinds.join(", ") || "none"})`);
    for (const e of c.evidence.filter((x) => c.explanationKinds.includes(x.kind) && x.track !== "language" && x.kind !== c.leadKind)) ok(c.explanation.includes(e.phrase), `${label}: the explanation says "${e.phrase}"`);
  }
}
const sane = (r, label, max = 12) => {
  ok(r.clips.length >= 1 && r.clips.length <= max, `${label}: ${r.clips.length} clip(s) returned`);
  ok(r.clips.every((c) => c.end > c.start && c.end - c.start >= 6 && c.end - c.start <= 80 && c.start >= 0 && c.end <= r.timeline.duration + 0.5), `${label}: every clip has sensible bounds`);
  ok(r.clips.every((c) => c.title && c.category && c.score >= 0 && c.score <= 100 && c.explanation && c.recommendation?.aspect && c.recommendation?.templateId && ["high", "medium", "low"].includes(c.tier)), `${label}: every clip has a title, category, score, explanation, format and template`);
};

console.log("\nThe original failure: ~30 plain transcript segments, no trigger phrases");
{
  const lines = plainTranscript();
  ok(lines.length === 30, "the transcript has 30 segments");
  const old = detectClips({ lines, duration: 230 });
  ok(old.length === 0, "the keyword detector finds NOTHING in it (this is the bug being fixed)");
  const r = await run({ lines, duration: 230 });
  sane(r, "plain transcript");
  ok(r.clips.length >= 4, `Moxie returns ${r.clips.length} candidate clips`);
  ok(r.engine.semantic === "lexical" && r.notes.some((n) => /shared vocabulary/.test(n)), "the lexical fallback is declared, not passed off as semantic understanding");
  ok(r.clips.every((c) => c.tier !== "high"), "with words alone and no corroboration, nothing is claimed as high confidence");
  const startsOnUnit = r.clips.every((c) => r.timeline.tracks.transcript.some((u) => Math.abs(u.t - c.start) < 0.8));
  ok(startsOnUnit, "every clip starts at the beginning of a sentence");
  const endsOnUnit = r.clips.every((c) => r.timeline.tracks.transcript.some((u) => Math.abs(u.end - c.end) < 1.5));
  ok(endsOnUnit, "every clip ends at the end of a sentence");
  ok(r.clips.every((c, i, a) => a.every((d, k) => k === i || Math.min(c.end, d.end) - Math.max(c.start, d.start) < 0.3 * Math.min(c.end - c.start, d.end - d.start))), "clips do not overlap heavily");
  ok(new Set(r.clips.map((c) => c.title)).size === r.clips.length, "titles are distinct");
  grounded(r, "plain transcript");
  console.log(r.clips.map((c) => `   ${c.tier} ${c.score} ${c.start}-${c.end} ${c.category} "${c.title}"`).join("\n"));
  const pricing = r.clips.filter((c) => Math.min(c.end, 105) - Math.max(c.start, 67.5) >= 15);
  ok(pricing.length >= 1, "the pricing discussion (lines 10 to 14, a self-contained argument) is covered by a clip");
  const sparse = await run({ lines: [{ t: 0, end: 3, text: "Okay." }, { t: 5, end: 8, text: "Yeah, right." }, { t: 10, end: 14, text: "Mm hm, sure, okay then." }, { t: 16, end: 20, text: "Alright let us go on." }], duration: 40 });
  ok(sparse.clips.length >= 1 && sparse.fallback && sparse.clips.every((c) => c.tier === "low"), "a transcript with nothing in it still yields the best available passage, labelled low confidence");
  ok(/Nothing in this recording stood out strongly/.test(sparse.clips[0].explanation), "and the explanation says nothing stood out");
}

console.log("\nAudio only (no transcript, no picture)");
{
  const pcm = voicedPcm([...speech(70, { db: -28 }), { t0: 30, t1: 36, f0: 140, db: -17, rate: 4.5 }, ...laughSegment(40, 43.5)], 72);
  const r = await run({ pcm, duration: 72 });
  sane(r, "audio only");
  ok(!r.timeline.has("transcript") && r.timeline.has("audio") && !r.timeline.has("face"), "capabilities say what was and was not analysed");
  ok(r.clips.every((c) => c.score <= 60 && c.tier !== "high"), "sound alone never reaches high confidence");
  ok(r.clips.every((c) => c.evidence.every((e) => ["voice", "interaction"].includes(e.modality))), "audio-only evidence is voice and interaction only");
  ok(r.clips.some((c) => c.start <= 36 && c.end >= 30) || r.clips.some((c) => c.start <= 43 && c.end >= 40), "the loud passage or the laughter is among the clips");
  ok(r.clips.every((c) => /No transcript was available|Nothing in this recording/.test(c.explanation)), "the explanation says no transcript was available");
  ok(r.clips.every((c) => c.recommendation.captions === "none"), "no captions are recommended without words");
  grounded(r, "audio only");
}

console.log("\nSingle speaker with visible reactions and gestures");
{
  const lines = plainTranscript({ speakers: null });
  const vis = { samples: visualSamples(230, [{ t: 78, kind: "smile" }, { t: 79, kind: "brow" }, { t: 80, kind: "nod" }, { t: 150, kind: "hands" }], { step: 0.5, hands: true }), caps: { face: true, hands: true, pose: false, motion: true } };
  const r = await run({ lines, visual: vis, duration: 230, pcm: voicedPcm(speech(228), 230) });
  sane(r, "single speaker");
  ok(r.timeline.has("face") && r.timeline.has("hands") && r.timeline.has("transcript") && r.timeline.has("audio"), "all four signals were analysed");
  ok(r.notes.some((n) => /Speakers are unknown/.test(n)) || r.engine.speakers.applied === false, "unknown speakers are acknowledged, so no conversation dynamics were invented");
  ok(!r.timeline.tracks.interaction.some((e) => ["challenge-response", "interruption", "rapid-exchange"].includes(e.type)), "no challenge, interruption or exchange is claimed for one speaker");
  const reaction = r.clips.find((c) => c.evidence.some((e) => e.modality === "face"));
  ok(!!reaction, "a clip whose evidence is a visible reaction exists");
  ok(reaction.evidence.some((e) => e.kind === "smile") || reaction.evidence.some((e) => e.kind === "brow-raise"), "its evidence names the observed expression (smile, raised brows), not a feeling");
  ok(!/happy|angry|sad|excit|nervous|afraid|emotion/i.test(JSON.stringify(r.clips.map((c) => [c.explanation, c.evidence.map((e) => e.label)]))), "no explanation attributes an inner emotion");
  grounded(r, "single speaker");
  ok(JSON.stringify(r.timeline.toJSON()).length > 1000, "the timeline serialises without any face template");
}

console.log("\nTwo-person conversation: claim, challenge, overlap, laughter, smiles");
{
  const lines = [
    { t: 0, end: 5, speaker: "Ana", text: "Thanks for joining me today, it is great to have you here." },
    { t: 6, end: 10, speaker: "Ben", text: "Happy to be here, I have been looking forward to this." },
    { t: 12, end: 18, speaker: "Ana", text: "Let me start with the claim I keep making, that remote teams ship slower than office teams." },
    { t: 19, end: 26, speaker: "Ana", text: "The data from our own projects over six years says offices win by about twenty percent." },
    { t: 26.5, end: 29, speaker: "Ben", text: "No, that is not true, you are comparing different kinds of projects." },
    { t: 29.6, end: 35, speaker: "Ana", text: "But the sample is large enough that the difference should show up anyway." },
    { t: 35.5, end: 39, speaker: "Ben", text: "Come on, you hired the best people for the office team." },
    { t: 40, end: 43, speaker: "Ana", text: "Okay, fair, that one actually stings a little." },
    { t: 60, end: 65, speaker: "Ben", text: "Let us move on to hiring, where I think we agree more." },
    { t: 66, end: 72, speaker: "Ana", text: "We do, the interview process is the part nobody measures." }];
  const pcm = voicedPcm([{ t0: 0, t1: 5, f0: 190, db: -28 }, { t0: 6, t1: 10, f0: 110, db: -28 }, { t0: 12, t1: 26, f0: 190, db: -28 }, { t0: 26.5, t1: 29, f0: 110, db: -20, rate: 3.5 }, { t0: 29.6, t1: 35, f0: 190, db: -22, rate: 3.2 }, { t0: 35.5, t1: 39, f0: 110, db: -21, rate: 3.5 }, ...laughSegment(40, 42.2, -20), { t0: 42.5, t1: 44, f0: 190, db: -28 }, { t0: 60, t1: 65, f0: 110, db: -28 }, { t0: 66, t1: 72, f0: 190, db: -28 }], 74);
  const vis = { samples: visualSamples(74, [{ t: 27, kind: "brow", slot: 0 }, { t: 40, kind: "smile", slot: 0 }, { t: 40, kind: "smile", slot: 1 }, { t: 30, kind: "nod", slot: 1 }], { faces: 2, step: 0.5 }), caps: { face: true, hands: false, pose: false, motion: true } };
  const r = await run({ lines, pcm, visual: vis, duration: 74 });
  sane(r, "two people");
  const top = r.clips[0];
  console.log("  top:", top.category, top.score, top.start, top.end, top.title, "|", top.explanation);
  ok(top.start <= 19 && top.end >= 40, "the strongest clip spans the claim, the challenge and the reaction");
  ok(top.category === "disagreement", `its category is disagreement (${top.category})`);
  ok(top.evidence.some((e) => e.kind === "challenge"), "the challenge between the two speakers is evidence");
  ok(top.evidence.some((e) => e.kind === "laughter" || e.kind === "shared-laughter"), "the laughter is evidence");
  ok(top.evidence.some((e) => e.modality === "face"), "the visible reaction is evidence");
  ok(/challenge/.test(top.explanation) && /laughter/.test(top.explanation), "the explanation mentions the challenge and the laughter");
  ok(top.tier === "high", "corroboration from several kinds of evidence earns high confidence");
  ok(top.recommendation.aspect === "9:16" && top.recommendation.templateId === "hot-take" && top.recommendation.focusX != null, `recommendation: ${top.recommendation.aspect}, ${top.recommendation.templateId}, crop centred at ${top.recommendation.focusX}`);
  ok(r.timeline.tracks.interaction.some((e) => e.type === "shared-laughter"), "laughter with both speakers and both faces smiling is shared laughter");
  ok(r.timeline.tracks.interaction.some((e) => e.type === "challenge-response"), "the interaction track has the challenge");
  grounded(r, "two people");
  ok(r.clips.every((c) => c.recommendation.reason), "every recommendation says why");
}

console.log("\nNo detectable faces");
{
  const lines = plainTranscript();
  const vis = { samples: visualSamples(230, [{ t: 100, kind: "burst" }], { faces: 0, step: 1 }), caps: { face: false, hands: false, pose: false, motion: true }, notes: ["No faces were detected in the video."] };
  const r = await run({ lines, visual: vis, duration: 230, pcm: voicedPcm(speech(228), 230) });
  sane(r, "no faces");
  ok(!r.timeline.has("face") && r.timeline.has("motion"), "the face signal is reported as unavailable");
  ok(r.notes.includes("No faces were detected in the video."), "the engine says no faces were detected");
  ok(r.clips.every((c) => !c.evidence.some((e) => e.modality === "face")), "no face evidence is claimed");
}

console.log("\nQuiet conversation (everything at a whisper)");
{
  const lines = plainTranscript({ speakers: null });
  const pcm = voicedPcm([{ t0: 1, t1: 90, f0: 120, db: -48 }, { t0: 90, t1: 96, f0: 120, db: -40, rate: 3.5 }, { t0: 96, t1: 228, f0: 120, db: -48 }], 230);
  const r = await run({ lines, pcm, duration: 230 });
  sane(r, "quiet");
  const rise = r.timeline.tracks.audio.find((e) => e.type === "intensity-rise");
  ok(rise && rise.t >= 85 && rise.t <= 92, `a rise is measured against this recording's own level even though everything is quiet (${rise?.t}s)`);
  ok(rise.data.aboveUsualDb > 3, "and reported relative to the usual level");
}

console.log("\nLoudness and movement without meaning are not rewarded");
{
  const bland = ["Okay.", "Yeah.", "Right, sure.", "Mm hm.", "Okay so.", "Yeah okay.", "Alright.", "Sure thing.", "Right right."];
  const lines = []; let t = 0;
  for (let i = 0; i < 9; i++, t += 6) lines.push({ t, end: t + 3, speaker: "Ana", text: bland[i] });
  const real = plainTranscript().slice(10, 19).map((l, i) => ({ ...l, t: 100 + i * 7, end: 100 + i * 7 + 5.5 }));
  const all = [...lines, ...real];
  const pcm = voicedPcm([{ t0: 1, t1: 165, f0: 120, db: -28 }, { t0: 20, t1: 30, f0: 160, db: -12, rate: 4 }], 170);
  const vis = { samples: visualSamples(170, [{ t: 22, kind: "burst" }, { t: 24, kind: "burst" }, { t: 26, kind: "burst" }], { step: 0.5 }), caps: { face: true, hands: false, pose: false, motion: true } };
  const r = await run({ lines: all, pcm, visual: vis, duration: 170 });
  console.log(r.clips.map((c) => `   ${c.tier} ${c.score} ${c.start}-${c.end}`).join("\n"));
  const loudBland = r.clips.find((c) => c.start < 30 && c.end > 20 && c.end < 80), content = r.clips.find((c) => c.start >= 90);
  ok(content, "a clip over the passages with real content exists");
  ok(!loudBland || loudBland.score < content.score, `the loud, jumpy but empty passage ranks below the real content (${loudBland?.score ?? "not chosen"} < ${content.score})`);
  ok(!loudBland || loudBland.tier !== "high", "and is never high confidence");
}

console.log("\nMissing signals never stop the analysis");
{
  const lines = plainTranscript();
  const pcm = voicedPcm(speech(228), 230);
  for (const [label, o] of [["transcript only", { lines }], ["audio only", { pcm }], ["transcript and audio", { lines, pcm }], ["picture only", { visual: { samples: visualSamples(100, [{ t: 40, kind: "burst" }, { t: 41, kind: "smile" }], { step: 0.5 }), caps: { face: true, motion: true } } }], ["nothing", {}]]) {
    const r = await run({ ...o, duration: 230 });
    if (label === "nothing") { ok(r.clips.length === 0 && r.notes.some((n) => /nothing to analyse/i.test(n)), "with no usable input it says so instead of crashing"); continue; }
    ok(r.clips.length >= 1, `${label}: still produces clips (${r.clips.length})`);
  }
}

console.log("\nLong recording");
{
  const lines = [];
  const base = plainTranscript();
  for (let i = 0; i < 900; i++) lines.push({ ...base[i % 30], t: i * 4, end: i * 4 + 3.4, speaker: i % 5 === 4 ? "Host" : "Guest", text: base[i % 30].text + (i % 30 === 0 ? ` Episode part ${Math.floor(i / 30)}.` : "") });
  const dur = 900 * 4;
  const pcm = voicedPcm([{ t0: 1, t1: dur - 1, f0: 120, db: -28 }], dur);
  const vis = { samples: visualSamples(dur, [{ t: 600, kind: "smile" }], { step: 3 }), caps: { face: true, motion: true } };
  const t0 = Date.now();
  const r = await run({ lines, pcm, visual: vis, duration: dur });
  const ms = Date.now() - t0;
  sane(r, "long recording");
  console.log(`  ${dur / 60} min recording, ${r.stats.units} sentences, ${r.stats.candidates} candidates analysed in ${ms} ms`);
  ok(ms < 60000, "a 60 minute recording is analysed in under a minute");
  ok(r.clips.length === 12, "the best 12 are returned");
}
console.log("\nAll moment checks passed.");
