#!/usr/bin/env node
// Unit tests for the Automatic Director's pure engine: dead-air removal, segment choice, pacing, the three styles' decisions,
// effect-density limits, framing, emphasis, frame state, B-roll matching and natural-language revisions. No browser needed.
import { buildPlan, describePlan } from "../js/director/plan.js";
import { detectSpeechRegions } from "../js/director/speech.js";
import { alignWords } from "../js/director/words.js";
import { findStats, findSteps, scoreWords } from "../js/director/emphasis.js";
import { frameForRange, cropWindow, maxZoomForFace, faceInside } from "../js/director/framing.js";
import { frameState, visualSignature, segmentAt } from "../js/director/frame-state.js";
import { parseInstruction, applyInstruction } from "../js/director/revise.js";
import { placeBroll, tagsFromName } from "../js/director/broll.js";
import { sfxSchedule } from "../js/director/sfx.js";
import { STYLES, STYLE_IDS, resolveParams } from "../js/director/styles.js";
import * as F from "./lib/director-fixtures.mjs";

let failed = 0;
const ok = (c, m) => { if (c) console.log(`  ok — ${m}`); else { failed++; console.log(`  FAIL — ${m}`); } };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const { lines, total } = F.linesFromDurations(F.estimatedDurations());
const picture = F.pictureFromLines(lines, total);
const regions = F.regionsFromLines(lines);
const analysis = { lines, picture, clips: F.momentsFromLines(lines), timeline: { tracks: { audio: [{ type: "intensity-rise", t: lines[2].t + 3, end: lines[2].t + 4, strength: 0.8 }], face: [], transcript: [] } } };
const src = { name: "interview.mp4", duration: total, width: 1280, height: 720 };
const mk = (style, extra = {}) => buildPlan({ analysis, speech: { regions }, style, aspect: "16:9", source: src, seed: 7, ...extra });

console.log("Voice activity detection");
{
  const sr = 16000, n = sr * 6, x = new Float32Array(n);
  let s = 1; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32) - 0.5;
  for (let i = 0; i < n; i++) x[i] = rnd() * 0.002;
  for (const [a, b] of [[0.5, 1.5], [3.0, 4.2]]) for (let i = a * sr; i < b * sr; i++) x[i] += 0.25 * Math.sin(2 * Math.PI * 140 * i / sr) * (0.6 + 0.4 * Math.sin(i / 900));
  const r = detectSpeechRegions(x, sr);
  ok(r.regions.length === 2, `two spoken stretches found in a six second take (${r.regions.length})`);
  ok(near(r.regions[0].start, 0.5, 0.12) && near(r.regions[0].end, 1.5, 0.2) && near(r.regions[1].start, 3.0, 0.12), `their edges are within 0.2 s (${r.regions.map((q) => `${q.start.toFixed(2)}-${q.end.toFixed(2)}`).join(", ")})`);
  const quiet = new Float32Array(n).map(() => rnd() * 0.002);
  ok(detectSpeechRegions(quiet, sr).regions.length <= 1, "a recording with no speech does not invent regions");
}

console.log("\nWords follow the voice, not the silence");
{
  const ws = alignWords([{ t: 10, end: 16, text: "one two three four five six", speaker: "A" }], [{ start: 10.2, end: 12 }, { start: 14, end: 15.8 }], {});
  ok(ws.length === 6 && ws.every((w) => (w.start >= 10.19 && w.end <= 12.01) || (w.start >= 13.99 && w.end <= 15.81)), "no word is placed in the 2 s gap inside the line");
  ok(ws.every((w, i) => i === 0 || w.start >= ws[i - 1].start), "words are in order");
}

console.log("\nEmphasis from observable signals");
{
  const ws = alignWords([{ t: 0, end: 6, text: "Honestly the biggest mistake is 73% of hires, never skipped." }], null, {});
  const sc = scoreWords(ws, { unitSig: () => 0.8, voiceEvents: [{ type: "intensity-rise", t: 1.2, end: 2.4, strength: 0.9 }] });
  const top = [...sc].sort((a, b) => b.emphasis - a.emphasis)[0];
  ok(top.emphasis > 0.6 && top.why.length >= 2, `the strongest word “${top.text}” has reasons: ${top.why.join(", ")}`);
  ok(sc.filter((w) => w.emphasis > 0.5).length < sc.length / 2, "not every word is emphasised");
  ok(sc.find((w) => w.text === "the").emphasis === 0, "function words are never emphasised");
  ok(findStats([{ t: 1, text: "73% of the hires I regret" }, { t: 5, text: "we did it twice" }]).length === 1, "a figure in the transcript becomes a stat, other lines do not");
  ok(findSteps(lines).length === 3, "“First… Second… Third…” is read as three steps");
}

console.log("\nPlans: structure, determinism, executable");
const plans = Object.fromEntries(STYLE_IDS.map((s) => [s, mk(s)]));
for (const id of STYLE_IDS) {
  const p = plans[id], segs = p.segments;
  ok(p.schema === "toasty.director.plan/1" && JSON.stringify(p) === JSON.stringify(mk(id)), `${id}: a plan is JSON and the same inputs give the identical plan`);
  ok(segs.length >= 2 && segs.every((s, i) => s.srcEnd > s.srcStart && (i === 0 || near(s.outStart, segs[i - 1].outEnd, 0.002))), `${id}: ${segs.length} shots, contiguous on the output timeline`);
  ok(segs.every((s, i) => i === 0 || s.cut !== "start"), `${id}: every cut says why`);
  ok(p.stats.deadAirRemoved > 3 && p.stats.contentSeconds < total - 3, `${id}: dead air removed (${p.stats.deadAirRemoved.toFixed(1)} s) so the footage runs ${p.stats.contentSeconds.toFixed(0)} s of ${total.toFixed(0)} s`);
  ok(p.decisions.length > 5 && p.decisions.every((d) => d.rule && d.action), `${id}: ${p.decisions.length} logged decisions, each with a rule`);
  ok(p.words.every((w) => w.end > w.start && segmentAt(p, (w.start + w.end) / 2)), `${id}: caption words all fall inside the edit`);
  const kept = p.words.filter((w) => w.start >= 0);
  ok(kept.every((w) => regions.some((r) => w.srcStart >= r.start - 0.2 && w.srcEnd <= r.end + 0.2)), `${id}: every word is timed inside a stretch where the voice is present`);
}

console.log("\nThe three styles make different decisions");
{
  const e = plans.energy.stats, c = plans.clean.stats, k = plans.cinematic.stats;
  ok(e.segments > c.segments && c.segments >= k.segments, `pacing: energy ${e.segments} shots > clean ${c.segments} >= cinematic ${k.segments}`);
  ok(e.deadAirRemoved > c.deadAirRemoved && c.deadAirRemoved > k.deadAirRemoved, `dead air: ${e.deadAirRemoved.toFixed(1)} s > ${c.deadAirRemoved.toFixed(1)} s > ${k.deadAirRemoved.toFixed(1)} s`);
  ok(e.punchIns > c.punchIns, `punch-in zooms: energy ${e.punchIns} vs clean ${c.punchIns}`);
  ok(plans.energy.captions.style === "kinetic" && plans.clean.captions.style === "bar" && plans.cinematic.captions.style === "cinema", "caption treatments differ: kinetic, bar, cinema");
  ok(plans.energy.captions.chunks[0].words.length <= 3 && plans.clean.captions.chunks.some((q) => q.words.length > 4), "energy captions are 1-3 words, clean captions are phrases");
  const kinds = (p) => new Set(p.cuts.filter((q) => q.kind !== "hard").map((q) => q.kind));
  ok([...kinds(plans.energy)].every((q) => ["wipe", "push", "flash"].includes(q)) && [...kinds(plans.cinematic)].every((q) => q === "dissolve") && [...kinds(plans.clean)].every((q) => q === "fade"), "transitions: energy wipe/push/flash, cinematic dissolve, clean fade");
  ok(plans.energy.audio.music.style === "upbeat" && plans.cinematic.audio.music.style === "cinematic" && plans.clean.audio.music.style === "chill", "music beds differ");
  ok(plans.energy.audio.sfx.length > plans.clean.audio.sfx.length, `sound accents: energy ${plans.energy.audio.sfx.length} vs clean ${plans.clean.audio.sfx.length}`);
  ok(plans.cinematic.look.grade.frame === "letterbox" && plans.clean.look.grade.frame === "none", "cinematic is letterboxed");
  const sig = Object.fromEntries(STYLE_IDS.map((s) => [s, visualSignature(plans[s]).join("|")]));
  ok(new Set(Object.values(sig)).size === 3, "the frame-by-frame description of the three plans is different");
}

console.log("\nAnti-overediting limits");
for (const id of STYLE_IDS) {
  const p = plans[id], L = STYLES[id].limits;
  ok(p.stats.zoomedShare <= L.zoomCoverage + 0.001, `${id}: zoomed ${(p.stats.zoomedShare * 100).toFixed(0)}% of the time (limit ${L.zoomCoverage * 100}%)`);
  ok(p.stats.effectsPer10s <= p.stats.effectLimitPer10s, `${id}: ${p.stats.effectsPer10s} effects per 10 s (limit ${p.stats.effectLimitPer10s.toFixed(1)})`);
  const hard = p.cuts.filter((c) => c.kind === "hard").length;
  ok(hard >= p.cuts.length / 2 || p.cuts.length < 3, `${id}: ${hard} of ${p.cuts.length} cuts are hard cuts`);
  const ps = [...p.punches].sort((a, b) => a.at - b.at);
  ok(ps.every((q, i) => i === 0 || q.at - ps[i - 1].at >= L.punchMinGap - 0.01), `${id}: zooms are at least ${L.punchMinGap} s apart`);
  ok(p.punches.every((q) => q.scale <= 1.32 && q.dur >= 0.5) && p.segments.every((s) => s.camera.scaleTo <= 1.32), `${id}: no zoom beyond 1.32x`);
}

console.log("\nFraming");
{
  const fr = frameForRange(picture, lines[2].t, lines[2].end);
  ok(near(fr.fx, 0.72, 0.03) && /mouth/.test(fr.reason), `follows the face whose mouth moves (Jordan on the right): x=${fr.fx.toFixed(2)}`);
  const none = frameForRange([], 0, 5, { manualFocusX: 0.3 });
  ok(none.fx === 0.3, "with no faces, the focus you set is used");
  const win = cropWindow({ srcW: 1280, srcH: 720, outW: 1080, outH: 1920, zoom: 1, fx: 0.72, fy: 0.5 });
  ok(near(win.w / 1280, 0.316, 0.01) && win.x >= 0 && win.x + win.w <= 1280, `a 9:16 crop is ${(win.w / 1280 * 100).toFixed(0)}% of the width and stays inside the picture`);
  ok(faceInside(win, { x: 0.72, y: 0.42, size: 0.22 }, 1280, 720), "and keeps the face inside");
  const zl = maxZoomForFace({ srcW: 1280, srcH: 720, outW: 1920, outH: 1080, faceSize: 0.5, limit: 1.3 });
  ok(zl < 1.3, `a large face limits the zoom (${zl.toFixed(2)}x) so it is never cut off`);
  const p916 = buildPlan({ analysis, speech: { regions }, style: "energy", aspect: "9:16", source: src, seed: 7 });
  ok(p916.segments.every((s) => { const w = cropWindow({ srcW: 1280, srcH: 720, outW: 1080, outH: 1920, zoom: s.camera.scaleTo, fx: s.camera.fx, fy: s.camera.fy }); const face = { x: s.camera.fx, y: 0.42, size: 0.22 }; return faceInside(w, face, 1280, 720, 0.02); }), "9:16: the framed speaker is inside every shot's crop at its widest zoom");
  ok(new Set(p916.segments.map((s) => s.camera.fx)).size >= 2, "9:16: the crop moves to the other speaker when the conversation turns");
}

console.log("\nFrame state is what the renderer draws");
{
  const p = plans.energy;
  const a = frameState(p, 0.2), b = frameState(p, p.timeline.intro + 3), z = frameState(p, p.timeline.total - 0.2);
  ok(a.phase === "intro" && b.phase === "content" && z.phase === "outro", "intro, content and outro phases");
  ok(b.srcTime >= p.segments[b.seg].srcStart && b.srcTime <= p.segments[b.seg].srcEnd, "the source time is inside the shot");
  const kp = p.typography[0];
  if (kp) { const mid = frameState(p, p.timeline.intro + (kp.start + kp.end) / 2), before = frameState(p, p.timeline.intro + kp.start - 0.5); ok(mid.typography.length === 1 && before.typography.length === 0, `key phrase “${kp.text}” is on screen only inside its window`); }
  const cap = p.captions.chunks[2], cm = frameState(p, p.timeline.intro + (cap.start + cap.end) / 2);
  ok(cm.captions && cm.captions.words.length === cap.words.length, "the caption chunk is on screen while it is spoken");
  const cut = p.cuts.find((c) => c.kind !== "hard");
  if (cut) { ok(frameState(p, p.timeline.intro + cut.at + cut.dur / 2).transition?.kind === cut.kind && !frameState(p, p.timeline.intro + cut.at + cut.dur + 0.1).transition, "a transition runs just after its cut and then ends"); ok(frameState(p, p.timeline.intro + cut.at - 0.04).snapshotDue, "the outgoing frame is held just before the cut"); }
  ok(JSON.stringify(frameState(p, 12.34)) === JSON.stringify(frameState(p, 12.34)), "frame state is deterministic");
}

console.log("\nSound design plan");
{
  const p = plans.energy;
  ok(p.audio.targetLufs === -16 && p.audio.enhance, "speech is normalised to -16 LUFS");
  ok(p.audio.sfx.every((e) => e.gainDb <= -15), "sound accents stay well below full scale");
  const wordsAbs = p.words.map((w) => [p.timeline.intro + w.start, p.timeline.intro + w.end]);
  const onWord = p.audio.sfx.filter((e) => !["whoosh", "tick", "swell", "pop"].includes(e.kind) && wordsAbs.some(([a, b]) => e.t > a + 0.05 && e.t < b - 0.05));
  ok(onWord.length === 0, "no impact lands in the middle of a spoken word");
  ok(sfxSchedule(p.audio.sfx).every((e) => e.peak > 0 && e.dur > 0), "every accent has a duration and level");
  const beats = p.decisions.find((d) => d.rule === "beat-cuts");
  ok(beats && beats.evidence.aligned >= 1, `jump cuts placed on the music's beat where the silence allows (${beats?.evidence.aligned} of ${beats?.evidence.tried})`);
}

console.log("\nRevisions through plain English");
{
  const base = { style: "clean", aspect: "16:9", params: resolveParams({}) };
  const expect = (text, check, label) => { const r = parseInstruction(text, { state: base }); ok(check(r), `“${text}” -> ${label}: ${r.applied.concat(r.unsupported.map((u) => "NO: " + u)).join("; ").slice(0, 110)}`); };
  expect("Less zooming.", (r) => r.params.zoom === 0.5, "zoom halved");
  expect("Make the captions bigger.", (r) => r.params.captionScale === 1.3, "captions bigger");
  expect("Remove the music.", (r) => r.params.music === false, "music off");
  expect("Make it faster.", (r) => r.params.pace > 1.2, "faster");
  expect("Use fewer transitions.", (r) => r.params.transitions === 0.5, "fewer transitions");
  expect("Start with the strongest statement.", (r) => r.params.startWithStrongest === true, "cold open");
  expect("Make it 30 seconds.", (r) => r.params.targetSeconds === 30, "30 seconds");
  expect("Use the Toasty branding.", (r) => r.params.branding === "full", "branding");
  expect("Make a punchy 60-second vertical video.", (r) => r.style === "energy" && r.aspect === "9:16" && r.params.targetSeconds === 60, "energy, vertical, 60 s");
  expect("Turn this interview into three polished clips.", (r) => r.params.count === 3, "three clips");
  expect("Make this more cinematic, but keep the editing subtle.", (r) => r.style === "cinematic" && r.params.zoom < 1, "cinematic and subtle");
  expect("Remove awkward pauses and make the audio sound professional.", (r) => r.params.pace >= 1.2 && r.applied.length === 2, "pauses cut, audio explained");
  expect("Add a dancing unicorn", (r) => !r.applied.length && r.unsupported.length === 1, "reported as not possible");
  expect("Make me look younger and add a voiceover", (r) => !r.applied.length && r.unsupported.length >= 2, "both reported as not possible");
  expect("Use b-roll", (r) => r.unsupported.some((u) => /library has no clips/.test(u)), "no library, so it says so");
  const once = applyInstruction({ ...base, params: { ...base.params } }, "Less zooming. Less zooming.");
  ok(once.settings.params.zoom === 0.5, "repeating an instruction in one message does not stack");
  const r1 = mk("energy", { params: { zoom: 0 } }), r2 = mk("energy", { params: { music: false } }), r3 = mk("energy", { params: { targetSeconds: 25 } }), r4 = mk("energy", { params: { startWithStrongest: true } }), r5 = mk("energy", { params: { transitions: 0 } }), r6 = mk("energy", { params: { captionScale: 1.3 } });
  ok(r1.punches.length === 0 && r1.segments.every((s) => s.camera.scaleTo === 1), "“no zoom” really removes every zoom from the plan");
  ok(r2.audio.music === null, "“remove the music” removes the music from the plan");
  ok(r3.timeline.content <= 25 * 1.12, `“25 seconds” re-cuts it to ${r3.timeline.content.toFixed(1)} s of footage`);
  ok(r4.decisions.some((d) => d.rule === "cold-open") && r4.segments[0].srcStart !== plans.energy.segments[0].srcStart, "“start with the strongest statement” changes the first shot");
  ok(r5.cuts.every((c) => c.kind === "hard"), "“no transitions” leaves only hard cuts");
  ok(near(r6.captions.size / plans.energy.captions.size, 1.3, 0.01), "“bigger captions” scales the caption size by 30%");
  const m = mk("energy", { params: { pace: 1.25 } });
  ok(m.stats.segments >= plans.energy.stats.segments && m.stats.deadAirRemoved >= plans.energy.stats.deadAirRemoved, "“faster” cuts at least as many pauses");
}

console.log("\nB-roll only where the words match");
{
  ok(tagsFromName("Hiring-Team_final.mp4").join() === "hiring,team", "tags come from the file name words");
  const words = plans.clean.words;
  const lib = [{ id: "b1", name: "hiring-team.mp4", duration: 8, tags: ["hiring"] }, { id: "b2", name: "volcano.mp4", duration: 8, tags: ["volcano"] }];
  const r = placeBroll({ library: lib, words, segments: plans.clean.segments, contentSeconds: plans.clean.timeline.content });
  ok(r.items.length >= 1 && r.items.every((i) => i.clip === "b1"), "footage tagged “hiring” is placed where “hiring” is spoken; the volcano clip is never used");
  ok(r.items.every((i) => i.end - i.start <= 2.5), "cutaways are short");
  const none = placeBroll({ library: [lib[1]], words, segments: plans.clean.segments, contentSeconds: 40 });
  ok(none.items.length === 0 && none.notes.length === 1, "when nothing matches, nothing is inserted and it says so");
  const withB = mk("clean", { brollLibrary: lib });
  ok(withB.broll.length >= 1 && withB.decisions.some((d) => d.rule === "b-roll"), "the planner logs each B-roll decision");
}

console.log("\nGraceful fallbacks");
{
  const bare = buildPlan({ analysis: { lines: [], clips: [] }, speech: null, style: "energy", aspect: "1:1", source: { name: "x.mp4", duration: 30 }, seed: 1 });
  ok(bare.segments.length >= 1 && bare.captions === null && bare.warnings.length >= 2, `no transcript, no voice data: still a valid plan with ${bare.warnings.length} plain warnings`);
  ok(frameState(bare, 5).phase !== undefined, "and it can be rendered");
  const long = buildPlan({ analysis: { lines, clips: F.momentsFromLines(lines), picture }, speech: { regions }, style: "clean", aspect: "16:9", source: { ...src, duration: 1800 }, params: { targetSeconds: 30 }, seed: 1 });
  ok(long.stats.mode === "one moment" || long.stats.mode === "best moments" || long.stats.mode === "whole recording", "a long source still plans");
}

console.log(failed ? `\n${failed} FAILED` : "\nALL PASSED — the Automatic Director plans deterministic, inspectable, style-specific, density-limited edits.");
process.exit(failed ? 1 : 0);
