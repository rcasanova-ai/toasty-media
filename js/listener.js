import { applyBrandTheme, normalizeBrandTheme } from "./brand-themes.js";
import { getBrandProfile } from "./brand-profile.js";
import { VideoEngine, getRoomIdFromUrl, isValidRoomId } from "./video-engine.js";
import { ProgramSync } from "./program-sync.js";
import { composeProgram, compositionOptionsFromState } from "./program-composition.js";
import { syncProgramRenderer, clearProgramRenderer, programFeedBindings, programFeedHealth } from "./program-renderer.js";
import { ProgramAudioBus, serializeProgramAudio } from "./program-audio.js";
import { ProgramAudioMixer } from "./program-audio-mixer.js";
import { RoomPresence } from "./room-presence.js";
import { ProgramServerSubscriber } from "./program-server-sync.js";
import { END_CARD_SOCIAL_PLATFORMS, END_CARD_SOCIAL_LABELS, END_CARD_SOCIAL_ICONS } from "./end-card.js";
import { normalizeTickerSpeed, tickerDurationSeconds } from "./program-ticker.js";
import {
  OutputConnection,
  SceneId,
  SourceHealth,
  countFeedHealth,
  normalizeScene
} from "./session-control.js";
import { speakHottieVoiceOnProgram, cancelHottieVoice } from "./hottie-voice.js";

// Toasty Studio Program Output — the finished, audience-facing broadcast canvas.
// This page contains ONLY the composited show: no director/guest/camera/scene controls of any kind.
// It is the single feed re-used for the Toasty viewer, tab-capture RTMP broadcasting, and Master
// Program Recording. Do not render recording chrome here — it would be burned into the master.
//
// Canonical control: RoomPresence role=output joins the SAME live session as Host/Guests/Producer.
// BroadcastChannel may accelerate same-browser Director, but a window opening is not CONNECTED.
// window.opener Host stream is a local optimization only — participant identities come from
// canonical session state.

const roomId = getRoomIdFromUrl();
const outputId = `output-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const engine = new VideoEngine();
let sync = null;
let presence = null;
let tickerRafId = null;
let tickerMeasureRafId = null;
let lastTickerAnimationKey = "";
let lastProgramState = null;
const mountedProgramTiles = new Map();
let audioUnlocked = true;
let audioError = null;
const programAudio = new ProgramAudioBus({ role: "program" });
const programMixer = new ProgramAudioMixer({ bus: programAudio, role: "program" });
let lastAudioPlayId = null;
let lastHottieUtteranceId = null;
let statusTimerId = null;
let serverSync = null;
let lastServerBundle = null;
let lastServerProgramRevision = 0;
let lastServerUpdateAt = null;
let lastProgramSource = "startup";
let lastServerError = "";
let lastInitError = "";
let debugMediaStarted = false;
let connection = OutputConnection.CONNECTING;
let connectedAt = null;
// Declared here (not next to renderSocialLinks() below) so it's initialized before init() ever runs.
// init() calls render() synchronously — via sync.readLastState()'s cached-state render — for any room
// that already has a previously published state in localStorage (i.e. virtually every real session,
// since Director publishes on join, before Program Output is ever opened). render() calls
// renderSocialLinks() in that same synchronous call stack, which starts before the module's remaining
// top-level statements execute — so a `let` declared further down the file was still in its temporal
// dead zone, throwing a ReferenceError that aborted init() before presence.start()/serverSync.start()
// ever ran, permanently freezing Program Output on its initial render with no live sync of any kind.
let lastSocialLinksKey = "";

const elements = {
  canvas: document.querySelector("#poCanvas"),
  chromeTop: document.querySelector("#poChromeTop"),
  chromeBottom: document.querySelector("#poChromeBottom"),
  brandLogo: document.querySelector("#poBrandLogo"),
  stage: document.querySelector("#poStage"),
  holding: document.querySelector("#poHolding"),
  holdingLogo: document.querySelector("#poHoldingLogo"),
  holdingTopic: document.querySelector("#poHoldingTopic"),
  holdingSession: document.querySelector("#poHoldingSession"),
  brb: document.querySelector("#poBrb"),
  brbLogo: document.querySelector("#poBrbLogo"),
  brbTopic: document.querySelector("#poBrbTopic"),
  technical: document.querySelector("#poTechnical"),
  technicalLogo: document.querySelector("#poTechnicalLogo"),
  ending: document.querySelector("#poEnding"),
  endingLogo: document.querySelector("#poEndingLogo"),
  endingHeadline: document.querySelector("#poEndingHeadline"),
  endingMessage: document.querySelector("#poEndingMessage"),
  endingWebsite: document.querySelector("#poEndingWebsite"),
  endingSocials: document.querySelector("#poEndingSocials"),
  endingQr: document.querySelector("#poEndingQr"),
  endingQrImage: document.querySelector("#poEndingQrImage"),
  liveChip: document.querySelector("#poLiveChip"),
  headline: document.querySelector("#poHeadline"),
  sessionName: document.querySelector("#poSessionName"),
  ticker: document.querySelector("#poTicker"),
  tickerTrack: document.querySelector("#poTickerTrack"),
  tickerText: document.querySelector("#poTickerText"),
  socialLinks: document.querySelector("#poSocialLinks"),
  poweredBy: document.querySelector("#programPoweredBy")
};

void startOutputDebugMedia();
init().catch((error) => {
  lastInitError = String(error?.stack || error?.message || error);
  lastServerError = lastInitError;
  console.error("[Program Output] init failed", error);
});

async function init() {
  applyBrand(normalizeBrandTheme(new URLSearchParams(window.location.search).get("brand")));
  if (!isValidRoomId(roomId)) {
    document.body.dataset.scene = SceneId.HOLDING;
    elements.holdingTopic.textContent = "Invalid Program Output link";
    return;
  }
  // No startup "Enable Audio" modal: this page is a broadcast source fed into tab-capture/OBS, not
  // something a human sits and clicks through. Attempt to unlock immediately, and fall back to a silent
  // one-time listener on the next interaction for browsers that require a real gesture first.
  void unlockAudio();
  document.addEventListener("click", unlockAudioOnce, { once: true, capture: true });
  document.addEventListener("keydown", unlockAudioOnce, { once: true, capture: true });
  window.addEventListener("resize", updateTickerFromLastState, { passive: true });
  engine.onMessage(handleTransportMessage);

  presence = new RoomPresence({
    roomId,
    participantId: outputId,
    role: "output",
    displayName: "Program Output"
  });
  presence.setOutputStatus(outputStatusPayload());
  presence.onControlChange((bundle) => {
    consumeServerBundle(bundle, "presence-announce");
  });

  sync = new ProgramSync(roomId);
  const lastState = sync.readLastState();
  if (lastState) render(lastState, "browser-local-cache");
  sync.onMessage((message) => {
    if (message?.type === "state") render(message.payload, "browser-local");
  });
  sync.requestState();

  serverSync = new ProgramServerSubscriber({
    roomId,
    onBundle: (bundle) => {
      lastServerBundle = bundle || null;
    },
    onProgram: (program, meta) => render(program, meta?.source || "server-poll"),
    onError: (error) => {
      lastServerError = error;
    }
  });
  await serverSync.poll({ force: true });
  serverSync.start();

  connection = OutputConnection.CONNECTING;
  reportOutputStatus();
  const admitted = await presence.start(outputId);
  if (admitted) {
    connection = OutputConnection.CONNECTED;
    connectedAt = Date.now();
    if (presence.program) render(presence.program, "presence-admit");
  } else {
    connection = OutputConnection.DISCONNECTED;
  }
  statusTimerId = window.setInterval(() => {
    if (normalizeScene(lastProgramState?.scene) === SceneId.LIVE) renderLiveStage(lastProgramState);
    reportOutputStatus();
  }, 2000);
  reportOutputStatus(true);
  void startOutputDebugMedia();
}

function ownedStreamFor(participant) {
  try {
    const api = window.opener?.__toastyProgramSources;
    if (!api) return null;
    if (typeof api.roomId === "function" && api.roomId() !== roomId) return null;
    if (participant?.role === "screen") {
      const screen = typeof api.screenStream === "function" ? api.screenStream() : null;
      const screenLive = screen?.getVideoTracks?.().some((track) => track.readyState === "live");
      return screenLive ? screen : null;
    }
    if (!participant || (participant.role !== "host" && participant.participantId !== "host")) return null;
    const stream = typeof api.hostStream === "function" ? api.hostStream() : null;
    const videoLive = stream?.getVideoTracks?.().some((track) => track.readyState === "live");
    return videoLive ? stream : null;
  } catch (_) {
    return null;
  }
}

function consumeServerBundle(bundle, source = "server") {
  lastServerBundle = bundle || null;
  if (bundle?.program) render(bundle.program, source);
}

function unlockAudioOnce() {
  if (!audioUnlocked) void unlockAudio();
}

async function unlockAudio() {
  audioError = null;
  const failures = [];

  try {
    const ctx = await programAudio.resume();
    if (ctx?.state !== "running") failures.push(`AudioContext is ${ctx?.state || "unavailable"}`);
  } catch (error) {
    failures.push(`AudioContext: ${String(error?.message || error)}`);
  }

  const previous = audioUnlocked;
  audioUnlocked = failures.length === 0;
  if (normalizeScene(lastProgramState?.scene) === SceneId.LIVE) renderLiveStage(lastProgramState);
  const playFailures = await unmuteParticipantAudio();
  failures.push(...playFailures);
  try {
    syncProgramAudio(lastProgramState);
    syncHottieVoice(lastProgramState);
  } catch (error) {
    failures.push(`ProgramAudioBus: ${String(error?.message || error)}`);
  }

  if (failures.length) {
    audioUnlocked = false;
    audioError = failures.join(" · ");
    reportOutputStatus(true);
    return;
  }

  audioUnlocked = true;
  audioError = null;
  if (!previous && normalizeScene(lastProgramState?.scene) === SceneId.LIVE) renderLiveStage(lastProgramState);
  syncProgramAudio(lastProgramState);
  syncHottieVoice(lastProgramState);
  reportOutputStatus(true);
}

async function unmuteParticipantAudio() {
  const failures = [];
  const videos = [...(elements.stage?.querySelectorAll("video") || [])];
  for (const video of videos) {
    video.muted = false;
    try {
      await video.play();
    } catch (error) {
      failures.push(`participant video play: ${String(error?.message || error)}`);
    }
  }
  return failures;
}

function render(programState, source = "unknown") {
  if (!programState) return;
  lastProgramState = programState;
  lastProgramSource = source;
  if (source.startsWith("server") || source.startsWith("presence")) {
    lastServerProgramRevision = Number(programState.revision) || lastServerProgramRevision || 0;
    lastServerUpdateAt = Date.now();
    lastServerError = "";
  }
  applyBrand(programState.brandTheme);
  const scene = normalizeScene(programState.scene);
  document.body.dataset.scene = scene;

  // Explicit, deterministic scene visibility — do not rely on CSS [data-scene="x"] selectors alone.
  // CSS still does the actual show/hide styling (display:flex/none), but .hidden is the ONE thing this
  // function itself guarantees regardless of any stylesheet: if a future CSS edit ever drops a selector,
  // adds a specificity conflict, or a scene name is ever mistyped, a scene will still explicitly hide
  // every other scene element rather than silently leaving a stale one visible underneath it.
  const isHolding = scene === SceneId.HOLDING;
  const isBrb = scene === SceneId.BRB;
  const isTechnical = scene === SceneId.TECHNICAL_DIFFICULTIES;
  const isEnding = scene === SceneId.ENDING;
  const isLiveScene = scene === SceneId.LIVE;
  if (elements.holding) elements.holding.hidden = !isHolding;
  if (elements.brb) elements.brb.hidden = !isBrb;
  if (elements.technical) elements.technical.hidden = !isTechnical;
  if (elements.ending) elements.ending.hidden = !isEnding;
  // NOT the .hidden attribute here: .po-stage/.po-chrome each have their own unconditional class-level
  // `display` rule (display:grid / display:flex), which — being author-origin CSS — beats the UA
  // stylesheet's [hidden]{display:none} rule regardless of specificity tie-breaking (author origin always
  // outranks UA origin at equal specificity). Setting .hidden here would silently do nothing, the exact
  // "looks like it should work, doesn't" trap this codebase has hit before. Inline style wins over any
  // class selector unconditionally, so it's what actually forces the outcome deterministically.
  const stageVisibility = isLiveScene ? "" : "hidden";
  if (elements.stage) elements.stage.style.visibility = stageVisibility;
  if (elements.chromeTop) elements.chromeTop.style.visibility = stageVisibility;
  if (elements.chromeBottom) elements.chromeBottom.style.visibility = stageVisibility;

  if (elements.headline) elements.headline.textContent = programState.topic || "";
  if (elements.sessionName) {
    elements.sessionName.hidden = !programState.sessionTitle;
    elements.sessionName.textContent = programState.sessionTitle || "";
  }
  elements.holdingTopic.textContent = programState.topic || elements.holdingTopic.textContent;
  if (elements.holdingSession) {
    elements.holdingSession.hidden = !programState.sessionTitle;
    elements.holdingSession.textContent = programState.sessionTitle || "";
  }
  if (elements.brbTopic) elements.brbTopic.textContent = programState.topic || "We'll be right back";
  renderSocialLinks(programState.endCard);

  const isLive = scene === SceneId.LIVE || Boolean(programState.live);
  elements.liveChip.hidden = !isLive;

  const tickerOn = Boolean(programState.ticker?.enabled && programState.ticker.text);
  elements.ticker.hidden = !tickerOn;
  if (tickerOn) renderTicker(programState.ticker);
  else lastTickerAnimationKey = "";

  if (scene === SceneId.LIVE) {
    renderLiveStage(programState);
  } else {
    clearStage();
  }
  if (scene === SceneId.ENDING) renderEndCard(programState.endCard);
  syncProgramAudio(programState);
  syncHottieVoice(programState);
  reportOutputStatus();
}

// programState.endCard already arrives fully resolved (session override -> profile default -> tasteful
// fallback all happen Producer-side in LiveSession.canonicalControlState/resolveEndCard) — Program Output
// just renders whatever it's handed.
function renderEndCard(endCard) {
  if (!endCard) return;
  if (elements.endingHeadline) elements.endingHeadline.textContent = endCard.headline || "Thanks for watching";
  if (elements.endingMessage) {
    elements.endingMessage.hidden = !endCard.message;
    elements.endingMessage.textContent = endCard.message || "";
  }
  if (elements.endingWebsite) {
    elements.endingWebsite.hidden = !endCard.website;
    elements.endingWebsite.textContent = endCard.website || "";
  }
  if (elements.endingSocials) {
    const entries = END_CARD_SOCIAL_PLATFORMS.map((platform) => [platform, endCard.socials?.[platform]]).filter(([, url]) => url);
    elements.endingSocials.hidden = entries.length === 0;
    elements.endingSocials.replaceChildren(...entries.map(([platform, url]) => {
      const link = document.createElement("span");
      link.className = "po-ending-social";
      link.dataset.platform = platform;
      link.title = END_CARD_SOCIAL_LABELS[platform] || platform;
      link.innerHTML = END_CARD_SOCIAL_ICONS[platform] || "";
      void url; // Program Output is a broadcast source, not a clickable page — the URL is shown for context only.
      return link;
    }));
  }
  if (elements.endingQr && elements.endingQrImage) {
    const showQr = Boolean(endCard.showQr && endCard.qrImage);
    elements.endingQr.hidden = !showQr;
    elements.endingQrImage.src = showQr ? endCard.qrImage : "";
  }
}

// Real, functional <a> links (not decorative) — genuinely clickable if someone opens Program Output
// directly in a browser, harmless and simply not clicked if this page is being captured for
// tab-capture/recording/OBS instead. Small and bottom-right so they never compete with the broadcast
// composition; only populated platforms render, and the whole region collapses to nothing when the
// resolved end card has no socials at all — no permanent dead space, no placeholder icons.
// (lastSocialLinksKey is declared near the top of the file — see the comment there for why.)
function renderSocialLinks(endCard) {
  if (!elements.socialLinks) return;
  const entries = END_CARD_SOCIAL_PLATFORMS.map((platform) => [platform, endCard?.socials?.[platform]]).filter(([, url]) => url);
  const key = entries.map(([platform, url]) => `${platform}:${url}`).join("|");
  elements.socialLinks.hidden = entries.length === 0;
  if (key === lastSocialLinksKey) return;
  lastSocialLinksKey = key;
  elements.socialLinks.replaceChildren(...entries.map(([platform, url]) => {
    const link = document.createElement("a");
    link.className = "po-social-link";
    link.dataset.platform = platform;
    link.href = /^https?:\/\//.test(url) ? url : `https://${url}`;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = END_CARD_SOCIAL_LABELS[platform] || platform;
    link.innerHTML = END_CARD_SOCIAL_ICONS[platform] || "";
    return link;
  }));
}

function programParticipants(programState) {
  return Array.isArray(programState?.participants) ? programState.participants.filter(Boolean) : [];
}

function isRoomEmpty(programState) {
  const options = compositionOptionsFromState(programState);
  if (programState?.asset?.status === "live" || programState?.asset?.id) {
    const composed = composeProgram(programParticipants(programState), options);
    if (composed.asset) return false;
  }
  if (options.screenShareActive) return false;
  const participants = programParticipants(programState);
  if (participants.length) return composeProgram(participants, options).slots.length === 0;
  return !programState.hostStarted && !programState.guestCount;
}

function renderLiveStage(programState) {
  if (isRoomEmpty(programState)) {
    clearStage();
    elements.stage.replaceChildren(buildWaitingRoom());
    return;
  }
  elements.stage.querySelector(".po-waitingroom")?.remove();
  syncProgramRenderer({
    stage: elements.stage,
    engine,
    roomId,
    participants: programParticipants(programState),
    mounted: mountedProgramTiles,
    frameIdPrefix: "program",
    muted: !audioUnlocked,
    videoEnabled: true,
    asset: programState.asset || null,
    assetLayout: programState.assetLayout || null,
    resolveOwnedStream: ownedStreamFor,
    compositionState: programState
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

function handleTransportMessage(message) {
  if (!message) return;
  if (message.action !== "view-connection" || message.value === false) return;
  const streamId = message.streamID || message.streamId || message.UUID || message.target || null;
  if (!streamId) return;
  for (const entry of mountedProgramTiles.values()) {
    if (entry.transportSourceId === streamId) entry.health = SourceHealth.PLAYING;
  }
  reportOutputStatus();
}

function outputStatusPayload() {
  const participants = programParticipants(lastProgramState);
  const composition = composeProgram(participants, compositionOptionsFromState(lastProgramState));
  const feeds = programFeedBindings(mountedProgramTiles);
  const health = programFeedHealth(mountedProgramTiles);
  const counts = countFeedHealth(health.items);
  const scene = normalizeScene(lastProgramState?.scene);
  const expectedFeeds = composition.slots.length;
  const playingFeeds = health.playing || counts.playing || 0;
  const readyFeeds = (health.items || []).filter((item) => item.health === SourceHealth.PLAYING || item.health === "attached" || item.health === "bound").length;
  const emptyFeeds = health.empty || counts.empty || feeds.empty;
  const videoReady = scene === SceneId.LIVE && expectedFeeds > 0 && readyFeeds === expectedFeeds && emptyFeeds === 0 && !health.failed;
  const audioReady = Boolean(audioUnlocked) && !audioError;
  return {
    outputId,
    sessionId: lastProgramState?.sessionId || roomId,
    roomId,
    connection,
    connected: connection === OutputConnection.CONNECTED,
    connectedAt,
    updatedAt: Date.now(),
    scene,
    live: scene === SceneId.LIVE,
    expectedFeeds,
    boundFeeds: feeds.bound,
    playingFeeds,
    readyFeeds,
    emptyFeeds,
    stalledFeeds: health.stalled || counts.stalled || 0,
    failedFeeds: health.failed || counts.failed || 0,
    sourceHealth: health.items,
    audioEnabled: audioReady,
    audioUnlocked: audioReady,
    audioError,
    videoReady,
    audioReady,
    programAudio: programMixer.state(),
    readyToRecord: connection === OutputConnection.CONNECTED && videoReady && audioReady && scene === SceneId.LIVE
  };
}

function reportOutputStatus(immediate = false) {
  const payload = outputStatusPayload();
  presence?.setOutputStatus(payload);
  sync?.publishOutputStatus(payload);
  if (immediate) presence?.publishNow();
}

// ROOT CAUSE of "severe echo/doubled audio" in every tab-capture recording: this used to pass
// ownedStreamFor()'s native MediaStream (the SAME physical mic the Director's own push frame already
// publishes into the VDO room) into programMixer.addParticipant(), which
// connectStream()s it into ProgramAudioBus -> ctx.destination. But Program Output's own room/scene
// VDO iframe (video-engine.js, deliberately unmuted) ALREADY autoplays that same person's voice into
// this tab's audio destination — that's the whole point of it being unmuted. Wiring the owned
// stream's audio in too meant every host/participant voice reached the tab's speakers (and therefore
// any tab-audio-share recording) twice, through two different-latency paths, producing a phasing/echo
// doubling. ownedStreamFor() stays video-only (see renderLiveStage's resolveOwnedStream below) —
// every participant's audio, including Host, arrives exclusively via that VDO iframe's own autoplay.
function syncProgramAudio(programState) {
  programMixer.addParticipant({ participantId: "host", label: "Host", transportLimited: true });
  programParticipants(programState).forEach((participant) => {
    if (participant.participantId === "host") return;
    programMixer.addParticipant({
      participantId: participant.participantId,
      label: participant.displayName,
      transportLimited: true
    });
  });
  const command = serializeProgramAudio(programState?.audio);
  if (!command) return;
  if (!audioUnlocked) return;
  if (command.action === "STOP_AUDIO") {
    if (lastAudioPlayId) programMixer.stopBus();
    lastAudioPlayId = null;
    return;
  }
  if (command.playId && command.playId === lastAudioPlayId) return;
  lastAudioPlayId = command.playId;
  programMixer.applyBusCommand(command).then((result) => {
    if (!result?.ok && result?.reason !== "elapsed" && result?.reason !== "already") {
      lastAudioPlayId = null;
      audioError = result?.reason || "ProgramAudioBus play failed";
      reportOutputStatus(true);
    }
  }).catch((error) => {
    lastAudioPlayId = null;
    audioError = String(error?.message || error);
    reportOutputStatus(true);
  });
}

function syncHottieVoice(programState) {
  const voice = programState?.hottieVoice;
  if (!voice?.speak || !String(voice.text || "").trim()) {
    if (lastHottieUtteranceId) {
      cancelHottieVoice();
      lastHottieUtteranceId = null;
    }
    return;
  }
  if (!audioUnlocked) return;
  if (voice.utteranceId && voice.utteranceId === lastHottieUtteranceId) return;
  lastHottieUtteranceId = voice.utteranceId || voice.text;
  speakHottieVoiceOnProgram(voice);
}

function applyBrand(themeId) {
  const theme = applyBrandTheme(themeId, { root: document.body, poweredBy: elements.poweredBy });
  const brandProfile = getBrandProfile(theme.id);
  const programMark = theme.compactMark || (theme.id === "peeps" ? "../shared/brand/toasty-media/ToastyTransparent.png" : theme.logoSrc);
  if (!lastProgramState?.topic) {
    elements.holdingTopic.textContent = theme.textLogo || `${theme.label} Studio`;
    if (elements.headline) elements.headline.textContent = theme.textLogo || `${theme.label} Studio`;
    if (elements.brbTopic) elements.brbTopic.textContent = "We'll be right back";
  }
  [elements.brandLogo, elements.holdingLogo, elements.brbLogo, elements.technicalLogo, elements.endingLogo].forEach((img) => {
    if (!img) return;
    if (programMark) { img.hidden = false; img.src = programMark; img.alt = theme.logoAlt || theme.label; }
    else img.hidden = true;
  });
  // Fallback only for the instant before the first real programState.endCard arrives — renderEndCard
  // (called from render() on every update) is the actual source of truth once program state exists.
  if (!lastProgramState?.endCard) {
    elements.endingHeadline.textContent = brandProfile.defaultCTA
      ? `${brandProfile.defaultCTA}${brandProfile.website ? " · " + brandProfile.website : ""}`
      : theme.label;
  }
}

function renderTicker(ticker) {
  if (!elements.ticker || !elements.tickerTrack || !elements.tickerText) return;
  const text = String(ticker?.text || "");
  const speed = normalizeTickerSpeed(ticker?.speed);
  if (elements.tickerText.textContent !== text) elements.tickerText.textContent = text;
  scheduleTickerMetrics(speed, text);
}

function updateTickerFromLastState() {
  if (!lastProgramState?.ticker?.enabled || !lastProgramState.ticker.text) return;
  renderTicker(lastProgramState.ticker);
}

function scheduleTickerMetrics(speed, text) {
  if (tickerMeasureRafId) cancelAnimationFrame(tickerMeasureRafId);
  applyTickerMetrics(speed, text);
  tickerMeasureRafId = requestAnimationFrame(() => {
    tickerMeasureRafId = null;
    applyTickerMetrics(speed, text);
  });
}

function applyTickerMetrics(speed, text) {
  if (!elements.ticker || !elements.tickerTrack || !elements.tickerText) return;
  const viewportWidth = elements.ticker.clientWidth || elements.ticker.getBoundingClientRect?.().width || 0;
  const textWidth = elements.tickerText.scrollWidth || elements.tickerText.getBoundingClientRect?.().width || 0;
  const duration = tickerDurationSeconds({ speed, viewportWidth, textWidth });
  const roundedDuration = Math.round(duration * 10) / 10;
  const start = Math.ceil(viewportWidth);
  const end = -Math.ceil(textWidth);
  elements.tickerTrack.style.setProperty("--po-ticker-duration", `${roundedDuration}s`);
  elements.tickerTrack.style.setProperty("--po-ticker-start", `${start}px`);
  elements.tickerTrack.style.setProperty("--po-ticker-end", `${end}px`);
  const animationKey = `${text}|${speed}|${roundedDuration}|${start}|${end}`;
  if (animationKey !== lastTickerAnimationKey) {
    lastTickerAnimationKey = animationKey;
    restartTicker();
  }
}

function restartTicker() {
  if (!elements.tickerTrack) return;
  if (tickerRafId) cancelAnimationFrame(tickerRafId);
  elements.tickerTrack.style.animation = "none";
  void elements.tickerTrack.offsetWidth;
  tickerRafId = requestAnimationFrame(() => { elements.tickerTrack.style.animation = ""; });
}

function outputDiagnosticsSnapshot(buildId) {
  const snap = presence?.snapshot() || {};
  const participants = programParticipants(lastProgramState);
  const host = participants.find((entry) => entry.role === "host" || entry.participantId === "host") || null;
  const guests = participants.filter((entry) => entry.role === "guest" || entry.participantId !== "host");
  return {
    buildId,
    role: "output",
    roomId,
    sessionId: lastProgramState?.sessionId || snap.sessionId || roomId,
    lifecycle: connection,
    server: {
      connected: !lastServerError,
      lastError: lastServerError || null,
      initError: lastInitError || null,
      entrypoint: "studio/listener.html",
      subscriber: serverSync ? "CREATED" : "NOT CREATED",
      pollCount: serverSync?.pollCount || 0,
      lastPollHttpStatus: serverSync?.lastHttpStatus ?? null,
      lastUpdateAt: lastServerUpdateAt || serverSync?.lastUpdateAt || null,
      programRevision: lastServerProgramRevision || lastProgramState?.revision || 0,
      programSource: lastProgramSource,
      scene: normalizeScene(lastProgramState?.scene),
      participantCount: participants.length,
      hostSourceId: host?.transportSourceId || null,
      guestSourceIds: guests.map((entry) => ({ participantId: entry.participantId, transportSourceId: entry.transportSourceId || null })),
      screenSourceId: lastProgramState?.screenShare?.transportSourceId || null
    },
    roster: snap.roster || [],
    outputs: snap.outputs || [],
    serverRoster: lastServerBundle?.roster || [],
    serverOutputs: lastServerBundle?.outputs || [],
    presence: snap,
    self: {
      participantId: outputId,
      presenceState: snap.presenceState || "idle",
      heartbeatStatus: snap.heartbeatStatus || "idle",
      lastHttpStatus: snap.lastHttpStatus,
      lastAnnounceAt: snap.lastAnnounceAt || null,
      lastSeenAt: snap.lastAnnounceAt || null,
      rosterContainsSelf: snap.rosterContainsSelf === true,
      transportSourceId: outputId,
      publisherSourceId: outputId,
      videoTrack: { readyState: "n/a" },
      audioTrack: { readyState: audioUnlocked ? "unlocked" : "gated" },
      transportState: connection
    },
    remotes: (snap.roster || []).map((entry) => ({
      participantId: entry.participantId,
      role: entry.role,
      requestedSourceId: entry.transportSourceId,
      mounted: mountedProgramTiles.has(entry.participantId),
      mediaState: mountedProgramTiles.get(entry.participantId)?.health || "presence",
      lastSeenAt: entry.lastSeenAt || null,
      audioLevel: entry.audioActivity?.audioLevel ?? 0,
      speaking: Boolean(entry.audioActivity?.speaking)
    })),
    programBindings: programFeedBindings(mountedProgramTiles),
    programHealth: programFeedHealth(mountedProgramTiles),
    screenShare: lastProgramState?.screenShare || null,
    screenHealth: mountedProgramTiles.get("__screen__")?.health || lastProgramState?.screenShare?.state || "inactive",
    activity: lastProgramState?.audioActivity || [],
    programAudio: programMixer.state()
  };
}

async function startOutputDebugMedia() {
  if (debugMediaStarted) return;
  if (new URLSearchParams(window.location.search).get("debugMedia") !== "1") return;
  debugMediaStarted = true;
  try {
    const [{ startMediaDiagnostics }, { BUILD_ID }] = await Promise.all([
      import("./media-diagnostics.js"),
      import("./build-info.js")
    ]);
    startMediaDiagnostics(() => {
      try {
        return outputDiagnosticsSnapshot(BUILD_ID);
      } catch (error) {
        console.error("[Program Output] debugMedia snapshot failed", error);
        return { role: "output", error: String(error?.message || error) };
      }
    });
  } catch (error) {
    console.error("[Program Output] debugMedia failed open; output continues", error);
  }
}
