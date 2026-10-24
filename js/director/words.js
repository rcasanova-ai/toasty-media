// Transcript words with timing. Speech recognition here gives line-level timing, so the words of a line are spread over the
// stretches of that line where the voice is actually present (js/director/speech.js), in proportion to word length. That is still
// an estimate, but it never parks a word on silence, and it is what the captions and kinetic text are synchronised to.
import { regionsIn } from "./speech.js";

const tokenize = (text) => String(text || "").trim().split(/\s+/).filter(Boolean);

export function lineEnd(lines, i) {
  const l = lines[i], next = lines[i + 1], n = tokenize(l.text).length;
  const est = l.t + Math.max(1, n * 0.4);
  return Math.max(l.t + 0.4, Math.min(l.end ?? est, next ? next.t : Infinity, l.t + n * 0.7 + 1.5));
}

// -> [{ text, start, end, line, speaker }] in SOURCE seconds, for lines overlapping [from, to].
export function alignWords(lines, regions, { from = 0, to = Infinity } = {}) {
  const sorted = [...(lines || [])].filter((l) => l && Number.isFinite(l.t) && String(l.text || "").trim()).sort((a, b) => a.t - b.t);
  const words = [];
  sorted.forEach((l, i) => {
    const e = lineEnd(sorted, i);
    if (e < from || l.t > to) return;
    const toks = tokenize(l.text);
    let spans = regions?.length ? regionsIn(regions, l.t - 0.12, e + 0.25) : [];
    if (!spans.length || spans.reduce((s, r) => s + r.end - r.start, 0) < Math.min(0.3, toks.length * 0.1)) spans = [{ start: l.t, end: e }];
    const total = spans.reduce((s, r) => s + r.end - r.start, 0);
    const weights = toks.map((w) => 1 + w.replace(/[^\w]/g, "").length * 0.2 + (/[,.;:!?]$/.test(w) ? 0.8 : 0)), wsum = weights.reduce((a, b) => a + b, 0);
    let consumed = 0;
    const at = (x, startOfWord = false) => { let acc = x * total; for (const s of spans) { const len = s.end - s.start; if (acc < len - 1e-9 || (!startOfWord && acc <= len + 1e-9)) return s.start + Math.min(acc, len); acc -= len; } return spans[spans.length - 1].end; };
    toks.forEach((w, k) => {
      const a = consumed / wsum, b = (consumed + weights[k]) / wsum; consumed += weights[k];
      const start = at(a, true); let end = at(b);
      const home = spans.find((sp) => start >= sp.start - 1e-6 && start <= sp.end + 1e-6);
      if (home && end > home.end + 1e-6) end = Math.max(home.end, start + 0.08);          // a word never straddles a pause
      if (end > from && start < to) words.push({ text: w, start, end: Math.max(end, start + 0.06), line: i, speaker: l.speaker || "" });
    });
  });
  return words;
}

// Source-time words -> output-time words using the plan's segments. Words that fall in removed stretches are dropped; words cut
// by a segment edge are clipped to it.
export function wordsToOutput(words, segments) {
  const out = [];
  for (const w of words) {
    const mid = (w.start + w.end) / 2, seg = segments.find((s) => mid >= s.srcStart && mid < s.srcEnd);
    if (!seg) continue;
    const start = seg.outStart + Math.max(0, w.start - seg.srcStart), end = seg.outStart + Math.min(seg.srcEnd, w.end) - seg.srcStart;
    if (end - start > 0.02) out.push({ ...w, srcStart: w.start, srcEnd: w.end, start, end, seg: seg.index });
  }
  return out;
}
