// Conversational dynamics: what happened BETWEEN people. It reads the shared timeline (speech units, vocal events, visible
// events, language events) and adds interaction events, each carrying refs to the events that justify it. Anything that needs
// to know who is speaking is only reported when speakers are known (labels from the Studio, or an estimate from pitch).
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const VISIBLE = ["smile", "brow-raise", "mouth-open", "head-turn", "head-nod", "lean-in", "lean-back", "body-lean-in", "posture-shift"];
const CHALLENGE_START = /^(no\b|nope|but\b|wait\b|really\b|come on|that'?s not|i (don'?t|disagree)|why\b|how (can|do)|are you sure|you'?re (wrong|kidding))/i;

export function analyzeInteraction(timeline, units, { speakersKnown = false } = {}) {
  const added = [];
  const emit = (type, t, end, strength, refs, data = {}) => { if (!(end >= t)) end = t; added.push(timeline.add("interaction", { type, t, end, strength: clamp(strength), data: { ...data, refs: [...new Set(refs.filter(Boolean))] } })); };
  const near = (tracks, types, a, b) => timeline.query(tracks, a, b).filter((e) => !types || types.includes(e.type));
  const audio = (types, a, b) => near("audio", types, a, b);
  const sameKnown = (a, b) => a.speaker && b.speaker && a.speaker === b.speaker;
  const diffKnown = (a, b) => a.speaker && b.speaker && a.speaker !== b.speaker;

  // Interruptions: talking over, cut-off sentences, or a new voice starting before the last one finished.
  for (let i = 0; i + 1 < units.length; i++) {
    const a = units[i], b = units[i + 1];
    if (!diffKnown(a, b)) continue;
    const overlapEv = audio(["overlap"], b.t - 1, b.t + 1.5)[0];
    const cutOff = /(—|--|-)\s*$/.test(a.text), early = b.t < a.end - 0.25;
    if (overlapEv || cutOff || early) emit("interruption", b.t - 0.3, Math.min(b.t + 2, b.end), 0.5 + (overlapEv ? 0.2 : 0) + (cutOff ? 0.15 : 0) + (early ? 0.1 : 0), [overlapEv?.id], { from: a.speaker, to: b.speaker, cutOff, overlapped: Boolean(overlapEv || early), unit: i });
  }
  // Challenge and response.
  for (let i = 0; i + 1 < units.length; i++) {
    const a = units[i], b = units[i + 1];
    if (!diffKnown(a, b) || b.t - a.end > 4 || a.words < 5 || a.features.question) continue;
    const challenge = b.words <= 40 && (CHALLENGE_START.test(b.text.trim()) || (b.features.question && b.words <= 14 && b.t - a.end <= 2) || (b.proto?.disagreement ?? 0) >= 0.55);
    if (!challenge) continue;
    let replyIdx = -1; for (let k = i + 2; k < Math.min(units.length, i + 5); k++) if (units[k].speaker === a.speaker && units[k].t - units[k - 1].end < 6) { replyIdx = k; break; }
    const end = replyIdx > 0 ? units[replyIdx].end : b.end;
    emit("challenge-response", a.t, end, 0.4 + 0.3 * a.sig + 0.15 * b.sig + (replyIdx > 0 ? 0.15 : 0), [], { claimBy: a.speaker, challengeBy: b.speaker, replied: replyIdx > 0, from: i, to: replyIdx > 0 ? replyIdx : i + 1, claim: a.text });
  }
  // Rapid exchange: four or more short alternating turns with little gap.
  for (let i = 0; i + 3 < units.length;) {
    let j = i;
    while (j + 1 < units.length && diffKnown(units[j], units[j + 1]) && units[j + 1].t - units[j].end <= 1.2 && units[j].words <= 14 && units[j + 1].words <= 14) j++;
    if (j - i >= 3) { emit("rapid-exchange", units[i].t, units[j].end, 0.45 + Math.min(0.35, (j - i - 3) * 0.1), [], { turns: j - i + 1, from: i, to: j }); i = j + 1; } else i++;
  }
  // Laughter: shared when more than one person is involved (speakers around it, or two smiles).
  for (const l of audio(["laughter"], 0, timeline.duration + 1)) {
    const around = units.filter((u) => u.end >= l.t - 6 && u.t <= l.end + 3);
    const speakers = new Set(around.map((u) => u.speaker).filter(Boolean));
    const smiles = near("face", ["smile"], l.t - 2, l.end + 2);
    const slots = new Set(smiles.map((s) => s.slot));
    const shared = speakers.size >= 2 || slots.size >= 2;
    const lineBefore = around.filter((u) => u.end <= l.t + 0.8).slice(-1)[0];
    emit(shared ? "shared-laughter" : "laughter-reaction", l.t, l.end, (shared ? 0.55 : 0.4) + l.strength * 0.3 + (slots.size >= 2 ? 0.1 : 0), [l.id, ...smiles.map((s) => s.id)], { speakers: [...speakers], smiles: smiles.length, afterUnit: lineBefore?.i ?? null });
  }
  // Visible reactions to strong statements.
  if (timeline.has("face") || timeline.has("pose")) {
    for (const u of units) {
      if (u.pct < 0.7 || u.sig < 0.18) continue;
      const vis = near(["face", "gesture"], VISIBLE, u.t, u.end + 3);
      if (vis.length) emit("visible-reaction", u.t, Math.max(u.end, ...vis.map((v) => v.end)), 0.35 + u.sig * 0.35 + Math.min(0.25, vis.length * 0.08), vis.map((v) => v.id), { unit: u.i, kinds: [...new Set(vis.map((v) => v.type))] });
    }
  }
  // Changes in speaking pattern at a turn.
  for (let i = 0; i + 1 < units.length; i++) {
    const a = units[i], b = units[i + 1];
    if (!diffKnown(a, b)) continue;
    const shift = audio(["speech-faster", "speech-slower", "energy-up", "energy-down", "pitch-jump", "intensity-rise"], b.t - 0.5, b.t + 3)[0];
    if (shift) emit("pattern-change", b.t, b.t + 3, 0.35 + shift.strength * 0.4, [shift.id], { kind: shift.type, from: a.speaker, to: b.speaker });
  }
  // Surprising exchange: a statement or question, a held pause, then a visible or vocal jolt or a laugh.
  const pauses = audio(["pause"], 0, timeline.duration + 1).filter((p) => p.data?.meaningful);
  for (const p of pauses) {
    const before = units.filter((u) => u.end <= p.t + 0.6 && u.end >= p.t - 1.2).slice(-1)[0];
    const after = [...audio(["pitch-jump", "laughter", "loud-reaction"], p.end - 0.5, p.end + 4), ...near("face", ["brow-raise", "mouth-open", "head-turn"], p.end - 0.5, p.end + 4)];
    const surpriseText = units.find((u) => u.t >= p.end - 0.3 && u.t <= p.end + 3 && u.features.surprise >= 0.5);
    if (before && (after.length || surpriseText) && (before.pct >= 0.5 || before.features.question)) emit("surprising-exchange", before.t, p.end + 4, 0.45 + Math.min(0.3, after.length * 0.12) + (surpriseText ? 0.12 : 0), [p.id, ...after.map((e) => e.id)], { unit: before.i, pause: p.data.duration, followedBy: [...new Set(after.map((e) => e.type)), ...(surpriseText ? ["surprised wording"] : [])] });
    else if (before && before.pct >= 0.75 && p.data.duration >= 1.5) emit("meaningful-pause", before.t, p.end, 0.3 + clamp((p.data.duration - 1) / 3) * 0.3 + before.sig * 0.2, [p.id], { unit: before.i, duration: p.data.duration });
  }
  // Build-up: sentence significance climbing toward a peak, and the vocal level rising with it.
  for (const peak of units.filter((u) => u.pct >= 0.85 && u.sig >= 0.2)) {
    const run = units.filter((u) => u.t >= peak.t - 18 && u.t <= peak.t);
    if (run.length < 4) continue;
    const n = run.length, xs = run.map((_, k) => k), mx = (n - 1) / 2, my = run.reduce((s, u) => s + u.sig, 0) / n;
    const slope = xs.reduce((s, x, k) => s + (x - mx) * (run[k].sig - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
    const rise = run.slice(-2).reduce((s, u) => s + u.sig, 0) / 2 - run.slice(0, 2).reduce((s, u) => s + u.sig, 0) / 2;
    if (slope > 0.015 && rise >= 0.12) { const lift = audio(["intensity-rise", "energy-up"], run[0].t, peak.end + 1); emit("buildup", run[0].t, peak.end, 0.35 + clamp(rise) * 0.8 + (lift.length ? 0.1 : 0), lift.map((e) => e.id), { peakUnit: peak.i, units: n }); }
  }
  // Resolution: a story that closes, or a point that lands and is followed by a settling pause or laughter.
  for (const s of timeline.tracks.language.filter((e) => e.type === "story" && e.data?.resolved)) emit("resolution", s.end - 1, s.end, 0.5 + s.strength * 0.3, [s.id], { kind: "story" });
  return added;
}
