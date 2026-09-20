// Session artifact / post-production model. Durable interfaces for future workers.
// No generation UI lives here.

export const ArtifactType = Object.freeze({
  FULL_EPISODE: "FULL_EPISODE",
  CLIP: "CLIP",
  SHORT: "SHORT",
  SUMMARY: "SUMMARY",
  ARTICLE: "ARTICLE",
  HIGHLIGHT_REEL: "HIGHLIGHT_REEL",
  FOCUS_GROUP_INSIGHTS: "FOCUS_GROUP_INSIGHTS"
});

export const ArtifactStatus = Object.freeze({
  PLANNED: "planned",
  PENDING: "pending",
  RUNNING: "running",
  READY: "ready",
  FAILED: "failed"
});

let seq = 0;
function nextArtifactId(type) {
  seq += 1;
  return `art-${String(type || "item").toLowerCase()}-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function createSessionRecord({
  sessionId,
  roomId,
  brandTheme = "",
  startedAt = Date.now(),
  endedAt = null,
  participants = [],
  recordingId = null,
  masterFile = null,
  isolatedFiles = [],
  transcriptRef = null,
  chatRef = null,
  productionActions = [],
  assetsUsed = [],
  markers = [],
  focusGroup = null
} = {}) {
  return {
    schema: "toasty.session.v1",
    sessionId: sessionId || roomId || null,
    roomId: roomId || null,
    brandTheme,
    startedAt,
    endedAt,
    durationSeconds: endedAt && startedAt ? Number(((endedAt - startedAt) / 1000).toFixed(3)) : 0,
    participants: (participants || []).map((item) => ({
      participantId: item.participantId,
      role: item.role,
      displayName: item.displayName || "",
      transportSourceId: item.transportSourceId || null
    })),
    recordingId,
    masterFile,
    isolatedFiles: isolatedFiles || [],
    transcriptRef,
    chatRef,
    productionActions: productionActions || [],
    assetsUsed: assetsUsed || [],
    markers: markers || [],
    focusGroup,
    artifacts: []
  };
}

export function createSessionArtifact({
  type,
  sessionId,
  status = ArtifactStatus.PLANNED,
  title = "",
  sourceRecordingId = null,
  payload = {}
} = {}) {
  const artifactType = ArtifactType[type] || type;
  if (!Object.values(ArtifactType).includes(artifactType)) return null;
  return {
    schema: "toasty.session-artifact.v1",
    id: nextArtifactId(artifactType),
    type: artifactType,
    sessionId: sessionId || null,
    status,
    title: title || artifactType,
    sourceRecordingId,
    createdAt: Date.now(),
    payload: payload || {}
  };
}

export function planDefaultArtifacts(session) {
  const sessionId = session?.sessionId || session?.roomId;
  const items = [
    createSessionArtifact({ type: ArtifactType.FULL_EPISODE, sessionId, title: "Full episode" }),
    createSessionArtifact({ type: ArtifactType.SUMMARY, sessionId, title: "Session summary" })
  ];
  if (session?.focusGroup) {
    items.push(createSessionArtifact({
      type: ArtifactType.FOCUS_GROUP_INSIGHTS,
      sessionId,
      title: "Focus group insight pack"
    }));
  }
  return items.filter(Boolean);
}

export class SessionArtifactStore {
  constructor() {
    this.session = null;
    this.items = [];
  }

  attachSession(record) {
    this.session = createSessionRecord(record);
    this.items = planDefaultArtifacts(this.session);
    this.session.artifacts = this.items;
    return this.session;
  }

  add(artifact) {
    const item = artifact?.id ? artifact : createSessionArtifact(artifact);
    if (!item) return null;
    this.items.push(item);
    if (this.session) this.session.artifacts = this.items;
    return item;
  }

  list() {
    return this.items.slice();
  }
}
