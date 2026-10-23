// Language intelligence: what was said, and how it is built. It works on sentence units of the transcript and combines
//   1. meaning: similarity to prototype statements (opinion, insight, story, humour, surprise, advice, disagreement) with a
//      local sentence-embedding model, and topic changes from embedding drift. Only when the model loaded (semantic.kind = "minilm").
//   2. discourse structure, which needs no model: information density relative to this recording, specificity, stance, contrast,
//      explanation, narrative (past-tense, time-ordered, first person), questions and their answers, quotability.
// No single phrase is required: a plain transcript with none of the usual trigger words still yields ranked units, because
// every unit is scored on how much it carries relative to the rest of the recording.
import { splitUnits, wordCount, tokens, contentTokens, buildIdf, cosine, meanVector } from "./text.js";

export const PROTOTYPES = {
  opinion: ["I strongly believe this is the wrong way to think about it.", "Honestly, that is the worst advice and people should stop following it.", "My take is that most people have this completely backwards."],
  insight: ["The real reason it works is something most people overlook.", "Once you understand the underlying principle everything else becomes obvious.", "What I learned is that the obvious explanation was not the true one."],
  story: ["Years ago something happened to me that changed how I work.", "We were in the middle of the project when everything suddenly fell apart.", "I remember the day it started and how it ended."],
  humor: ["That is hilarious, I could not stop laughing at the joke.", "It was so absurd that the whole room burst out laughing."],
  surprise: ["I had no idea, that completely surprised me.", "Wait, that is unbelievable, I did not expect that at all."],
  advice: ["If you want to get better, here is exactly what you should do.", "My advice is to start small and keep going every single day."],
  disagreement: ["No, I disagree, that is not true and here is why.", "But that does not make sense, you are missing the point."]
};

const FILLER = /\b(um+|uh+|you know|i mean|kind of|sort of|like,|basically|literally)\b/gi;
const STANCE = [/\bi (really |honestly |truly )?(think|believe|feel|know|learned|realized|want|need|hate|love|refuse|doubt)\b/i, /\b(we|you|people|they) (should|must|need to|have to|ought to|shouldn'?t|can'?t|cannot)\b/i, /\b(biggest|best|worst|real|only|greatest|most important|hardest|easiest)\b/i, /\b(never|always|nobody|everyone|everybody|nothing|every single|completely|totally|absolutely|exactly)\b/i];
const CONTRAST = [/\b(but|however|although|though|instead|rather than|whereas|unlike|yet)\b/i, /\bnot\b.{1,28}\b(but|it'?s|they'?re|that'?s)\b/i, /\b(actually|in fact|the opposite|on the contrary)\b/i];
const EXPLAIN = [/\b(because|so that|which means|that means|means that|for example|for instance|the reason|in other words|works by|that'?s why|therefore|as a result|the way it works)\b/i, /\b(first|second|third|step|then you|so you)\b/i];
const TEMPORAL = /\b(when|then|one day|years? ago|months? ago|last (year|week|month|summer|winter)|back (then|in)|yesterday|after|before|suddenly|eventually|finally|at the time|that (night|morning|day)|in (19|20)\d\d)\b/i;
const PAST = /\b(was|were|had|went|came|said|told|got|made|took|saw|knew|felt|started|ended|decided|realized|asked|called|happened|lost|found|left|ran|met|built|gave|thought|wanted|needed|tried|ended up)\b|\b\w{3,}ed\b/gi;
const RESOLVE = /\b(so now|that'?s (why|how|when)|turns? out|in the end|the lesson|what i learned|looking back|ever since|and that was|never again|it worked|we won|we lost)\b/i;
const SURPRISE = /\b(wow|whoa|wait|no way|seriously|unbelievable|crazy|insane|can'?t believe|had no idea|didn'?t expect|oh my)\b/i;
const CONNECTIVE_START = /^(and|so|but|because|then|um|uh|well|yeah|okay|ok|right|like|or|also|which|that|it|this|they|he|she)\b/i;
const GENERAL = /\b(everyone|nobody|most people|always|never|the (key|secret|truth|problem|point|difference)|is (not|about)|isn'?t|aren'?t|are (not|just))\b/i;
const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const count = (text, res) => res.reduce((n, r) => n + (r.test(text) ? 1 : 0), 0);

export function unitFeatures(u, idfFn, maxIdf) {
  const text = u.text, words = u.words, toks = contentTokens(text);
  const meanIdf = toks.length ? toks.reduce((s, w) => s + idfFn(w), 0) / toks.length : 0;
  const caps = (text.match(/(?<![.!?]\s)(?<!^)\b[A-Z][a-z]{2,}/g) || []).length;
  const digits = (text.match(/\b\d[\d,.:]*\b/g) || []).length;
  const fillers = (text.match(FILLER) || []).length;
  const pastHits = (text.match(PAST) || []).length;
  const f = {
    densityRaw: (meanIdf / maxIdf) * clamp(toks.length / 4),
    specificity: clamp((caps + digits * 1.5 + (/["“]/.test(text) ? 1 : 0)) / 3),
    stance: clamp(count(text, STANCE) / 2),
    contrast: clamp(count(text, CONTRAST) * 0.7),
    explain: clamp(count(text, EXPLAIN) * 0.6 + (words >= 14 ? 0.2 : 0)),
    narrative: clamp(pastHits / Math.max(6, words) * 4 + (TEMPORAL.test(text) ? 0.35 : 0) + (/\b(i|we|my|our)\b/i.test(text) ? 0.15 : 0)),
    question: /\?\s*$/.test(text) && words >= 4 ? 1 : 0,
    surprise: clamp((SURPRISE.test(text) ? 0.6 : 0) + (/[!?]{2,}|!\s*$/.test(text) && words <= 14 ? 0.4 : 0)),
    resolution: RESOLVE.test(text) ? 1 : 0,
    filler: clamp(fillers / Math.max(4, words / 3)),
    laughText: /\b(ha(ha)+|hehe+|lol)\b|\[(laughter|laughs)\]|\((laughter|laughs)\)/i.test(text) ? 1 : 0
  };
  const cleanStart = !CONNECTIVE_START.test(text) ? 1 : 0.4;
  const lengthFit = words >= 6 && words <= 28 ? 1 : words > 28 && words <= 45 ? 0.6 : words >= 4 ? 0.5 : 0;
  f._cleanStart = cleanStart; f._lengthFit = lengthFit; f._general = GENERAL.test(text) ? 1 : 0;
  return f;
}

function percentileRanks(values) {
  const order = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(values.length);
  for (let a = 0; a < order.length;) {
    let b = a; while (b + 1 < order.length && order[b + 1][0] === order[a][0]) b++;
    const rank = values.length > 1 ? (a + b) / 2 / (values.length - 1) : 0.5;   // ties share their average rank
    for (let k = a; k <= b; k++) out[order[k][1]] = order[a][0] <= 0 ? 0 : rank;
    a = b + 1;
  }
  return out;
}

function topicBoundaries(unitVecs, { window = 4, minGap = 6 } = {}) {
  const n = unitVecs.length, sims = new Array(n).fill(null);
  if (n < window * 2 + 2) return [];
  for (let i = window; i <= n - window; i++) sims[i] = cosine(meanVector(unitVecs, i - window, i), meanVector(unitVecs, i, i + window));
  const vals = sims.filter((v) => v != null), mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length) || 1e-6;
  const depth = (i) => { let l = sims[i], r = sims[i]; for (let k = i - 1; k >= window && sims[k] >= l; k--) l = sims[k]; for (let k = i + 1; k <= n - window && sims[k] >= r; k++) r = sims[k]; return (l - sims[i]) + (r - sims[i]); };
  const cands = [];
  for (let i = window; i <= n - window; i++) {
    const isMin = (sims[i - 1] == null || sims[i] <= sims[i - 1]) && (sims[i + 1] == null || sims[i] <= sims[i + 1]);
    if (isMin) { const d = depth(i); if (d > 0.5 * sd + 0.02 && sims[i] < mean - 0.4 * sd) cands.push({ i, d, sim: sims[i] }); }
  }
  cands.sort((a, b) => b.d - a.d);
  const kept = [];
  for (const c of cands) if (kept.every((k) => Math.abs(k.i - c.i) >= minGap)) kept.push(c);
  return kept.sort((a, b) => a.i - b.i);
}

export async function analyzeLanguage(lines, { embedder = null, onProgress, signal } = {}) {
  const units = splitUnits(lines);
  const info = { units, topics: [], events: [], boundaries: [], semantic: { kind: embedder?.kind || "none", note: embedder?.note || "" }, stats: { units: units.length } };
  if (!units.length) return info;

  const { idf, N } = buildIdf(units.map((u) => u.text));
  const maxIdf = Math.log(N + 1) + 1;
  const feats = units.map((u) => unitFeatures(u, idf, maxIdf));
  const densityPct = percentileRanks(feats.map((f) => f.densityRaw));

  // Embeddings: topics always (model or lexical); prototype affinity only with the real model.
  let vecs = null, proto = null;
  if (embedder) {
    vecs = await embedder.embed(units.map((u) => u.text), { onProgress: (p) => onProgress?.(p * 0.9) });
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    if (embedder.kind === "minilm") {
      const names = Object.keys(PROTOTYPES), flat = names.flatMap((n) => PROTOTYPES[n].map((text) => ({ n, text })));
      const pv = await embedder.embed(flat.map((p) => p.text));
      proto = vecs.map((v) => { const a = {}; flat.forEach((p, k) => { const s = cosine(v, pv[k]); a[p.n] = Math.max(a[p.n] ?? -1, s); }); for (const n of names) a[n] = clamp((a[n] - 0.28) / 0.32); return a; });
    }
  }

  // Narrative is judged over a neighbourhood: a story is several consecutive past-tense, time-ordered sentences.
  const narrSmooth = feats.map((_, i) => { let s = 0, c = 0; for (let k = Math.max(0, i - 2); k <= Math.min(units.length - 1, i + 2); k++) { s += feats[k].narrative; c++; } return s / c; });

  const sigs = units.map((u, i) => {
    const f = feats[i], p = proto?.[i];
    const protoMax = p ? Math.max(p.opinion, p.insight, p.story, p.humor, p.surprise, p.advice, p.disagreement) : 0;
    let raw = 0.26 * densityPct[i] + 0.10 * f.specificity + 0.14 * f.stance + 0.12 * f.contrast + 0.10 * (f._lengthFit * f._cleanStart * (0.5 + 0.5 * f._general)) + 0.08 * f.explain + 0.08 * narrSmooth[i] + 0.04 * f.question + 0.08 * f.surprise;
    let total = 0.9;
    if (p) { raw += 0.22 * protoMax; total += 0.22; }
    raw = raw / total * 1.7;
    if (u.words < 4) raw *= u.words / 4;
    raw *= clamp(contentTokens(u.text).length / 4);   // a line with almost no content words cannot be significant
    raw *= 1 - 0.5 * f.filler;
    return clamp(raw);
  });
  const pct = percentileRanks(sigs);
  units.forEach((u, i) => { u.sig = Math.round(sigs[i] * 1000) / 1000; u.pct = Math.round(pct[i] * 1000) / 1000; u.features = feats[i]; u.proto = proto?.[i] || null; u.narrSmooth = narrSmooth[i]; });

  // Topics.
  const bounds = vecs ? topicBoundaries(vecs) : [];
  let topic = 0, bi = 0;
  units.forEach((u, i) => { if (bi < bounds.length && bounds[bi].i === i) { topic++; bi++; } u.topic = topic; });
  info.boundaries = bounds.map((b) => ({ unit: b.i, t: units[b.i].t, strength: clamp(b.d * 2), sim: b.sim }));
  info.topics = Array.from({ length: topic + 1 }, (_, k) => { const us = units.filter((u) => u.topic === k); return { index: k, start: us[0].t, end: us[us.length - 1].end, from: us[0].i, to: us[us.length - 1].i }; });

  // Events, from the units that carry the most for this recording.
  const events = [];
  const label = (u, i) => {
    const f = u.features, p = u.proto, cues = [];
    if (f.stance >= 0.5) cues.push("takes a clear stance");
    if (f.contrast >= 0.7) cues.push("sets up a contrast");
    if (f.explain >= 0.6) cues.push("explains a reason");
    if (f.specificity >= 0.5) cues.push("gives specifics");
    if (f.surprise >= 0.5) cues.push("sounds surprised");
    if (u.pct >= 0.9 && u.sig >= 0.22) cues.push("carries unusually distinctive content for this recording");
    if (p?.opinion >= 0.5) cues.push("reads as an opinion");
    if (p?.insight >= 0.5) cues.push("reads as an insight");
    if (p?.humor >= 0.5) cues.push("reads as humour");
    let type = "statement";
    if (f.laughText || p?.humor >= 0.6) type = "humor";
    else if (f.surprise >= 0.6 || p?.surprise >= 0.65) type = "surprise";
    else if (f.stance >= 0.5 && (f.contrast >= 0.7 || p?.opinion >= 0.5 || f._general)) type = "opinion";
    else if ((p?.insight ?? 0) >= 0.55 || (f.explain >= 0.6 && f.contrast >= 0.7)) type = "insight";
    else if (f.explain >= 0.6) type = "explanation";
    else if (f._lengthFit * f._cleanStart >= 1 && f.densityRaw > 0 && u.pct >= 0.7 && (f.contrast >= 0.7 || f._general)) type = "quotable";
    else if (p?.advice >= 0.6) type = "advice";
    return { type, cues };
  };
  const cutoff = Math.max(0.18, percentileValue(sigs, 0.72));
  units.forEach((u, i) => {
    if (u.sig < cutoff) return;
    const { type, cues } = label(u, i);
    events.push({ type, t: u.t, end: u.end, strength: u.sig, speaker: u.speaker, unit: i, data: { cues, text: u.text } });
  });
  // Quotable lines are reported regardless of rank when they are clean and complete.
  units.forEach((u, i) => { const f = u.features; if (!events.some((e) => e.unit === i) && f._lengthFit * f._cleanStart >= 1 && u.pct >= 0.6 && (f.contrast >= 0.7 || f._general) && f.question === 0) events.push({ type: "quotable", t: u.t, end: u.end, strength: clamp(u.sig * 0.9), speaker: u.speaker, unit: i, data: { cues: ["a short, complete line that stands alone"], text: u.text } }); });

  // Stories: a run of narrative sentences, with its resolution.
  for (let i = 0; i < units.length;) {
    if (narrSmooth[i] >= 0.5 && feats[i].narrative >= 0.3) {
      let j = i; while (j + 1 < units.length && narrSmooth[j + 1] >= 0.42 && units[j + 1].t - units[j].end < 4) j++;
      if (j - i >= 3) {
        let end = j, resolved = false;
        for (let k = j; k <= Math.min(units.length - 1, j + 2); k++) if (feats[k].resolution) { end = k; resolved = true; break; }
        const strength = clamp(0.35 + (narrSmooth.slice(i, j + 1).reduce((a, b) => a + b, 0) / (j - i + 1)) * 0.5 + (resolved ? 0.15 : 0));
        events.push({ type: "story", t: units[i].t, end: units[end].end, strength, speaker: units[i].speaker, unit: i, data: { cues: ["time-ordered, first-person account", resolved ? "closes with a resolution" : "builds without a clear resolution"], resolved, from: i, to: end, text: units[i].text } });
        i = end + 1; continue;
      }
    }
    i++;
  }

  // Questions and their answers.
  for (let i = 0; i < units.length; i++) {
    if (!feats[i].question) continue;
    let j = i; while (j + 1 < units.length && j - i < 3 && !feats[j + 1].question && units[j + 1].t - units[j].end < 6 && (j === i || units[j + 1].speaker === units[i + 1].speaker)) j++;
    if (j === i) continue;
    const answerSig = units.slice(i + 1, j + 1).reduce((s, u) => s + u.sig, 0) / (j - i);
    const asked = units[i].speaker, answered = units[i + 1].speaker;
    const crossSpeaker = Boolean(asked && answered && asked !== answered);
    events.push({ type: "question-answer", t: units[i].t, end: units[j].end, strength: clamp(0.25 + answerSig * 0.9 + (crossSpeaker ? 0.1 : -0.05)), speaker: answered, unit: i, data: { cues: [crossSpeaker ? "a question and the other person's answer" : "a question the speaker answers themselves"], crossSpeaker, from: i, to: j, text: units[i].text } });
  }
  info.events = events.sort((a, b) => a.t - b.t);
  info.stats.cutoff = cutoff;
  onProgress?.(1);
  return info;
}

export function percentileValue(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}
