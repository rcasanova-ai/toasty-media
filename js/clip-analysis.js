// Batch analysis of a finished recording or an upload: decode the audio locally, find laughter / silence / loud reactions,
// merge with whatever transcript exists (the Studio's own live transcript, an imported file, or an in-browser transcription),
// and ask the clip detector for suggestions. Nothing leaves the computer.
import { detectAudioEvents } from "./audio-events.js";
import { detectClips } from "./clip-detector.js";

export const MAX_DECODE_BYTES = 700 * 1024 * 1024;

const decodeCache = new WeakMap();   // a render and the analysis of the same file decode it once

export async function decodeMono16k(blob, { AudioContextImpl = globalThis.AudioContext } = {}) {
  if (decodeCache.has(blob)) return decodeCache.get(blob);
  const result = await decodeUncached(blob, { AudioContextImpl });
  decodeCache.set(blob, result);
  return result;
}

async function decodeUncached(blob, { AudioContextImpl }) {
  if (blob.size > MAX_DECODE_BYTES) { const e = new Error("This file is too large to analyse in the browser (over 700 MB). Trim it first or import a transcript and use the suggestions from that."); e.code = "too-large"; throw e; }
  const ctx = new AudioContextImpl({ sampleRate: 16000 });
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const n = decoded.length, mono = new Float32Array(n), chs = decoded.numberOfChannels;
    for (let c = 0; c < chs; c++) { const d = decoded.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += d[i] / chs; }
    return { samples: mono, duration: decoded.duration, sampleRate: 16000 };
  } finally { try { await ctx.close(); } catch (_) {} }
}

export function suggestClips({ lines = [], events = [], duration, minScore = 45, max = 12 } = {}) {
  return detectClips({ lines, events, duration, minScore, max });
}

export async function analyzeSource(blob, { lines = [], onProgress } = {}) {
  onProgress?.("Reading the audio…");
  let decoded = null, events = [], note = "";
  try { decoded = await decodeMono16k(blob); events = detectAudioEvents(decoded.samples, decoded.sampleRate); }
  catch (error) { note = error?.message || "The audio could not be decoded, so only the transcript was used."; }
  const duration = decoded?.duration ?? (lines.length ? Math.max(...lines.map((l) => l.end ?? l.t + 3)) : 0);
  onProgress?.("Finding moments…");
  return { duration, events, pcm: decoded?.samples || null, note, clips: suggestClips({ lines, events, duration }) };
}
