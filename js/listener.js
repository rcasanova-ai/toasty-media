import { applyBrandTheme, normalizeBrandTheme } from "./brand-themes.js";
import { getBrandProfile } from "./brand-profile.js";
import { VideoEngine, getRoomIdFromUrl, isValidRoomId } from "./video-engine.js";
import { ProgramSync } from "./program-sync.js";

// Toasty Studio Program Output — the finished, audience-facing broadcast canvas.
// This page contains ONLY the composited show: no director/guest/camera/scene controls of any kind.
// It is the single feed re-used for the Toasty viewer, tab-capture RTMP broadcasting, and local recording.

const roomId = getRoomIdFromUrl();
const engine = new VideoEngine();
let sync = null;
const mountedTiles = new Map(); // tileKey -> streamId currently mounted in that tile's iframe
let tickerRafId = null;

const elements = {
  canvas: document.querySelector("#poCanvas"),
  brandLogo: document.querySelector("#poBrandLogo"),
  liveBadge: document.querySelector("#poLiveBadge"),
  liveBadgeText: document.querySelector("#poLiveBadgeText"),
  stage: document.querySelector("#poStage"),
  holding: document.querySelector("#poHolding"),
  holdingLogo: document.querySelector("#poHoldingLogo"),
  holdingTopic: document.querySelector("#poHoldingTopic"),
  ending: document.querySelector("#poEnding"),
  endingLogo: document.querySelector("#poEndingLogo"),
  endingCta: document.querySelector("#poEndingCta"),
  liveChip: document.querySelector("#poLiveChip"),
  topic: document.querySelector("#poTopic"),
  ticker: document.querySelector("#poTicker"),
  tickerTrack: document.querySelector("#poTickerTrack"),
  tickerText: document.querySelector("#poTickerText")
};

init();

function init() {
  if (!isValidRoomId(roomId)) {
    document.body.dataset.scene = "holding";
    elements.holdingTopic.textContent = "Invalid Program Output link";
    return;
  }
  applyBrand(normalizeBrandTheme(new URLSearchParams(window.location.search).get("brand")));
  sync = new ProgramSync(roomId);
  const lastState = sync.readLastState();
  if (lastState) render(lastState);
  sync.onMessage((message) => {
    if (message?.type === "state") render(message.payload);
  });
  sync.requestState();
}

function render(programState) {
  if (!programState) return;
  applyBrand(programState.brandTheme);
  document.body.dataset.scene = programState.scene || "holding";

  elements.topic.textContent = programState.topic || "";
  elements.holdingTopic.textContent = programState.topic || elements.holdingTopic.textContent;

  const isLive = Boolean(programState.live);
  elements.liveBadge.dataset.live = String(isLive);
  elements.liveBadgeText.textContent = isLive ? "LIVE" : "ON SET";
  elements.liveChip.hidden = !isLive;

  const tickerOn = Boolean(programState.ticker?.enabled && programState.ticker.text);
  elements.ticker.hidden = !tickerOn;
  if (tickerOn && elements.tickerText.textContent !== programState.ticker.text) {
    elements.tickerText.textContent = programState.ticker.text;
    restartTicker();
  }

  if (programState.scene === "live") {
    renderStage(programState);
  } else {
    clearStage();
  }
}

function renderStage(programState) {
  const seats = Array.isArray(programState.seats) ? programState.seats : [];
  const host = seats.find((seat) => seat.id === "host") || null;
  const activeGuests = seats.filter((seat) => seat.id !== "host" && seat.active);
  const layout = resolveLayout(programState, activeGuests);

  elements.stage.dataset.layout = layout;
  document.body.dataset.layout = layout;

  const tiles = buildTilePlan(layout, host, activeGuests);
  const activeKeys = new Set(tiles.map((tile) => tile.key));
  [...mountedTiles.keys()].filter((key) => !activeKeys.has(key)).forEach(teardownTile);

  elements.stage.replaceChildren(...tiles.map((tile) => buildTileElement(tile)));
}

// Fully disconnects a tile's VDO.Ninja iframe (rather than just detaching it from the DOM) so a
// dropped participant or an inactive scene doesn't keep an invisible connection running.
function teardownTile(key) {
  engine.frames.get(key)?.remove();
  engine.frames.delete(key);
  mountedTiles.delete(key);
}

function resolveLayout(programState, activeGuests) {
  const requested = programState.layout || "auto";
  const needsScreenPartner = requested === "screen-speaker" || requested === "screen-dominant";
  if (needsScreenPartner && activeGuests.length === 0) return "1";
  if (requested !== "auto") return requested;
  if (programState.screenSharing && activeGuests.length > 0) return "screen-speaker";
  return String(Math.min(4, 1 + activeGuests.length));
}

function buildTilePlan(layout, host, activeGuests) {
  if (layout === "screen-speaker" || layout === "screen-dominant") {
    return [
      { key: "host", role: "screen", seat: host, showLowerThird: false },
      { key: activeGuests[0].id, role: "speaker", seat: activeGuests[0], showLowerThird: true }
    ];
  }
  if (layout === "fullmedia") {
    return [{ key: "host", role: "screen", seat: host, showLowerThird: false }];
  }
  const count = Math.max(1, Math.min(4, Number(layout) || 1));
  const speakers = [host, ...activeGuests].filter(Boolean).slice(0, count);
  return speakers.map((seat) => ({ key: seat.id, role: "speaker", seat, showLowerThird: true }));
}

function buildTileElement(tile) {
  const el = document.createElement("article");
  el.className = "po-tile";
  el.dataset.role = tile.role;

  const videoHost = document.createElement("div");
  videoHost.className = "po-tile-video";
  el.appendChild(videoHost);

  if (tile.showLowerThird && tile.seat) {
    const lowerThird = document.createElement("div");
    lowerThird.className = "po-lower-third";
    lowerThird.innerHTML = `<span class="po-lower-third-name"></span><span class="po-lower-third-title"></span>`;
    lowerThird.querySelector(".po-lower-third-name").textContent = tile.seat.name || "";
    const titleEl = lowerThird.querySelector(".po-lower-third-title");
    titleEl.textContent = tile.seat.title || "";
    titleEl.hidden = !tile.seat.title;
    el.appendChild(lowerThird);
  }

  mountTileVideo(videoHost, tile);
  return el;
}

function mountTileVideo(container, tile) {
  const streamId = tile.seat?.streamId;
  if (!streamId) {
    container.classList.add("po-tile-video--empty");
    return;
  }
  if (mountedTiles.get(tile.key) === streamId) {
    // Same stream already mounted for this tile in a previous render; VideoEngine tracks the live
    // iframe by frameId, so pulling it out of the stage and re-appending keeps the connection alive.
    const existing = engine.frames.get(tile.key);
    if (existing) { container.replaceChildren(existing); return; }
  }
  mountedTiles.set(tile.key, streamId);
  engine.mountSoloFrame(container, { roomId, streamId }, tile.key);
}

function clearStage() {
  [...mountedTiles.keys()].forEach(teardownTile);
  elements.stage.replaceChildren();
}

function applyBrand(themeId) {
  const theme = applyBrandTheme(themeId, { root: document.body });
  const brandProfile = getBrandProfile(theme.id);
  [elements.brandLogo, elements.holdingLogo, elements.endingLogo].forEach((img) => {
    if (theme.logoSrc) { img.hidden = false; img.src = theme.logoSrc; img.alt = theme.logoAlt || theme.label; }
    else img.hidden = true;
  });
  elements.endingCta.textContent = brandProfile.defaultCTA
    ? `${brandProfile.defaultCTA}${brandProfile.website ? " · " + brandProfile.website : ""}`
    : theme.label;
}

function restartTicker() {
  if (tickerRafId) cancelAnimationFrame(tickerRafId);
  elements.tickerTrack.style.animation = "none";
  // Force reflow so the restarted CSS animation actually restarts from the beginning.
  void elements.tickerTrack.offsetWidth;
  tickerRafId = requestAnimationFrame(() => { elements.tickerTrack.style.animation = ""; });
}
