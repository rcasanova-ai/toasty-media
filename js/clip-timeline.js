// Pure animation timeline for a clip render. computeFrame() turns (template, time) into a plain description of what is on
// screen at that instant: which phase (intro, clip, outro), the camera zoom and pan, caption words and which is active,
// overlays and their fade, and any transition between phases. The renderer only draws that description; nothing here touches
// a canvas, so the whole timeline is testable in Node.
import { fillText } from "./clip-templates.js";

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const lerp = (a, b, k) => a + (b - a) * k;
export const EASE = {
  linear: (k) => k,
  in: (k) => k * k,
  out: (k) => 1 - (1 - k) * (1 - k),
  inOut: (k) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2),
  back: (k) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); }
};

export function planTimeline(tpl, clipSeconds) {
  const intro = tpl.intro.kind === "none" ? 0 : tpl.intro.seconds;
  const outro = tpl.outro.kind === "none" ? 0 : tpl.outro.seconds;
  return { intro, clip: clipSeconds, outro, total: intro + clipSeconds + outro };
}

// Transcript lines (source time) -> words with estimated timing, relative to the clip start. Speech recognition here gives
// line-level timing only, so a line's words are spread across its duration in proportion to their length (an estimate, and
// reported as such in the UI).
export function captionWords(lines, start, end) {
  const words = [];
  const sorted = [...(lines || [])].filter((l) => l && Number.isFinite(l.t)).sort((a, b) => a.t - b.t);
  sorted.forEach((line, i) => {
    const tokens = String(line.text || "").trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) return;
    const next = sorted[i + 1];
    const lineEnd = Math.min(line.end ?? (line.t + tokens.length * 0.38), next ? next.t : Infinity, line.t + tokens.length * 0.6 + 1);
    if (lineEnd < start || line.t > end) return;
    const weights = tokens.map((w) => 1 + w.length * 0.18), total = weights.reduce((a, b) => a + b, 0);
    let cursor = line.t;
    tokens.forEach((w, k) => {
      const dur = (lineEnd - line.t) * (weights[k] / total);
      const ws = cursor, we = cursor + dur; cursor = we;
      if (we > start && ws < end) words.push({ text: w, start: Math.max(0, ws - start), end: Math.min(end, we) - start });
    });
  });
  return words;
}

// Group words into display chunks: short for kinetic/karaoke, a readable line for a bar.
export function captionChunks(words, style) {
  const maxWords = style === "bar" ? 8 : 3, chunks = [];
  let cur = [];
  const flush = () => { if (cur.length) { chunks.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end }); cur = []; } };
  for (const w of words) {
    if (cur.length && w.start - cur[cur.length - 1].end > 0.8) flush();
    cur.push(w);
    if (cur.length >= maxWords || /[.!?]$/.test(w.text)) flush();
  }
  flush();
  return chunks;
}

function cameraAt(tpl, clipT, clipLen) {
  const p = clipLen > 0 ? clamp01(clipT / clipLen) : 0;
  const k = (EASE[tpl.camera.ease] || EASE.inOut)(p);
  let scale = lerp(tpl.camera.zoomFrom, tpl.camera.zoomTo, k);
  for (const pi of tpl.camera.punchIns) {
    const at = pi.at * clipLen, local = (clipT - at) / pi.dur;
    if (local >= 0 && local <= 1) scale *= 1 + (pi.scale - 1) * Math.sin(Math.PI * local) ** 0.7;
  }
  return { scale, panX: tpl.camera.panX * (k - 0.5) * 2, panY: tpl.camera.panY * (k - 0.5) * 2 };
}

export function computeFrame({ tpl, plan, words = [], chunks = null, t, vars = {}, spec = {}, brand = {} }) {
  const clampT = Math.max(0, Math.min(plan.total, t));
  const f = { t: clampT, total: plan.total, phase: "clip", clipT: 0, progress: 0, camera: { scale: 1, panX: 0, panY: 0 }, intro: null, outro: null, captions: null, transition: null, overlays: { progressBar: null, lowerThird: null, badge: null, frame: tpl.overlays.frame, logo: tpl.overlays.logo, custom: [] } };
  const tr = tpl.transition.kind === "none" ? 0 : tpl.transition.seconds;
  if (clampT < plan.intro) {
    f.phase = "intro";
    const p = clamp01(clampT / plan.intro);
    f.intro = { kind: tpl.intro.kind, p, title: fillText(spec.title ?? tpl.intro.title, vars), subtitle: fillText(spec.subtitle ?? tpl.intro.subtitle, vars),
      // rolling title: each line of the title rolls up into place in turn
      rows: fillText(spec.title ?? tpl.intro.title, vars).split(/\s+/).reduce((rows, w) => { const last = rows[rows.length - 1]; if (last && (last + " " + w).length <= 16) rows[rows.length - 1] = last + " " + w; else rows.push(w); return rows; }, []).slice(0, 4).map((text, i, arr) => ({ text, k: EASE.back(clamp01((p - 0.08 * i) / 0.45)), out: clamp01((p - 0.82) / 0.18) })) };
  } else if (clampT >= plan.intro + plan.clip) {
    f.phase = "outro";
    const p = plan.outro ? clamp01((clampT - plan.intro - plan.clip) / plan.outro) : 1;
    f.outro = { kind: tpl.outro.kind, p, text: fillText(spec.outroText ?? tpl.outro.text, vars), subtitle: fillText(tpl.outro.subtitle, vars), k: EASE.out(clamp01(p / 0.4)) };
  } else {
    f.clipT = clampT - plan.intro;
    f.progress = plan.clip > 0 ? clamp01(f.clipT / plan.clip) : 0;
    f.camera = cameraAt(tpl, f.clipT, plan.clip);
  }
  // Transitions straddle the boundaries between phases.
  if (tr) {
    const boundaries = [];
    if (plan.intro) boundaries.push({ at: plan.intro, from: "intro", to: "clip" });
    if (plan.outro) boundaries.push({ at: plan.intro + plan.clip, from: "clip", to: "outro" });
    for (const b of boundaries) if (clampT >= b.at - tr / 2 && clampT <= b.at + tr / 2) { f.transition = { kind: tpl.transition.kind, p: clamp01((clampT - (b.at - tr / 2)) / tr), from: b.from, to: b.to }; break; }
  }
  if (f.phase === "clip" || (f.transition && f.transition.to === "clip")) {
    const ct = f.clipT;
    if (tpl.captions.style !== "none") {
      const cs = chunks || captionChunks(words, tpl.captions.style);
      const cur = cs.find((c) => ct >= c.start - 0.05 && ct <= c.end + 0.25);
      if (cur) f.captions = { style: tpl.captions.style, position: tpl.captions.position, size: tpl.captions.size, uppercase: tpl.captions.uppercase, highlight: tpl.captions.highlight,
        pop: EASE.back(clamp01((ct - cur.start) / 0.22)),
        words: cur.words.map((w) => ({ text: w.text, state: ct >= w.end ? "past" : ct >= w.start ? "active" : "future", k: clamp01((ct - w.start) / Math.max(0.12, w.end - w.start)) })) };
    }
    if (tpl.overlays.progressBar) f.overlays.progressBar = f.progress;
    if (tpl.overlays.titleBadge) f.overlays.badge = { text: tpl.overlays.titleBadge, alpha: clamp01(ct / 0.4) * (1 - clamp01((ct - 3.4) / 0.6)) };
    const lt = spec.lowerThird;
    if ((tpl.overlays.lowerThird || lt) && lt?.name) { const a = clamp01((ct - 0.6) / 0.5) * (1 - clamp01((ct - 5.6) / 0.5)); if (a > 0) f.overlays.lowerThird = { name: lt.name, role: lt.role || "", alpha: a, slide: 1 - EASE.out(clamp01((ct - 0.6) / 0.5)) }; }
    for (const c of spec.custom || []) { const a = clamp01((ct - c.at) / 0.3) * (1 - clamp01((ct - (c.at + c.dur - 0.3)) / 0.3)); if (a > 0) f.overlays.custom.push({ text: c.text, alpha: a, position: c.position, rise: 1 - EASE.out(clamp01((ct - c.at) / 0.4)) }); }
  }
  return f;
}
