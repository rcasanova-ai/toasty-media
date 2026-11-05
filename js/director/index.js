// The Automatic Director: from a recording and a style to a finished, measured video. This module is the engine's front door and
// has no user interface. js/make-video.js (the page) and the tests both call it.
//
//   const session = await openSession({ blob, name, analysis, onProgress })      // decode once, find where the voice is
//   const edit = await makeEdit(session, { style, aspect, instruction })           // -> { settings, plans[], reply }
//   const out = await renderEdit(session, edit, { onProgress, signal })            // -> files with measured audio
//   const next = reviseEdit(session, edit, "less zooming")                         // -> a new edit (re-render to see it)
import { buildPlan } from "./plan.js";
import { detectSpeechRegions } from "./speech.js";
import { applyInstruction } from "./revise.js";
import { tagsFromName } from "./broll.js";
import { DEFAULT_PARAMS } from "./styles.js";

export { buildPlan, describePlan } from "./plan.js";
export { STYLES, STYLE_IDS } from "./styles.js";
export { parseInstruction } from "./revise.js";

// analysis: the result of analyzeRecording() (lines, clips, timeline, picture, notes). decoded: { samples (16 kHz mono), sampleRate, duration }.
export async function openSession({ blob, name = "", analysis, decoded = null, width = 1280, height = 720, duration = 0, brollFiles = [], onProgress } = {}) {
  let dec = decoded;
  if (!dec) { const { decodeMono16k } = await import("../clip-analysis.js"); onProgress?.({ phase: "listening", message: "Finding where the voice is…" }); dec = await decodeMono16k(blob).catch(() => null); }
  const speech = dec ? detectSpeechRegions(dec.samples, dec.sampleRate) : null;
  const library = [];
  for (const f of brollFiles || []) library.push({ id: f.id || `b${library.length + 1}`, name: f.name, duration: f.duration || 0, tags: f.tags?.length ? f.tags : tagsFromName(f.name), blob: f.blob });
  return { blob, name, analysis, decoded: dec, speech, width, height, duration: duration || dec?.duration || analysis?.stats?.duration || 0, broll: library };
}

export function defaultSettings({ style = "clean", aspect = "16:9", params = {} } = {}) { return { style, aspect, params: { ...DEFAULT_PARAMS, ...params }, seed: 1 }; }

function plansFor(session, settings) {
  const common = { analysis: session.analysis, speech: session.speech, style: settings.style, aspect: settings.aspect, params: settings.params, seed: settings.seed, source: { name: session.name, duration: session.duration, width: session.width, height: session.height }, brollLibrary: session.broll.length ? session.broll : null };
  const n = settings.params.count || 1;
  if (n <= 1) return [buildPlan(common)];
  const clips = [...(session.analysis?.clips || [])].sort((a, b) => b.score - a.score), picked = [];
  for (const c of clips) if (!picked.some((p) => p.start < c.end && c.start < p.end)) picked.push(c);
  const chosen = picked.slice(0, n).sort((a, b) => a.start - b.start);
  if (!chosen.length) return [buildPlan(common)];
  return chosen.map((c, i) => buildPlan({ ...common, seed: settings.seed + i, forcedRange: { start: c.start, end: Math.min(session.duration || c.end, c.end), title: c.title, score: c.score, clipId: c.id } }));
}

// Interpret the instruction, then plan. The reply says what was done and what could not be.
export function makeEdit(session, { style = "clean", aspect = "16:9", instruction = "", params = {} } = {}) {
  let settings = defaultSettings({ style, aspect, params });
  const reply = { applied: [], unsupported: [] };
  if (instruction.trim()) { const r = applyInstruction(settings, instruction, { hasBroll: session.broll.length > 0 }); settings = r.settings; reply.applied = r.applied; reply.unsupported = r.unsupported; }
  return { settings, plans: plansFor(session, settings), reply, history: instruction.trim() ? [instruction.trim()] : [] };
}

// Revision: same recording, same seed, changed settings. An instruction that cannot be carried out changes nothing and says so.
export function reviseEdit(session, edit, instruction) {
  const r = applyInstruction(edit.settings, instruction, { hasBroll: session.broll.length > 0 });
  if (!r.changed) return { ...edit, reply: { applied: [], unsupported: r.unsupported }, unchanged: true };
  return { settings: r.settings, plans: plansFor(session, r.settings), reply: { applied: r.applied, unsupported: r.unsupported }, history: [...(edit.history || []), instruction.trim()] };
}

export async function renderEdit(session, edit, { onProgress, signal, logo = null, verifyAudio = true } = {}) {
  const { renderDirected } = await import("./render.js");
  const brollFiles = Object.fromEntries(session.broll.filter((b) => b.blob).map((b) => [b.id, b.blob]));
  const results = [];
  for (let i = 0; i < edit.plans.length; i++) {
    if (signal?.aborted) break;
    const plan = edit.plans[i];
    const r = await renderDirected({ source: session.blob, plan, decoded: session.decoded, logo, verifyAudio, brollFiles, signal, onProgress: (p) => onProgress?.({ index: i, count: edit.plans.length, plan, ...p }) });
    results.push({ plan, ...r });
  }
  return results;
}
