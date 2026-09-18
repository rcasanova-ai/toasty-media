// Shared "mount N remote participant tiles into a stage container" reconciler — used identically by
// js/live-session.js (Host's participant stage, watching up to 3 Guests) and js/guest.js (a Guest's
// participant stage, watching the Host + up to 2 other Guests). One implementation instead of two
// independently-maintained ones, per this pass's "render from the participant/source collection, not
// guestFrame1/guestFrame2/guestFrame3 special-casing" instruction.
//
// VideoEngine.mountFrame/mountParticipantView replace their ENTIRE container's children on every mount
// (container.replaceChildren(iframe) — see js/video-engine.js) — passing the outer multi-tile stage
// directly would wipe out every OTHER tile on each call. So each remote participant gets its own dedicated
// child <div> that mountParticipantView targets individually; only THAT tile is ever touched when only
// that one participant's stream changes.
import { composeParticipantView, RemoteLayout } from "./program-composition.js";

// stage: the outer container (e.g. #lvGuestFrame's PARENT, or an equivalent — see call sites for what
//   element this actually is on each page). Gets `data-remote-layout` set to drive the CSS grid.
// engine: a VideoEngine instance.
// roomId: current VDO room id.
// participants: full participant list (see js/participant-registry.js's shape) — same list
//   composeProgram/composeParticipantView both read.
// selfParticipantId: whoever THIS stage belongs to (excluded from its own remote tiles).
// mounted: a Map the caller owns and passes back in on every call — this function's only piece of
//   persistent state, tracking participantId -> {tile, frameId} across repeated syncs so it knows what's
//   already mounted and never needs to remount an already-live tile.
// frameIdPrefix: distinct per caller (e.g. "guestview" for Host's stage, "remoteview" for a Guest's) so
//   VideoEngine.frames never collides between the two different stages a single page might have.
// onEmpty: called with the layout when there are zero others (e.g. to show "Waiting for participant" copy)
//   — this module has no opinion on what that empty state looks like, only when it applies.
export function syncParticipantStage({ stage, engine, roomId, participants, selfParticipantId, mounted, frameIdPrefix, onEmpty }) {
  if (!stage) return { layout: RemoteLayout.WAITING, others: [] };
  const composition = composeParticipantView(participants, selfParticipantId);
  stage.dataset.remoteLayout = composition.layout;

  const stillPresent = new Set(composition.others.map((p) => p.participantId));

  // Unmount/remove tiles for anyone no longer in the composition (left, kicked, disconnected).
  for (const [participantId, entry] of [...mounted.entries()]) {
    if (stillPresent.has(participantId)) continue;
    engine.unmountFrame(entry.videoContainer, entry.frameId, "");
    entry.tile.remove();
    mounted.delete(participantId);
  }

  // Mount tiles for anyone newly in the composition, in composition order — appending only NEW tiles
  // (never reordering existing ones) is what keeps everyone else visually stable (see
  // js/program-composition.js's stableOrder comment).
  composition.others.forEach((participant) => {
    if (mounted.has(participant.participantId)) return;
    if (!participant.transportSourceId) return; // presence known but VDO source not resolved yet
    // Two nested elements, not one: mountParticipantView/VideoEngine.mountFrame replaces its ENTIRE
    // container's children on mount (container.replaceChildren(iframe) — see js/video-engine.js), which
    // would wipe out a label placed directly on the same element. The outer .lv-remote-tile is what this
    // module tracks/positions in the grid and never touches again after creating it; the inner .vdo-frame
    // is the ONLY thing mountParticipantView ever sees.
    const tile = document.createElement("div");
    tile.className = "lv-remote-tile";
    tile.dataset.participantId = participant.participantId;
    const videoContainer = document.createElement("div");
    videoContainer.className = "vdo-frame lv-video-tile";
    tile.appendChild(videoContainer);
    const label = document.createElement("div");
    label.className = "lv-remote-tile-label";
    const role = [participant.title, participant.company].filter(Boolean).join(", ");
    label.textContent = [participant.displayName, role].filter(Boolean).join(" · ") || "Participant";
    tile.appendChild(label);
    stage.appendChild(tile);
    const frameId = `${frameIdPrefix}-${participant.participantId}`;
    engine.mountParticipantView(videoContainer, { roomId, streamId: participant.transportSourceId }, frameId);
    mounted.set(participant.participantId, { tile, videoContainer, frameId, transportSourceId: participant.transportSourceId });
  });

  if (composition.others.length === 0 && onEmpty) onEmpty(composition.layout);
  return composition;
}

// Tears down every mounted tile — used on leave/end, mirroring the single-tile unmountFrame call sites
// this replaces.
export function clearParticipantStage({ engine, mounted }) {
  for (const entry of mounted.values()) {
    engine.unmountFrame(entry.videoContainer, entry.frameId, "");
    entry.tile.remove();
  }
  mounted.clear();
}
