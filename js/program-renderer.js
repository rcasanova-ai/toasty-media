// ONE Program Renderer — consumes composeProgram() and mounts real per-participant sources.
// Used by Producer Program Preview (director.html, muted) and Preview Live Stream
// (studio/listener.html, unmuted after the audio gate). Same tiles, same lower thirds, same
// 1/2/3/4 layouts. VDO is transport only: each slot is a clean &view=<id> (or a native
// MediaStream when this page already owns it). Never scene=0.

import { composeProgram, ProgramLayout, compositionOptionsFromState } from "./program-composition.js";
import { buildParticipantLowerThird, updateParticipantLowerThird } from "./participant-lower-third.js";
import { SourceKind } from "./participant-registry.js";
import { allowlistedImageUrl, sanitizeBroadcastText } from "./program-asset.js";

const LAYOUT_COUNT = Object.freeze({
  single: "1",
  duo: "2",
  trio: "3",
  quad: "4",
  [ProgramLayout.SPOTLIGHT]: ProgramLayout.SPOTLIGHT,
  [ProgramLayout.ACTIVE_SPEAKER]: ProgramLayout.ACTIVE_SPEAKER,
  [ProgramLayout.SCREEN_ONLY]: ProgramLayout.SCREEN_ONLY,
  [ProgramLayout.SCREEN_SPEAKER]: ProgramLayout.SCREEN_SPEAKER,
  [ProgramLayout.SCREEN_STRIP]: ProgramLayout.SCREEN_STRIP,
  [ProgramLayout.ASSET_FULL]: ProgramLayout.ASSET_FULL,
  [ProgramLayout.ASSET_SPEAKER]: ProgramLayout.ASSET_SPEAKER,
  [ProgramLayout.ASSET_SPEAKER_PIP]: ProgramLayout.ASSET_SPEAKER_PIP
});
const REBIND_STALE_MS = 5000;

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

export function inspectSourceHealth(entry) {
  const container = entry?.videoContainer;
  if (!container) return "empty";
  const video = typeof container.querySelector === "function" ? container.querySelector("video") : null;
  if (video) {
    if (video.error) return "failed";
    if (typeof video.readyState === "number") {
      if (video.readyState >= 2 && !video.paused && !video.ended) return "playing";
      if (video.readyState >= 1) return video.ended ? "stalled" : "attached";
      return "stalled";
    }
    return entry.health === "playing" ? "playing" : "attached";
  }
  const iframe = typeof container.querySelector === "function" ? container.querySelector("iframe") : null;
  if (iframe) {
    if (entry?.health === "playing" || entry?.health === "stalled" || entry?.health === "failed" || entry?.health === "ended") return entry.health;
    if (entry?.transportSourceId) return entry.health === "bound" ? "bound" : "binding";
    return "attached";
  }
  if (container.classList?.contains("po-tile-video--empty")) return "empty";
  return "empty";
}

export function programFeedHealth(mounted) {
  const items = [];
  if (!mounted) return { items, playing: 0, attached: 0, stalled: 0, failed: 0, empty: 0, bound: 0, tiles: 0 };
  for (const [participantId, entry] of mounted.entries()) {
    const health = inspectSourceHealth(entry);
    if (entry) entry.health = health;
    items.push({
      participantId,
      health,
      transportSourceId: entry?.transportSourceId || null
    });
  }
  const counts = { playing: 0, attached: 0, stalled: 0, failed: 0, empty: 0 };
  for (const item of items) {
    if (counts[item.health] != null) counts[item.health] += 1;
    else counts.empty += 1;
  }
  const bindings = programFeedBindings(mounted);
  return { items, ...counts, bound: bindings.bound, tiles: bindings.tiles };
}

export function bindProgramSourceHealth(entry) {
  if (!entry?.videoContainer || entry._healthBound) return;
  const video = entry.videoContainer.querySelector?.("video");
  const iframe = entry.videoContainer.querySelector?.("iframe");
  const setHealth = (health) => { entry.health = health; };
  if (video) {
    video.addEventListener("playing", () => setHealth("playing"));
    video.addEventListener("waiting", () => setHealth("stalled"));
    video.addEventListener("stalled", () => setHealth("stalled"));
    video.addEventListener("error", () => setHealth("failed"));
    video.addEventListener("emptied", () => setHealth("empty"));
    entry._healthBound = true;
    entry.health = inspectSourceHealth(entry);
    return;
  }
  if (iframe) {
    iframe.addEventListener("load", () => {
      if (entry.health !== "playing") setHealth("attached");
    });
    iframe.addEventListener("error", () => setHealth("failed"));
    entry._healthBound = true;
    if (entry.health !== "playing") entry.health = "attached";
  }
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
  resolveOwnedStream = null,
  compositionState = null
}) {
  const options = compositionState
    ? compositionOptionsFromState(compositionState)
    : { asset, assetLayout };
  if (!stage || !mounted) return composeProgram(participants, options);
  const composition = composeProgram(participants, options);
  stage.dataset.programLayout = composition.layout || "";
  stage.dataset.layout = programLayoutCount(composition.layout);
  stage.dataset.compositionMode = composition.mode || "";
  stage.dataset.featuredId = composition.featuredId || "";

  syncProgramAssetTile(stage, composition.asset);
  syncProgramScreenTile(stage, composition.screen, {
    engine,
    roomId,
    frameIdPrefix,
    muted,
    videoEnabled,
    resolveOwnedStream,
    mounted
  });

  const stillPresent = new Set(composition.slots.map((slot) => slot.participantId));
  for (const [participantId, entry] of [...mounted.entries()]) {
    if (participantId === "__screen__") continue;
    if (stillPresent.has(participantId)) continue;
    unmountProgramSlot(engine, entry);
    entry.tile.remove();
    mounted.delete(participantId);
  }

  composition.slots.forEach((participant, index) => {
    const existing = mounted.get(participant.participantId);
    const nextSource = slotSourceKey(participant, videoEnabled, resolveOwnedStream, muted);
    const featured = composition.featuredId === participant.participantId || (index === 0 && (composition.layout === ProgramLayout.SPOTLIGHT || composition.layout === ProgramLayout.ACTIVE_SPEAKER));
    if (existing) {
      existing.tile.dataset.role = featured ? "featured" : "speaker";
      updateParticipantLowerThird(existing.lowerThird, participant);
      if (existing.sourceKey !== nextSource || shouldRebindProgramSlot(existing)) {
        unmountProgramSlot(engine, existing);
        mountProgramSlotVideo(engine, existing.videoContainer, participant, roomId, existing.frameId, muted, videoEnabled, resolveOwnedStream);
        existing.sourceKey = nextSource;
        existing.transportSourceId = participant.transportSourceId || null;
        existing._healthBound = false;
        existing.mountedAt = Date.now();
        existing.health = inspectSourceHealth(existing);
        bindProgramSourceHealth(existing);
      } else {
        syncOwnedVideoMute(existing.videoContainer, muted);
        existing.health = inspectSourceHealth(existing);
      }
      return;
    }
    const tile = document.createElement("article");
    tile.className = "po-tile";
    tile.dataset.role = featured ? "featured" : "speaker";
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
      sourceKey: nextSource,
      mountedAt: Date.now(),
      health: inspectSourceHealth({ videoContainer })
    });
    bindProgramSourceHealth(mounted.get(participant.participantId));
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

function syncProgramScreenTile(stage, screen, { engine, roomId, frameIdPrefix, muted, videoEnabled, resolveOwnedStream, mounted }) {
  const existing = mounted.get("__screen__");
  if (!screen) {
    if (existing) {
      unmountProgramSlot(engine, existing);
      existing.tile.remove();
      mounted.delete("__screen__");
    }
    return;
  }
  const fakeParticipant = {
    participantId: screen.participantId,
    role: "screen",
    transportSourceId: screen.transportSourceId,
    videoSource: screen.stream ? { kind: SourceKind.NATIVE_MEDIA_STREAM, stream: screen.stream } : undefined
  };
  const nextSource = slotSourceKey(fakeParticipant, videoEnabled, (participant) => {
    if (resolveOwnedStream) {
      const owned = resolveOwnedStream({ ...participant, role: "screen", participantId: screen.ownerParticipantId || "host" });
      if (owned) return owned;
    }
    return screen.stream || null;
  }, muted);
  if (existing) {
    if (existing.sourceKey !== nextSource || shouldRebindProgramSlot(existing)) {
      unmountProgramSlot(engine, existing);
      mountProgramSlotVideo(engine, existing.videoContainer, fakeParticipant, roomId, existing.frameId, muted, videoEnabled, () => screen.stream || resolveOwnedStream?.({ role: "screen", participantId: screen.ownerParticipantId || "host" }));
      existing.sourceKey = nextSource;
      existing._healthBound = false;
      existing.mountedAt = Date.now();
      existing.health = inspectSourceHealth(existing);
      bindProgramSourceHealth(existing);
    } else {
      syncOwnedVideoMute(existing.videoContainer, muted);
    }
    return;
  }
  const tile = document.createElement("article");
  tile.className = "po-tile po-tile--screen";
  tile.dataset.role = "screen";
  tile.dataset.participantId = screen.participantId;
  const videoContainer = document.createElement("div");
  videoContainer.className = "po-tile-video";
  tile.appendChild(videoContainer);
  stage.insertBefore(tile, stage.querySelector(".po-tile[data-role='featured'], .po-tile[data-role='speaker'], .po-tile[data-role='asset']") || stage.firstChild);
  const frameId = `${frameIdPrefix}-screen`;
  mountProgramSlotVideo(
    engine,
    videoContainer,
    fakeParticipant,
    roomId,
    frameId,
    muted,
    videoEnabled,
    () => screen.stream || resolveOwnedStream?.({ role: "screen", participantId: screen.ownerParticipantId || "host" })
  );
  mounted.set("__screen__", {
    tile,
    videoContainer,
    frameId,
    lowerThird: null,
    transportSourceId: screen.transportSourceId || null,
    sourceKey: nextSource,
    mountedAt: Date.now(),
    health: inspectSourceHealth({ videoContainer })
  });
  bindProgramSourceHealth(mounted.get("__screen__"));
}

function shouldRebindProgramSlot(entry) {
  if (!entry?.transportSourceId) return false;
  const health = inspectSourceHealth(entry);
  if (!["binding", "stalled", "failed", "empty"].includes(health)) return false;
  const mountedAt = Number(entry.mountedAt) || 0;
  return Boolean(mountedAt && Date.now() - mountedAt > REBIND_STALE_MS);
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
  const hottie = asset.createdBy === "hottie" ? document.createElement("p") : null;
  if (hottie) {
    hottie.className = "po-asset-hottie";
    hottie.textContent = "Moxie · AI Producer";
  }
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
    if (hottie) card.appendChild(hottie);
  } else {
    card.append(kicker, title, excerpt, attribution);
    if (hottie) card.appendChild(hottie);
  }
  return card;
}
