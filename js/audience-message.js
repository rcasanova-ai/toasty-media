// Unified audience chat. Adapters normalize vendor payloads into AudienceMessage.
// Hottie consumes this model. Public AI replies MUST identify as Hottie · Toasty Producer.

export const AudienceSource = Object.freeze({
  TOASTY: "TOASTY",
  YOUTUBE: "YOUTUBE",
  X: "X",
  TELEGRAM: "TELEGRAM",
  DEMO: "DEMO"
});

export const AudienceKind = Object.freeze({
  COMMENT: "comment",
  QUESTION: "question",
  HAND: "hand"
});

export const HOTTIE_PUBLIC_IDENTITY = "Hottie · Toasty Producer";

let seq = 0;
function nextAudienceId() {
  seq += 1;
  return `aud-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function createAudienceMessage({
  id,
  sessionId = null,
  source = AudienceSource.TOASTY,
  sourceMessageId = null,
  author = "",
  text = "",
  timestamp = Date.now(),
  kind = AudienceKind.COMMENT,
  metadata = {}
} = {}) {
  const body = String(text || "").trim();
  if (!body) return null;
  return {
    id: id || nextAudienceId(),
    sessionId,
    source: AudienceSource[source] || source || AudienceSource.TOASTY,
    sourceMessageId: sourceMessageId || null,
    author: String(author || "Audience").slice(0, 80),
    text: body.slice(0, 500),
    timestamp: Number(timestamp) || Date.now(),
    kind: Object.values(AudienceKind).includes(kind) ? kind : AudienceKind.COMMENT,
    metadata: metadata && typeof metadata === "object" ? metadata : {}
  };
}

export function normalizeAudienceMessage(raw = {}, { sessionId, source } = {}) {
  const text = raw.text || raw.message || raw.body || "";
  const kind = inferKind(raw.type || raw.kind, text);
  return createAudienceMessage({
    id: raw.id,
    sessionId: sessionId || raw.sessionId || null,
    source: source || mapLegacyPlatform(raw.platform || raw.source),
    sourceMessageId: raw.sourceMessageId || raw.platformUserId || raw.id || null,
    author: raw.author || raw.displayName || raw.user || "",
    text,
    timestamp: raw.timestamp,
    kind,
    metadata: raw.metadata || {}
  });
}

export function analyzeAudienceMessage(message) {
  const text = String(message?.text || "");
  const question = message?.kind === AudienceKind.QUESTION || /\?/.test(text);
  return {
    id: message?.id,
    isQuestion: question,
    unanswered: question && !message?.metadata?.answered,
    theme: themeOf(text),
    interesting: question || text.length > 40
  };
}

export function clusterAudienceQuestions(messages = []) {
  const questions = (messages || []).filter((item) => analyzeAudienceMessage(item).isQuestion);
  const buckets = new Map();
  for (const item of questions) {
    const key = themeOf(item.text) || "general";
    const bucket = buckets.get(key) || { theme: key, count: 0, messages: [] };
    bucket.count += 1;
    bucket.messages.push(item);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count);
}

export class AudienceAdapter {
  constructor({ source = AudienceSource.TOASTY, sessionId = null, store = null } = {}) {
    this.source = source;
    this.sessionId = sessionId;
    this.store = store;
  }

  ingest(raw) {
    const message = normalizeAudienceMessage(raw, { sessionId: this.sessionId, source: this.source });
    if (!message) return null;
    this.store?.ingest?.({
      platform: this.source.toLowerCase(),
      platformUserId: message.sourceMessageId,
      displayName: message.author,
      message: message.text,
      type: message.kind,
      timestamp: message.timestamp
    });
    return message;
  }
}

export function hottiePublicReply({ text, inReplyTo = null, sessionId = null } = {}) {
  return createAudienceMessage({
    sessionId,
    source: AudienceSource.TOASTY,
    author: HOTTIE_PUBLIC_IDENTITY,
    text,
    kind: AudienceKind.COMMENT,
    metadata: { inReplyTo, identity: HOTTIE_PUBLIC_IDENTITY, impersonatesHost: false }
  });
}

function mapLegacyPlatform(platform) {
  const value = String(platform || "").toUpperCase();
  if (value === "YOUTUBE") return AudienceSource.YOUTUBE;
  if (value === "X" || value === "TWITTER") return AudienceSource.X;
  if (value === "TELEGRAM") return AudienceSource.TELEGRAM;
  if (value === "DEMO") return AudienceSource.DEMO;
  return AudienceSource.TOASTY;
}

function inferKind(type, text) {
  if (type === "question" || type === AudienceKind.QUESTION) return AudienceKind.QUESTION;
  if (type === "hand" || type === AudienceKind.HAND) return AudienceKind.HAND;
  if (/\?/.test(String(text || ""))) return AudienceKind.QUESTION;
  return AudienceKind.COMMENT;
}

function themeOf(text) {
  const n = String(text || "").toLowerCase();
  if (/grid|power|electric/.test(n)) return "power";
  if (/price|cost|budget/.test(n)) return "pricing";
  if (/regulat|control|privacy/.test(n)) return "regulation";
  if (/\?/.test(n)) return "question";
  return "general";
}
