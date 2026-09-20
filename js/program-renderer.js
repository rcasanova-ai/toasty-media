// ONE Program Renderer — consumes composeProgram() and mounts real per-participant sources.
// Used by Producer Program Preview (director.html, muted) and Preview Live Stream
// (studio/listener.html, unmuted after the audio gate). Same tiles, same lower thirds, same
// 1/2/3/4 layouts. VDO is transport only: each slot is a clean &view=<id> (or a native
// MediaStream when this page already owns it). Never scene=0.

import { composeProgram, ProgramLayout } from "./program-composition.js";
import { buildParticipantLowerThird, updateParticipantLowerThird } from "./participant-lower-third.js";
import { SourceKind } from "./participant-registry.js";
import { allowlistedImageUrl, sanitizeBroadcastText } from "./program-asset.js";

const LAYOUT_COUNT = Object.freeze({
  single: "1",
  duo: "2",
  trio: "3",
  quad: "4",
  [ProgramLayout.ASSET_FULL]: ProgramLayout.ASSET_FULL,
  [ProgramLayout.ASSET_SPEAKER]: ProgramLayout.ASSET_SPEAKER,
  [ProgramLayout.ASSET_SPEAKER_PIP]: ProgramLayout.ASSET_SPEAKER_PIP
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
  return LAYOUT_COUNT[layout] || layout || "";
}

export function programFeedBindings(mounted) {
  let bound = 0;
  let empty = 0;
  if (!mounted) return { bound: 0, empty: 0, tiles: 0 };
  for (const entry of mounted.values()) {
    const container = entry.videoContainer;
    const hasSource = Boolean(container?.querySelector("iframe, video"));
    const isEmpty = container?.classList.contains("po-tile-video--empty");
    if (hasSource && !isEmpty) bound += 1;
    else empty += 1;
  }
  return { bound, empty, tiles: mounted.size };
}

export function syncProgramRenderer({
  stage,
  engine,
  roomId,
  participants = [],
  mounted,
  frameIdPrefix = "program",
  muted = false,
  videoEnabled = true,
  asset = null,
  assetLayout = null,
  resolveOwnedStream = null
}) {
  if (!stage || !mounted) return composeProgram(participants, { asset, assetLayout });
  const composition = composeProgram(participants, { asset, assetLayout });
  stage.dataset.programLayout = composition.layout || "";
  stage.dataset.layout = programLayoutCount(composition.layout);

  syncProgramAssetTile(stage, composition.asset);

  const stillPresent = new Set(composition.slots.map((slot) => slot.participantId));
  for (const [participantId, entry] of [...mounted.entries()]) {
    if (stillPresent.has(participantId)) continue;
    unmountProgramSlot(engine, entry);
    entry.tile.remove();
    mounted.delete(participantId);
  }

  composition.slots.forEach((participant) => {
    const existing = mounted.get(participant.participantId);
    const nextSource = slotSourceKey(participant, videoEnabled, resolveOwnedStream, muted);
    if (existing) {
      updateParticipantLowerThird(existing.lowerThird, participant);
      if (existing.sourceKey !== nextSource) {
        unmountProgramSlot(engine, existing);
        mountProgramSlotVideo(engine, existing.videoContainer, participant, roomId, existing.frameId, muted, videoEnabled, resolveOwnedStream);
        existing.sourceKey = nextSource;
        existing.transportSourceId = participant.transportSourceId || null;
      } else {
        syncOwnedVideoMute(existing.videoContainer, muted);
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
    mountProgramSlotVideo(engine, videoContainer, participant, roomId, frameId, muted, videoEnabled, resolveOwnedStream);
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

function slotSourceKey(participant, videoEnabled = true, resolveOwnedStream = null, muted = false) {
  if (!videoEnabled) return `placeholder:${participant.participantId}`;
  if (resolveOwnedStream?.(participant)) return `owned:${participant.participantId}`;
  if (participant?.videoSource?.kind === SourceKind.NATIVE_MEDIA_STREAM && participant.videoSource.stream) {
    return `native:${participant.participantId}`;
  }
  return `vdo:${participant?.transportSourceId || ""}:${muted ? "muted" : "unmuted"}`;
}

function syncOwnedVideoMute(container, muted) {
  container?.querySelectorAll("video").forEach((video) => {
    video.muted = Boolean(muted);
    if (!muted) video.play?.().catch(() => {});
  });
}

function mountNativeProgramVideo(container, stream, muted) {
  const video = document.createElement("video");
  video.autoplay = true;
  video.muted = Boolean(muted);
  video.playsInline = true;
  video.srcObject = stream;
  video.play?.().catch(() => {});
  container.classList.remove("po-tile-video--empty");
  container.replaceChildren(video);
}

function mountProgramSlotVideo(engine, container, participant, roomId, frameId, muted, videoEnabled = true, resolveOwnedStream = null) {
  if (!videoEnabled) {
    container.classList.add("po-tile-video--empty");
    container.replaceChildren();
    return;
  }
  const owned = resolveOwnedStream?.(participant);
  if (owned) {
    mountNativeProgramVideo(container, owned, muted);
    return;
  }
  if (participant?.videoSource?.kind === SourceKind.NATIVE_MEDIA_STREAM && participant.videoSource.stream) {
    mountNativeProgramVideo(container, participant.videoSource.stream, muted);
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

function syncProgramAssetTile(stage, asset) {
  const existing = stage.querySelector(".po-tile[data-role='asset']");
  if (!asset) {
    existing?.remove();
    return;
  }
  const nextKey = `${asset.id}:${asset.title}:${asset.sourceUrl}`;
  if (existing?.dataset.assetKey === nextKey) return;
  existing?.remove();
  const tile = document.createElement("article");
  tile.className = "po-tile po-tile--asset";
  tile.dataset.role = "asset";
  tile.dataset.assetId = asset.id || "";
  tile.dataset.assetKey = nextKey;
  tile.appendChild(buildProgramAssetCard(asset));
  stage.insertBefore(tile, stage.firstChild);
}

export function buildProgramAssetCard(asset) {
  const card = document.createElement("div");
  card.className = "po-asset-card";
  const kicker = document.createElement("p");
  kicker.className = "po-asset-kicker";
  kicker.textContent = sanitizeBroadcastText(asset.sourceName || asset.attribution || "Source", 80);
  const title = document.createElement("h2");
  title.className = "po-asset-title";
  title.textContent = sanitizeBroadcastText(asset.title || "", 180);
  const excerpt = document.createElement("p");
  excerpt.className = "po-asset-excerpt";
  excerpt.textContent = sanitizeBroadcastText(asset.excerpt || asset.preview?.excerpt || "", 280);
  const attribution = document.createElement("p");
  attribution.className = "po-asset-attribution";
  const domain = asset.provenance?.domain || "";
  attribution.textContent = [asset.attribution || asset.sourceName, domain].filter(Boolean).join(" · ");
  const imageUrl = allowlistedImageUrl(asset.preview?.imageUrl || asset.media?.src);
  if (imageUrl) {
    const figure = document.createElement("div");
    figure.className = "po-asset-visual";
    const img = document.createElement("img");
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.src = imageUrl;
    figure.appendChild(img);
    card.append(figure, kicker, title, excerpt, attribution);
  } else {
    card.append(kicker, title, excerpt, attribution);
  }
  return card;
}
