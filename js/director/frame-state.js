// What is on screen at time T of an edit plan. Pure: (plan, T) -> a plain description (which shot and source time, the camera, the
// active caption chunk and which words have been spoken, the typography and graphics with their animation progress, any
// transition and the intro or outro card). The renderer only draws this description, so the whole timeline is testable in Node
// and a given plan always produces the same frames.
export const EASE = {
  linear: (k) => k,
  in: (k) => k * k,
  out: (k) => 1 - (1 - k) * (1 - k),
  inOut: (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
  back: (k) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); }
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, k) => a + (b - a) * k;
const IN = 0.35, OUT = 0.3;

export function segmentAt(plan, c) {
  const segs = plan.segments;
  let lo = 0, hi = segs.length - 1;
  if (!segs.length) return null;
  if (c < segs[0].outStart) return segs[0];
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].outStart <= c) lo = mid; else hi = mid - 1; }
  return segs[lo];
}

export function cameraAt(seg, c) {
  const len = Math.max(0.001, seg.outEnd - seg.outStart), p = clamp01((c - seg.outStart) / len);
  const e = (EASE[seg.camera.ease] || EASE.inOut)(p);
  let scale = lerp(seg.camera.scaleFrom, seg.camera.scaleTo, e);
  for (const pu of seg.punches || []) {
    const k = (c - pu.at) / pu.dur;
    if (k >= 0 && k <= 1) scale *= 1 + (pu.scale - 1) * Math.sin(Math.PI * k) ** 0.7;
  }
  return { scale, fx: seg.camera.fx + (seg.camera.pan || 0) * (p - 0.5) * 2, fy: seg.camera.fy };
}

export function introRows(title, p) {
  return String(title || "").split(/\s+/).filter(Boolean).reduce((rows, w) => { const last = rows[rows.length - 1]; if (last && (last + " " + w).length <= 16) rows[rows.length - 1] = last + " " + w; else rows.push(w); return rows; }, [])
    .slice(0, 4).map((text, i) => ({ text, k: EASE.back(clamp01((p - 0.08 * i) / 0.45)), out: clamp01((p - 0.82) / 0.18) }));
}

export function frameState(plan, T) {
  const tl = plan.timeline, t = Math.max(0, Math.min(tl.total, T));
  const st = { T: t, total: tl.total, phase: "content", c: 0, seg: null, srcTime: 0, camera: { scale: 1, fx: 0.5, fy: 0.5 }, transition: null, snapshotDue: false, card: null, cardFade: 0, captions: null, typography: [], graphics: [], broll: null, progress: 0 };
  if (tl.intro && t < tl.intro) {
    st.phase = "intro"; const p = clamp01(t / tl.intro);
    st.card = { which: "intro", kind: plan.intro.kind, p, title: plan.intro.title, subtitle: plan.intro.subtitle || "", rows: introRows(plan.intro.title, p) };
    return st;
  }
  if (tl.outro && t >= tl.intro + tl.content) {
    st.phase = "outro"; const p = clamp01((t - tl.intro - tl.content) / tl.outro);
    st.card = { which: "outro", kind: plan.outro.kind, p, text: plan.outro.text, subtitle: plan.outro.subtitle, k: EASE.out(clamp01(p / 0.4)) };
    return st;
  }
  const c = Math.max(0, Math.min(tl.content, t - tl.intro)), seg = segmentAt(plan, c);
  st.c = c; st.seg = seg.index; st.progress = tl.content ? c / tl.content : 0;
  st.srcTime = seg.srcStart + (c - seg.outStart);
  st.camera = cameraAt(seg, c);
  // fades from the intro card and into the outro card
  if (tl.intro && c < 0.35) st.cardFade = 1 - c / 0.35;
  if (tl.outro && c > tl.content - 0.3) st.cardFade = -((c - (tl.content - 0.3)) / 0.3);        // negative: fading towards the outro
  // transition: it runs just after the cut, over the incoming shot
  for (const cut of plan.cuts) {
    if (cut.kind === "hard") continue;
    if (c >= cut.at && c < cut.at + cut.dur) st.transition = { kind: cut.kind, p: (c - cut.at) / cut.dur, e: EASE.inOut((c - cut.at) / cut.dur) };
    else if (cut.at > c && cut.at - c <= 0.1) st.snapshotDue = true;
  }
  // captions
  const cap = plan.captions;
  if (cap) {
    const ch = cap.chunks.find((x) => c >= x.start - 0.04 && c <= x.end);
    if (ch) st.captions = {
      style: cap.style, position: cap.position, size: cap.size, uppercase: cap.uppercase, font: cap.font,
      inK: clamp01((c - ch.start + 0.04) / 0.22), outK: clamp01((ch.end - c) / 0.18),
      words: ch.words.map((w) => ({ text: w.text, mark: w.mark, state: c >= w.end ? "past" : c >= w.start ? "active" : "future", k: clamp01((c - w.start) / Math.max(0.12, w.end - w.start)), shown: clamp01((c - w.start + 0.05) / 0.2) }))
    };
  }
  const prog = (it) => ({ inK: clamp01((c - it.start) / IN), outK: clamp01((it.end - c) / OUT), t: c - it.start, dur: it.end - it.start });
  for (const it of plan.typography) if (c >= it.start && c <= it.end) st.typography.push({ ...it, ...prog(it), words: it.words.map((w) => ({ text: w.text, k: EASE.back(clamp01((c - w.start + 0.08) / 0.3)), shown: c >= w.start - 0.08 })) });
  for (const g of plan.graphics) if (c >= g.start && c <= g.end) st.graphics.push({ ...g, ...prog(g) });
  for (const b of plan.broll || []) if (c >= b.start && c <= b.end) st.broll = { ...b, inK: clamp01((c - b.start) / 0.25), outK: clamp01((b.end - c) / 0.25), srcTime: b.srcStart + (c - b.start) };
  return st;
}

// Everything that changes on screen between two plans' frames, used by tests to prove two styles look different.
export function visualSignature(plan, step = 0.5) {
  const sig = [];
  for (let t = 0; t < plan.timeline.total; t += step) { const s = frameState(plan, t); sig.push([s.phase, s.seg, +s.camera.scale.toFixed(2), s.transition?.kind || "", s.captions?.style || "", s.typography.length, s.graphics.length].join(":")); }
  return sig;
}
