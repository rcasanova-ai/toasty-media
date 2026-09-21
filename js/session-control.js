// Canonical live-session control plane — the ONE snapshot Host, Guests, Producer, and Program Output
// subscribe to. VDO.Ninja remains media transport. BroadcastChannel may accelerate same-browser Program
// Output, but it is not the authority (it cannot reach a phone Guest, and production showed it also
// failed to keep Program Output in the Director's session).
//
// Authority lives on the presence backend (scripts/render-production-server.mjs /api/presence/* +
// scripts/toasty-auth-db.py). Every surface heartbeats through RoomPresence; this module is the shared
// snapshot/command/output-health shape those heartbeats carry.

export const ControlRole = Object.freeze({
  HOST: "host",
  GUEST: "guest",
  OUTPUT: "output"
});

export const SceneId = Object.freeze({
  HOLDING: "holding",
  LIVE: "live",
  BRB: "brb",
  // Producer-triggered "something broke" holding state — distinct from BRB (a planned break). Reversible
  // immediately back to LIVE: this is a scene flag only, participant/session state is untouched by it.
  TECHNICAL_DIFFICULTIES: "technical-difficulties",
  ENDING: "ending"
});

export const OutputConnection = Object.freeze({
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected"
});

export const SourceHealth = Object.freeze({
  EMPTY: "empty",
  EXPECTED: "expected",
  BINDING: "binding",
  BOUND: "bound",
  ATTACHED: "attached",
  PLAYING: "playing",
  STALLED: "stalled",
  ENDED: "ended",
  FAILED: "failed"
});

export const MediaCommandType = Object.freeze({
  MUTE_MIC: "mute-mic",
  UNMUTE_MIC_REQUEST: "unmute-mic-request",
  CAMERA_OFF: "camera-off",
  CAMERA_ON_REQUEST: "camera-on-request"
});

export const OUTPUT_STALE_MS = 6000;

export function normalizeScene(scene) {
  return Object.values(SceneId).includes(scene) ? scene : SceneId.HOLDING;
}

export function sceneIsLive(scene) {
  return normalizeScene(scene) === SceneId.LIVE;
}

export function buildCanonicalState({
  sessionId = null,
  roomId,
  scene = SceneId.HOLDING,
  live = false,
  topic = "",
  sessionTitle = "",
  ticker = { enabled: false, text: "" },
  brandTheme = "",
  participants = [],
  asset = null,
  assetLayout = null,
  audio = null,
  compositionMode = "balanced",
  spotlightParticipantId = null,
  activeParticipantId = null,
  shareLayout = null,
  screenShare = null,
  audioActivity = [],
  recording = null,
  outputs = [],
  endCard = null,
  hottieVoice = null,
  revision = 0,
  updatedAt = Date.now()
} = {}) {
  const normalizedScene = normalizeScene(scene);
  return {
    sessionId: sessionId || roomId || null,
    roomId: roomId || null,
    scene: normalizedScene,
    live: live || normalizedScene === SceneId.LIVE,
    topic: topic || "",
    sessionTitle: sessionTitle || "",
    ticker: {
      enabled: Boolean(ticker?.enabled),
      text: String(ticker?.text || ""),
      speed: Number(ticker?.speed || 16) || 16
    },
    brandTheme: brandTheme || "",
    participants: (participants || []).map(serializeControlParticipant).filter(Boolean),
    asset: asset || null,
    assetLayout: assetLayout || null,
    compositionMode: compositionMode || "balanced",
    spotlightParticipantId: spotlightParticipantId || null,
    activeParticipantId: activeParticipantId || null,
    shareLayout: shareLayout || null,
    screenShare: screenShare && typeof screenShare === "object" ? {
      active: Boolean(screenShare.active),
      participantId: screenShare.ownerParticipantId || screenShare.participantId || "host",
      ownerParticipantId: screenShare.ownerParticipantId || screenShare.participantId || "host",
      transportSourceId: screenShare.transportSourceId || null,
      state: screenShare.state || (screenShare.active ? "expected" : "inactive")
    } : { active: false, participantId: null, ownerParticipantId: null, transportSourceId: null, state: "inactive" },
    audioActivity: Array.isArray(audioActivity) ? audioActivity : [],
    audio: audio || null,
    recording: recording || null,
    outputs: (outputs || []).map(normalizeOutputStatus).filter(Boolean),
    endCard: endCard || null,
    hottieVoice: hottieVoice && typeof hottieVoice === "object" ? {
      utteranceId: hottieVoice.utteranceId || null,
      text: String(hottieVoice.text || "").slice(0, 400),
      speak: Boolean(hottieVoice.speak),
      source: hottieVoice.source || "hottie-voice",
      provider: hottieVoice.provider || "browser-speech",
      speaker: hottieVoice.speaker || "Hottie",
      mode: hottieVoice.mode || "PROGRAM_AUDIO",
      startedAt: Number(hottieVoice.startedAt) || Date.now()
    } : null,
    revision: Number(revision) || 0,
    updatedAt: Number(updatedAt) || Date.now()
  };
}

export function serializeControlParticipant(participant) {
  if (!participant) return null;
  return {
    participantId: participant.participantId,
    role: participant.role,
    displayName: participant.displayName || "",
    title: participant.title || "",
    company: participant.company || "",
    transportSourceId: participant.transportSourceId || null,
    connectionStatus: participant.connectionStatus || "connected",
    onProgram: participant.onProgram !== false,
    joinedAt: participant.joinedAt || null,
    micEnabled: participant.micEnabled ?? null,
    cameraEnabled: participant.cameraEnabled ?? null,
    micPending: participant.micPending || null,
    cameraPending: participant.cameraPending || null
  };
}

export function createMediaCommand({
  id,
  targetParticipantId,
  type,
  requestedBy = "producer"
} = {}) {
  if (!targetParticipantId || !Object.values(MediaCommandType).includes(type)) return null;
  return {
    id: id || `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    targetParticipantId,
    type,
    requestedBy,
    createdAt: Date.now()
  };
}

export function mergeRosterMedia(participants = [], roster = []) {
  const byTransport = new Map();
  const byId = new Map();
  for (const entry of roster || []) {
    if (entry.role === ControlRole.OUTPUT) continue;
    byId.set(entry.participantId, entry);
    if (entry.transportSourceId) byTransport.set(entry.transportSourceId, entry);
  }
  return (participants || []).map((participant) => {
    const match = byId.get(participant.participantId) || byTransport.get(participant.transportSourceId || participant.participantId);
    if (!match) return participant;
    const next = { ...participant };
    if (typeof match.micEnabled === "boolean") {
      next.micEnabled = match.micEnabled;
      if (next.micPending && Boolean(next.micPending.wantEnabled) === match.micEnabled) next.micPending = null;
    }
    if (typeof match.cameraEnabled === "boolean") {
      next.cameraEnabled = match.cameraEnabled;
      if (next.cameraPending && Boolean(next.cameraPending.wantEnabled) === match.cameraEnabled) next.cameraPending = null;
    }
    if (match.displayName) next.displayName = match.displayName;
    if (match.title != null) next.title = match.title;
    if (match.company != null) next.company = match.company;
    if (match.transportSourceId) next.transportSourceId = match.transportSourceId;
    return next;
  });
}

export function applyMediaAckToSeat(seat, rosterEntry) {
  if (!seat || !rosterEntry) return seat;
  const next = { ...seat };
  if (rosterEntry.participantId) next.presenceParticipantId = rosterEntry.participantId;
  if (typeof rosterEntry.micEnabled === "boolean") {
    if (next.micPending) {
      if (Boolean(next.micPending.wantEnabled) === rosterEntry.micEnabled) {
        next.mic = rosterEntry.micEnabled;
        next.micPending = null;
      }
    } else {
      next.mic = rosterEntry.micEnabled;
    }
  }
  if (typeof rosterEntry.cameraEnabled === "boolean") {
    if (next.cameraPending) {
      if (Boolean(next.cameraPending.wantEnabled) === rosterEntry.cameraEnabled) {
        next.camera = rosterEntry.cameraEnabled;
        next.cameraPending = null;
      }
    } else {
      next.camera = rosterEntry.cameraEnabled;
    }
  }
  return next;
}

export function commandTargetsParticipant(command, { participantId, transportSourceId } = {}) {
  if (!command?.targetParticipantId) return false;
  const target = command.targetParticipantId;
  return target === participantId || (transportSourceId && target === transportSourceId);
}

export function seenAtMs(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function outputConnectionState(output, now = Date.now(), staleMs = OUTPUT_STALE_MS) {
  if (!output) return OutputConnection.DISCONNECTED;
  const seen = seenAtMs(output.updatedAt || output.lastSeenAt);
  if (!seen) return OutputConnection.CONNECTING;
  if (now - seen > staleMs) return OutputConnection.DISCONNECTED;
  if (output.connection === OutputConnection.CONNECTING) return OutputConnection.CONNECTING;
  return OutputConnection.CONNECTED;
}

export function normalizeOutputStatus(payload = {}) {
  if (!payload || typeof payload !== "object") return null;
  const expected = Number(payload.expectedFeeds) || 0;
  const bound = Number(payload.boundFeeds) || 0;
  const playing = Number(payload.playingFeeds) || 0;
  const empty = Number(payload.emptyFeeds) || 0;
  const audioEnabled = Boolean(payload.audioEnabled || payload.audioReady);
  const audioError = payload.audioError || null;
  const failed = Number(payload.failedFeeds) || 0;
  const scene = normalizeScene(payload.scene);
  const videoReady = expected > 0 && playing === expected && empty === 0 && failed === 0;
  const connection = payload.connection || (payload.connected ? OutputConnection.CONNECTED : OutputConnection.CONNECTING);
  return {
    outputId: payload.outputId || payload.participantId || null,
    sessionId: payload.sessionId || null,
    roomId: payload.roomId || null,
    connection,
    connectedAt: payload.connectedAt || null,
    updatedAt: seenAtMs(payload.updatedAt) || Date.now(),
    scene,
    audioEnabled,
    audioError,
    expectedFeeds: expected,
    boundFeeds: bound,
    playingFeeds: playing,
    emptyFeeds: empty,
    stalledFeeds: Number(payload.stalledFeeds) || 0,
    failedFeeds: Number(payload.failedFeeds) || 0,
    sourceHealth: payload.sourceHealth || [],
    videoReady,
    audioReady: audioEnabled && !audioError,
    readyToRecord: videoReady && audioEnabled && !audioError && scene === SceneId.LIVE
  };
}

export function summarizeOutputForProducer(outputs = [], now = Date.now()) {
  const live = (outputs || [])
    .map((item) => normalizeOutputStatus(item))
    .filter(Boolean)
    .filter((item) => outputConnectionState(item, now) !== OutputConnection.DISCONNECTED)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null;
  if (!live) {
    return {
      connection: OutputConnection.DISCONNECTED,
      connected: false,
      scene: null,
      live: false,
      expectedFeeds: 0,
      boundFeeds: 0,
      playingFeeds: 0,
      emptyFeeds: 0,
      audioUnlocked: false,
      audioReady: false,
      audioError: null,
      videoReady: false,
      readyToRecord: false,
      updatedAt: null
    };
  }
  const connection = outputConnectionState(live, now);
  return {
    connection,
    connected: connection === OutputConnection.CONNECTED,
    scene: live.scene,
    live: live.scene === SceneId.LIVE,
    expectedFeeds: live.expectedFeeds,
    boundFeeds: live.boundFeeds,
    playingFeeds: live.playingFeeds,
    emptyFeeds: live.emptyFeeds,
    audioUnlocked: live.audioEnabled,
    audioReady: live.audioReady,
    audioError: live.audioError,
    videoReady: live.videoReady,
    readyToRecord: connection === OutputConnection.CONNECTED && live.readyToRecord,
    updatedAt: live.updatedAt,
    outputId: live.outputId
  };
}

export function recordingBlockReasonFromOutput(output, { policyAllows = true, captureSupported = true } = {}) {
  if (!policyAllows) return "Recording is disabled by this session's capture policy.";
  if (!captureSupported) return "This browser cannot capture Program Output. Use current Chrome.";
  if (!output || output.connection === OutputConnection.DISCONNECTED || !output.connected) {
    return "Program Output is not connected. Open Program Output and wait until it says Connected.";
  }
  if (output.connection === OutputConnection.CONNECTING) return "Program Output is connecting…";
  if (output.scene !== SceneId.LIVE) return "Set the scene to Live before recording.";
  if (!output.expectedFeeds) return "Program Output has no participant feeds yet. Join Host and Guest, then go Live.";
  if (!output.videoReady) {
    return `Program Output video is not ready (${output.readyFeeds ?? output.playingFeeds ?? 0}/${output.expectedFeeds} ready).`;
  }
  if (output.audioError) return `Program Output audio failed: ${output.audioError}`;
  if (!output.audioReady) return "Enable program audio on the Program Output tab, then start recording.";
  return null;
}

export function countFeedHealth(healthItems = []) {
  const counts = { empty: 0, attached: 0, playing: 0, stalled: 0, failed: 0 };
  for (const item of healthItems) {
    const health = item?.health || SourceHealth.EMPTY;
    if (counts[health] != null) counts[health] += 1;
    else counts.empty += 1;
  }
  return counts;
}
