// Moxie production action bus.
// LLM / speech never mutates Studio. Structured intents become ProductionActions here,
// then a validated handler (ProgramController or a GREEN private worker) may run.

export const ProductionActionStatus = Object.freeze({
  RECEIVED: "RECEIVED",
  PROCESSING: "PROCESSING",
  READY: "READY",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
  APPROVED: "APPROVED",
  EXECUTING: "EXECUTING",
  LIVE: "LIVE",
  COMPLETED: "COMPLETED",
  REJECTED: "REJECTED",
  FAILED: "FAILED"
});

export const ActionRiskLevel = Object.freeze({
  GREEN: "GREEN",
  AMBER: "AMBER",
  RED: "RED"
});

export const ResponseAudience = Object.freeze({
  PRIVATE_HOST: "PRIVATE_HOST",
  PRIVATE_PRODUCER: "PRIVATE_PRODUCER",
  PRIVATE_CREW: "PRIVATE_CREW",
  PROGRAM: "PROGRAM",
  NONE: "NONE"
});

export const MoxieIntent = Object.freeze({
  SEARCH_WEB: "SEARCH_WEB",
  SEARCH_IMAGE: "SEARCH_IMAGE",
  FACT_CHECK: "FACT_CHECK",
  RECALL_TRANSCRIPT: "RECALL_TRANSCRIPT",
  DEFINE: "DEFINE",
  EXPLAIN: "EXPLAIN",
  SHOW_ASSET: "SHOW_ASSET",
  SHOW_URL: "SHOW_URL",
  SHOW_IMAGE: "SHOW_IMAGE",
  SHOW_TEXT: "SHOW_TEXT",
  CHANGE_SCENE: "CHANGE_SCENE",
  CHANGE_LAYOUT: "CHANGE_LAYOUT",
  SPOTLIGHT_PERSON: "SPOTLIGHT_PERSON",
  PLAY_MEDIA: "PLAY_MEDIA",
  PLAY_SOUND: "PLAY_SOUND",
  UPDATE_TICKER: "UPDATE_TICKER",
  CREATE_LOWER_THIRD: "CREATE_LOWER_THIRD",
  CLIP_MOMENT: "CLIP_MOMENT",
  MARK_MOMENT: "MARK_MOMENT",
  READ_CHAT: "READ_CHAT",
  RESPOND_CHAT: "RESPOND_CHAT",
  CREW_ADVICE: "CREW_ADVICE",
  UNKNOWN: "UNKNOWN"
});

const GREEN_INTENTS = new Set([
  MoxieIntent.SEARCH_WEB,
  MoxieIntent.SEARCH_IMAGE,
  MoxieIntent.FACT_CHECK,
  MoxieIntent.RECALL_TRANSCRIPT,
  MoxieIntent.DEFINE,
  MoxieIntent.EXPLAIN,
  MoxieIntent.CLIP_MOMENT,
  MoxieIntent.MARK_MOMENT,
  MoxieIntent.READ_CHAT,
  MoxieIntent.CREW_ADVICE
]);

const RED_INTENTS = new Set([
  "END_SHOW",
  "START_RECORDING",
  "STOP_RECORDING",
  "CHANGE_DESTINATION",
  "DISCONNECT_PARTICIPANT"
]);

let seq = 0;
export function nextProductionActionId() {
  seq += 1;
  return `hact-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function riskForIntent(intent, { destructive = false } = {}) {
  if (destructive || RED_INTENTS.has(intent)) return ActionRiskLevel.RED;
  if (GREEN_INTENTS.has(intent)) return ActionRiskLevel.GREEN;
  return ActionRiskLevel.AMBER;
}

export function requiresApproval(riskLevel) {
  return riskLevel === ActionRiskLevel.AMBER || riskLevel === ActionRiskLevel.RED;
}

export function createProductionAction({
  id,
  sessionId = null,
  intent = MoxieIntent.UNKNOWN,
  payload = {},
  requestedBy = "host",
  createdAt = Date.now(),
  riskLevel,
  status = ProductionActionStatus.RECEIVED,
  preview = null,
  heardText = "",
  provenance = null,
  responseAudience = ResponseAudience.PRIVATE_PRODUCER,
  spokenResponse = null
} = {}) {
  const risk = riskLevel || riskForIntent(intent);
  const audience = Object.values(ResponseAudience).includes(responseAudience)
    ? responseAudience
    : ResponseAudience.PRIVATE_PRODUCER;
  return {
    id: id || nextProductionActionId(),
    sessionId,
    intent,
    payload: payload && typeof payload === "object" ? payload : {},
    requestedBy,
    createdAt,
    riskLevel: risk,
    status,
    preview,
    heardText: String(heardText || ""),
    responseAudience: audience,
    spokenResponse: spokenResponse || null,
    provenance: provenance || {
      heardText: String(heardText || ""),
      requestedBy,
      createdAt,
      sources: [],
      approval: null,
      result: null
    }
  };
}

export class MoxieActionBus {
  constructor() {
    this.items = [];
    this._listeners = new Set();
  }

  on(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  _emit() {
    this._listeners.forEach((cb) => cb(this.items));
  }

  push(action) {
    const full = createProductionAction(action);
    this.items.unshift(full);
    this._emit();
    return full;
  }

  get(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  update(id, patch = {}) {
    const item = this.get(id);
    if (!item) return null;
    Object.assign(item, patch);
    if (patch.status || patch.preview || patch.payload) this._emit();
    return item;
  }

  setStatus(id, status, extra = {}) {
    return this.update(id, { status, ...extra });
  }

  recordProvenance(id, patch = {}) {
    const item = this.get(id);
    if (!item) return null;
    item.provenance = { ...item.provenance, ...patch };
    this._emit();
    return item;
  }

  now() {
    return this.items.find((item) =>
      item.status === ProductionActionStatus.PROCESSING
      || item.status === ProductionActionStatus.RECEIVED
      || item.status === ProductionActionStatus.EXECUTING
    ) || null;
  }

  ready() {
    return this.items.filter((item) =>
      item.status === ProductionActionStatus.READY
      || item.status === ProductionActionStatus.AWAITING_APPROVAL
    );
  }

  history() {
    return this.items.filter((item) =>
      item.status === ProductionActionStatus.COMPLETED
      || item.status === ProductionActionStatus.LIVE
      || item.status === ProductionActionStatus.REJECTED
      || item.status === ProductionActionStatus.FAILED
    );
  }

  clear() {
    this.items = [];
    this._emit();
  }
}
