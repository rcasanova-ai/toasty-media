// The Automatic Director's planner. Takes what Moxie already knows about a recording (transcript lines, ranked moments, the
// behavioral timeline, face positions, where the voice is present) and decides the edit: which stretches of the source to use and
// in what order, where the cuts fall, how tight the pauses are, the framing and zooms, caption timing, typography, graphics,
// transitions, music, sound accents and the intro and outro. The result is ONE plain JSON object, the edit plan, that
// js/director/render.js executes frame by frame. The planner is pure and seeded: the same inputs always give the same plan, and
// every decision carries the rule and the observable evidence behind it (plan.decisions) so a bad edit can be traced to its cause.
//
// Anti-overediting: every effect is placed through one Budget (effects per ten seconds, a minimum gap between prominent effects,
// a cap on how much of the video may be zoomed, a cap on simultaneous effects). What does not fit is skipped and logged.
import { getStyle, resolveParams } from "./styles.js";
import { regionsIn } from "./speech.js";
import { alignWords, lineEnd, wordsToOutput } from "./words.js";
import { findStats, findSteps, isContentWord, keyPhrase, scoreWords } from "./emphasis.js";
import { frameForRange, maxZoomForFace } from "./framing.js";
import { scoreLine } from "../clip-detector.js";
import { MUSIC_STYLES } from "../clip-music.js";
import { placeBroll } from "./broll.js";

export const PLAN_SCHEMA = "toasty.director.plan/1";
export const ASPECT_SIZE = Object.freeze({ "16:9": [1920, 1080], "9:16": [1080, 1920], "1:1": [1080, 1080] });

const r3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const GENERIC_SPEAKER = /^(speaker\s*\d*|host|guest|unknown|you|me|participant\s*\d*|user\s*\d*|s\d+)$/i;

// ------------------------------------------------------------------ effect budget
class Budget {
  constructor(limits, scale = 1) { this.l = limits; this.scale = Math.max(0.01, scale); this.items = []; this.rejected = []; }
  // cls: "camera" (punch-ins), "text" (key phrases, statistics, diagrams, lower thirds) and "transition" each keep their own
  // minimum gap and concurrency limit; the density limit (effects per ten seconds) counts all of them together.
  check(start, end, cls) {
    const perWindow = this.l.per10s * this.scale;
    const inWin = this.items.filter((i) => i.cls !== "transition" && i.start > start - 10 && i.start <= start + 10).length;
    if (cls !== "transition" && inWin + 1 > Math.max(1, perWindow * 2)) return "density (effects per ten seconds)";
    if (cls !== "light") {
      const gap = (cls === "camera" ? this.l.punchMinGap : this.l.minGap) / Math.min(2, this.scale);
      if (this.items.some((i) => i.cls === cls && start < i.end + gap && end > i.start - gap)) return "minimum gap between prominent effects";
      if (cls === "text" && this.items.filter((i) => i.cls === "text" && i.start < end && i.end > start).length + 1 > this.l.maxConcurrent) return "too many effects at once";
    }
    return null;
  }
  add(kind, start, end, cls = "text") { const why = this.check(start, end, cls); if (why) { this.rejected.push({ kind, start, why }); return why; } this.items.push({ kind, start, end, cls }); return null; }
}

// ------------------------------------------------------------------ planning
// input: {
//   analysis: { clips, lines, timeline, picture, notes },   timeline: BehaviorTimeline or its JSON; picture: [{t, faces:[{x,y,size,mouthOpen}]}]
//   speech: { regions } | null, style, aspect, params, seed, source: { name, duration, width, height }, forcedRange: { start, end, title } | null
// }
export function buildPlan(input) {
  const { analysis = {}, speech = null, style: styleId = "clean", aspect = "16:9", params: userParams = {}, seed = 1, source = {}, forcedRange = null, brollLibrary = null } = input;
  const S = getStyle(styleId), P = resolveParams(userParams), rng = mulberry32((seed >>> 0) || 1);
  const duration = Number(source.duration) || 0, srcW = source.width || 1280, srcH = source.height || 720;
  const [outW, outH] = ASPECT_SIZE[aspect] || ASPECT_SIZE["16:9"];
  const lines = [...(analysis.lines || [])].filter((l) => l && Number.isFinite(l.t) && String(l.text || "").trim()).sort((a, b) => a.t - b.t);
  const regions = speech?.regions?.length ? speech.regions : null;
  const picture = (analysis.picture || []).length ? analysis.picture : null;
  const tracks = analysis.timeline?.tracks || {};
  const units = tracks.transcript || [];
  const decisions = [], warnings = [];
  const note = (t, rule, evidence, action) => decisions.push({ t: r3(t), rule, evidence, action });
  if (!lines.length) warnings.push("There is no transcript, so captions, key phrases and statistics are unavailable and cuts rely on the audio alone.");
  if (!regions) warnings.push("The voice could not be located in the audio, so dead air was not removed.");
  if (!picture) warnings.push("No faces were tracked, so framing uses the centre (or the focus you set).");

  const unitSig = (t) => { const u = units.find((x) => t >= x.t && t <= x.end); if (u) return u.strength ?? 0.3; const l = lines.find((x, i) => t >= x.t && t <= lineEnd(lines, i)); return l ? Math.min(1, scoreLine(l).score / 100) : 0.25; };
  const lineValue = (a, b) => lines.reduce((s, l, i) => { const e = lineEnd(lines, i); return e > a && l.t < b ? s + unitSig(l.t) + scoreLine(l).score / 200 : s; }, 0);

  // pacing numbers for this render
  const pc = { maxGap: S.pace.maxGap / P.pace, keep: S.pace.keepGap / Math.sqrt(P.pace), lead: S.pace.lead, tail: S.pace.tail, maxShot: S.pace.maxShot / P.pace, minShot: S.pace.minShot };
  const target = P.targetSeconds ?? (forcedRange ? Math.min(S.targetSeconds, Math.max(15, forcedRange.end - forcedRange.start)) : S.targetSeconds);

  // ---------------- 1. which parts of the source
  let ranges, mode;
  const clips = [...(analysis.clips || [])].filter((c) => c.end > c.start).sort((a, b) => b.score - a.score);
  if (forcedRange) { ranges = [{ ...forcedRange }]; mode = "one moment"; }
  else if (duration <= target * 1.6 || !clips.length) { ranges = [{ start: 0, end: duration, title: "" }]; mode = "whole recording"; }
  else {
    ranges = []; let budget = 0;
    for (const c of clips) { if (budget >= target * 1.5) break; if (ranges.some((r) => r.start < c.end && c.start < r.end)) continue; ranges.push({ start: c.start, end: Math.min(duration, c.end), title: c.title, score: c.score, clipId: c.id }); budget += Math.min(c.end - c.start, target * 1.5); }
    ranges.sort((a, b) => a.start - b.start); mode = "best moments";
  }
  note(0, "choose-source", { mode, source: `${fmtT(duration)}`, target: `${Math.round(target)} s`, moments: clips.length }, mode === "whole recording" ? "Use the whole recording and tighten it." : `Use ${ranges.length} moment${ranges.length === 1 ? "" : "s"} ranked by Moxie: ${ranges.map((r) => `${fmtT(r.start)}-${fmtT(r.end)} (${r.title || "untitled"})`).join(", ")}.`);

  // ---------------- 2. dead air: tighten each range around the voice
  const reactions = [...(tracks.face || []), ...(tracks.audio || [])].filter((e) => ["smile", "brow-raise", "laughter", "head-nod"].includes(e.type) && (e.strength ?? 0.5) >= 0.45);
  const pieces = [];
  ranges.forEach((range, ri) => {
    const rs = regions ? regionsIn(regions, range.start, range.end) : null;
    if (!rs || !rs.length) { pieces.push({ start: range.start, end: range.end, ri, cut: pieces.length ? "topic" : "start" }); return; }
    let cur = { start: Math.max(range.start, rs[0].start - pc.lead), end: rs[0].end + pc.tail, ri, cut: pieces.length ? "topic" : "start" };
    for (let i = 1; i < rs.length; i++) {
      const gap = rs[i].start - rs[i - 1].end;
      const react = reactions.find((e) => e.t >= rs[i - 1].end - 0.2 && e.t <= rs[i].start + 0.2);
      const hold = react ? S.pace.reactionHold : 0;
      const keep = Math.max(pc.keep, Math.min(gap, hold));
      if (gap > pc.maxGap && gap > keep + 0.05) {
        const tail = Math.min(pc.tail, keep * 0.6), lead = Math.min(pc.lead + 0.05, keep - tail);
        cur.end = rs[i - 1].end + tail; pieces.push(cur);
        cur = { start: rs[i].start - lead, end: rs[i].end + pc.tail, ri, cut: "gap", removed: r3(gap - tail - lead) };
        if (react) note(rs[i - 1].end, "hold-reaction", { event: `${react.type} at ${fmtT(react.t)}`, strength: react.strength }, `Kept ${keep.toFixed(2)} s of the ${gap.toFixed(1)} s pause so the reaction is seen.`);
      } else cur.end = rs[i].end + pc.tail;
    }
    cur.end = Math.min(range.end + 0.3, cur.end); pieces.push(cur);
  });
  for (const p of pieces) { p.start = clamp(p.start, 0, duration); p.end = clamp(p.end, 0, duration); }
  const kept = pieces.filter((p) => p.end - p.start >= 0.4);
  const removedGaps = kept.filter((p) => p.cut === "gap");
  const removedSeconds = removedGaps.reduce((s, p) => s + (p.removed || 0), 0);
  if (removedGaps.length) note(0, "remove-dead-air", { pauses: removedGaps.length, longest: `${Math.max(...removedGaps.map((p) => p.removed)).toFixed(1)} s`, threshold: `${pc.maxGap.toFixed(2)} s` }, `Cut ${removedGaps.length} pause${removedGaps.length === 1 ? "" : "s"} longer than ${pc.maxGap.toFixed(2)} s down to ${pc.keep.toFixed(2)} s (${removedSeconds.toFixed(1)} s removed).`);

  // ---------------- 3. shots: split at speaker changes and over-long shots (cuts that remove no time)
  const lineAt = (t) => { for (let i = 0; i < lines.length; i++) if (t >= lines[i].t - 0.05 && t < lineEnd(lines, i)) return i; return -1; };
  const shots = [];
  for (const p of kept) {
    const starts = lines.map((l, i) => ({ i, t: l.t, speaker: l.speaker || "" })).filter((s) => s.t > p.start + pc.minShot && s.t < p.end - pc.minShot);
    const splits = [];
    let prevSpeaker = lines[lineAt(p.start + 0.05)]?.speaker || "";
    let lastCut = p.start;
    for (const s of starts) {
      const turn = s.speaker && prevSpeaker && s.speaker !== prevSpeaker;
      const tooLong = s.t - lastCut >= pc.maxShot;
      if ((turn && s.t - lastCut >= pc.minShot) || tooLong) { splits.push({ at: Math.max(lastCut + 0.1, s.t - 0.12), kind: turn ? "turn" : "reframe" }); lastCut = s.t; }
      if (s.speaker) prevSpeaker = s.speaker;
    }
    let from = p.start, cut = p.cut, removed = p.removed;
    for (const sp of splits) { shots.push({ start: from, end: sp.at, ri: p.ri, cut, removed }); from = sp.at; cut = sp.kind; removed = 0; }
    shots.push({ start: from, end: p.end, ri: p.ri, cut, removed });
  }
  for (const s of shots) { const li = lineAt((s.start + s.end) / 2); s.speaker = li >= 0 ? (lines[li].speaker || "") : ""; }

  // ---------------- 4. fit the length: drop the lowest-value shots first
  const len = (list) => list.reduce((s, x) => s + (x.end - x.start), 0);
  let chosen = shots;
  if (len(chosen) > target * 1.06 && chosen.length > 1) {
    const withValue = chosen.map((s, i) => ({ s, i, density: lineValue(s.start, s.end) / Math.max(1, s.end - s.start) + (i === 0 ? 0.05 : 0) }));
    const dropped = [];
    while (len(withValue.map((x) => x.s)) > target * 1.06 && withValue.length > 1) {
      const idx = withValue.reduce((m, x, i) => (x.density < withValue[m].density - 1e-9 || (Math.abs(x.density - withValue[m].density) < 1e-9 && i > m) ? i : m), 0);
      dropped.push(withValue.splice(idx, 1)[0]);
    }
    chosen = withValue.map((x) => x.s);
    note(0, "fit-length", { before: `${len(shots).toFixed(0)} s`, target: `${Math.round(target)} s` }, `Dropped ${dropped.length} lowest-value shot${dropped.length === 1 ? "" : "s"} (least significant speech per second): ${dropped.map((d) => fmtT(d.s.start)).join(", ")}.`);
    // a dropped neighbour makes the next shot a jump in the story
    chosen.forEach((s, i) => { if (i > 0 && s.start - chosen[i - 1].end > 5 && s.cut !== "topic") { s.cut = "topic"; } });
    if (chosen.length) chosen[0].cut = "start";
  }
  if (len(chosen) > target * 1.06 && chosen.length) {
    // one long shot is still too long: end it at the last sentence that fits
    const first = chosen[0]; const cap = first.start + target;
    const li = lines.map((l, i) => lineEnd(lines, i)).filter((e) => e <= cap && e > first.start + 3).pop();
    chosen = [{ ...first, end: li ?? cap }];
    note(0, "fit-length", { shot: `${len(shots).toFixed(0)} s` }, `Ended the edit at the last sentence that fits ${Math.round(target)} s.`);
  }

  // ---------------- 5. start with the strongest statement (a revision), without repeating it
  if (P.startWithStrongest && chosen.length) {
    let best = null;
    lines.forEach((l, i) => { const e = lineEnd(lines, i); const sh = chosen.findIndex((s) => l.t >= s.start - 0.05 && e <= s.end + 0.3); if (sh < 0) return; const dur = e - l.t; if (dur < 2 || dur > 9) return; const v = unitSig(l.t) + scoreLine(l).score / 200; if (!best || v > best.v) best = { v, i, sh, a: l.t - 0.12, b: e + 0.25 }; });
    if (best && !(best.sh === 0 && best.a - chosen[0].start < 1.5)) {
      const s = chosen[best.sh], before = { ...s, end: best.a }, hook = { start: best.a, end: Math.min(s.end, best.b), ri: s.ri, speaker: s.speaker, cut: "start" }, after = { ...s, start: hook.end, cut: "reframe", removed: 0 };
      const parts = [before.end - before.start > 0.8 ? before : null, after.end - after.start > 0.8 ? after : null].filter(Boolean);
      const rest = chosen.flatMap((x, i) => (i === best.sh ? parts : [x]));
      chosen = [hook, ...rest]; chosen.slice(1).forEach((x, i) => { if (i === 0) x.cut = "topic"; });
      note(hook.start, "cold-open", { line: lines[best.i].text.slice(0, 80), significance: +unitSig(lines[best.i].t).toFixed(2) }, `Moved the strongest statement (${fmtT(hook.start)}) to the start; it is not repeated later.`);
    } else if (best) note(best.a, "cold-open", {}, "The strongest statement already opens the edit.");
  }

  // ---------------- 6. titles, then segments with output times (and beat-aware cut placement)
  const bpm = MUSIC_STYLES[S.sound.music]?.bpm || 100, beat = 60 / bpm;
  const title = (P.title ?? forcedRange?.title ?? (mode === "best moments" ? ranges.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0]?.title : "") ?? "") || (source.name ? String(source.name).replace(/\.[a-z0-9]{2,4}$/i, "").replace(/[-_]+/g, " ").trim() : "");
  const shortTitle = String(title || "").replace(/\s+/g, " ").trim().slice(0, 64).replace(/\s+\S*$/, (m, off, str) => (str.length > 62 ? "" : m));
  const intro = P.intro && shortTitle ? { kind: P.branding === "full" ? "logo-sting" : S.intro.kind, seconds: S.intro.seconds, title: shortTitle, subtitle: "" } : null;
  const outroKind = P.branding === "none" ? null : S.outro.kind;
  const outro = P.outro && outroKind ? { kind: outroKind, seconds: S.outro.seconds, text: outroKind === "cta" ? "Follow for more" : "Toasty Media", subtitle: "toasty.media" } : null;
  const introT = intro ? intro.seconds : 0;
  const segments = []; let cursor = 0, beatsAligned = 0, beatsTried = 0;
  chosen.forEach((sh, i) => {
    if (i > 0 && sh.cut === "gap" && S.sound.music && (styleId === "energy" || styleId === "cinematic") && P.music) {
      const prev = segments[i - 1], tCut = introT + cursor, nb = Math.round(tCut / beat) * beat, d = nb - tCut;
      const lastSpeech = regions ? regionsIn(regions, prev.srcStart, prev.srcEnd).pop() : null;
      const tailAvail = lastSpeech ? prev.srcEnd - lastSpeech.end - 0.04 : 0, gapAvail = sh.start - prev.srcEnd - 0.02;
      beatsTried++;
      if (Math.abs(d) <= 0.14 && d >= -tailAvail && d <= Math.max(0, gapAvail)) { prev.srcEnd = r3(prev.srcEnd + d); prev.outEnd = r3(prev.outEnd + d); cursor = prev.outEnd; beatsAligned++; }
      else if (Math.abs(d) <= 0.06) beatsAligned++;
    }
    const seg = { index: i, srcStart: r3(sh.start), srcEnd: r3(sh.end), outStart: r3(cursor), outEnd: r3(cursor + (sh.end - sh.start)), cut: i === 0 ? "start" : sh.cut, speaker: sh.speaker || "", removedBefore: r3(sh.removed || 0) };
    segments.push(seg); cursor = seg.outEnd;
  });
  const contentT = r3(cursor);
  if (beatsTried) note(0, "beat-cuts", { music: `${S.sound.music} ${bpm} bpm`, tried: beatsTried, aligned: beatsAligned }, `Placed ${beatsAligned} of ${beatsTried} jump cuts on a beat by moving each within the silence around it.`);
  const total = r3(introT + contentT + (outro ? outro.seconds : 0));

  // ---------------- 7. words in output time, and which deserve emphasis
  const srcWords = alignWords(lines, regions, { from: Math.min(...segments.map((s) => s.srcStart), 0), to: Math.max(...segments.map((s) => s.srcEnd), 0) });
  const scored = scoreWords(srcWords, { unitSig, voiceEvents: tracks.audio || [] });
  const words = wordsToOutput(scored, segments).map((w) => ({ text: w.text, start: r3(w.start), end: r3(w.end), line: w.line, speaker: w.speaker, emphasis: r3(w.emphasis), why: w.why, seg: w.seg, srcStart: r3(w.srcStart), srcEnd: r3(w.srcEnd) }));
  const thr = { clean: 0.62, energy: 0.5, cinematic: 0.6 }[styleId] ?? 0.6;
  const spacing = { clean: 4.5, energy: 1.5, cinematic: 6 }[styleId] ?? 3;
  const marks = [];
  if (P.typography > 0) {
    const cand = words.filter((w) => w.emphasis >= thr / Math.min(1.4, P.typography)).sort((a, b) => b.emphasis - a.emphasis);
    for (const w of cand) if (!marks.some((m) => Math.abs(m.start - w.start) < spacing / Math.min(1.5, P.typography))) { w.mark = true; marks.push(w); }
    marks.sort((a, b) => a.start - b.start);
    marks.forEach((w) => note(w.start, "emphasize-word", { word: w.text, score: w.emphasis, because: w.why }, `${S.typography.keywordMark} emphasis on “${w.text.replace(/[^\w$%']/g, "")}”.`));
  }

  // ---------------- 7b. optional B-roll from the user's own library, only where a spoken word matches a tag
  let broll = [];
  if (brollLibrary?.length && userParams.broll !== false) {
    const placed = placeBroll({ library: brollLibrary, words, segments, contentSeconds: contentT, maxShare: 0.25 });
    broll = placed.items;
    for (const b of broll) note(b.start, "b-roll", { word: b.word, clip: b.name }, `Cut away to ${b.name} for ${(b.end - b.start).toFixed(1)} s while the original voice continues (${b.reason}).`);
    for (const n of placed.notes) { warnings.push(n); note(0, "b-roll", {}, n); }
  } else if (userParams.broll === true) warnings.push("B-roll was requested but no B-roll footage is in your library.");

  // ---------------- 8. camera: framing, jump-cut scales, drift
  const zoomK = P.zoom;
  const narrow = outW / outH < 1.2;
  let jump = 0;
  const camera = [];
  segments.forEach((seg, i) => {
    const fr = frameForRange(picture, seg.srcStart, seg.srcEnd, { manualFocusX: userParams.focusX ?? null, needSingle: narrow });
    const cuts = ["gap", "turn", "reframe"].includes(seg.cut);
    if (i > 0 && cuts) jump++; else if (i > 0) jump = 0;
    const base = S.camera.jumpScales[jump % S.camera.jumpScales.length];
    const driftDir = S.camera.driftPerShot ? (i % 2 === 0 ? 1 : -1) : 1;
    const [d0, d1] = S.camera.drift, a = driftDir > 0 ? d0 : d1, b = driftDir > 0 ? d1 : d0;
    const cap = maxZoomForFace({ srcW, srcH, outW, outH, faceSize: fr.faceSize, limit: 1.32 });
    const sc = (v) => clamp(1 + (v - 1) * zoomK, 1, cap);
    seg.camera = { scaleFrom: r3(sc(base * a)), scaleTo: r3(sc(base * b)), fx: r3(fr.fx), fy: r3(clamp(fr.fy + (fr.faces ? 0.04 : 0), 0.3, 0.7)), pan: S.camera.driftPerShot ? r3(0.035 * driftDir * zoomK) : 0, ease: S.camera.ease, cap: r3(cap) };
    camera.push({ seg: i, reason: fr.reason, faces: fr.faces, confidence: r3(fr.confidence), capped: base * b > cap });
    if (picture && (i === 0 || fr.fx !== camera[i - 1]?.fx)) note(seg.outStart, "frame-speaker", { faces: fr.faces, confidence: +fr.confidence.toFixed(2), x: +fr.fx.toFixed(2) }, `Shot ${i + 1}: framed on ${fr.reason}.`);
  });

  // ---------------- 9. effect budget: punch-ins, key phrases, statistics, diagram, lower third, transitions
  const budget = new Budget(S.limits, (P.graphics + P.typography + P.zoom) / 3 || 0.2);
  const punches = [], typography = [], graphics = [];
  const segAt = (t) => segments.find((s) => t >= s.outStart && t < s.outEnd) || null;
  const strongSort = marks.slice().sort((a, b) => b.emphasis - a.emphasis);
  let punchSeconds = 0, flip = 1;
  if (zoomK > 0) {
    for (const w of strongSort) {
      const seg = segAt(w.start); if (!seg) continue;
      const dur = Math.min(S.camera.punch.dur, seg.outEnd - w.start + 0.1);
      const at = Math.max(seg.outStart + 0.35, w.start - 0.12);
      if (at + dur > seg.outEnd - 0.05 || dur < 0.5) continue;
      if (punchSeconds + dur > contentT * S.limits.zoomCoverage * Math.min(1.5, zoomK)) { note(w.start, "skip-zoom", { word: w.text }, "Skipped: too much of the video would already be zoomed."); continue; }
      const gapOk = !punches.some((p) => Math.abs(p.at - at) < S.limits.punchMinGap / Math.max(0.3, Math.min(2.25, zoomK * zoomK)));
      if (!gapOk) continue;
      const why = budget.add("punch", at, at + dur, "camera");
      if (why) { note(w.start, "skip-zoom", { word: w.text }, `Skipped: ${why}.`); continue; }
      const k = 1 + (S.camera.punch.scale - 1) * zoomK * (flip > 0 ? 1 : 0.8);
      const capHere = Math.min(seg.camera.cap, 1.32) / Math.max(seg.camera.scaleTo, 1);
      punches.push({ at: r3(at), dur: r3(dur), scale: r3(clamp(k, 1.02, Math.max(1.02, capHere))), seg: seg.index, reason: "emphasized word", word: w.text }); punchSeconds += dur; flip = -flip;
      note(at, "punch-in", { word: w.text, emphasis: w.emphasis, because: w.why }, `${Math.round((k - 1) * 100)}% smooth push-in for ${dur.toFixed(1)} s.`);
    }
    if (picture) {
      for (const e of reactions.filter((r) => r.type === "smile" || r.type === "brow-raise")) {
        const seg = segments.find((s) => e.t >= s.srcStart && e.t < s.srcEnd); if (!seg) continue;
        const at = seg.outStart + (e.t - seg.srcStart) - 0.2, dur = Math.min(S.camera.punch.dur * 1.4, seg.outEnd - at - 0.05); if (dur < 0.8 || at < seg.outStart + 0.3) continue;
        if (punches.some((p) => Math.abs(p.at - at) < S.limits.punchMinGap)) continue;
        if (punchSeconds + dur > contentT * S.limits.zoomCoverage) continue;
        if (budget.add("punch", at, at + dur, "camera")) continue;
        punches.push({ at: r3(at), dur: r3(dur), scale: r3(clamp(1 + (S.camera.punch.scale - 1) * 0.6 * zoomK, 1.02, 1.12)), seg: seg.index, reason: "visible reaction", word: "" }); punchSeconds += dur;
        note(at, "reaction-zoom", { event: `${e.type} at ${fmtT(e.t)}`, strength: e.strength }, "Gentle push-in on a visible reaction (an observation of the face, not a claim about feeling).");
      }
    }
  }
  for (const p of punches) { const s = segments[p.seg]; (s.punches ||= []).push(p); }
  punches.sort((a, b) => a.at - b.at);

  // key phrases: the best sentence-level phrase per stretch, timed to the speaker's own words
  const byLine = new Map(); words.forEach((w) => { if (!byLine.has(w.line)) byLine.set(w.line, []); byLine.get(w.line).push(w); });
  const lineCands = [...byLine.entries()].map(([li, ws]) => { const kp = keyPhrase(ws, styleId === "energy" ? 4 : styleId === "cinematic" ? 8 : 5); const sig = unitSig(ws[0].srcStart); return kp && ws.length >= 5 ? { li, kp, sig, score: sig + Math.max(...ws.map((w) => w.emphasis)) } : null; }).filter(Boolean).sort((a, b) => b.score - a.score);
  const kpDur = { clean: 2.4, energy: 1.8, cinematic: 3.4 }[styleId];
  if (P.typography > 0 && captionsOn(P)) {
    for (const c of lineCands) {
      if (c.score < 0.75) continue;
      const seg = segAt(c.kp.start); if (!seg) continue;
      const start = c.kp.start, end = Math.min(seg.outEnd - 0.05, Math.max(c.kp.end + 0.5, start + kpDur));
      if (end - start < 1.1) continue;
      const why = budget.add("key-phrase", start, end, "text");
      if (why) { note(start, "skip-key-phrase", { text: c.kp.text }, `Skipped: ${why}.`); continue; }
      typography.push({ id: `kp-${typography.length + 1}`, kind: "key-phrase", variant: S.typography.keyPhrase, text: c.kp.text, words: c.kp.words.map((w) => ({ text: w.text, start: w.start, end: w.end })), start: r3(start), end: r3(end), position: "upper", reason: "most significant sentence in this stretch" });
      note(start, "key-phrase", { text: c.kp.text, significance: +c.sig.toFixed(2) }, `${S.typography.keyPhrase} typography, each word appearing as it is spoken.`);
    }
  }

  // statistics callouts: numbers taken verbatim from the transcript
  if (S.graphics.stats && P.graphics > 0) {
    for (const st of findStats(lines)) {
      const w = words.find((x) => x.line === st.line && /\d|percent|million|billion|thousand|one|two|three|four|five|six|seven|eight|nine|ten/i.test(x.text)); if (!w) continue;
      const seg = segAt(w.start); if (!seg) continue;
      const start = Math.max(seg.outStart + 0.1, w.start - 0.1), end = Math.min(seg.outEnd - 0.05, start + 2.8); if (end - start < 1.2) continue;
      const why = budget.add("stat", start, end, "text");
      if (why) { note(start, "skip-stat", { value: st.value }, `Skipped: ${why}.`); continue; }
      graphics.push({ id: `stat-${graphics.length + 1}`, kind: "stat-callout", value: st.value.replace(/\s+/g, " "), label: st.label, start: r3(start), end: r3(end), arrow: Boolean(S.graphics.arrows), reason: "number spoken in the transcript" });
      note(start, "stat-callout", { quote: st.text }, `Callout card with the figure “${st.value}”${S.graphics.arrows ? " and an arrow" : ""}.`);
    }
  }
  // simple diagram: spoken steps ("first ... second ... third ...")
  if (S.graphics.diagram && P.graphics > 0) {
    const steps = findSteps(lines);
    const nodes = steps.map((s) => ({ s, w: words.find((x) => x.line === s.line) })).filter((x) => x.w);
    if (nodes.length >= 3) {
      const start = nodes[0].w.start - 0.1, end = Math.min(contentT - 0.05, nodes[nodes.length - 1].w.start + 3.0);
      const why = budget.add("diagram", start, end, "text");
      if (why) note(start, "skip-diagram", {}, `Skipped: ${why}.`);
      else { graphics.push({ id: "diagram-1", kind: "diagram", steps: nodes.map((x) => ({ label: x.s.label, at: r3(x.w.start) })), start: r3(start), end: r3(end), reason: "the speaker listed steps in order" }); note(start, "diagram", { steps: nodes.map((x) => x.s.label) }, "Step diagram: each node appears as its step is spoken."); }
    }
  }
  // lower third: only a name that is really in the recording's speaker labels, or one the user gave
  const lt = P.lowerThird || (() => { const sp = segments.map((s) => s.speaker).find((n) => n && !GENERIC_SPEAKER.test(n)); return sp ? { name: sp, role: "" } : null; })();
  if (lt?.name && S.graphics.lowerThird && P.graphics > 0 && contentT > 5) {
    const start = 0.6, end = Math.min(contentT - 0.1, 5.2);
    if (!budget.add("lower-third", start, end, "light")) { graphics.push({ id: "lt-1", kind: "lower-third", name: lt.name, role: lt.role || "", start, end, reason: P.lowerThird ? "you asked for it" : "name taken from the recording's own speaker label" }); note(start, "lower-third", { name: lt.name }, "Lower third at the start of the first shot."); }
  }
  // background accents and branding
  if (S.graphics.accents !== "none" && P.graphics > 0) graphics.push({ id: "accent-1", kind: "accent", variant: S.graphics.accents, start: 0, end: contentT, reason: "style frame" });
  if (P.branding === "full") graphics.push({ id: "bug-1", kind: "bug", start: 0, end: contentT, reason: "you asked for the Toasty branding" });
  graphics.sort((a, b) => a.start - b.start);

  // ---------------- 10. transitions at the cuts
  const cuts = [];
  let nonHard = 0, lastNonHard = -9;
  const cycle = S.transitions.cycle || [S.transitions.topic];
  segments.forEach((seg, i) => {
    if (i === 0) return;
    let kind = "hard", why = seg.cut === "gap" ? "jump cut inside continuous talk" : seg.cut === "turn" ? "change of speaker" : seg.cut === "reframe" ? "re-frame within one thought" : "";
    const longPause = seg.cut === "gap" && seg.removedBefore >= (styleId === "energy" ? 0.9 : 1.4);
    const wantsTransition = seg.cut === "topic" || longPause || (styleId === "energy" && seg.cut === "turn" && i % 2 === 1);
    const share = S.transitions.share * P.transitions;
    if (wantsTransition && P.transitions > 0 && nonHard < Math.max(1, Math.ceil(share * segments.length)) && i - lastNonHard > 1) {
      const dur = Math.min(S.transitions.seconds, (seg.outEnd - seg.outStart) * 0.45, (segments[i - 1].outEnd - segments[i - 1].outStart) * 0.45);
      if (dur >= 0.2 && !budget.add("transition", seg.outStart - 0.1, seg.outStart + dur, "transition")) {
        kind = cycle[nonHard % cycle.length]; why = seg.cut === "topic" ? "the story jumps to a different part of the recording" : longPause ? `a ${seg.removedBefore.toFixed(1)} s pause was removed here` : "speaker change"; nonHard++; lastNonHard = i;
        note(seg.outStart, "transition", { cut: seg.cut, source: `${fmtT(segments[i - 1].srcEnd)} to ${fmtT(seg.srcStart)}` }, `${kind} (${dur.toFixed(2)} s); other cuts stay hard.`);
        cuts.push({ at: seg.outStart, seg: i, kind, dur: r3(dur), why }); return;
      }
    }
    cuts.push({ at: seg.outStart, seg: i, kind, dur: 0, why });
  });
  const hardN = cuts.filter((c) => c.kind === "hard").length;
  if (cuts.length) note(0, "transition-density", { cuts: cuts.length, transitions: nonHard }, `${hardN} of ${cuts.length} cuts are plain hard cuts; transitions are not added between every segment.`);

  // ---------------- 11. captions
  const capCfg = S.captions;
  const captions = captionsOn(P) && words.length ? { style: capCfg.style, position: capCfg.position, size: r3(capCfg.size * P.captionScale), uppercase: capCfg.uppercase, font: capCfg.font, chunks: chunk(words, capCfg.maxWords, segments) } : null;

  // ---------------- 12. sound
  const sfx = [];
  const base = S.sound.sfxGainDb;
  const put = (t, kind, rel, reason) => { if (!P.sfx || S.sound.sfx === "none") return; if (t < 0 || t > total - 0.1 || sfx.some((x) => Math.abs(x.t - t) < 0.35)) return; sfx.push({ t: r3(t), kind, gainDb: r3(base + rel), reason }); };
  if (S.sound.sfx !== "none" && P.sfx) {
    for (const c of cuts.filter((x) => x.kind !== "hard")) put(introT + c.at - Math.min(0.25, c.dur * 0.8), c.kind === "dissolve" ? "swell" : "whoosh", c.kind === "flash" ? 2 : 0, `${c.kind} transition`);
    if (S.sound.sfx === "full" || S.sound.sfx === "sparse") {
      let lastImpact = -9;
      for (const p of punches.filter((x) => x.reason === "emphasized word")) { if (p.at - lastImpact < (S.sound.sfx === "full" ? 3.5 : 9)) continue; const w = words.find((x) => x.text === p.word && Math.abs(x.start - p.at) < 0.6); if ((w?.emphasis ?? 0) >= (S.sound.sfx === "full" ? 0.62 : 0.8)) { put(introT + p.at + 0.1, S.sound.sfx === "full" ? "impact" : "boom", 0, `accent on “${p.word}”`); lastImpact = p.at; } }
      if (S.sound.sfx === "full") { for (const ty of typography) put(introT + ty.start - 0.05, "pop", -4, "key phrase appears"); for (const g of graphics.filter((x) => x.kind === "stat-callout")) put(introT + g.start, "pop", -2, "callout appears"); }
    }
    if (intro) put(0.05, styleId === "cinematic" ? "boom" : styleId === "energy" ? "whoosh" : "tick", styleId === "cinematic" ? 2 : 0, "title appears");
    if (outro && S.sound.sfx !== "minimal") put(introT + contentT + 0.05, styleId === "energy" ? "impact" : "swell", 0, "end card");
    // never on top of a spoken word unless it is a whoosh or a tick: nudge into the nearest gap, else lower it
    for (const e of sfx) {
      if (["whoosh", "tick", "swell"].includes(e.kind)) continue;
      const wd = words.find((w) => introT + w.start <= e.t && introT + w.end >= e.t);
      if (wd) { const out = introT + wd.end + 0.04; if (out - e.t < 0.3) { e.t = r3(out); e.reason += " (moved into the pause after the word)"; } else { e.gainDb = r3(e.gainDb - 6); e.reason += " (lowered under speech)"; } }
    }
    sfx.sort((a, b) => a.t - b.t);
  }
  const music = P.music && S.sound.music ? { style: S.sound.music, gainDb: P.musicGainDb ?? S.sound.musicGainDb, duckDb: S.sound.duckDb, bpm } : null;
  if (music) note(0, "music", { style: music.style, bpm }, `${music.style} bed at ${music.gainDb} dB, ducked ${Math.abs(music.duckDb)} dB under the voice, faded in and out.`);
  if (sfx.length) note(0, "sound-accents", { count: sfx.length, kinds: [...new Set(sfx.map((s) => s.kind))] }, "Accents are synthesized in the browser (no sample library), kept under the voice and moved off spoken words.");

  const effects = punches.length + typography.length + graphics.filter((g) => g.kind !== "accent" && g.kind !== "bug").length + nonHard;
  const stats = {
    mode, sourceSeconds: r3(duration), outputSeconds: total, contentSeconds: contentT, segments: segments.length, hardCuts: hardN, transitions: nonHard, deadAirRemoved: r3(removedSeconds), pausesCut: removedGaps.length,
    punchIns: punches.length, zoomAmount: r3(punches.reduce((a, q) => a + (q.scale - 1) * q.dur, 0)), broll: broll.length, zoomedShare: contentT ? r3(punchSeconds / contentT) : 0, keyPhrases: typography.length, graphics: graphics.filter((g) => g.kind !== "accent" && g.kind !== "bug").length, emphasizedWords: marks.length, soundAccents: sfx.length,
    effectsPer10s: contentT ? r3((effects / contentT) * 10) : 0, effectLimitPer10s: S.limits.per10s * 2, beatCuts: { tried: beatsTried, aligned: beatsAligned }, skipped: budget.rejected.length
  };
  return {
    schema: PLAN_SCHEMA, style: styleId, styleName: S.name, aspect, size: [outW, outH], seed, source: { name: source.name || "", duration: r3(duration), width: srcW, height: srcH },
    params: P, timeline: { intro: introT, content: contentT, outro: outro ? outro.seconds : 0, total },
    segments, cuts, punches, words, captions, typography, graphics, broll, intro, outro,
    audio: { enhance: true, targetLufs: -16, music, sfx }, look: { grade: S.grade, theme: S.theme, captions: capCfg.style },
    decisions: decisions.sort((a, b) => a.t - b.t), skipped: budget.rejected, camera, stats, warnings, notes: analysis.notes || []
  };
}

function captionsOn(P) { return P.captions !== false; }

// Caption chunks: whole phrases that never cross a cut, break on sentence ends and pauses, and stay on screen until the next one.
function chunk(words, maxWords, segments) {
  const out = []; let cur = [];
  const flush = () => { if (cur.length) { out.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur.map((w) => ({ text: w.text, start: w.start, end: w.end, mark: Boolean(w.mark) })) }); cur = []; } };
  for (const w of words) {
    const prev = cur[cur.length - 1];
    if (prev && (w.seg !== prev.seg || w.start - prev.end > 0.6 || cur.length >= maxWords || /[.!?]$/.test(prev.text) || (cur.length >= Math.ceil(maxWords * 0.6) && /[,;:]$/.test(prev.text)))) flush();
    cur.push(w);
  }
  flush();
  out.forEach((c, i) => { const next = out[i + 1], seg = segments.find((s) => c.start >= s.outStart - 0.01 && c.start < s.outEnd); const limit = Math.min(next ? next.start : Infinity, seg ? seg.outEnd : Infinity); c.end = r3(Math.min(c.end + 0.3, limit)); c.start = r3(c.start); });
  return out;
}

// Plain-language summary of a plan for the UI.
export function describePlan(plan) {
  const s = plan.stats;
  return [
    `${plan.styleName}, ${plan.aspect}: ${s.outputSeconds.toFixed(0)} s from ${s.sourceSeconds.toFixed(0)} s of footage (${s.mode}).`,
    `${s.segments} shot${s.segments === 1 ? "" : "s"}, ${s.pausesCut} pause${s.pausesCut === 1 ? "" : "s"} tightened (${s.deadAirRemoved.toFixed(1)} s of dead air removed), ${s.hardCuts} hard cut${s.hardCuts === 1 ? "" : "s"}, ${s.transitions} transition${s.transitions === 1 ? "" : "s"}.`,
    `${s.punchIns} zoom${s.punchIns === 1 ? "" : "s"}, ${s.keyPhrases} key phrase${s.keyPhrases === 1 ? "" : "s"}, ${s.graphics} graphic${s.graphics === 1 ? "" : "s"}, ${s.soundAccents} sound accent${s.soundAccents === 1 ? "" : "s"}${plan.audio.music ? `, ${plan.audio.music.style} music` : ", no music"}.`
  ];
}
