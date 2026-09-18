// Shared remote-media state model — same four states for both js/guest.js (Guest viewing Host) and
// js/live-session.js/js/host-view.js (Host viewing a Guest). Exists because presence and media are
// different layers that can each independently be true or false: presence confirms WHO is in the room,
// media confirms whether their VIDEO is actually visible. Before this, a Guest whose Host had genuinely
// joined (presence confirmed) but whose video wasn't rendering still saw "Waiting for host to join" — an
// honest but misleading message once the earlier presence pass shipped, since the Host WAS present; the
// real problem had moved to the media layer. See js/video-engine.js's requestPeerVideoState for how
// REMOTE_MEDIA_LIVE gets confirmed — a real DOM-visibility signal from the remote viewer's own detailed
// state, not just "the iframe loaded" or "presence exists."
export const RemoteMediaState = Object.freeze({
  WAITING_FOR_PARTICIPANT: "waiting-for-participant", // presence has no other participant yet
  CONNECTING_REMOTE_MEDIA: "connecting-remote-media", // presence confirms them; view mounted; no confirmed video yet
  REMOTE_MEDIA_LIVE: "remote-media-live", // confirmed: a real video track is actually visible
  REMOTE_MEDIA_ERROR: "remote-media-error" // mounted well past a reasonable window with no confirmed video
});

export const REMOTE_MEDIA_STATE_LABEL = Object.freeze({
  [RemoteMediaState.WAITING_FOR_PARTICIPANT]: "Waiting for someone to join",
  [RemoteMediaState.CONNECTING_REMOTE_MEDIA]: "Connecting video…",
  [RemoteMediaState.REMOTE_MEDIA_LIVE]: "",
  [RemoteMediaState.REMOTE_MEDIA_ERROR]: "Connected, but their video isn't coming through"
});
