// Multimodal moment intelligence: turn the behavioral timeline into ranked, bounded, explained clip suggestions.
//
// Candidates are whole thoughts (sentence units, snapped to turns, pauses and topic edges), never keyword hits. Each is scored on
//   semantic significance, vocal emphasis, visible reactions, gestures, interaction dynamics, narrative completeness and clip
//   suitability. Modalities that are not available are left out and the rest re-weighted, so audio-only, single-person and
//   faceless recordings all work. Vocal, visual and gesture evidence only counts in proportion to the context around it
//   (meaning or interaction), so loudness or fidgeting alone cannot make a clip.
// Every suggestion lists the detected events behind it and an explanation built only from those events.
import { wordCount } from "./text.js";

export const MOMENT_CATEGORIES = Object.freeze({
  disagreement: "Disagreement",
  "strong-opinion": "Strong opinion",
  insight: "Insight",
  explanation: "Explanation",
  story: "Personal story",
  humor: "Shared laughter",
  surprise: "Surprise",
  quotable: "Quotable line",
  "question-answer": "Question and answer",
  exchange: "Rapid exchange",
  reaction: "Visible reaction",
  highlight: "Best available passage"
});

const WEIGHTS = { semantic: 0.28, vocal: 0.14, visual: 0.09, gesture: 0.07, interaction: 0.18, narrative: 0.14, suitability: 0.10 };
const VOCAL_W = { "intensity-rise": 0.9, "pitch-variation": 0.35, "pitch-jump": 0.6, "speech-faster": 0.3, "speech-slower": 0.25, "energy-up": 0.5, "energy-down": 0.25, laughter: 1, "loud-reaction": 0.7, overlap: 0.8, pause: 0.45 };
const FACE_W = { smile: 0.8, "brow-raise": 0.7, "mouth-open": 0.7, "head-turn": 0.5, "head-nod": 0.5, "lean-in": 0.6, "lean-back": 0.5 };
const GESTURE_W = { gesture: 0.9, "sudden-movement": 0.5, "posture-shift": 0.5, "body-lean-in": 0.5, "body-lean-back": 0.4, "head-movement": 0.4, stillness: 0.3 };
const INTERACTION_W = { "challenge-response": 0.9, interruption: 0.7, "rapid-exchange": 0.7, "shared-laughter": 0.9, "laughter-reaction": 0.5, "visible-reaction": 0.8, "pattern-change": 0.4, "surprising-exchange": 0.9, "meaningful-pause": 0.6, buildup: 0.6, resolution: 0.5 };
const LANG_W = { opinion: 1, insight: 1, explanation: 0.8, story: 1, surprise: 0.8, humor: 0.8, quotable: 0.9, "question-answer": 0.7, advice: 0.7, statement: 0.5 };

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const r1 = (v) => Math.round(v * 10) / 10;
const noisyOr = (xs) => 1 - xs.reduce((p, x) => p * (1 - clamp(x)), 1);
// Repeats of the same kind of event inside one clip count once (the strongest), so a run of weak signals cannot add up to a strong one.
const perType = (events, weights, scale) => { const best = new Map(); for (const e of events) { const v = scale * (weights[e.type] ?? 0.3) * (e.strength ?? 0.4); if (v > (best.get(e.type) ?? 0)) best.set(e.type, v); } return [...best.values()]; };
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const CONNECTIVE = /^(and|so|but|because|then|um|uh|well|yeah|okay|ok|right|like|or|also|which|that|it|this|they|he|she)\b/i;

// ---- evidence wording: one phrase per event kind, built from the event's own measured data ----
function describe(e) {
  const d = e.data || {};
  switch (e.type) {
    case "intensity-rise": return { kind: "louder", phrase: "increased vocal intensity", label: `Speaking ${d.aboveUsualDb} dB above this recording's usual level (${d.deltaDb} dB up from the 8 s before)` };
    case "pitch-variation": return { kind: "pitch-variation", phrase: "wider pitch movement than usual", label: `Pitch moved ${d.sdSemitones} semitones against a usual ${d.usualSemitones}` };
    case "pitch-jump": return { kind: "pitch-jump", phrase: "a jump in pitch", label: `Pitch jumped ${d.semitones} semitones` };
    case "speech-faster": return { kind: "faster", phrase: "faster speech", label: `Speaking about ${Math.round((d.rate / d.usual) * 10) / 10}x this recording's usual pace` };
    case "speech-slower": return { kind: "slower", phrase: "slower, more deliberate speech", label: `Speaking about ${Math.round((d.rate / d.usual) * 10) / 10}x this recording's usual pace` };
    case "energy-up": return { kind: "energy-up", phrase: "a rise in conversational energy", label: "Level, pace and pitch movement rose against the previous 10 s" };
    case "energy-down": return { kind: "energy-down", phrase: "a drop in energy", label: "Level and pace fell against the previous 10 s" };
    case "laughter": return { kind: "laughter", phrase: "laughter", label: `Laughter for ${d.duration} s` };
    case "loud-reaction": return { kind: "loud-reaction", phrase: "a sudden loud reaction", label: "A sudden burst of sound" };
    case "overlap": return { kind: "overlap", phrase: "people talking over each other", label: "Overlapping voices" };
    case "pause": return { kind: "pause", phrase: `a ${d.duration} s pause`, label: `${d.duration} s of silence between speech` };
    case "smile": return { kind: "smile", phrase: "a visible smile", label: "A smile (mouth corners raised)" };
    case "brow-raise": return { kind: "brow-raise", phrase: "raised eyebrows", label: "Eyebrows raised" };
    case "mouth-open": return { kind: "mouth-open", phrase: "an open-mouthed reaction", label: "Mouth opened wide with raised brows" };
    case "head-turn": return { kind: "head-turn", phrase: "a head turn", label: `Head turned about ${d.degrees}°` };
    case "head-nod": return { kind: "head-nod", phrase: "head nodding", label: `Head nod (${d.nods} movements)` };
    case "head-movement": return { kind: "head-movement", phrase: "head movement", label: "The head moved across the frame" };
    case "lean-in": case "body-lean-in": return { kind: "lean-in", phrase: "leaning in", label: "Leaned toward the camera" };
    case "lean-back": case "body-lean-back": return { kind: "lean-back", phrase: "leaning back", label: "Leaned away from the camera" };
    case "posture-shift": return { kind: "posture-shift", phrase: "a change in posture", label: "Shoulders shifted position" };
    case "gesture": return { kind: "gesture", phrase: "animated hand gestures", label: "Hands moving" };
    case "sudden-movement": return { kind: "sudden-movement", phrase: "sudden movement", label: "A burst of movement in the picture" };
    case "stillness": return { kind: "stillness", phrase: `${d.seconds} s of stillness`, label: `The picture held still for ${d.seconds} s` };
    case "challenge-response": return { kind: "challenge", phrase: d.replied ? "a challenge from another speaker and a reply" : "a challenge from another speaker", label: `${d.claimBy}'s claim is challenged by ${d.challengeBy}${d.replied ? " and answered" : ""}` };
    case "interruption": return { kind: "interruption", phrase: "an interruption", label: `${d.to} cut in on ${d.from}` };
    case "rapid-exchange": return { kind: "rapid-exchange", phrase: `a rapid exchange of ${d.turns} turns`, label: `${d.turns} short turns back and forth` };
    case "shared-laughter": return { kind: "shared-laughter", phrase: "shared laughter", label: `Laughter with ${d.speakers.length >= 2 ? "more than one person speaking nearby" : "more than one person smiling"}` };
    case "laughter-reaction": return { kind: "laughter", phrase: "laughter", label: "Laughter right after a line" };
    case "visible-reaction": return { kind: "visible-reaction", phrase: `a visible reaction (${d.kinds.map((k) => k.replace(/-/g, " ")).join(", ")})`, label: `Visible reaction during or right after the statement: ${d.kinds.join(", ")}` };
    case "pattern-change": return { kind: "pattern-change", phrase: "a change in speaking pattern", label: `The speaking pattern changed at the turn (${d.kind.replace(/-/g, " ")})` };
    case "surprising-exchange": return { kind: "surprising-exchange", phrase: `a held pause then ${d.followedBy.join(" and ").replace(/-/g, " ")}`, label: `A ${d.pause} s pause followed by ${d.followedBy.join(", ")}` };
    case "meaningful-pause": return { kind: "meaningful-pause", phrase: `a ${d.duration} s pause after the point`, label: `A ${d.duration} s pause after a strong line` };
    case "buildup": return { kind: "buildup", phrase: "a build-up toward the point", label: `Significance climbs over ${d.units} sentences toward the key line` };
    case "resolution": return { kind: "resolution", phrase: "a resolution", label: "The story closes with a resolution" };
    case "opinion": return { kind: "opinion", phrase: "a strong claim", label: `Opinion: ${d.cues.join(", ")}` };
    case "insight": return { kind: "insight", phrase: "an insight", label: `Insight: ${d.cues.join(", ")}` };
    case "explanation": return { kind: "explanation", phrase: "a clear explanation", label: `Explains a reason: ${d.cues.join(", ")}` };
    case "story": return { kind: "story", phrase: "a personal story", label: `Story: ${d.cues.join("; ")}` };
    case "surprise": return { kind: "surprise-wording", phrase: "surprised wording", label: "Wording and punctuation read as surprise" };
    case "humor": return { kind: "humor-wording", phrase: "wording that reads as humour", label: "Reads as a joke or humour" };
    case "quotable": return { kind: "quotable", phrase: "a short, quotable line", label: `Quotable: ${d.cues.join(", ")}` };
    case "question-answer": return { kind: "question-answer", phrase: "a question and its answer", label: d.cues[0] };
    case "advice": return { kind: "advice", phrase: "clear advice", label: "Reads as advice" };
    case "statement": return { kind: "statement", phrase: "a distinctive statement", label: `Distinctive for this recording: ${d.cues.join(", ") || "carries more than most lines"}` };
    default: return null;
  }
}
const MODALITY = { language: "language", audio: "voice", face: "face", gesture: "body", motion: "body", interaction: "interaction" };

function categoryOf(events) {
  const has = (type) => events.filter((e) => e.type === type);
  const top = (list) => Math.max(0, ...list.map((e) => e.strength ?? 0));
  const reaction = events.some((e) => e.track === "face" || e.type === "visible-reaction");
  const cands = [];
  const c = has("challenge-response"); if (c.length) cands.push(["disagreement", 1.0 * top(c) + (reaction || has("shared-laughter").length ? 0.1 : 0)]);
  const sh = [...has("shared-laughter"), ...has("humor")]; if (sh.length) cands.push(["humor", 0.95 * top(sh)]);
  const su = [...has("surprising-exchange"), ...has("surprise")]; if (su.length) cands.push(["surprise", 0.9 * top(su)]);
  const st = has("story"); if (st.length) cands.push(["story", 0.95 * top(st)]);
  const op = has("opinion"); if (op.length) cands.push(["strong-opinion", 0.9 * top(op)]);
  const ins = has("insight"); if (ins.length) cands.push(["insight", 0.9 * top(ins)]);
  const ex = has("explanation"); if (ex.length) cands.push(["explanation", 0.8 * top(ex)]);
  const q = has("quotable"); if (q.length) cands.push(["quotable", 0.8 * top(q)]);
  const qa = has("question-answer"); if (qa.length) cands.push(["question-answer", 0.75 * top(qa)]);
  const rx = has("rapid-exchange"); if (rx.length) cands.push(["exchange", 0.75 * top(rx)]);
  const vr = has("visible-reaction"); if (vr.length) cands.push(["reaction", 0.8 * top(vr)]);
  cands.sort((a, b) => b[1] - a[1]);
  return cands[0]?.[0] || "highlight";
}

function recommend(category, ctx) {
  const { multiSpeaker, faces, reactionEvents, duration, fallback, hasText, avgFaceX } = ctx;
  let aspect = "16:9", templateId = "toasty-classic", captions = hasText ? "bar" : "none", why = "";
  switch (category) {
    case "disagreement": templateId = "hot-take"; captions = "kinetic"; aspect = reactionEvents && faces ? "9:16" : "16:9"; why = reactionEvents && faces ? "Vertical, framed on the visible reaction, with animated captions" : "Both sides stay in frame; animated captions carry the exchange"; break;
    case "strong-opinion": templateId = "hot-take"; captions = "kinetic"; aspect = "9:16"; why = "A single strong claim suits vertical framing with animated captions"; break;
    case "humor": templateId = "laugh-track"; captions = "kinetic"; aspect = faces ? "9:16" : "1:1"; why = "Shared laughter plays best tight and bright"; break;
    case "surprise": templateId = "energy-burst"; captions = "kinetic"; aspect = faces ? "9:16" : "1:1"; why = "A jolt in the middle of a clip suits fast cuts and punch-ins"; break;
    case "story": templateId = "documentary"; captions = "karaoke"; aspect = multiSpeaker ? "16:9" : "9:16"; why = "A story needs room to build; word-by-word captions follow the telling"; break;
    case "insight": case "explanation": templateId = "clean-insight"; captions = "bar"; aspect = "1:1"; why = "A calm, readable layout for an explanation"; break;
    case "quotable": templateId = "podcast-quote"; captions = "karaoke"; aspect = "1:1"; why = "A short line that stands alone works as a pull-quote"; break;
    case "question-answer": templateId = "news-flash"; captions = "bar"; aspect = "16:9"; why = "A question and its answer read clearly with a lower third"; break;
    case "exchange": case "reaction": templateId = "vertical-pop"; captions = "kinetic"; aspect = faces ? "9:16" : "1:1"; why = "Quick turns and reactions suit a fast vertical cut"; break;
    default: templateId = "minimal-cut"; captions = hasText ? "bar" : "none"; why = fallback ? "Nothing in this recording stood out strongly, so this stays plain: choose a style yourself" : "A plain, faithful cut";
  }
  if (!hasText && captions !== "none") captions = "none";
  const rec = { aspect, templateId, captions, reason: why };
  if (aspect !== "16:9" && avgFaceX != null) { rec.focusX = Math.round(clamp(avgFaceX) * 20) / 20; rec.reason += ` (crop centred on where the reaction was seen)`; }
  return rec;
}

// ---- main ----
export function proposeMoments({ timeline, units, vocal = null, duration = null, max = 12, minLength = 12, maxLength = 60, minResults = 4 } = {}) {
  const dur = duration || timeline.duration;
  const caps = { semantic: timeline.has("transcript") && units.length > 0, vocal: timeline.has("audio"), visual: timeline.has("face"), gesture: timeline.has("hands") || timeline.has("pose") || timeline.has("motion"), interaction: (timeline.has("transcript") && units.length > 0) || timeline.has("audio") };
  if (!caps.semantic && !caps.vocal && !caps.visual && !caps.gesture) return { clips: [], fallback: false, best: 0, candidates: 0, caps };
  const tracks = timeline.tracks;
  const lang = tracks.language, inter = tracks.interaction, audio = tracks.audio, face = tracks.face, body = [...tracks.gesture, ...tracks.motion];

  // Candidate windows.
  const windows = [];
  if (units.length >= 2) {
    const N = units.length;
    const starts = units.map((u, i) => {
      if (i === 0) return true; const p = units[i - 1];
      return (u.speaker && p.speaker && u.speaker !== p.speaker) || u.t - p.end >= 0.8 || u.topic !== p.topic || (!CONNECTIVE.test(u.text) && /[.!?…]["')]?$/.test(p.text));
    });
    const seedScore = units.map((u) => {
      const boost = noisyOr([...audio, ...face, ...body, ...inter].filter((e) => e.end >= u.t - 0.5 && e.t <= u.end + 2).map((e) => (e.strength ?? 0.4) * 0.5));
      return 0.65 * u.sig + 0.35 * boost * (0.4 + 0.6 * clamp(u.sig / 0.3));
    });
    const seeds = new Set([...seedScore.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]).slice(0, Math.min(N, 40 + Math.ceil(N / 8))).map((x) => x[1])]);
    for (const e of [...lang, ...inter]) if (e.data?.unit != null) seeds.add(e.data.unit); else if (e.unit != null) seeds.add(e.unit);
    for (let i = 0; i < N; i += 4) seeds.add(i);
    const seen = new Set();
    for (const s of seeds) {
      const su = units[s];
      const sIdx = []; for (let i = s; i >= 0 && su.t - units[i].t <= 32; i--) if (starts[i]) sIdx.push(i); if (!sIdx.length) sIdx.push(s);
      for (const i of sIdx.slice(0, 6)) {
        let added = 0, mg = 0;
        for (let j = i; j < N; j++) {
          if (j > i) mg = Math.max(mg, units[j].t - units[j - 1].end);
          if (mg > 10 || units[j].end - units[i].t > maxLength) break;       // a clip is one continuous moment: no long dead air inside
          if (j < s) continue;
          const len = units[j].end - units[i].t;
          if (len < minLength || (units[j].end < su.end + 1.5 && j < N - 1 && len < 25)) continue;
          const key = `${i}:${j}`; if (seen.has(key)) continue; seen.add(key);
          windows.push({ i, j, a: units[i].t, b: units[j].end }); if (++added >= 8) break;
        }
      }
    }
    if (!windows.length) windows.push({ i: 0, j: N - 1, a: units[0].t, b: units[N - 1].end });
  } else {
    // No usable transcript: windows are built around vocal and visual events themselves.
    const evs = [...audio, ...inter, ...face, ...body].filter((e) => !["pause", "stillness"].includes(e.type));
    for (const e of evs) { const a = Math.max(0, e.t - 8), b = Math.min(dur, Math.max(e.end + 6, a + minLength)); if (b - a >= minLength * 0.7) windows.push({ i: -1, j: -1, a, b }); }
    for (let a = 0; a + minLength <= dur; a += 20) windows.push({ i: -1, j: -1, a, b: Math.min(dur, a + 30) });
  }

  const inWin = (list, a, b) => list.filter((e) => e.end >= a && e.t <= b);
  const scored = windows.map((w) => {
    const U = w.i >= 0 ? units.slice(w.i, w.j + 1) : [];
    const A = inWin(audio, w.a, w.b), F = inWin(face, w.a, w.b), G = inWin(body, w.a, w.b), I = inWin(inter, w.a, w.b), L = inWin(lang, w.a, w.b);
    const len = w.b - w.a;
    // Semantic.
    let semantic = 0, story = 0;
    if (U.length) {
      const sigs = U.map((u) => u.sig).sort((a, b) => b - a), pcts = U.map((u) => u.pct);
      const semAbs = clamp((0.6 * sigs[0] + 0.4 * (sigs.slice(0, 3).reduce((s, v) => s + v, 0) / Math.min(3, sigs.length))) / 0.55);
      const maxLang = Math.max(0, ...L.filter((e) => e.t >= w.a - 0.1 && e.end <= w.b + 0.1).map((e) => e.strength * (LANG_W[e.type] ?? 0.5)));
      semantic = clamp(0.7 * (0.6 * semAbs + 0.4 * Math.max(...pcts) * clamp(sigs[0] / 0.3)) + 0.3 * maxLang);
      story = Math.max(0, ...L.filter((e) => e.type === "story" && e.t >= w.a - 0.1 && e.end <= w.b + 0.1).map((e) => e.strength));
    }
    const vocalRaw = noisyOr(perType(A.filter((e) => e.type !== "pause" || e.data?.meaningful), VOCAL_W, 0.6));
    const visualRaw = noisyOr(perType(F, FACE_W, 0.6));
    const gestureRaw = noisyOr(perType(G, GESTURE_W, 0.6));
    const interaction = noisyOr(perType(I, INTERACTION_W, 0.85));
    // Context gate: movement and loudness only count in proportion to meaning or interaction around them.
    const context = Math.max(semantic, interaction, story);
    const gate = 0.35 + 0.65 * clamp(context / 0.45);
    const vocalS = vocalRaw * gate, visualS = visualRaw * gate, gestureS = gestureRaw * gate;
    // Narrative completeness.
    let narrative = 0.4, suit;
    if (U.length) {
      const first = U[0], last = U[U.length - 1], prev = units[w.i - 1], next = units[w.j + 1];
      const startClean = !prev || (first.speaker && prev.speaker && first.speaker !== prev.speaker) || first.t - prev.end >= 0.8 || first.topic !== prev.topic || (/[.!?…]["')]?$/.test(prev.text));
      const noDangling = !CONNECTIVE.test(first.text);
      const endClean = !next || /[.!?…"')\]]$/.test(last.text);
      const settled = !next || next.t - last.end >= 0.8 || (next.speaker && last.speaker && next.speaker !== last.speaker) || A.some((e) => e.type === "laughter" && e.t >= last.end - 1) || next.topic !== last.topic;
      const crosses = U.some((u) => u.topic !== first.topic) ? U.filter((u) => u.topic !== first.topic).length / U.length : 0;
      const qa = L.some((e) => e.type === "question-answer" && e.t >= w.a - 0.1 && e.end <= w.b + 0.1);
      const qOpen = first.features.question === 0 && U.some((u) => u.features.question) && !qa;
      const storyDone = L.some((e) => e.type === "story" && e.data.resolved && e.t >= w.a - 0.1 && e.end <= w.b + 0.1);
      const storyCut = L.some((e) => e.type === "story" && (e.t < w.a - 0.5 || e.end > w.b + 0.5));
      narrative = clamp(0.1 + (startClean ? 0.2 : 0) + (noDangling ? 0.15 : 0) + (endClean ? 0.15 : 0) + (settled ? 0.15 : 0) + (qa ? 0.12 : 0) + (storyDone ? 0.15 : 0) - 0.25 * crosses - (qOpen ? 0.1 : 0) - (storyCut ? 0.2 : 0) + (inter.some((e) => e.type === "buildup" && e.end <= w.b + 0.1 && e.t >= w.a - 0.1) ? 0.08 : 0));
      const speech = U.reduce((s, u) => s + (u.end - u.t), 0) / Math.max(1, len), speakers = new Set(U.map((u) => u.speaker).filter(Boolean)).size;
      const lenFit = len >= 20 && len <= 55 ? 1 : len < 20 ? clamp((len - 8) / 12) : clamp(1 - (len - 55) / 40);
      suit = clamp(0.5 * lenFit + 0.2 * clamp(speech / 0.6) + 0.15 * (first.sig >= 0.15 || first.features.question ? 1 : 0.4) + 0.15 * (speakers <= 3 ? 1 : 0.4));
    } else {
      const lenFit = len >= 15 && len <= 50 ? 1 : clamp(1 - Math.abs(len - 30) / 40);
      narrative = 0.35 + (A.some((e) => e.type === "pause") ? 0.1 : 0); suit = 0.5 * lenFit + 0.2;
    }
    // A clip is one continuous moment: dead air inside it, or a long tail after the last thing that mattered, counts against it.
    let deadAir = 0;
    for (let k = 1; k < U.length; k++) deadAir += Math.max(0, U[k].t - U[k - 1].end - 3);
    const marks = [...U.filter((u) => u.sig >= 0.2).map((u) => [u.t, u.end]), ...[...A, ...F, ...G, ...I, ...L].filter((e) => (e.strength ?? 0) >= 0.4 && e.type !== "pause" && e.type !== "stillness").map((e) => [e.t, e.end])];
    const lastMark = marks.length ? Math.max(...marks.map((m) => m[1])) : w.b, firstMark = marks.length ? Math.min(...marks.map((m) => m[0])) : w.a;
    const slack = Math.max(0, (w.b - lastMark) - 8) + Math.max(0, (firstMark - w.a) - 12);
    narrative = clamp(narrative - clamp(deadAir / 15) * 0.4);
    const comp = { semantic, vocal: vocalS, visual: visualS, gesture: gestureS, interaction, narrative, suitability: suit };
    let wsum = 0, total = 0;
    for (const [k, wt] of Object.entries(WEIGHTS)) { if (k in caps && !caps[k]) continue; wsum += wt; total += wt * comp[k]; }
    let score = wsum ? total / wsum : 0;
    const strong = Object.entries(comp).filter(([k, v]) => k !== "narrative" && k !== "suitability" && v >= 0.3).length;
    score += Math.min(0.12, Math.max(0, strong - 1) * 0.04);
    // Without any words, scores are capped: sound and movement alone never make a high-confidence clip.
    score -= clamp(slack / 40) * 0.2;
    score *= len <= 40 ? 1 : 1 - clamp((len - 40) / 20) * 0.2;   // focused clips beat sprawling ones
    if (!caps.semantic) score = Math.min(score, 0.6);
    return { ...w, U, comp, score: clamp(score), A, F, G, I, L };
  });

  // Choose: best first, no heavy overlap.
  scored.sort((a, b) => b.score - a.score);
  const chosen = [];
  const overlapRatio = (k, c) => { const x = Math.min(k.b, c.b) - Math.max(k.a, c.a); return x > 0 ? x / Math.min(k.b - k.a, c.b - c.a) : 0; };
  for (const c of scored) {
    if (chosen.length >= max) break;
    if (!chosen.some((k) => overlapRatio(k, c) > 0.2)) chosen.push(c);
  }
  // Always offer a handful of options: if strict separation left too few, take the best remaining that are mostly different.
  for (const c of scored) {
    if (chosen.length >= Math.min(max, minResults)) break;
    if (!chosen.includes(c) && !chosen.some((k) => overlapRatio(k, c) > 0.5)) chosen.push(c);
  }
  const best = chosen[0]?.score ?? 0;
  const usedUnits = new Set();
  const clips = chosen.sort((a, b) => b.score - a.score).map((c, rank) => finalize(c, { units, timeline, dur, caps, rank, usedUnits }));
  const fallback = clips.length > 0 && clips.every((c) => c.tier === "low");
  clips.forEach((c) => { c.fallback = fallback; });
  return { clips: clips.sort((a, b) => b.score - a.score), fallback, best, candidates: scored.length, caps };
}

function finalize(c, { units, timeline, dur, caps, rank, usedUnits }) {
  const { U } = c;
  let start = c.a, end = c.b;
  if (U.length) {
    const prev = units[c.i - 1], next = units[c.j + 1];
    start = Math.max(prev ? (prev.end + U[0].t) / 2 : 0, U[0].t - 0.4);
    end = U[U.length - 1].end + 0.7;
    const tail = c.A.find((e) => e.type === "laughter" && e.t >= end - 1.5 && e.t <= end + 2);
    if (tail) end = Math.max(end, tail.end + 0.5);
    if (next) end = Math.min(end, Math.max(U[U.length - 1].end + 0.3, (U[U.length - 1].end + next.t) / 2 + 0.4));
  }
  start = Math.max(0, r1(start)); end = Math.min(dur, r1(end));
  if (end - start < 6) end = Math.min(dur, r1(start + 6));

  // Evidence: the detected events inside the final bounds that carry this clip.
  const within = (e) => e.end >= start && e.t <= end && (e.type !== "story" || (Math.min(e.end, end) - Math.max(e.t, start)) / Math.max(1, e.end - e.t) >= 0.5);
  const pool = [];
  for (const [track, list] of [["language", c.L], ["audio", c.A], ["face", c.F], ["gesture", c.G], ["interaction", c.I]]) for (const e of list) if (within(e)) { const d = describe(e); if (d) pool.push({ e, d, track, weight: (e.strength ?? 0.4) * ({ language: 1, audio: 0.9, face: 0.9, gesture: 0.8, interaction: 1 }[track]) }); }
  pool.sort((a, b) => b.weight - a.weight);
  const evidence = []; const seenKind = new Map();
  for (const p of pool) {
    if (p.e.type === "pause" && !p.e.data?.meaningful) continue;
    if (p.e.track === "language" && p.e.type === "statement" && evidence.some((x) => x.modality === "language")) continue;
    const n = seenKind.get(p.d.kind) || 0; if (n >= 1) continue; seenKind.set(p.d.kind, n + 1);
    evidence.push({ id: p.e.id, unit: p.e.data?.from ?? p.e.data?.unit ?? p.e.unit ?? null, cues: p.e.data?.cues || [], track: p.e.track, modality: MODALITY[p.e.track] || p.e.track, kind: p.d.kind, type: p.e.type, t: p.e.t, end: p.e.end, strength: p.e.strength ?? 0, label: p.d.label, phrase: p.d.phrase });
    if (evidence.length >= 8) break;
  }
  const category = categoryOf(evidence.map((x) => ({ type: x.type, track: x.track, strength: x.strength })));
  const leadEv = evidence.find((x) => x.track === "language" && x.unit != null && ["story", "opinion", "insight", "explanation", "quotable", "surprise-wording", "humor-wording", "question-answer", "statement"].includes(x.kind)) || evidence.find((x) => x.track === "interaction" && x.unit != null);
  const ranked = U.length ? [...U].sort((a, b) => (b.features._lengthFit * b.features._cleanStart * 0.5 + b.sig) - (a.features._lengthFit * a.features._cleanStart * 0.5 + a.sig)) : [];
  const leadUnit = leadEv && U.find((u) => u.i === leadEv.unit);
  const keyUnit = (leadUnit && !usedUnits.has(leadUnit.i) ? leadUnit : ranked.find((u) => !usedUnits.has(u.i) && u.words >= 3)) || leadUnit || ranked[0] || null;
  if (keyUnit) usedUnits.add(keyUnit.i);
  const score = Math.round(c.score * 100);
  // High confidence needs corroboration from a second kind of evidence (voice, picture or interaction), not words alone.
  const corroborated = ["vocal", "visual", "gesture", "interaction"].filter((k) => c.comp[k] >= 0.3).length >= 1 && c.comp.semantic >= 0.3 || (!caps.semantic ? false : c.comp.interaction >= 0.5);
  const tier = c.score >= 0.52 && corroborated ? "high" : c.score >= 0.4 ? "medium" : "low";
  const speakers = [...new Set(U.map((u) => u.speaker).filter(Boolean))];
  const faceEvs = c.F.filter(within);
  const reactionEvents = faceEvs.length > 0;
  const avgFaceX = faceEvs.length ? faceEvs.reduce((s, e) => s + (e.data?.x ?? 0.5), 0) / faceEvs.length : null;
  const title = titleFor(keyUnit, category, start);
  const explanation = explain({ category, evidence, tier, comp: c.comp, caps });
  const recommendation = recommend(category, { multiSpeaker: speakers.length >= 2, faces: timeline.has("face"), reactionEvents, duration: end - start, fallback: tier === "low", hasText: U.length > 0, avgFaceX });
  return {
    id: `moxie-${Math.round(start * 10)}-${Math.round(end * 10)}`, start, end, title, category, categories: [category], score, tier, confidence: tier,
    components: Object.fromEntries(Object.entries(c.comp).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    evidence, explanation: explanation.text, explanationKinds: explanation.kinds, leadKind: explanation.lead, reason: explanation.text, speakers,
    recommendation, source: "moxie", keyText: keyUnit?.text || ""
  };
}

function titleFor(u, category, start) {
  if (u) {
    let s = u.text.replace(/\s+/g, " ").trim().replace(/^(and|so|but|um+|uh+|well|yeah|okay|ok|right|like)[, ]+/i, "").replace(/^(.)/, (m) => m.toUpperCase());
    s = s.replace(/[.!?…]+$/, "");
    if (wordCount(s) >= 3) { if (s.length > 64) s = s.slice(0, 63).replace(/\s+\S*$/, "") + "…"; return s; }
  }
  return `${MOMENT_CATEGORIES[category]} at ${fmtT(start)}`;
}

const LEADS = {
  disagreement: "A claim meets a challenge", "strong-opinion": "A strong claim", insight: "An insight", explanation: "A clear explanation", story: "A personal story", humor: "A moment of shared laughter",
  surprise: "A surprising turn", quotable: "A short line that stands alone", "question-answer": "A question and its answer", exchange: "A quick back-and-forth", reaction: "A statement with visible reactions", highlight: "One of the most coherent passages"
};
function explain({ category, evidence, tier, comp, caps }) {
  const leadKinds = { disagreement: ["challenge"], "strong-opinion": ["opinion"], insight: ["insight"], explanation: ["explanation"], story: ["story"], humor: ["shared-laughter", "humor-wording", "laughter"], surprise: ["surprising-exchange", "surprise-wording"], quotable: ["quotable"], "question-answer": ["question-answer"], exchange: ["rapid-exchange"], reaction: ["visible-reaction"], highlight: ["statement"] }[category];
  const kinds = [];
  const lead = evidence.find((x) => leadKinds.includes(x.kind));
  if (lead) kinds.push(lead.kind);
  const rest = evidence.filter((x) => x !== lead && x.kind !== "statement");
  const picked = []; const seenMod = new Set();
  for (const x of rest) if (!seenMod.has(x.modality)) { seenMod.add(x.modality); picked.push(x); }      // the strongest item from each kind of evidence first
  for (const x of rest) if (picked.length < 5 && !picked.includes(x)) picked.push(x);
  const support = rest.filter((x) => picked.includes(x)).slice(0, 5);
  support.forEach((x) => kinds.push(x.kind));
  const phrases = support.map((x) => x.phrase);
  let text;
  if (tier === "low") {
    const bits = [];
    if (comp.narrative >= 0.6) bits.push("it opens and closes on complete thoughts");
    if (comp.semantic >= 0.25) bits.push("it carries more distinctive content than most of the recording");
    if (comp.suitability >= 0.6) bits.push("it runs a workable length");
    text = `Nothing in this recording stood out strongly, so this is one of the most coherent passages: ${bits.join(", ") || "it is a complete passage"}.` + (phrases.length ? ` Also detected: ${join(phrases)}.` : "");
  } else {
    const l = lead ? (LEADS[category] || "A moment") : "A moment";
    text = phrases.length ? `${l} with ${join(phrases)}.` : `${l}.`;
    if (lead?.kind === "statement") text = `A passage that carries more than most of this recording (${lead.cues.join(", ") || "distinctive wording"})${phrases.length ? " with " + join(phrases) : ""}.`;
    else if (!lead) text = `${phrases.length ? "Detected: " + join(phrases) : "A passage with a few small signals"}.`;
  }
  if (!caps.semantic && tier !== "low") text += " No transcript was available, so this is based on sound and picture only.";
  return { text, kinds: [...new Set(kinds)], lead: lead?.kind || null };
}
const join = (xs) => xs.length <= 1 ? xs.join("") : xs.slice(0, -1).join(", ") + " and " + xs[xs.length - 1];
