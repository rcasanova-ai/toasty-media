import { applyBrandTheme, normalizeBrandTheme } from "./brand-themes.js";
import { getBrandProfile } from "./brand-profile.js";
import { VideoEngine, getRoomIdFromUrl, isValidRoomId } from "./video-engine.js";
import { ProgramSync } from "./program-sync.js";
import { composeProgram } from "./program-composition.js";
import { syncProgramRenderer, clearProgramRenderer } from "./program-renderer.js";
import { ProgramAudioBus, serializeProgramAudio } from "./program-audio.js";

// Toasty Studio Program Output — the finished, audience-facing broadcast canvas.
// This page contains ONLY the composited show: no director/guest/camera/scene controls of any kind.
// It is the single feed re-used for the Toasty viewer, tab-capture RTMP broadcasting, and Master
// Program Recording. Do not render recording chrome here — it would be burned into the master.
//
// Video is the ONE Program Renderer (js/program-renderer.js): composeProgram() + one clean per-person
// source per slot. Producer Program Preview uses the same renderer. VDO is transport only
// (`&room&scene&view=<id>&cleanoutput`) — never a visible scene=0 auto-mix.

const roomId = getRoomIdFromUrl();
const engine = new VideoEngine();
let sync = null;
let tickerRafId = null;
let lastProgramState = null;
const mountedProgramTiles = new Map();
// Browsers block autoplay of unmuted <video> without a user gesture in that frame. Program Output
// carries real (unmuted) program audio on purpose, so participant views are not mounted until the
// operator clicks the audio gate once — see renderLiveStage() and the click handler below.
let audioUnlocked = false;
const programAudio = new ProgramAudioBus({ role: "program" });
let lastAudioPlayId = null;

const elements = {
  canvas: document.querySelector("#poCanvas"),
  brandLogo: document.querySelector("#poBrandLogo"),
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
  programAudio.resume().catch(() => {});
  // Mount now, inside this click's user-activation window, if the show is already live — a render
  // that arrives later without a fresh gesture wouldn't reliably get an unmuted autoplay.
  if (lastProgramState?.scene === "live") renderLiveStage(lastProgramState);
  syncProgramAudio(lastProgramState);
}

function render(programState) {
  if (!programState) return;
  lastProgramState = programState;
  applyBrand(programState.brandTheme);
  document.body.dataset.scene = programState.scene || "holding";

  elements.topic.textContent = programState.topic || "";
  elements.holdingTopic.textContent = programState.topic || elements.holdingTopic.textContent;

  const isLive = Boolean(programState.live);
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
    elements.audioGate.hidden = true;
  }
  syncProgramAudio(programState);
}

function programParticipants(programState) {
  return Array.isArray(programState?.participants) ? programState.participants.filter(Boolean) : [];
}

function isRoomEmpty(programState) {
  if (programState?.asset?.status === "live" || programState?.asset?.id) {
    const composed = composeProgram(programParticipants(programState), {
      asset: programState.asset,
      assetLayout: programState.assetLayout
    });
    if (composed.asset) return false;
  }
  const participants = programParticipants(programState);
  if (participants.length) return composeProgram(participants).slots.length === 0;
  return !programState.hostStarted && !programState.guestCount;
}

function renderLiveStage(programState) {
  if (isRoomEmpty(programState)) {
    clearStage();
    elements.stage.replaceChildren(buildWaitingRoom());
    elements.audioGate.hidden = true;
    return;
  }
  elements.stage.querySelector(".po-waitingroom")?.remove();
  elements.audioGate.hidden = audioUnlocked;
  syncProgramRenderer({
    stage: elements.stage,
    engine,
    roomId,
    participants: programParticipants(programState),
    mounted: mountedProgramTiles,
    frameIdPrefix: "program",
    muted: false,
    videoEnabled: audioUnlocked,
    asset: programState.asset || null,
    assetLayout: programState.assetLayout || null
  });
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
  clearProgramRenderer({ engine, mounted: mountedProgramTiles, stage: elements.stage });
}

function syncProgramAudio(programState) {
  const command = serializeProgramAudio(programState?.audio);
  if (!command) return;
  if (!audioUnlocked) return;
  if (command.action === "STOP_AUDIO") {
    if (lastAudioPlayId) programAudio.stop();
    lastAudioPlayId = null;
    return;
  }
  if (command.playId && command.playId === lastAudioPlayId) return;
  lastAudioPlayId = command.playId;
  programAudio.applyCommand(command).then((result) => {
    if (!result?.ok && result?.reason !== "elapsed" && result?.reason !== "already") {
      lastAudioPlayId = null;
    }
  }).catch(() => {
    lastAudioPlayId = null;
  });
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
