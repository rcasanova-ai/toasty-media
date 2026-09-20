// Unified production breadcrumb log. Timestampable events for recording,
// post-production, and focus-group evidence. Does not mutate Program Output DOM.

export const ProductionEventType = Object.freeze({
  PARTICIPANT_JOINED: "participant-joined",
  PARTICIPANT_LEFT: "participant-left",
  SHARE_STARTED: "share-started",
  SHARE_STOPPED: "share-stopped",
  LAYOUT_CHANGED: "layout-changed",
  SPOTLIGHT_CHANGED: "spotlight-changed",
  ASSET_PROPOSED: "asset-proposed",
  ASSET_TAKEN_LIVE: "asset-taken-live",
  ASSET_REMOVED: "asset-removed",
  AUDIO_PLAYED: "audio-played",
  AUDIO_STOPPED: "audio-stopped",
  MARKER_ADDED: "marker-added",
  HOTTIE_PROPOSAL: "hottie-proposal",
  HOTTIE_ACTION: "hottie-action",
  CHAT_SURFACED: "chat-surfaced",
  RECORDING_STARTED: "recording-started",
  RECORDING_STOPPED: "recording-stopped"
});

let seq = 0;
export function nextProductionEventId() {
  seq += 1;
  return `pe-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function createProductionEvent({
  type,
  timestamp = Date.now(),
  sessionId = null,
  participantId = null,
  payload = {}
} = {}) {
  if (!Object.values(ProductionEventType).includes(type)) return null;
  return {
    id: nextProductionEventId(),
    type,
    timestamp: Number(timestamp) || Date.now(),
    sessionId,
    participantId,
    payload: payload && typeof payload === "object" ? payload : {}
  };
}

export class ProductionTimeline {
  constructor() {
    this.items = [];
  }

  record(type, payload = {}, extra = {}) {
    const event = createProductionEvent({ type, payload, ...extra });
    if (!event) return null;
    this.items.push(event);
    return event;
  }

  during(startedAt, stoppedAt = Date.now()) {
    return this.items.filter((item) => item.timestamp >= startedAt && item.timestamp <= stoppedAt);
  }

  recent(limit = 80) {
    return this.items.slice(-limit);
  }

  clear() {
    this.items = [];
  }
}
