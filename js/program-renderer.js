// ONE Program Renderer — consumes composeProgram() and mounts real per-participant sources.
// Used by Producer Program Preview (director.html, muted) and Preview Live Stream
// (studio/listener.html, unmuted after the audio gate). Same tiles, same lower thirds, same
// 1/2/3/4 layouts. VDO is transport only: each slot is a clean &view=<id> (or a native
// MediaStream when this page already owns it). Never scene=0.

import { composeProgram } from "./program-composition.js";
import { buildParticipantLowerThird, updateParticipantLowerThird } from "./participant-lower-third.js";
import { SourceKind } from "./participant-registry.js";

const LAYOUT_COUNT = Object.freeze({
  single: "1",
  duo: "2",
  trio: "3",
  quad: "4"
});

// JSON-safe participant snapshot for ProgramSync. MediaStreams cannot cross BroadcastChannel.
export function serializeProgramParticipant(participant) {
  if (!participant) return null;
  return {
    participantId: participant.participantId,
    role: participant.role,
    displayName: participant.displayName || "",
    title: participant.title || "",
    company: participant.company || "",
    transportSourceId: participant.transportSourceId || null,
    connectionStatus: participant.connectionStatus,
    onProgram: participant.onProgram !== false,
    joinedAt: participant.joinedAt
  };
}

export function programLayoutCount(layout) {
  return LAYOUT_COUNT[layout] || "";
}

export function syncProgramRenderer({
  stage,
  engine,
  roomId,
  participants = [],
  mounted,
  frameIdPrefix = "program",
  muted = false,
  videoEnabled = true
}) {
  if (!stage || !mounted) return composeProgram(participants);
  const composition = composeProgram(participants);
  stage.dataset.programLayout = composition.layout || "";
  stage.dataset.layout = programLayoutCount(composition.layout);

  const stillPresent = new Set(composition.slots.map((slot) => slot.participantId));
  for (const [participantId, entry] of [...mounted.entries()]) {
    if (stillPresent.has(participantId)) continue;
    unmountProgramSlot(engine, entry);
    entry.tile.remove();
    mounted.delete(participantId);
  }

  composition.slots.forEach((participant) => {
    const existing = mounted.get(participant.participantId);
    const nextSource = slotSourceKey(participant, videoEnabled);
    if (existing) {
      updateParticipantLowerThird(existing.lowerThird, participant);
      if (existing.sourceKey !== nextSource) {
        unmountProgramSlot(engine, existing);
        mountProgramSlotVideo(engine, existing.videoContainer, participant, roomId, existing.frameId, muted, videoEnabled);
        existing.sourceKey = nextSource;
        existing.transportSourceId = participant.transportSourceId || null;
      }
      return;
    }
    const tile = document.createElement("article");
    tile.className = "po-tile";
    tile.dataset.role = "speaker";
    tile.dataset.participantId = participant.participantId;
    const videoContainer = document.createElement("div");
    videoContainer.className = "po-tile-video";
    tile.appendChild(videoContainer);
    const lowerThird = buildParticipantLowerThird(participant);
    tile.appendChild(lowerThird);
    stage.appendChild(tile);
    const frameId = `${frameIdPrefix}-${participant.participantId}`;
    mountProgramSlotVideo(engine, videoContainer, participant, roomId, frameId, muted, videoEnabled);
    mounted.set(participant.participantId, {
      tile,
      videoContainer,
      frameId,
      lowerThird,
      transportSourceId: participant.transportSourceId || null,
      sourceKey: nextSource
    });
  });

  return composition;
}

export function clearProgramRenderer({ engine, mounted, stage }) {
  if (mounted) {
    for (const entry of mounted.values()) {
      unmountProgramSlot(engine, entry);
      entry.tile.remove();
    }
    mounted.clear();
  }
  if (stage) {
    stage.replaceChildren();
    stage.dataset.programLayout = "";
    stage.dataset.layout = "";
  }
}

function slotSourceKey(participant, videoEnabled = true) {
  if (!videoEnabled) return `placeholder:${participant.participantId}`;
  if (participant?.videoSource?.kind === SourceKind.NATIVE_MEDIA_STREAM && participant.videoSource.stream) {
    return `native:${participant.participantId}`;
  }
  return `vdo:${participant?.transportSourceId || ""}`;
}

function mountProgramSlotVideo(engine, container, participant, roomId, frameId, muted, videoEnabled = true) {
  if (!videoEnabled) {
    container.classList.add("po-tile-video--empty");
    container.replaceChildren();
    return;
  }
  if (participant?.videoSource?.kind === SourceKind.NATIVE_MEDIA_STREAM && participant.videoSource.stream) {
    const video = document.createElement("video");
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.srcObject = participant.videoSource.stream;
    container.classList.remove("po-tile-video--empty");
    container.replaceChildren(video);
    return;
  }
  const streamId = participant?.transportSourceId;
  if (!streamId || !engine) {
    container.classList.add("po-tile-video--empty");
    container.replaceChildren();
    return;
  }
  container.classList.remove("po-tile-video--empty");
  engine.mountParticipantView(container, { roomId, streamId, muted }, frameId);
}

function unmountProgramSlot(engine, entry) {
  if (!entry) return;
  if (entry.frameId && engine) engine.unmountFrame(entry.videoContainer, entry.frameId, "");
  else entry.videoContainer?.replaceChildren();
}
