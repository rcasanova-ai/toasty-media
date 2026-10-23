#!/usr/bin/env node
// Language intelligence: sentence units, significance without trigger phrases, stories, questions and answers, topic changes,
// and the declared fallback when the semantic model cannot be loaded.
import { analyzeLanguage } from "../js/behavior/language.js";
import { createEmbedder, resetModelCache } from "../js/behavior/embeddings.js";
import { splitUnits } from "../js/behavior/text.js";
import { plainTranscript } from "./lib/behavior-fixtures.mjs";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };

// A stand-in for the sentence-embedding model: hashed bag of words. It exercises the model code path (prototypes, topic drift)
// deterministically and offline. It is NOT presented as a quality measure of MiniLM.
const hashModel = () => async (texts) => texts.map((t) => { const v = new Float32Array(256); for (const w of String(t).toLowerCase().match(/[a-z']+/g) || []) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0; v[h % 256] += 1; } const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / n); });

console.log("\nSentence units");
{
  const u = splitUnits([{ t: 10, end: 20, speaker: "A", text: "First point here. Second point follows right after it. Third." }]);
  ok(u.length === 2 && u[0].t === 10 && u[u.length - 1].end === 20, "a line with several sentences is split and the time shared out; a one-word fragment joins the sentence before it");
  ok(u[0].end <= u[1].t + 0.01, "units are consecutive");
}

console.log("\nSignificance without trigger phrases");
{
  const lines = plainTranscript();
  const r = await analyzeLanguage(lines, { embedder: await createEmbedder(lines.map((l) => l.text), { disableModel: true }) });
  ok(r.units.length === 30, "30 units");
  const top = [...r.units].sort((a, b) => b.sig - a.sig).slice(0, 8).map((u) => u.text);
  ok(top.some((t) => /price|charge|lesson|reason|ego/i.test(t)), `the highest-significance lines are the substantive ones (${top.slice(0, 3).map((t) => t.slice(0, 28)).join(" | ")})`);
  const bottom = [...r.units].sort((a, b) => a.sig - b.sig).slice(0, 4).map((u) => u.text);
  ok(bottom.some((t) => /Thanks|Hiring was a different|Anyway/.test(t)), `and the lowest are pleasantries and signposts (${bottom.map((t) => t.slice(0, 24)).join(" | ")})`);
  ok(r.events.length >= 5 && r.events.every((e) => e.strength > 0 && e.data.cues), "events carry the cues that produced them");
  ok(r.events.some((e) => e.type === "story"), "the opening account is recognised as a story (time-ordered, first person, past tense)");
  const story = r.events.find((e) => e.type === "story");
  ok(story.t === 0 && story.end > 40, "and spans the whole telling");
  ok(r.semantic.kind === "lexical", "without the model, the result says it is lexical");
}

console.log("\nQuestions and answers");
{
  const r = await analyzeLanguage([
    { t: 0, end: 4, speaker: "Host", text: "What is the one thing founders get wrong about pricing in the first year?" },
    { t: 5, end: 12, speaker: "Guest", text: "They price against competitors instead of against the value they create for a customer." },
    { t: 12.5, end: 18, speaker: "Guest", text: "A customer saving ten hours a week will happily pay far more than the market rate." }], { embedder: await createEmbedder([], { disableModel: true }) });
  const qa = r.events.find((e) => e.type === "question-answer");
  ok(qa && qa.data.crossSpeaker && qa.t === 0 && qa.end >= 17, "a question and the other person's answer are one event");
}

console.log("\nTopic changes");
{
  const a = ["The oven temperature controls the crust and the crumb of every loaf.", "A hotter oven gives the loaf a thicker crust and a darker colour.", "Steam in the oven early on keeps the crust flexible while the loaf rises.", "Bread dough needs steam and a hot oven for the crust to blister.", "Our oven runs hot so every loaf gets a dark crust quickly.", "The crust of a loaf cracks when the oven steam is released.", "Crust colour in a hot oven depends on sugar in the dough."];
  const b = ["Payroll for a team in three countries is a nightmare of forms and deadlines.", "The accountant files payroll taxes every quarter in each country separately.", "Payroll deadlines differ by country so the accountant keeps a calendar.", "Taxes and payroll filings pile up when a team grows across countries.", "Our accountant handles payroll taxes and forms for the whole team.", "Country payroll rules change yearly and the accountant tracks each form.", "Filing payroll taxes late in any country brings a penalty."];
  const lines = [...a, ...b, ...a].map((text, i) => ({ t: i * 6, end: i * 6 + 5, speaker: "A", text }));
  const emb = await createEmbedder([], { loader: async () => hashModel() });
  ok(emb.kind === "minilm", "the model path is used when a model loads");
  const r = await analyzeLanguage(lines, { embedder: emb });
  ok(r.semantic.kind === "minilm", "the result says a semantic model ran");
  ok(r.boundaries.length >= 2 && r.boundaries.some((x) => Math.abs(x.unit - 7) <= 1) && r.boundaries.some((x) => Math.abs(x.unit - 14) <= 1), `topic changes are found where the subject changes (units ${r.boundaries.map((x) => x.unit).join(", ")})`);
  ok(r.topics.length === r.boundaries.length + 1 && r.units.every((u) => u.topic >= 0), "units carry their topic");
  ok(r.units.every((u) => u.proto && typeof u.proto.opinion === "number"), "with a model, each unit also carries prototype affinities (opinion, insight, story, humour, surprise)");
}

console.log("\nModel unavailable");
{
  resetModelCache();
  const emb = await createEmbedder(["hello world"], { importer: async () => { throw new Error("Failed to fetch dynamically imported module"); } });
  ok(emb.kind === "lexical" && /could not be loaded/.test(emb.note) && /shared vocabulary/.test(emb.note), "a failed download falls back to the lexical embedder and says so in plain words");
  const aborted = new AbortController(); aborted.abort();
  let threw = null; try { const e2 = await createEmbedder([], { loader: async () => hashModel(), signal: aborted.signal }); await e2.embed(["x"]); } catch (e) { threw = e; }
  ok(threw?.name === "AbortError", "cancelling stops embedding");
}
console.log("\nAll language checks passed.");
