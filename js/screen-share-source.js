// Canonical screen-share source. Host and Guest use THIS model — there is no
// HostScreenShareSystem vs GuestScreenShareSystem.
//
// Transport underneath may be a VDO.Ninja second push iframe (screenshare=1, webcam=0)
// or a same-browser MediaStream optimization. ProgramComposition only consumes this object.

export const ScreenShareState = Object.freeze({
  INACTIVE: "inactive",
  EXPECTED: "expected",
  BINDING: "binding",
  BOUND: "bound",
  PLAYING: "playing",
  STALLED: "stalled",
  ENDED: "ended",
  FAILED: "failed"
});

export function createScreenShareSource({
  ownerParticipantId = "host",
  transportSourceId = null,
  state = ScreenShareState.INACTIVE,
  active = false,
  stream = null,
  displayName = "Screen",
  reason = ""
} = {}) {
  // `active` is trusted as given, NOT re-derived from transportSourceId: that id is generated locally
  // the instant a share is requested, long before VDO.Ninja/getDisplayMedia confirm anything, so treating
  // its mere existence as "live" is what let a cancelled/failed share read as active everywhere
  // (presence, Program composition) that consumed this object. Callers now pass active:true only once a
  // real confirmation (push-connection:true) has arrived — see js/live-session.js's startScreenShare.
  const live = Boolean(active);
  return {
    ownerParticipantId: ownerParticipantId || "host",
    participantId: ownerParticipantId || "host",
    transportSourceId: transportSourceId || null,
    state: (live && state === ScreenShareState.INACTIVE) ? ScreenShareState.EXPECTED : state,
    active: live,
    stream: stream || null,
    displayName: displayName || "Screen",
    reason: reason || ""
  };
}

export function serializeScreenShareSource(share) {
  if (!share || typeof share !== "object") {
    return { active: false, participantId: null, ownerParticipantId: null, transportSourceId: null, state: ScreenShareState.INACTIVE };
  }
  return {
    active: Boolean(share.active),
    participantId: share.ownerParticipantId || share.participantId || "host",
    ownerParticipantId: share.ownerParticipantId || share.participantId || "host",
    transportSourceId: share.transportSourceId || null,
    state: share.state || (share.active ? ScreenShareState.EXPECTED : ScreenShareState.INACTIVE),
    displayName: share.displayName || "Screen",
    reason: share.reason || ""
  };
}

export function isScreenShareAvailable(share) {
  return Boolean(share?.active && (share.transportSourceId || share.stream));
}

export function screenShareFromPresence(entry) {
  const share = entry?.screenShare;
  if (!share?.active || !share.transportSourceId) {
    return createScreenShareSource({
      ownerParticipantId: entry?.participantId || "host",
      state: share?.state && share.state !== "inactive" ? share.state : ScreenShareState.INACTIVE
    });
  }
  return createScreenShareSource({
    ownerParticipantId: share.participantId || entry.participantId || "host",
    transportSourceId: share.transportSourceId,
    state: share.state || ScreenShareState.EXPECTED,
    active: true,
    displayName: `${entry?.displayName || share.participantId || "Participant"} screen`
  });
}

export function findActiveScreenShare(roster = []) {
  for (const entry of roster || []) {
    const share = screenShareFromPresence(entry);
    if (share.active && share.transportSourceId) return share;
  }
  return createScreenShareSource();
}

export function isScreenTransportId(streamId, roomId) {
  if (!streamId) return false;
  if (roomId && String(streamId).startsWith(`${roomId}s`)) return true;
  return /s[a-z0-9]+$/i.test(String(streamId)) && String(streamId).includes("s");
}

export function applyScreenShareHealth(share, health) {
  if (!share) return createScreenShareSource();
  const next = { ...share };
  if (!share.active) {
    next.state = ScreenShareState.INACTIVE;
    return next;
  }
  if (health === "playing") next.state = ScreenShareState.PLAYING;
  else if (health === "stalled") next.state = ScreenShareState.STALLED;
  else if (health === "failed") next.state = ScreenShareState.FAILED;
  else if (health === "ended") next.state = ScreenShareState.ENDED;
  else if (health === "bound" || health === "attached") next.state = ScreenShareState.BOUND;
  else if (health === "binding") next.state = ScreenShareState.BINDING;
  else if (share.transportSourceId) next.state = ScreenShareState.EXPECTED;
  return next;
}

export function screenPublisherEndedMessage(message) {
  if (!message) return false;
  if (message.screenshare === false) return true;
  if (message.hangup === true) return true;
  if (message.action === "push-connection" && message.value === false) return true;
  if (message.action === "stream-ended" || message.action === "ended") return true;
  return false;
}
