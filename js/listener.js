import { applyBrandTheme, normalizeBrandTheme } from "./brand-themes.js?v=studio-20260916d";
import { getBrandProfile } from "./brand-profile.js?v=studio-20260916d";
import { VideoEngine, getRoomIdFromUrl, isValidRoomId } from "./video-engine.js?v=studio-20260916d";
import { ProgramSync } from "./program-sync.js";

// Toasty Studio Program Output — the finished, audience-facing broadcast canvas.
// This page contains ONLY the composited show: no director/guest/camera/scene controls of any kind.
// It is the single feed re-used for the Toasty viewer, tab-capture RTMP broadcasting, and local recording.
//
// The video layer is VDO.Ninja's own auto-mixed room view (scene=0), not an individually-addressed
// per-seat composite. Two per-seat approaches (solo/view, and director-assigned numbered scenes) were
// each implemented and directly tested against real published streams; both failed inside VDO.Ninja
// itself (solo/view hits a cross-origin localStorage bug in VDO.Ninja's own TURN-selection code;
// numbered scenes accept the director's assignment over signaling but never negotiate media to the
// viewer). scene=0 is the one mode that has shown video reliably, every time, including on production.
// Toasty's own branded chrome (logo, LIVE badge, topic, ticker, holding/ending screens) still wraps it.

const roomId = getRoomIdFromUrl();
const engine = new VideoEngine();
let sync = null;
let programMounted = false;
let tickerRafId = null;
let lastProgramState = null;
// Browsers block autoplay of unmuted <video> without a user gesture in that frame. The program frame
// carries real (unmuted) program audio on purpose, so it isn't mounted until the operator clicks the
// audio gate once — see mountProgramVideo() and the click handler below.
let audioUnlocked = false;

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
  tickerText: document.querySelector("#poTickerText"),
  audioGate: document.querySelector("#poAudioGate"),
  poweredBy: document.querySelector("#programPoweredBy")
};

init();

function init() {
  applyBrand(normalizeBrandTheme(new URLSearchParams(window.location.search).get("brand")));
  if (!isValidRoomId(roomId)) {
    document.body.dataset.scene = "holding";
    elements.holdingTopic.textContent = "Invalid Program Output link";
    elements.audioGate.hidden = true;
    return;
  }
  elements.stage.dataset.layout = "1";
  elements.audioGate.addEventListener("click", unlockAudio, { once: true });
  sync = new ProgramSync(roomId);
  const lastState = sync.readLastState();
  if (lastState) render(lastState);
  sync.onMessage((message) => {
    if (message?.type === "state") render(message.payload);
  });
  sync.requestState();
}

function unlockAudio() {
  audioUnlocked = true;
  elements.audioGate.hidden = true;
  // Mount now, inside this click's user-activation window, if the show is already live — a render
  // that arrives later without a fresh gesture wouldn't reliably get an unmuted autoplay.
  if (lastProgramState?.scene === "live") renderLiveStage(lastProgramState);
}

function render(programState) {
  if (!programState) return;
  lastProgramState = programState;
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
    renderLiveStage(programState);
  } else {
    clearStage();
    elements.audioGate.hidden = true; // nothing to unlock on holding/ending — no media playing there
  }
}

// Distinguishes "genuinely nobody has joined yet" from "video is loading" so the audience sees a real
// branded waiting-room instead of a blank frame. hostStarted/guestCount come from Director (see
// publishProgramState) — hostStarted is only true once the host has actually clicked "Start camera &
// microphone", not just because Director's page is open.
function renderLiveStage(programState) {
  const roomEmpty = !programState.hostStarted && !programState.guestCount;
  if (roomEmpty) {
    if (programMounted) clearStage();
    elements.stage.replaceChildren(buildWaitingRoom());
    elements.audioGate.hidden = true; // no real media yet, nothing to unlock
    return;
  }
  elements.audioGate.hidden = audioUnlocked; // real video is due — show the gate until it's clicked
  mountProgramVideo();
}

function mountProgramVideo() {
  if (programMounted) return;
  if (!audioUnlocked) {
    elements.stage.replaceChildren(buildTile(false));
    return;
  }
  programMounted = true;
  const tile = buildTile(true);
  elements.stage.replaceChildren(tile);
  engine.mountProgramFrame(tile.querySelector(".po-tile-video"), { roomId }, "program");
}

function buildTile(withVideo) {
  const el = document.createElement("article");
  el.className = "po-tile";
  el.dataset.role = "speaker";
  const videoHost = document.createElement("div");
  videoHost.className = "po-tile-video";
  if (!withVideo) videoHost.classList.add("po-tile-video--empty");
  el.appendChild(videoHost);
  return el;
}

function buildWaitingRoom() {
  const wrap = document.createElement("div");
  wrap.className = "po-waitingroom";
  [
    { label: "Host", note: "Joining soon" },
    { label: "Guest 1", note: "Open" },
    { label: "Guest 2", note: "Open" },
    { label: "Guest 3", note: "Open" }
  ].forEach((slot) => {
    const card = document.createElement("div");
    card.className = "po-waitingroom-slot";
    card.innerHTML = `
      <span class="po-waitingroom-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8"></path></svg>
      </span>
      <span class="po-waitingroom-label"></span>
      <span class="po-waitingroom-note"></span>
    `;
    card.querySelector(".po-waitingroom-label").textContent = slot.label;
    card.querySelector(".po-waitingroom-note").textContent = slot.note;
    wrap.appendChild(card);
  });
  return wrap;
}

function clearStage() {
  if (programMounted) {
    engine.frames.get("program")?.remove();
    engine.frames.delete("program");
    programMounted = false;
  }
  elements.stage.replaceChildren();
}

function applyBrand(themeId) {
  const theme = applyBrandTheme(themeId, { root: document.body, poweredBy: elements.poweredBy });
  const brandProfile = getBrandProfile(theme.id);
  if (!lastProgramState?.topic) {
    elements.holdingTopic.textContent = theme.textLogo || `${theme.label} Studio`;
    elements.topic.textContent = theme.textLogo || `${theme.label} Studio`;
  }
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
