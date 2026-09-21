// Hottie Program Audio voice.
// V1 uses the browser Speech Synthesis API (free, already in the page). The provider boundary is
// the only place a later ElevenLabs (or other) TTS implementation should plug in.

import { ResponseAudience } from "./hottie-action.js";

export const HottieVoiceMode = Object.freeze({
  TEXT_ONLY: "TEXT_ONLY",
  PRIVATE_HOST_AUDIO: "PRIVATE_HOST_AUDIO",
  PROGRAM_AUDIO: "PROGRAM_AUDIO"
});

export const HottieTtsProviderId = Object.freeze({
  BROWSER_SPEECH: "browser-speech",
  TEXT_ONLY: "text-only"
});

const HOTTIE_VOICE_SOURCE = "hottie-voice";
let utteranceSeq = 0;

function nextUtteranceId() {
  utteranceSeq += 1;
  return `hvoice-${Date.now().toString(36)}-${utteranceSeq.toString(36)}`;
}

export function conciseSpokenText(text, limit = 220) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  if (raw.length <= limit) return raw;
  const cut = raw.slice(0, limit - 1);
  const atSentence = cut.match(/^(.*[.!?])\s/);
  if (atSentence?.[1] && atSentence[1].length >= 60) return atSentence[1];
  const atWord = cut.lastIndexOf(" ");
  return `${(atWord > 40 ? cut.slice(0, atWord) : cut).trim()}…`;
}

export function serializeHottieVoice(plan = null) {
  if (!plan || !plan.speak || !plan.text) return null;
  return {
    utteranceId: plan.utteranceId,
    text: conciseSpokenText(plan.text),
    speak: true,
    source: HOTTIE_VOICE_SOURCE,
    provider: plan.provider || HottieTtsProviderId.BROWSER_SPEECH,
    speaker: "Hottie",
    mode: HottieVoiceMode.PROGRAM_AUDIO,
    startedAt: plan.startedAt || Date.now()
  };
}

export function createHottieVoicePlan({
  mode,
  text = "",
  requestedBy = "host",
  responseAudience = ResponseAudience.PRIVATE_PRODUCER,
  provider
} = {}) {
  const audience = Object.values(ResponseAudience).includes(responseAudience)
    ? responseAudience
    : ResponseAudience.PRIVATE_PRODUCER;
  const speak = audience === ResponseAudience.PROGRAM && Boolean(String(text || "").trim());
  const allowedMode = speak
    ? HottieVoiceMode.PROGRAM_AUDIO
    : (Object.values(HottieVoiceMode).includes(mode) ? mode : HottieVoiceMode.TEXT_ONLY);
  const spoken = conciseSpokenText(text);
  return {
    mode: allowedMode,
    responseAudience: audience,
    text: spoken,
    requestedBy,
    speak,
    utteranceId: speak ? nextUtteranceId() : null,
    source: HOTTIE_VOICE_SOURCE,
    speaker: "Hottie",
    provider: provider || (speak ? HottieTtsProviderId.BROWSER_SPEECH : HottieTtsProviderId.TEXT_ONLY),
    startedAt: speak ? Date.now() : null,
    reason: speak
      ? "Host asked Hottie publicly; answer goes out on Program Audio."
      : "Private crew/producer copy. Not spoken on Program Audio."
  };
}

export function shouldSpeakOnProgram(utterance, responseAudience = null) {
  if (responseAudience === ResponseAudience.PROGRAM) return true;
  if (responseAudience && responseAudience !== ResponseAudience.PROGRAM) return false;
  return /\b(tell (everyone|the audience|them)|say it (out loud|on (air|program))|announce)\b/i.test(String(utterance || ""));
}

export function isHottieSelfEcho(line, { speaking = false, lastSpoken = "", lastHeardCommand = "", spokenAt = 0, now = Date.now() } = {}) {
  if (!line) return false;
  if (line.source === HOTTIE_VOICE_SOURCE || line.participantId === "hottie") return true;
  if (/^hottie$/i.test(String(line.speaker || ""))) return true;
  const heard = String(line.text || "").trim().toLowerCase();
  if (!heard) return false;
  const spoken = String(lastSpoken || "").trim().toLowerCase();
  const command = String(lastHeardCommand || "").trim().toLowerCase();
  const recent = now - Number(spokenAt || 0) < 8000;
  if (speaking && command && heard === command) return true;
  if (!spoken || !recent) return false;
  if (heard === spoken || spoken.includes(heard) || heard.includes(spoken.slice(0, Math.min(80, spoken.length)))) {
    return true;
  }
  return false;
}

export class TextOnlyTtsProvider {
  constructor() {
    this.id = HottieTtsProviderId.TEXT_ONLY;
    this.speaking = false;
    this._currentId = null;
  }

  speak(text, { utteranceId, onstart, onend } = {}) {
    this.cancel();
    this.speaking = false;
    this._currentId = utteranceId || null;
    onstart?.({ utteranceId: this._currentId, text: conciseSpokenText(text), provider: this.id });
    onend?.({ utteranceId: this._currentId, skipped: true });
    this._currentId = null;
    return { ok: true, spoken: false, provider: this.id };
  }

  cancel() {
    this.speaking = false;
    this._currentId = null;
  }
}

export class BrowserSpeechTtsProvider {
  static isSupported() {
    return typeof window !== "undefined" && typeof window.speechSynthesis !== "undefined" && typeof window.SpeechSynthesisUtterance === "function";
  }

  constructor() {
    this.id = HottieTtsProviderId.BROWSER_SPEECH;
    this.speaking = false;
    this._currentId = null;
    this._utterance = null;
  }

  speak(text, { utteranceId, onstart, onend, onerror } = {}) {
    const spoken = conciseSpokenText(text);
    if (!spoken) return { ok: false, reason: "empty" };
    if (!BrowserSpeechTtsProvider.isSupported()) {
      return new TextOnlyTtsProvider().speak(spoken, { utteranceId, onstart, onend });
    }
    this.cancel();
    const synth = window.speechSynthesis;
    const utterance = new window.SpeechSynthesisUtterance(spoken);
    utterance.rate = 1.04;
    utterance.pitch = 1;
    utterance.lang = "en-US";
    this._utterance = utterance;
    this._currentId = utteranceId || nextUtteranceId();
    utterance.addEventListener("start", () => {
      this.speaking = true;
      onstart?.({ utteranceId: this._currentId, text: spoken, provider: this.id });
    });
    utterance.addEventListener("end", () => {
      if (this._utterance !== utterance) return;
      this.speaking = false;
      this._utterance = null;
      onend?.({ utteranceId: this._currentId });
      this._currentId = null;
    });
    utterance.addEventListener("error", (event) => {
      if (this._utterance !== utterance) return;
      this.speaking = false;
      this._utterance = null;
      onerror?.({ utteranceId: this._currentId, error: event?.error });
      this._currentId = null;
    });
    synth.speak(utterance);
    return { ok: true, spoken: true, provider: this.id, utteranceId: this._currentId };
  }

  cancel() {
    this.speaking = false;
    this._utterance = null;
    this._currentId = null;
    if (typeof window !== "undefined") window.speechSynthesis?.cancel?.();
  }
}

export function createHottieTtsProvider() {
  if (BrowserSpeechTtsProvider.isSupported()) return new BrowserSpeechTtsProvider();
  return new TextOnlyTtsProvider();
}

let programTts = null;

export function speakHottieVoiceOnProgram(voice) {
  if (!voice?.speak || !voice.text) return { ok: false, reason: "silent" };
  if (!programTts) programTts = createHottieTtsProvider();
  if (programTts.speaking) programTts.cancel();
  return programTts.speak(voice.text, { utteranceId: voice.utteranceId });
}

export function cancelHottieVoice() {
  programTts?.cancel?.();
}

export { HOTTIE_VOICE_SOURCE };
