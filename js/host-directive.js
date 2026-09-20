// Deterministic Host-directive recognition. Transcript-level, not audio wake-word DSP.
// Only HOST speech addressed TO Toasty becomes a production command. A guest saying
// "Toasty is interesting" is conversation, never a directive.
//
// The wake phrase is a constant so it can change later without rewriting call sites.
// Routing (intent family + payload) is string matching, not an LLM. Downstream actions
// (research, TAKE LIVE, etc.) are NOT executed here — this module only recognizes and structures.

export const DEFAULT_WAKE_WORD = "toasty";

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
  GENERIC: "generic"
});

export const HottieStatus = Object.freeze({
  LISTENING: "listening",
  THINKING: "thinking",
  RESEARCHING: "researching",
  FOUND: "found",
  READY: "ready",
  ON_AIR: "on-air"
});

export const DirectiveStatus = Object.freeze({
  RECOGNIZED: "recognized",
  QUEUED: "queued",
  COMPLETED: "completed",
  DISMISSED: "dismissed"
});

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

// Address form: optional "hey ", then the wake word, then a comma/colon OR a command verb.
// "Toasty is interesting" fails (wake word is the subject, not an address).
export function extractAddressedCommand(text, wakeWord = DEFAULT_WAKE_WORD) {
  const raw = foldText(text);
  if (!raw) return null;
  const wake = escapeRegExp(wakeWord);
  const addressed = new RegExp(
    `^(?:hey\\s+)?${wake}\\s*[,:—\\-]\\s*(.+)$|^((?:hey\\s+)?${wake})\\s+(find|look\\s*up|search|get|show|bring|remind|what|who|tell|ask|put|spotlight|keep|follow|make|take|remove|play|give|back|switch|return)\\b([\\s\\S]*)$`,
    "i"
  );
  const match = raw.match(addressed);
  if (!match) return null;
  if (match[1]) return { wakeWord, rest: match[1].trim() };
  const verb = (match[3] || "").trim();
  const tail = (match[4] || "").trim();
  return { wakeWord, rest: `${verb} ${tail}`.trim() };
}

export function classifyDirectiveIntent(rest) {
  const text = foldText(rest).toLowerCase();
  if (/remind me|what did .+ say|said about/.test(text)) return DirectiveIntent.RECALL;
  if (/who hasn'?t|who have we not heard|not heard from|hasn'?t answered|have not answered/.test(text)) return DirectiveIntent.QUIET;
  if (/haven'?t covered|have not covered|what haven'?t we|missed anything|what are we missing/.test(text)) return DirectiveIntent.UNCOVERED;
  if (/audience question|from the audience|from chat|bring up .+ (question|comment)/.test(text)) return DirectiveIntent.AUDIENCE;
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
  if (/\b(spotlight|up big|make .+ big|put .+ (?:up|on) (?:big|large))\b/.test(text)) return DirectiveIntent.SET_SPOTLIGHT;
  if (/^(find|look\s*up|search|get|show|bring)\b/.test(text) || /\b(article|source|clip|image|chart|document)\b/.test(text)) {
    return DirectiveIntent.FIND;
  }
  return DirectiveIntent.GENERIC;
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
    /(?:put|spotlight|make)\s+(.+?)(?:\s+up(?:\s+big)?|\s+big|\s+large|\s+dominant|\s+spotlight)?$|spotlight\s+(.+)$/i
  );
  return (match?.[1] || match?.[2] || "").trim();
}

function shareLayoutFrom(text) {
  const value = foldText(text).toLowerCase();
  if (/\b(full|only|all useful)\b/.test(value)) return "screen-only";
  if (/\b(strip|bottom|along)\b/.test(value)) return "screen-strip";
  return "screen-speaker";
}

export function extractDirectivePayload(intent, rest, participants = []) {
  const trimmed = foldText(rest);
  if (intent === DirectiveIntent.FIND) {
    const query = trimmed.replace(/^(find|look\s*up|search(?:\s+for)?|get|show|bring)\s+(me\s+)?/i, "").trim();
    return { query: query || trimmed };
  }
  if (intent === DirectiveIntent.RECALL) {
    const about = trimmed.match(/about\s+(.+)$/i);
    const who = trimmed.match(/what did\s+(.+?)\s+say/i) || trimmed.match(/remind me what\s+(.+?)\s+said/i);
    return { query: trimmed, speakerName: who ? who[1].trim() : "", topic: about ? about[1].trim() : "" };
  }
  if (intent === DirectiveIntent.AUDIENCE) {
    const about = trimmed.match(/about\s+(.+)$/i);
    return { query: about ? about[1].trim() : trimmed };
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
  return { query: trimmed };
}

export function detectHostDirective(line, { wakeWord = DEFAULT_WAKE_WORD, participants = [] } = {}) {
  if (!line?.text || !isHostSpeaker(line)) return null;
  const addressed = extractAddressedCommand(line.text, wakeWord);
  if (!addressed) return null;
  const intent = classifyDirectiveIntent(addressed.rest);
  return {
    id: nextId(),
    participantId: line.participantId || "host",
    speaker: line.speaker || "Host",
    timestamp: line.timestamp || Date.now(),
    rawText: line.text,
    wakeWord: addressed.wakeWord,
    intent,
    payload: extractDirectivePayload(intent, addressed.rest, participants),
    status: DirectiveStatus.RECOGNIZED
  };
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
