// Deterministic Host-directive recognition. Transcript-level, not audio wake-word DSP.
// Only HOST speech addressed TO Hottie (or legacy "Toasty") becomes a production command.
// A guest saying "Hottie is interesting" is conversation, never a directive.
//
// Routing (intent family + payload) is string matching, not an LLM. Downstream actions
// are NOT executed here — this module only recognizes and structures.

import { HottieIntent, ActionRiskLevel, ResponseAudience, riskForIntent } from "./hottie-action.js";

export const DEFAULT_WAKE_WORD = "hottie";
export const WAKE_WORDS = Object.freeze(["hottie", "toasty"]);

export const DirectiveIntent = Object.freeze({
  FIND: "find",
  RECALL: "recall",
  UNCOVERED: "uncovered",
  QUIET: "quiet",
  AUDIENCE: "audience",
  SET_LAYOUT: "set_layout",
  SET_SPOTLIGHT: "set_spotlight",
  CLEAR_SPOTLIGHT: "clear_spotlight",
  SET_ACTIVE_SPEAKER_MODE: "set_active_speaker_mode",
  SET_SHARE_LAYOUT: "set_share_layout",
  STOP_SHARE: "stop_share",
  TAKE_ASSET: "take_asset",
  REMOVE_ASSET: "remove_asset",
  PLAY_AUDIO: "play_audio",
  FACT_CHECK: "fact_check",
  CLIP: "clip",
  MARK: "mark",
  CHANGE_SCENE: "change_scene",
  READ_CHAT: "read_chat",
  RESPOND_CHAT: "respond_chat",
  ANSWER: "answer",
  CREW: "crew",
  END_SHOW: "end_show",
  RECORDING: "recording",
  GENERIC: "generic"
});

export const HottieStatus = Object.freeze({
  LISTENING: "listening",
  HEARD: "heard",
  THINKING: "thinking",
  SEARCHING: "searching",
  RESEARCHING: "researching",
  FOUND: "found",
  PREPARING: "preparing",
  READY: "ready",
  AWAITING_APPROVAL: "awaiting-approval",
  TAKING_LIVE: "taking-live",
  ON_AIR: "on-air",
  SPEAKING: "speaking",
  DONE: "done",
  NEEDS_CLARIFICATION: "needs-clarification",
  ERROR: "error"
});

export const DirectiveStatus = Object.freeze({
  RECOGNIZED: "recognized",
  QUEUED: "queued",
  COMPLETED: "completed",
  DISMISSED: "dismissed"
});

const ADDRESS_VERBS = "find|look|search|get|show|bring|pull|remind|what|who|tell|ask|put|spotlight|keep|follow|make|take|remove|play|give|back|switch|return|clip|mark|save|check|fact|go|end|define|explain|read|respond|start|stop";

let uid = 0;
function nextId() { return `dir-${Date.now().toString(36)}-${(uid++).toString(36)}`; }

export function isHostSpeaker(line) {
  return line?.role === "host" || line?.participantId === "host";
}

function foldText(text) {
  return String(text || "").trim().replace(/[’‘]/g, "'");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractAddressedCommand(text, wakeWord = DEFAULT_WAKE_WORD) {
  const raw = foldText(text);
  if (!raw) return null;
  const words = Array.isArray(wakeWord) ? wakeWord : [wakeWord, ...WAKE_WORDS.filter((item) => item !== wakeWord)];
  for (const word of words) {
    const wake = escapeRegExp(word);
    const addressed = new RegExp(
      `^(?:hey\\s+)?${wake}\\s*[,:—\\-]\\s*(.+)$|^((?:hey\\s+)?${wake})\\s+(${ADDRESS_VERBS})\\b([\\s\\S]*)$`,
      "i"
    );
    const match = raw.match(addressed);
    if (!match) continue;
    if (match[1]) return { wakeWord: word, rest: match[1].trim() };
    const verb = (match[3] || "").trim();
    const tail = (match[4] || "").trim();
    return { wakeWord: word, rest: `${verb} ${tail}`.trim() };
  }
  return null;
}

export function commandBody(text) {
  return foldText(text).replace(/^(?:hey\s+)?(hottie|toasty)\s*[,:—\-]?\s*/i, "").trim();
}

export function wantsProgramVisual(utterance) {
  const text = commandBody(utterance).toLowerCase();
  if (!text) return false;
  if (/\btake (it|that) live\b/.test(text) || /\bput it (?:on|up)(?:\s+live)?\b/.test(text)) return false;
  if (/\b(on screen|on program)\b/.test(text)) return true;
  if (/\bpull(\s+\w+){0,8}\s+up\b/.test(text)) return true;
  if (/\b(show|put|bring|display)\b.{0,50}\b(photo|picture|image|article|graphic|card)\b/.test(text)) return true;
  if (/\bput this audience question on screen\b/.test(text)) return true;
  return false;
}

export function wantsAssetPrep(utterance) {
  const text = commandBody(utterance).toLowerCase();
  if (!text || wantsProgramVisual(text)) return false;
  return /\b(get (it|that) ready|get (it|that) prepared|prepare it|find (me )?(an? )?(article|source|clip))\b/.test(text)
    || /^(find|look\s*up|search)\b/.test(text);
}

export function isConversationalQuestion(utterance) {
  const text = commandBody(utterance).toLowerCase();
  if (!text) return false;
  if (wantsProgramVisual(text)) return false;
  if (/\b(get (it|that) ready|clip that|mark that|end the show)\b/.test(text)) return false;
  if (/\b(post|reply) (that |this )?(to|in) (the )?chat\b/.test(text)) return false;
  return /^(who|what|when|where|why|how|is|are|was|were|did|does|do)\b/.test(text)
    || /\?$/.test(text)
    || /\bremind (everyone|us|the (room|audience))\b/.test(text)
    || /\bwhat (does|is|are) (the )?(chat|people in chat|audience)\b/.test(text)
    || /\banswer\b.{0,40}\bquestion\b/.test(text)
    || /\btell everyone\b/.test(text);
}

export function inferResponseAudience(utterance, { intent } = {}) {
  const text = commandBody(utterance).toLowerCase();
  if (/\bdon'?t say (this|that|it) on air\b/.test(text) || /\bnot on (air|program)\b/.test(text) || /\boff the air\b/.test(text)) {
    return ResponseAudience.PRIVATE_CREW;
  }
  if (/\bprivately\b/.test(text) || /\btell me privately\b/.test(text) || /\bjust (tell|between) me\b/.test(text) || /\bin my ear\b/.test(text)) {
    return ResponseAudience.PRIVATE_HOST;
  }
  if (/\btell the producer\b/.test(text) || /\bfor the producer\b/.test(text)) {
    return ResponseAudience.PRIVATE_PRODUCER;
  }
  if (/\btell (everyone|the (room|audience)|them)\b/.test(text) || /\bsay it (out loud|on (air|program))\b/.test(text) || /\bannounce\b/.test(text)) {
    return ResponseAudience.PROGRAM;
  }
  if (intent === DirectiveIntent.CLIP || intent === DirectiveIntent.MARK) return ResponseAudience.NONE;
  if (intent === DirectiveIntent.RESPOND_CHAT) return ResponseAudience.PRIVATE_PRODUCER;
  if (intent === DirectiveIntent.END_SHOW || intent === DirectiveIntent.RECORDING || intent === DirectiveIntent.CHANGE_SCENE) {
    return ResponseAudience.PRIVATE_PRODUCER;
  }
  if (wantsProgramVisual(text) || wantsAssetPrep(text)) return ResponseAudience.PRIVATE_PRODUCER;
  if (intent === DirectiveIntent.CREW || /\b(which camera|what camera|camera should we)\b/.test(text)) {
    return ResponseAudience.PRIVATE_HOST;
  }
  if (
    intent === DirectiveIntent.SET_SPOTLIGHT
    || intent === DirectiveIntent.CLEAR_SPOTLIGHT
    || intent === DirectiveIntent.SET_LAYOUT
    || intent === DirectiveIntent.SET_ACTIVE_SPEAKER_MODE
    || intent === DirectiveIntent.SET_SHARE_LAYOUT
    || intent === DirectiveIntent.STOP_SHARE
    || intent === DirectiveIntent.PLAY_AUDIO
    || intent === DirectiveIntent.TAKE_ASSET
    || intent === DirectiveIntent.REMOVE_ASSET
  ) {
    return ResponseAudience.PRIVATE_HOST;
  }
  if (
    intent === DirectiveIntent.ANSWER
    || intent === DirectiveIntent.FACT_CHECK
    || intent === DirectiveIntent.RECALL
    || intent === DirectiveIntent.AUDIENCE
    || intent === DirectiveIntent.READ_CHAT
  ) {
    return ResponseAudience.PROGRAM;
  }
  if (isConversationalQuestion(text)) return ResponseAudience.PROGRAM;
  return ResponseAudience.PRIVATE_PRODUCER;
}

export function classifyDirectiveIntent(rest) {
  const text = foldText(rest).toLowerCase();
  if (/\b(end (the )?show|kill the stream|disconnect everyone)\b/.test(text)) return DirectiveIntent.END_SHOW;
  if (/\b(start recording|stop recording|record (this|that)|stop the recording)\b/.test(text)) return DirectiveIntent.RECORDING;
  if (/\bfact[-\s]?check\b/.test(text) || /\bis (that|what) .{0,80}(actually )?(true|right|accurate)\b/.test(text) || /\bcheck if that'?s actually true\b/.test(text)) {
    return DirectiveIntent.FACT_CHECK;
  }
  if (/\b(clip that|clip this|save the last|mark that|mark this|mark the last|mark a moment)\b/.test(text)) {
    return /\bclip\b/.test(text) || /\bsave the last\b/.test(text) ? DirectiveIntent.CLIP : DirectiveIntent.MARK;
  }
  if (/\b(go to|switch to|take us to|put us on)\b/.test(text) && /\b(brb|holding|starting soon|live|ending|technical)\b/.test(text)) {
    return DirectiveIntent.CHANGE_SCENE;
  }
  if (wantsProgramVisual(text)) return DirectiveIntent.FIND;
  if (/\b(post|reply) (that |this )?(to|in) (the )?chat\b/.test(text) || /\brespond (to|in) (the )?chat\b/.test(text)) {
    return DirectiveIntent.RESPOND_CHAT;
  }
  if (
    /\b(read (the )?chat|from chat|audience question|from the audience|people in chat|what (does|is|are) (the )?chat|what chat is saying|what (is|are) (the )?people in chat|chat (is )?(saying|think)|answer .{0,40}question)\b/.test(text)
  ) {
    return DirectiveIntent.AUDIENCE;
  }
  if (/remind (me|everyone|us)|what did .+ say|said about|what did we say|what was the name|ten minutes ago|what you found/.test(text)) {
    return DirectiveIntent.RECALL;
  }
  if (/who hasn'?t|who have we not heard|not heard from|hasn'?t answered|have not answered/.test(text)) return DirectiveIntent.QUIET;
  if (/haven'?t covered|have not covered|what haven'?t we|missed anything|what are we missing/.test(text)) return DirectiveIntent.UNCOVERED;
  if (/\b(take it live|take that live|take it on(?:\s+air)?|put it (?:on|up)(?:\s+live)?)\b/.test(text)) return DirectiveIntent.TAKE_ASSET;
  if (/\b(remove that|take that off|get that off|clear the (?:card|article|asset))\b/.test(text)) return DirectiveIntent.REMOVE_ASSET;
  if (/\b(drum roll|rimshot|applause|sting|stinger|whistle|whoosh)\b/.test(text) || /^(play|give me|hit me with|cue)\b/.test(text)) {
    return DirectiveIntent.PLAY_AUDIO;
  }
  if (/\b(back to us|return to guests|stop shar|end shar|screens? off)\b/.test(text)) return DirectiveIntent.STOP_SHARE;
  if (/\b(screen full|full screen|screens? only|make the screen full)\b/.test(text)) return DirectiveIntent.SET_SHARE_LAYOUT;
  if (/\b(along the bottom|participant strip|keep everyone along)\b/.test(text)) return DirectiveIntent.SET_SHARE_LAYOUT;
  if (/\b(my screen|the screen|this screen|bring .+ screen|show screen)\b/.test(text)) return DirectiveIntent.SET_SHARE_LAYOUT;
  if (/\b(follow whoever is talking|active speaker|whoever is talking|follow the speaker)\b/.test(text)) {
    return DirectiveIntent.SET_ACTIVE_SPEAKER_MODE;
  }
  if (/\b(back to everyone|everyone the same size|same size|switch to balanced|keep everyone the same|balanced)\b/.test(text)) {
    return DirectiveIntent.CLEAR_SPOTLIGHT;
  }
  if (/\b(spotlight|up big|make .+ big|put .+ (?:up|on) (?:big|large)|bring .+ full screen)\b/.test(text)) {
    return DirectiveIntent.SET_SPOTLIGHT;
  }
  if (/\b(which camera|what camera|camera should we)\b/.test(text)) return DirectiveIntent.CREW;
  if (wantsProgramVisual(text) || wantsAssetPrep(text) || /^(find|look\s*up|look\s+(that|it|this)\s+up|search|get|show|bring|pull(\s+up)?)\b/.test(text) || /\b(article|source|clip|image|picture|photo|chart|document|repo|github)\b/.test(text)) {
    return DirectiveIntent.FIND;
  }
  if (isConversationalQuestion(text)) return DirectiveIntent.ANSWER;
  return DirectiveIntent.GENERIC;
}

export function hottieIntentFromDirective(intent, rest = "") {
  const text = foldText(rest).toLowerCase();
  if (intent === DirectiveIntent.ANSWER) {
    if (/\bdefine\b/.test(text)) return HottieIntent.DEFINE;
    if (/\bexplain\b/.test(text)) return HottieIntent.EXPLAIN;
    return HottieIntent.SEARCH_WEB;
  }
  if (intent === DirectiveIntent.FIND) {
    if (/\b(picture|photo|image)\b/.test(text)) return wantsProgramVisual(text) ? HottieIntent.SHOW_IMAGE : HottieIntent.SEARCH_IMAGE;
    if (wantsProgramVisual(text) || /\b(pull (that|it|this)?\s*up|show|put (it|that) on)\b/.test(text)) return HottieIntent.SHOW_URL;
    return HottieIntent.SEARCH_WEB;
  }
  if (intent === DirectiveIntent.RECALL) return HottieIntent.RECALL_TRANSCRIPT;
  if (intent === DirectiveIntent.FACT_CHECK) return HottieIntent.FACT_CHECK;
  if (intent === DirectiveIntent.CLIP) return HottieIntent.CLIP_MOMENT;
  if (intent === DirectiveIntent.MARK) return HottieIntent.MARK_MOMENT;
  if (intent === DirectiveIntent.CHANGE_SCENE) return HottieIntent.CHANGE_SCENE;
  if (intent === DirectiveIntent.SET_LAYOUT || intent === DirectiveIntent.CLEAR_SPOTLIGHT || intent === DirectiveIntent.SET_ACTIVE_SPEAKER_MODE || intent === DirectiveIntent.SET_SHARE_LAYOUT) {
    return HottieIntent.CHANGE_LAYOUT;
  }
  if (intent === DirectiveIntent.SET_SPOTLIGHT) return HottieIntent.SPOTLIGHT_PERSON;
  if (intent === DirectiveIntent.PLAY_AUDIO) return HottieIntent.PLAY_SOUND;
  if (intent === DirectiveIntent.TAKE_ASSET) return HottieIntent.SHOW_ASSET;
  if (intent === DirectiveIntent.AUDIENCE || intent === DirectiveIntent.READ_CHAT) return HottieIntent.READ_CHAT;
  if (intent === DirectiveIntent.RESPOND_CHAT) return HottieIntent.RESPOND_CHAT;
  if (intent === DirectiveIntent.CREW) return HottieIntent.CREW_ADVICE;
  if (intent === DirectiveIntent.END_SHOW || intent === DirectiveIntent.RECORDING) return intent === DirectiveIntent.END_SHOW ? "END_SHOW" : "START_RECORDING";
  return HottieIntent.UNKNOWN;
}

export function resolveParticipantId(query, participants = []) {
  const q = foldText(query).toLowerCase();
  if (!q) return null;
  const list = (participants || []).filter(Boolean);
  if (/\b(me|my|i|host|myself)\b/.test(q) && !list.some((p) => foldText(p.displayName).toLowerCase() === q)) {
    return list.find((p) => p.role === "host" || p.participantId === "host")?.participantId || "host";
  }
  const exact = list.find((p) => foldText(p.displayName).toLowerCase() === q);
  if (exact) return exact.participantId;
  const contained = list.find((p) => {
    const name = foldText(p.displayName).toLowerCase();
    return name && (q.includes(name) || name.includes(q) || q.startsWith(name.split(" ")[0]));
  });
  return contained?.participantId || null;
}

function spotlightNameFrom(text) {
  const match = foldText(text).match(
    /(?:put|spotlight|make|bring)\s+(.+?)(?:\s+up(?:\s+big)?|\s+big|\s+large|\s+dominant|\s+spotlight|\s+full screen)?$|spotlight\s+(.+)$/i
  );
  return (match?.[1] || match?.[2] || "").trim();
}

function shareLayoutFrom(text) {
  const value = foldText(text).toLowerCase();
  if (/\b(full|only|all useful)\b/.test(value)) return "screen-only";
  if (/\b(strip|bottom|along)\b/.test(value)) return "screen-strip";
  return "screen-speaker";
}

function sceneFrom(text) {
  const value = foldText(text).toLowerCase();
  if (/\bbrb\b/.test(value)) return "brb";
  if (/\bholding|starting soon\b/.test(value)) return "holding";
  if (/\btechnical\b/.test(value)) return "technical-difficulties";
  if (/\bending\b/.test(value)) return "ending";
  if (/\blive\b/.test(value)) return "live";
  return null;
}

export function extractDirectivePayload(intent, rest, participants = []) {
  const trimmed = foldText(rest);
  if (intent === DirectiveIntent.FIND) {
    const query = trimmed
      .replace(/^(find|look\s*up|look\s+(that|it|this)\s+up|search(?:\s+for)?|get|show|bring|pull(?:\s+up)?)\s+(me\s+)?/i, "")
      .replace(/^(that|it|this)\s+up$/i, "that")
      .trim();
    return { query: query || trimmed };
  }
  if (intent === DirectiveIntent.RECALL) {
    const about = trimmed.match(/about\s+(.+)$/i);
    const who = trimmed.match(/what did\s+(.+?)\s+say/i) || trimmed.match(/remind me what\s+(.+?)\s+said/i);
    return { query: trimmed, speakerName: who ? who[1].trim() : "", topic: about ? about[1].trim() : "" };
  }
  if (intent === DirectiveIntent.FACT_CHECK) {
    const claim = trimmed.replace(/^fact[-\s]?check( me)?[.,:]?\s*/i, "").replace(/^me[.,:]?\s*/i, "").trim();
    return { query: claim || trimmed, claim: claim || trimmed };
  }
  if (intent === DirectiveIntent.CLIP || intent === DirectiveIntent.MARK) {
    const minutes = trimmed.match(/last\s+(\d+)\s+minute/);
    const seconds = minutes ? Number(minutes[1]) * 60 : /last minute/.test(trimmed.toLowerCase()) ? 60 : 45;
    return { query: trimmed, preRollSeconds: seconds, postRollSeconds: 15, reason: trimmed };
  }
  if (intent === DirectiveIntent.CHANGE_SCENE) {
    return { query: trimmed, scene: sceneFrom(trimmed) };
  }
  if (intent === DirectiveIntent.AUDIENCE) {
    const about = trimmed.match(/about\s+(.+)$/i);
    const who = trimmed.match(/answer\s+(.+?)(?:'s|s)?\s+question/i);
    return {
      query: about ? about[1].trim() : trimmed,
      author: who ? who[1].trim() : "",
      speakAnswer: /\banswer\b/.test(trimmed.toLowerCase())
    };
  }
  if (intent === DirectiveIntent.ANSWER) {
    return { query: trimmed.replace(/^(who|what|when|where|why|how|is|are)\s+/i, "").replace(/\?+$/g, "").trim() || trimmed };
  }
  if (intent === DirectiveIntent.SET_SPOTLIGHT) {
    const name = spotlightNameFrom(trimmed);
    return {
      query: trimmed,
      participantName: name,
      participantId: resolveParticipantId(name, participants)
    };
  }
  if (intent === DirectiveIntent.CLEAR_SPOTLIGHT || intent === DirectiveIntent.SET_LAYOUT) {
    return { query: trimmed, mode: "balanced" };
  }
  if (intent === DirectiveIntent.SET_ACTIVE_SPEAKER_MODE) {
    return { query: trimmed, mode: "active-speaker" };
  }
  if (intent === DirectiveIntent.SET_SHARE_LAYOUT) {
    return { query: trimmed, shareLayout: shareLayoutFrom(trimmed) };
  }
  if (intent === DirectiveIntent.PLAY_AUDIO) {
    return { query: trimmed };
  }
  if (intent === DirectiveIntent.RECORDING) {
    return { query: trimmed, recording: /\bstop\b/i.test(trimmed) ? "stop" : "start" };
  }
  return { query: trimmed };
}

export function detectHostDirective(line, { wakeWord = DEFAULT_WAKE_WORD, participants = [], alreadyAddressed = false } = {}) {
  if (!line?.text || !isHostSpeaker(line)) return null;
  const addressed = alreadyAddressed
    ? { wakeWord: DEFAULT_WAKE_WORD, rest: foldText(line.text).replace(/^(?:hey\s+)?(hottie|toasty)\s*[,:—\-]?\s*/i, "") }
    : extractAddressedCommand(line.text, wakeWord);
  if (!addressed?.rest) return null;
  const intent = classifyDirectiveIntent(addressed.rest);
  const hottieIntent = hottieIntentFromDirective(intent, addressed.rest);
  const payload = extractDirectivePayload(intent, addressed.rest, participants);
  const responseAudience = inferResponseAudience(line.text || addressed.rest, { intent, hottieIntent });
  let riskLevel = riskForIntent(hottieIntent, {
    destructive: intent === DirectiveIntent.END_SHOW || intent === DirectiveIntent.RECORDING
  });
  if (responseAudience === ResponseAudience.PROGRAM && !wantsProgramVisual(addressed.rest) && riskLevel !== ActionRiskLevel.RED) {
    riskLevel = ActionRiskLevel.GREEN;
  }
  return {
    id: nextId(),
    participantId: line.participantId || "host",
    speaker: line.speaker || "Host",
    timestamp: line.timestamp || Date.now(),
    rawText: line.text,
    wakeWord: addressed.wakeWord,
    intent,
    hottieIntent,
    riskLevel,
    responseAudience,
    payload,
    status: DirectiveStatus.RECOGNIZED,
    explicit: !alreadyAddressed
  };
}

export function detectImplicitProductionCue(line) {
  if (!line?.text || !isHostSpeaker(line)) return null;
  if (extractAddressedCommand(line.text)) return null;
  const text = foldText(line.text);
  const cue = /\b((can (we|you) )?(pull|bring|put) (that|this|it)\b.{0,40}\bup\b|look that up|find that|can you find|what's his name|what did she say|show me the picture|go back to the other|clip that|check if that'?s actually true)\b/i.test(text);
  if (!cue) return null;
  const intent = classifyDirectiveIntent(text);
  return {
    id: nextId(),
    implicit: true,
    rawText: line.text,
    speaker: line.speaker || "Host",
    timestamp: line.timestamp || Date.now(),
    intent,
    hottieIntent: hottieIntentFromDirective(intent, text),
    payload: extractDirectivePayload(intent, text),
    riskLevel: ActionRiskLevel.AMBER,
    execute: false
  };
}

export function ensureAddressedText(text) {
  const raw = foldText(text);
  if (!raw) return "";
  if (extractAddressedCommand(raw)) return raw;
  return `Hottie, ${raw}`;
}

export function productionActionFromDirective(directive) {
  if (!directive?.intent) return null;
  const payload = directive.payload || {};
  if (directive.intent === DirectiveIntent.SET_SPOTLIGHT) {
    return { type: "SET_SPOTLIGHT", participantId: payload.participantId || null, participantName: payload.participantName || "" };
  }
  if (directive.intent === DirectiveIntent.CLEAR_SPOTLIGHT || directive.intent === DirectiveIntent.SET_LAYOUT) {
    return { type: "SET_LAYOUT", mode: "balanced" };
  }
  if (directive.intent === DirectiveIntent.SET_ACTIVE_SPEAKER_MODE) {
    return { type: "SET_ACTIVE_SPEAKER_MODE" };
  }
  if (directive.intent === DirectiveIntent.SET_SHARE_LAYOUT) {
    return { type: "SET_SHARE_LAYOUT", shareLayout: payload.shareLayout || "screen-speaker" };
  }
  if (directive.intent === DirectiveIntent.STOP_SHARE) {
    return { type: "STOP_SHARE" };
  }
  if (directive.intent === DirectiveIntent.TAKE_ASSET) {
    return { type: "TAKE_ASSET" };
  }
  if (directive.intent === DirectiveIntent.REMOVE_ASSET) {
    return { type: "REMOVE_ASSET" };
  }
  if (directive.intent === DirectiveIntent.PLAY_AUDIO) {
    return { type: "PLAY_AUDIO", query: payload.query || directive.rawText };
  }
  return null;
}

export class HostDirectiveLog {
  constructor() {
    this.items = [];
  }

  push(directive) {
    this.items.push(directive);
    return directive;
  }

  recent(limit = 10) {
    return this.items.slice(-limit);
  }

  clear() {
    this.items = [];
  }
}

export { HottieIntent, ActionRiskLevel, ResponseAudience };
