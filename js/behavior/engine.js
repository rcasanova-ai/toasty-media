// Moxie behavioral engine: one call that turns a recording (and optionally a transcript) into a behavioral timeline and ranked,
// explained clip suggestions. Everything runs on this computer. Missing pieces degrade, they do not stop the analysis:
//   no transcript      -> Whisper in the browser, else voice and picture only (lower confidence, said so)
//   no semantic model  -> lexical topic analysis, said so
//   no faces / video   -> voice and transcript only
//   cancelled          -> AbortError, nothing half-finished is returned
import { BehaviorTimeline } from "./timeline.js";
import { analyzeLanguage } from "./language.js";
import { createEmbedder } from "./embeddings.js";
import { analyzeVocal, estimateTurns } from "./vocal.js";
import { detectVisualEvents } from "./visual.js";
import { analyzeInteraction } from "./interaction.js";
import { proposeMoments } from "./moments.js";

export const ENGINE_VERSION = 1;
const checkAbort = (signal) => { if (signal?.aborted) throw new DOMException("Analysis cancelled", "AbortError"); };

// Pure core: everything after the media has been read. Used directly by tests and by analyzeRecording().
//   lines: [{ t, end?, speaker?, text }], pcm: Float32Array (mono), visual: { samples, caps } | null
export async function analyzeTimeline({ lines = [], pcm = null, vocalRunner = analyzeVocal, sampleRate = 16000, visual = null, duration = 0, embedder = null, embedderOptions = {}, signal, onProgress, source = "upload", id = "", max = 12, transcriptSource = lines.length ? "provided" : "none" } = {}) {
  const notes = [];
  const timeline = new BehaviorTimeline({ duration, source, id });
  const stage = (name, fraction, message) => onProgress?.({ stage: name, fraction, message });

  // Voice.
  let vocal = null;
  if (pcm && pcm.length >= sampleRate * 2) {
    stage("voice", 0, "Listening to the voice…");
    vocal = await vocalRunner(pcm, sampleRate, { signal, onProgress: (p) => stage("voice", p, "Listening to the voice…") });
    timeline.duration = Math.max(timeline.duration, vocal.duration);
    timeline.setCapability("audio", true, `${vocal.events.length} vocal events against this recording's own baseline`);
    timeline.addAll("audio", vocal.events);
  } else timeline.setCapability("audio", false, pcm ? "audio too short" : "no audio could be read");
  checkAbort(signal);

  // Picture.
  if (visual?.samples?.length) {
    stage("picture", 0, "Reading movement and reactions…");
    const caps = visual.caps || {};
    const { events } = detectVisualEvents(visual.samples, caps);
    timeline.setCapability("motion", Boolean(caps.motion), caps.motion ? "frame-to-frame movement measured" : "not measured");
    timeline.setCapability("face", Boolean(caps.face), caps.face ? "faces tracked (smile, brows, mouth, head, lean)" : "no faces detected");
    timeline.setCapability("hands", Boolean(caps.hands), caps.hands ? "hands tracked" : "not tracked");
    timeline.setCapability("pose", Boolean(caps.pose), caps.pose ? "shoulders and posture tracked" : "not tracked");
    for (const e of events) timeline.add(["smile", "brow-raise", "mouth-open", "head-turn", "head-nod", "head-movement", "lean-in", "lean-back"].includes(e.type) ? "face" : ["sudden-movement", "stillness"].includes(e.type) ? "motion" : "gesture", e);
    timeline.duration = Math.max(timeline.duration, visual.samples[visual.samples.length - 1].t);
  }
  for (const n of visual?.notes || []) notes.push(n);
  checkAbort(signal);

  // Language.
  let language = { units: [], events: [], boundaries: [], topics: [], semantic: { kind: "none", note: "" } };
  const hasText = lines.some((l) => String(l.text || "").trim());
  if (hasText) {
    stage("language", 0, "Understanding what was said…");
    const corpus = lines.map((l) => l.text);
    const emb = embedder || await createEmbedder(corpus, { signal, onStatus: (m) => stage("language", 0, m), ...embedderOptions });
    if (emb.note) notes.push(emb.note);
    language = await analyzeLanguage(lines, { embedder: emb, signal, onProgress: (p) => stage("language", p, "Understanding what was said…") });
    timeline.setCapability("transcript", true, `${language.units.length} sentences from ${transcriptSource}`);
    for (const u of language.units) timeline.add("transcript", { type: "unit", t: u.t, end: u.end, speaker: u.speaker, strength: u.sig, data: { text: u.text, unit: u.i } });
    for (const e of language.events) timeline.add("language", { ...e, data: { ...e.data, unit: e.unit } });
    for (const b of language.boundaries) timeline.add("boundaries", { type: "topic-shift", t: b.t, strength: b.strength, data: { unit: b.unit } });
  } else timeline.setCapability("transcript", false, "no transcript");
  checkAbort(signal);

  // Who is speaking, if the transcript did not say.
  let speakerInfo = { applied: false, reason: "no transcript" };
  if (language.units.length) {
    if (vocal) speakerInfo = estimateTurns(language.units, vocal.series, vocal.baseline); else speakerInfo = { applied: false, reason: language.units.some((u) => u.speaker) ? "speaker labels were provided" : "no audio to separate voices" };
    let prev = null; language.units.forEach((u) => { if (u.speaker && u.speaker !== prev) { timeline.add("turns", { type: "turn", t: u.t, end: u.end, speaker: u.speaker, data: { estimated: Boolean(u.speakerEstimated) } }); prev = u.speaker; } });
  }
  const speakersKnown = language.units.some((u) => u.speaker);
  if (language.units.length && !speakersKnown) notes.push("Speakers are unknown, so challenges, interruptions and rapid exchanges between people were not assessed.");

  // Between people.
  stage("interaction", 0, "Looking at how people responded to each other…");
  timeline.sort();
  analyzeInteraction(timeline, language.units, { speakersKnown });
  timeline.sort();
  checkAbort(signal);

  stage("moments", 0, "Choosing and bounding the best moments…");
  const result = proposeMoments({ timeline, units: language.units, vocal, duration: timeline.duration, max });
  if (!timeline.has("transcript") && !timeline.has("audio") && !timeline.has("motion")) notes.push("There was nothing to analyse: no transcript, no readable audio and no picture.");
  stage("moments", 1, "Done");
  return {
    version: ENGINE_VERSION, timeline, clips: result.clips, fallback: result.fallback, notes,
    engine: { semantic: language.semantic.kind, transcript: transcriptSource, speakers: speakerInfo, capabilities: { ...timeline.capabilities } },
    stats: { units: language.units.length, candidates: result.candidates, duration: timeline.duration },
    // Face positions per sample (fractions of the frame, no landmarks): what the Automatic Director frames crops with.
    picture: visual?.samples?.length ? visual.samples.map((s) => ({ t: s.t, motion: s.motion, faces: (s.faces || []).map((f) => ({ x: f.x, y: f.y, size: f.size, mouthOpen: f.mouthOpen })) })) : null
  };
}

// Reads the media, then runs the core. deps are injectable so tests (and other products) can supply their own pieces:
//   decodeAudio(blob) -> { samples, duration, sampleRate }, transcribe(pcm, {signal,onStatus,onProgress}) -> lines,
//   sampleVideo(blob, opts) -> { samples, caps, notes }.
export async function analyzeRecording({ blob, lines = [], signal, onProgress, onStatus, deps = {}, options = {}, id = "", source = "upload", knownDuration = 0 } = {}) {
  const notes = [];
  const emit = (stage, fraction, message) => onProgress?.({ stage, fraction, message });
  const decodeAudio = deps.decodeAudio || (await import("../clip-analysis.js")).decodeMono16k;
  let pcm = null, duration = knownDuration || 0;
  emit("audio", 0, "Reading the audio…");
  try { const d = await decodeAudio(blob); pcm = d.samples; duration = d.duration || duration; }
  catch (error) { if (error?.name === "AbortError") throw error; notes.push(error?.message || "The audio could not be read."); }
  checkAbort(signal);

  let transcriptSource = lines.length ? "provided" : "none", workLines = lines;
  if (!lines.length && pcm && options.transcribe !== false) {
    emit("transcript", 0, "Transcribing on this computer…");
    try {
      const transcribe = deps.transcribe || (await import("../clip-transcribe.js")).transcribePcm;
      workLines = await transcribe(pcm, { signal, onStatus: (m) => { onStatus?.(m); emit("transcript", 0, m); }, onProgress: (p) => emit("transcript", p, `Transcribing… ${Math.round(p * 100)}%`) });
      transcriptSource = "whisper-tiny.en (in this browser)";
      if (!workLines.length) { notes.push("The speech model found no words in this recording, so the analysis used the voice and picture only."); transcriptSource = "none"; }
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      workLines = []; transcriptSource = "none";
      notes.push(`Transcription was unavailable (${String(error?.message || error).slice(0, 120)}), so the analysis used the voice and picture only. Confidence is lower without words; import a transcript to improve it.`);
    }
  }
  checkAbort(signal);

  let visual = null;
  if (options.visual !== false) {
    emit("picture", 0, "Watching the video…");
    try {
      const sample = deps.sampleVideo || (await import("./visual.js")).sampleVideo;
      visual = await sample(blob, { duration, signal, onStatus: (m) => { onStatus?.(m); emit("picture", 0, m); }, onProgress: (p) => emit("picture", p, `Watching the video… ${Math.round(p * 100)}%`), tracker: options.tracker || "auto" });
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      notes.push(`The picture could not be analysed (${String(error?.message || error).slice(0, 100)}).`);
    }
  }
  checkAbort(signal);
  const vocalRunner = options.worker === false ? undefined : (deps.vocalRunner || (await import("./vocal-client.js")).analyzeVocalInWorker);
  const result = await analyzeTimeline({ vocalRunner, lines: workLines, pcm, visual, duration, signal, onProgress, source, id, transcriptSource, embedderOptions: options.embedder || {}, max: options.max || 12 });
  result.notes.unshift(...notes);
  result.lines = workLines;
  return result;
}
