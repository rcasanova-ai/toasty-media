#!/usr/bin/env node
// The engine around the media: automatic transcription, failure of each optional model, cancellation, progress, and that the
// whole thing can run with injected pieces (so another product can reuse it with its own capture and consent).
import { analyzeRecording } from "../js/behavior/engine.js";
import { resetModelCache } from "../js/behavior/embeddings.js";
import { voicedPcm, plainTranscript, visualSamples, SR } from "./lib/behavior-fixtures.mjs";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };
const blob = { size: 1000 };
const pcm = voicedPcm([{ t0: 1, t1: 228, db: -28 }], 230);
const transcript = plainTranscript();
const base = (extra = {}) => ({ blob, id: "t", knownDuration: 230, options: { embedder: { disableModel: true }, worker: false }, deps: { decodeAudio: async () => ({ samples: pcm, duration: 230 }), transcribe: async () => transcript, sampleVideo: async () => ({ samples: visualSamples(230, [{ t: 78, kind: "smile" }], { step: 1 }), caps: { face: true, motion: true }, notes: [] }), ...extra.deps }, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "deps")) });

console.log("\nExisting video with no transcript: transcribe, then analyse");
{
  const stages = [];
  let transcribed = 0;
  const r = await analyzeRecording(base({ deps: { transcribe: async (p, o) => { transcribed++; o.onProgress?.(1); return transcript; } }, onProgress: (p) => stages.push(p.stage) }));
  ok(transcribed === 1, "a recording with no transcript is transcribed automatically");
  ok(r.engine.transcript.startsWith("whisper") && r.timeline.has("transcript"), "the transcript source is recorded");
  ok(r.lines.length === 30, "the transcribed lines come back (30 segments) so they can be cached");
  ok(r.clips.length >= 4, `and the 30 plain segments produce ${r.clips.length} clips`);
  ok(["audio", "transcript", "picture", "voice", "language", "interaction", "moments"].every((s) => stages.includes(s)), "progress is reported for every stage");
  ok(r.timeline.has("audio") && r.timeline.has("face") && r.timeline.has("motion"), "voice and picture were analysed on the same timeline");
  const given = await analyzeRecording(base({ lines: transcript, deps: { transcribe: async () => { throw new Error("must not run"); } } }));
  ok(given.clips.length >= 4 && given.engine.transcript === "provided", "a provided transcript is used and Whisper is not run");
}

console.log("\nFailed model downloads");
{
  const r = await analyzeRecording(base({ deps: { transcribe: async () => { throw new Error("Failed to fetch https://huggingface.co/Xenova/whisper-tiny.en"); } } }));
  ok(r.clips.length >= 1 && r.engine.transcript === "none" && r.notes.some((n) => /Transcription was unavailable/.test(n) && /voice and picture only/.test(n)), "a failed speech model download falls back to voice and picture, and says so");
  ok(r.clips.every((c) => c.tier !== "high") && r.clips.every((c) => /No transcript was available|Nothing in this recording/.test(c.explanation)), "and confidence reflects the missing words");

  resetModelCache();
  const r2 = await analyzeRecording(base({ options: { embedder: { importer: async () => { throw new Error("offline"); } }, worker: false } }));
  ok(r2.engine.semantic === "lexical" && r2.notes.some((n) => /language model could not be loaded/.test(n)) && r2.clips.length >= 4, "a failed language model download falls back to lexical analysis, declared in the notes");

  const r3 = await analyzeRecording(base({ deps: { sampleVideo: async () => { throw new Error("tracker blocked"); } } }));
  ok(r3.notes.some((n) => /picture could not be analysed/.test(n)) && r3.clips.length >= 4 && !r3.timeline.has("face"), "a failed picture analysis does not stop the rest");

  const r4 = await analyzeRecording(base({ deps: { decodeAudio: async () => { throw new Error("Unable to decode audio data"); } }, lines: transcript }));
  ok(r4.clips.length >= 4 && r4.notes.some((n) => /decode/i.test(n)) && !r4.timeline.has("audio"), "undecodable audio still allows transcript analysis");

  const r5 = await analyzeRecording(base({ options: { visual: false, transcribe: false, embedder: { disableModel: true }, worker: false }, lines: [] }));
  ok(r5.clips.length >= 1 && !r5.timeline.has("transcript") && !r5.timeline.has("face"), "with models and picture turned off, voice alone still works");
}

console.log("\nCancellation");
{
  for (const at of ["audio", "transcript", "picture", "voice", "language"]) {
    const ac = new AbortController();
    let err = null, result = null;
    try { result = await analyzeRecording(base({ signal: ac.signal, onProgress: (p) => { if (p.stage === at) ac.abort(); } })); } catch (e) { err = e; }
    ok(err?.name === "AbortError" && !result, `cancelling during "${at}" stops with AbortError and returns no half-finished result`);
  }
  const ac = new AbortController();
  let err = null;
  try { await analyzeRecording(base({ signal: ac.signal, deps: { transcribe: async (p, { signal }) => { ac.abort(); if (signal.aborted) throw new DOMException("Transcription cancelled", "AbortError"); return transcript; } } })); } catch (e) { err = e; }
  ok(err?.name === "AbortError", "a cancelled transcription is not mistaken for a failed one");
}

console.log("\nReuse");
{
  const r = await analyzeRecording(base());
  const json = JSON.parse(JSON.stringify(r.timeline.toJSON()));
  ok(json.version === 1 && Object.keys(json.tracks).length === 9 && json.tracks.transcript.length === 30, "the behavioral timeline serialises as plain JSON a different product could consume");
  ok(!/landmark|embedding|descriptor/i.test(JSON.stringify(json)), "and holds no face template");
  ok(r.engine.capabilities.face.available && r.engine.capabilities.transcript.available, "capabilities report what was analysed");
}
console.log("\nAll engine checks passed.");
