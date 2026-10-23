// Text helpers shared by the language analysis: sentence units with timing, tokens, and a local lexical embedder.
const STOP = new Set("a an and are as at be been but by can could did do does for from had has have he her his i if in into is it its just me my not of on or our she so than that the their them then there they this to too up us was we were what when which who will with would you your am about all also any because been being both each few more most other over same some such only own out very yeah okay um uh like really alright sure thanks thank anyway hello welcome mm hmm hm yes let go going get got well now".split(" "));

export const wordCount = (s) => (String(s || "").trim().match(/\S+/g) || []).length;
export const tokens = (s) => (String(s || "").toLowerCase().match(/[a-z0-9']+/g) || []).map((w) => w.replace(/^'+|'+$/g, "")).filter(Boolean);
export const contentTokens = (s) => tokens(s).filter((w) => w.length > 2 && !STOP.has(w));
export const isStop = (w) => STOP.has(w);

// Lines [{ t, end?, speaker?, text }] -> sentence units [{ i, t, end, speaker, text, words, lineIndex }].
// A line holding several sentences is split and its time is shared out by word count; one-or-two-word fragments join the
// previous unit when it is the same speaker and follows closely, so "Right." does not become a unit of its own.
export function splitUnits(lines) {
  const units = [];
  const sorted = [...lines].filter((l) => l && Number.isFinite(l.t) && String(l.text || "").trim()).sort((a, b) => a.t - b.t);
  sorted.forEach((line, lineIndex) => {
    const text = String(line.text).replace(/\s+/g, " ").trim();
    const parts = text.split(/(?<=[.!?…])["')\]]?\s+(?=["'(\[]?[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
    const end = Number.isFinite(line.end) && line.end > line.t ? line.end : line.t + Math.max(1.5, wordCount(text) * 0.38);
    const total = parts.reduce((s, p) => s + Math.max(1, wordCount(p)), 0);
    let cursor = line.t;
    for (const p of parts) {
      const span = (end - line.t) * Math.max(1, wordCount(p)) / total;
      const prev = units[units.length - 1];
      if (wordCount(p) <= 2 && prev && prev.speaker === (line.speaker || "") && cursor - prev.end < 1.2) { prev.text += " " + p; prev.end = cursor + span; prev.words = wordCount(prev.text); }
      else units.push({ i: 0, t: cursor, end: cursor + span, speaker: line.speaker || "", text: p, words: wordCount(p), lineIndex });
      cursor += span;
    }
  });
  units.forEach((u, i) => { u.i = i; u.t = Math.round(u.t * 100) / 100; u.end = Math.round(u.end * 100) / 100; });
  return units;
}

export function cosine(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
export function meanVector(vectors, from, to) {
  const n = vectors[0]?.length || 0, out = new Float32Array(n);
  const lo = Math.max(0, from), hi = Math.min(vectors.length, to);
  for (let k = lo; k < hi; k++) for (let i = 0; i < n; i++) out[i] += vectors[k][i];
  let norm = 0; for (let i = 0; i < n; i++) norm += out[i] * out[i];
  norm = Math.sqrt(norm) || 1; for (let i = 0; i < n; i++) out[i] /= norm;
  return out;
}

// Document frequencies over the units of THIS recording, so "rare" means rare here (a niche term is information; "thing" is not).
export function buildIdf(texts) {
  const df = new Map();
  for (const t of texts) for (const w of new Set(contentTokens(t))) df.set(w, (df.get(w) || 0) + 1);
  const N = texts.length;
  return { N, idf: (w) => Math.log((N + 1) / ((df.get(w) || 0) + 1)) + 1, df };
}

// Local lexical embedder: hashed unigram + bigram TF-IDF vectors. It measures shared vocabulary, NOT meaning, and is only
// used for topic segmentation when the semantic model cannot be loaded. The engine reports which one ran.
export function lexicalEmbedder(corpus = []) {
  const DIM = 768;
  const { idf } = buildIdf(corpus);
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) % DIM; };
  return {
    kind: "lexical",
    async embed(texts) {
      return texts.map((t) => {
        const v = new Float32Array(DIM), w = contentTokens(t);
        w.forEach((tok, i) => { v[hash(tok)] += idf(tok); if (i > 0) v[hash(w[i - 1] + "_" + tok)] += 0.5 * Math.min(idf(tok), idf(w[i - 1])); });
        let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i];
        n = Math.sqrt(n) || 1; for (let i = 0; i < DIM; i++) v[i] /= n;
        return v;
      });
    }
  };
}
