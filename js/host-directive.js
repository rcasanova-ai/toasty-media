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
  GENERIC: "generic"
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
    `^(?:hey\\s+)?${wake}\\s*[,:—\\-]\\s*(.+)$|^((?:hey\\s+)?${wake})\\s+(find|look\\s*up|search|get|show|bring|remind|what|who|tell|ask)\\b([\\s\\S]*)$`,
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
  if (/^(find|look\s*up|search|get|show|bring)\b/.test(text) || /\b(article|source|clip|image|chart|document)\b/.test(text)) {
    return DirectiveIntent.FIND;
  }
  return DirectiveIntent.GENERIC;
}

export function extractDirectivePayload(intent, rest) {
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
  return { query: trimmed };
}

export function detectHostDirective(line, { wakeWord = DEFAULT_WAKE_WORD } = {}) {
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
    payload: extractDirectivePayload(intent, addressed.rest),
    status: DirectiveStatus.RECOGNIZED
  };
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
