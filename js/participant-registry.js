// Canonical Toasty participant/source model — the single shape every UI surface (lower thirds, Program
// Output, AI Producer context, recordings, guest sidebar) should eventually read a participant from,
// replacing today's separate ad-hoc shapes (LiveSession.hostProfile, LiveSession.guestSeats entries).
// Seeded here with the Host as its first real entry (see live-session.js's joinAsHost/endShow) — guest
// migration is deliberate follow-up work once Host-tile geometry is proven on a real device, not done in
// this pass.
//
// videoSource/audioSource describe WHERE the frames actually come from, never VDO identity: the Host's
// video is a native getUserMedia MediaStream (Toasty owns the pixels directly), a remote guest's video is
// (once resolved) a clean individual view of just that person, never scene=0's room auto-mix.
// transportSourceId is VDO.Ninja's own room/push/view stream id — metadata for wiring up the transport
// connection, never something a compositor keys off of.
export const ParticipantRole = Object.freeze({ HOST: "host", GUEST: "guest" });

export const ConnectionStatus = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  CONNECTED: "connected",
  DISCONNECTED: "disconnected"
});

export const SourceKind = Object.freeze({
  NATIVE_MEDIA_STREAM: "native-media-stream", // Toasty-owned getUserMedia stream, rendered directly
  VDO_PARTICIPANT_VIEW: "vdo-participant-view", // clean &view=<id> remote source, once resolved
  NONE: "none"
});

export function createParticipant({
  participantId,
  role,
  displayName = "",
  title = "",
  company = "",
  connectionStatus = ConnectionStatus.IDLE,
  videoSource = { kind: SourceKind.NONE },
  audioSource = { kind: SourceKind.NONE },
  transportSourceId = null,
  // Stable-ordering key for js/program-composition.js's stableOrder — when this participant first
  // appeared, stamped once at genuine discovery by the caller (never regenerated on a repeat upsert of the
  // same participant), so recomposition on a later join/leave never reshuffles someone already positioned.
  // Defaults to "now" so any caller that doesn't pass one explicitly still gets a real, if less precise,
  // ordering key rather than everyone tying at undefined.
  joinedAt = Date.now(),
  // Connected doesn't necessarily mean visible in Program — see js/program-composition.js's composeProgram,
  // which filters on this. Defaults true: for this pass, every connected camera participant is on Program
  // automatically: Producer taking sources on/off Program individually is later work this field is already
  // shaped for, not built yet.
  onProgram = true
}) {
  if (!participantId) throw new Error("createParticipant requires participantId.");
  if (!role) throw new Error("createParticipant requires role.");
  return { participantId, role, displayName, title, company, connectionStatus, videoSource, audioSource, transportSourceId, joinedAt, onProgram };
}

// Keyed by participantId. Plain Map, not a class with its own event system — every consumer so far
// (LiveSession) already owns its own emit machinery, so this only needs to be a shared shape plus a place
// to look entries up, not a second observable store competing with LiveSession's existing events.
export class ParticipantRegistry {
  constructor() {
    this._byId = new Map();
  }

  upsert(participant) {
    this._byId.set(participant.participantId, participant);
    return participant;
  }

  remove(participantId) {
    this._byId.delete(participantId);
  }

  get(participantId) {
    return this._byId.get(participantId) || null;
  }

  list() {
    return [...this._byId.values()];
  }
}
