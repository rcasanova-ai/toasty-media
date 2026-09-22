// Read-only Session Artifacts for ENDED sessions.
// Does not join RoomPresence, start ProgramSync, or reopen a live room.
// Only surfaces data that is actually persisted today.

import { loadMasterRecording, recalledMasterRecordingId } from "./program-recording.js";

export const ArtifactSectionId = Object.freeze({
  RECORDINGS: "recordings",
  CLIPS: "clips",
  TRANSCRIPT: "transcript",
  MOXIE: "hottie",
  AUDIENCE: "audience",
  NOTES: "notes",
  SHOW_ASSETS: "show-assets",
  RUN_OF_SHOW: "run-of-show",
  PARTICIPANTS: "participants",
  METADATA: "metadata"
});

export function sessionMetadataArtifact(session) {
  if (!session) return null;
  return {
    id: session.id,
    title: session.title || "Untitled session",
    status: session.status,
    brandId: session.brandId || "",
    roomId: session.roomId || null,
    createdAt: session.createdAt || null,
    startedAt: session.startedAt || null,
    endedAt: session.endedAt || null,
    lastActiveAt: session.lastActiveAt || null,
    endCard: session.endCard && Object.keys(session.endCard).length ? session.endCard : null
  };
}

export async function loadSessionArtifacts(session, { loadRecording = loadMasterRecording, recallRecordingId = recalledMasterRecordingId } = {}) {
  const metadata = sessionMetadataArtifact(session);
  const recordingId = session?.roomId ? recallRecordingId(session.roomId) : null;
  let recording = null;
  if (recordingId) {
    try {
      recording = await loadRecording(recordingId);
    } catch (_) {
      recording = null;
    }
  }
  const manifest = recording?.manifest || null;
  const blob = recording?.blob || null;
  const hasRecording = Boolean(blob) || Boolean(manifest);
  const markers = Array.isArray(manifest?.markers) ? manifest.markers : [];
  const momentMarkers = markers.filter((item) => item?.kind === "moment-marker" || item?.type === "hottie" || item?.source === "hottie");
  const transcript = manifest?.transcript || null;
  const chat = manifest?.chat || null;
  const assetsUsed = Array.isArray(manifest?.assetsUsed) ? manifest.assetsUsed : [];
  const productionActions = Array.isArray(manifest?.productionActions) ? manifest.productionActions : [];
  const participants = Array.isArray(manifest?.participants) && manifest.participants.length
    ? manifest.participants
    : [];
  const hottieResearch = Array.isArray(manifest?.hottieResearch) ? manifest.hottieResearch : [];

  const sections = [];
  sections.push({
    id: ArtifactSectionId.METADATA,
    title: "Session",
    available: true,
    data: metadata
  });
  if (hasRecording) {
    sections.push({
      id: ArtifactSectionId.RECORDINGS,
      title: "Recordings",
      available: true,
      data: {
        recordingId: manifest?.recordingId || recordingId,
        mimeType: blob?.type || manifest?.media?.mimeType || "video/webm",
        bytes: blob?.size || manifest?.media?.bytes || 0,
        durationSeconds: manifest?.durationSeconds || null,
        startedAt: manifest?.startedAt || null,
        stoppedAt: manifest?.stoppedAt || null,
        blob,
        hasAudioOnly: false
      }
    });
  }
  if (momentMarkers.length || markers.length) {
    sections.push({
      id: ArtifactSectionId.CLIPS,
      title: "Clips & Moments",
      available: true,
      data: { markers, momentMarkers, generatedClips: [] }
    });
  }
  if (transcript && (Array.isArray(transcript) ? transcript.length : transcript.text || transcript.lines)) {
    sections.push({
      id: ArtifactSectionId.TRANSCRIPT,
      title: "Transcript",
      available: true,
      data: transcript
    });
  }
  if (hottieResearch.length) {
    sections.push({
      id: ArtifactSectionId.MOXIE,
      title: "Moxie / Research",
      available: true,
      data: hottieResearch
    });
  }
  if (chat && (Array.isArray(chat) ? chat.length : chat.messages)) {
    sections.push({
      id: ArtifactSectionId.AUDIENCE,
      title: "Audience / Chat",
      available: true,
      data: chat
    });
  }
  if (assetsUsed.length || metadata?.endCard) {
    sections.push({
      id: ArtifactSectionId.SHOW_ASSETS,
      title: "Show Assets",
      available: true,
      data: { assetsUsed, endCard: metadata?.endCard || null }
    });
  }
  if (productionActions.length) {
    sections.push({
      id: ArtifactSectionId.RUN_OF_SHOW,
      title: "Run of Show / production markers",
      available: true,
      data: { productionActions }
    });
  }
  if (participants.length) {
    sections.push({
      id: ArtifactSectionId.PARTICIPANTS,
      title: "Participants",
      available: true,
      data: participants
    });
  }

  return {
    session,
    metadata,
    sections,
    deferred: deferredArtifactReport({ hasRecording, manifest })
  };
}

export function deferredArtifactReport({ hasRecording, manifest } = {}) {
  return [
    { artifact: "recording", persistedToday: Boolean(hasRecording), where: "IndexedDB media-store + localStorage room pointer", sessionLinkage: "roomId via toastyMasterRecording:${roomId}", viewableToday: Boolean(hasRecording), deferredIfMissing: !hasRecording },
    { artifact: "audio-only recording", persistedToday: false, where: "not a separate persisted object", sessionLinkage: "none", viewableToday: false, deferredIfMissing: true },
    { artifact: "clips", persistedToday: false, where: "not generated/stored", sessionLinkage: "none", viewableToday: false, deferredIfMissing: true },
    { artifact: "MomentMarkers", persistedToday: Boolean(manifest?.markers?.length), where: "master recording manifest in IndexedDB", sessionLinkage: "manifest.sessionId / roomId", viewableToday: Boolean(manifest?.markers?.length), deferredIfMissing: !manifest?.markers?.length },
    { artifact: "transcript", persistedToday: Boolean(manifest?.transcript), where: "optional field on master manifest (usually empty)", sessionLinkage: "manifest", viewableToday: Boolean(manifest?.transcript), deferredIfMissing: !manifest?.transcript },
    { artifact: "Moxie research", persistedToday: false, where: "in-memory ShowContext during live session only", sessionLinkage: "none after reload", viewableToday: false, deferredIfMissing: true },
    { artifact: "source provenance", persistedToday: Boolean(manifest?.assetsUsed?.length), where: "master manifest assetsUsed when a recording exists", sessionLinkage: "manifest", viewableToday: Boolean(manifest?.assetsUsed?.length), deferredIfMissing: !manifest?.assetsUsed?.length },
    { artifact: "audience chat", persistedToday: Boolean(manifest?.chat), where: "optional master manifest chatRef (usually empty)", sessionLinkage: "manifest", viewableToday: Boolean(manifest?.chat), deferredIfMissing: !manifest?.chat },
    { artifact: "notes / summary / documents", persistedToday: false, where: "post-production markdown is downloaded, not stored per session", sessionLinkage: "none", viewableToday: false, deferredIfMissing: true },
    { artifact: "graphics/assets", persistedToday: Boolean(manifest?.assetsUsed?.length), where: "manifest assetsUsed; end card on live_sessions.end_card_json", sessionLinkage: "session row + manifest", viewableToday: Boolean(manifest?.assetsUsed?.length), deferredIfMissing: !manifest?.assetsUsed?.length },
    { artifact: "Run of Show", persistedToday: false, where: "in-memory RunOfShow on LiveSession", sessionLinkage: "none after reload", viewableToday: false, deferredIfMissing: true },
    { artifact: "participants", persistedToday: Boolean(manifest?.participants?.length), where: "master manifest when recorded; live_sessions only has participantCount at list time", sessionLinkage: "manifest", viewableToday: Boolean(manifest?.participants?.length), deferredIfMissing: !manifest?.participants?.length },
    { artifact: "session metadata", persistedToday: true, where: "live_sessions via /api/sessions", sessionLinkage: "session id", viewableToday: true, deferredIfMissing: false }
  ];
}
