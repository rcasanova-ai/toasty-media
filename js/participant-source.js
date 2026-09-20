// Canonical on-program participant camera/mic identity.
// Distinct from ScreenShareSource: one person may own both a camera source and a screen source.

export const ParticipantSourceKind = Object.freeze({
  CAMERA: "participant-camera",
  MICROPHONE: "participant-microphone"
});

export const ParticipantSourceState = Object.freeze({
  EXPECTED: "expected",
  BINDING: "binding",
  BOUND: "bound",
  PLAYING: "playing",
  STALLED: "stalled",
  ENDED: "ended",
  FAILED: "failed"
});

export function createParticipantSource({
  participantId,
  role = "guest",
  kind = ParticipantSourceKind.CAMERA,
  transportSourceId = null,
  stream = null,
  state = ParticipantSourceState.EXPECTED,
  displayName = ""
} = {}) {
  return {
    participantId: participantId || null,
    role,
    kind,
    transportSourceId: transportSourceId || null,
    stream: stream || null,
    state,
    displayName: displayName || ""
  };
}

export function cameraSourceFromParticipant(participant) {
  if (!participant) return null;
  return createParticipantSource({
    participantId: participant.participantId,
    role: participant.role,
    kind: ParticipantSourceKind.CAMERA,
    transportSourceId: participant.transportSourceId || null,
    stream: participant.videoSource?.stream || null,
    displayName: participant.displayName || ""
  });
}
