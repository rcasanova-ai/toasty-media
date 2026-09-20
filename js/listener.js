import { applyBrandTheme, normalizeBrandTheme } from "./brand-themes.js";
import { getBrandProfile } from "./brand-profile.js";
import { VideoEngine, getRoomIdFromUrl, isValidRoomId } from "./video-engine.js";
import { ProgramSync } from "./program-sync.js";
import { composeProgram, compositionOptionsFromState } from "./program-composition.js";
import { syncProgramRenderer, clearProgramRenderer, programFeedBindings, programFeedHealth } from "./program-renderer.js";
import { ProgramAudioBus, serializeProgramAudio } from "./program-audio.js";
import { ProgramAudioMixer } from "./program-audio-mixer.js";
import { RoomPresence } from "./room-presence.js";
import { studioApiEndpoint } from "./studio-api.js";
import {
  OutputConnection,
  SceneId,
  SourceHealth,
  countFeedHealth,
  normalizeScene
} from "./session-control.js";

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
let lastProgramState = null;
const mountedProgramTiles = new Map();
let audioUnlocked = false;
let audioError = null;
const programAudio = new ProgramAudioBus({ role: "program" });
const programMixer = new ProgramAudioMixer({ bus: programAudio, role: "program" });
let lastAudioPlayId = null;
let statusTimerId = null;
let connection = OutputConnection.CONNECTING;
let connectedAt = null;

const elements = {
  canvas: document.querySelector("#poCanvas"),
  brandLogo: document.querySelector("#poBrandLogo"),
  stage: document.querySelector("#poStage"),
  holding: document.querySelector("#poHolding"),
  holdingLogo: document.querySelector("#poHoldingLogo"),
  holdingTopic: document.querySelector("#poHoldingTopic"),
  brb: document.querySelector("#poBrb"),
  brbLogo: document.querySelector("#poBrbLogo"),
  brbTopic: document.querySelector("#poBrbTopic"),
  ending: document.querySelector("#poEnding"),
  endingLogo: document.querySelector("#poEndingLogo"),
  endingCta: document.querySelector("#poEndingCta"),
  liveChip: document.querySelector("#poLiveChip"),
  topic: document.querySelector("#poTopic"),
  ticker: document.querySelector("#poTicker"),
  tickerTrack: document.querySelector("#poTickerTrack"),
  tickerText: document.querySelector("#poTickerText"),
  audioGate: document.querySelector("#poAudioGate"),
  audioGateLabel: document.querySelector(".po-audio-gate-label"),
  audioGateNote: document.querySelector(".po-audio-gate-note"),
  poweredBy: document.querySelector("#programPoweredBy")
};

init();

async function init() {
  applyBrand(normalizeBrandTheme(new URLSearchParams(window.location.search).get("brand")));
  if (!isValidRoomId(roomId)) {
    document.body.dataset.scene = SceneId.HOLDING;
    elements.holdingTopic.textContent = "Invalid Program Output link";
    elements.audioGate.hidden = true;
    return;
  }
  elements.audioGate.addEventListener("click", unlockAudio);
  engine.onMessage(handleTransportMessage);

  presence = new RoomPresence({
    roomId,
    participantId: outputId,
    role: "output",
    displayName: "Program Output"
  });
  presence.setOutputStatus(outputStatusPayload());
  presence.onControlChange((bundle) => {
    if (bundle.program) render(bundle.program);
  });

  sync = new ProgramSync(roomId);
  const lastState = sync.readLastState();
  if (lastState) render(lastState);
  sync.onMessage((message) => {
    if (message?.type === "state") render(message.payload);
  });
  sync.requestState();

  try {
    const response = await fetch(`${studioApiEndpoint()}/api/presence/room?roomId=${encodeURIComponent(roomId)}`);
    if (response.ok) {
      const data = await response.json();
      if (data.program) render(data.program);
    }
  } catch (_) {}

  connection = OutputConnection.CONNECTING;
  reportOutputStatus();
  const admitted = await presence.start(outputId);
  if (admitted) {
    connection = OutputConnection.CONNECTED;
    connectedAt = Date.now();
    if (presence.program) render(presence.program);
  } else {
    connection = OutputConnection.DISCONNECTED;
  }
  statusTimerId = window.setInterval(reportOutputStatus, 2000);
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

async function unlockAudio() {
  audioError = null;
  const failures = [];
  if (elements.audioGateLabel) elements.audioGateLabel.textContent = "Enabling program audio…";
  if (elements.audioGateNote) elements.audioGateNote.textContent = "Resuming audio, unmuting participant paths, and confirming the Program Audio bus.";

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
  } catch (error) {
    failures.push(`ProgramAudioBus: ${String(error?.message || error)}`);
  }

  if (failures.length) {
    audioUnlocked = false;
    audioError = failures.join(" · ");
    elements.audioGate.hidden = false;
    if (elements.audioGateLabel) elements.audioGateLabel.textContent = "Program audio failed";
    if (elements.audioGateNote) elements.audioGateNote.textContent = audioError;
    reportOutputStatus(true);
    return;
  }

  audioUnlocked = true;
  audioError = null;
  elements.audioGate.hidden = true;
  if (!previous && normalizeScene(lastProgramState?.scene) === SceneId.LIVE) renderLiveStage(lastProgramState);
  syncProgramAudio(lastProgramState);
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

function render(programState) {
  if (!programState) return;
  lastProgramState = programState;
  applyBrand(programState.brandTheme);
  const scene = normalizeScene(programState.scene);
  document.body.dataset.scene = scene;

  elements.topic.textContent = programState.topic || "";
  elements.holdingTopic.textContent = programState.topic || elements.holdingTopic.textContent;
  if (elements.brbTopic) elements.brbTopic.textContent = programState.topic || "We'll be right back";

  const isLive = scene === SceneId.LIVE || Boolean(programState.live);
  elements.liveChip.hidden = !isLive;

  const tickerOn = Boolean(programState.ticker?.enabled && programState.ticker.text);
  elements.ticker.hidden = !tickerOn;
  if (tickerOn && elements.tickerTrack) {
    elements.tickerTrack.style.setProperty("--po-ticker-duration", `${Math.max(8, Math.min(40, Number(programState.ticker?.speed || 16)))}s`);
  }
  if (tickerOn && elements.tickerText.textContent !== programState.ticker.text) {
    elements.tickerText.textContent = programState.ticker.text;
    restartTicker();
  }

  if (scene === SceneId.LIVE) {
    renderLiveStage(programState);
  } else {
    clearStage();
    elements.audioGate.hidden = true;
  }
  syncProgramAudio(programState);
  reportOutputStatus();
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
    elements.audioGate.hidden = true;
    return;
  }
  elements.stage.querySelector(".po-waitingroom")?.remove();
  elements.audioGate.hidden = audioUnlocked;
  if (!audioUnlocked) {
    if (elements.audioGateLabel) {
      elements.audioGateLabel.textContent = audioError ? "Program audio failed" : "Enable program audio";
    }
    if (elements.audioGateNote) {
      elements.audioGateNote.textContent = audioError
        || "Video is already on. Click once so the audience (and the master recording) can hear the room and soundboard.";
    }
  }
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
  const emptyFeeds = health.empty || counts.empty || feeds.empty;
  const videoReady = scene === SceneId.LIVE && expectedFeeds > 0 && playingFeeds === expectedFeeds && emptyFeeds === 0 && !health.failed;
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

function syncProgramAudio(programState) {
  const hostOwned = ownedStreamFor({ role: "host", participantId: "host" });
  if (hostOwned) programMixer.addParticipant({ participantId: "host", stream: hostOwned, label: "Host" });
  programParticipants(programState).forEach((participant) => {
    if (participant.participantId === "host") return;
    const owned = ownedStreamFor(participant);
    programMixer.addParticipant({
      participantId: participant.participantId,
      stream: owned,
      label: participant.displayName,
      transportLimited: !owned
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

function applyBrand(themeId) {
  const theme = applyBrandTheme(themeId, { root: document.body, poweredBy: elements.poweredBy });
  const brandProfile = getBrandProfile(theme.id);
  if (!lastProgramState?.topic) {
    elements.holdingTopic.textContent = theme.textLogo || `${theme.label} Studio`;
    elements.topic.textContent = theme.textLogo || `${theme.label} Studio`;
    if (elements.brbTopic) elements.brbTopic.textContent = "We'll be right back";
  }
  [elements.brandLogo, elements.holdingLogo, elements.brbLogo, elements.endingLogo].forEach((img) => {
    if (!img) return;
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
  void elements.tickerTrack.offsetWidth;
  tickerRafId = requestAnimationFrame(() => { elements.tickerTrack.style.animation = ""; });
}

function outputDiagnosticsSnapshot(buildId) {
  const snap = presence?.snapshot() || {};
  return {
    buildId,
    role: "output",
    roomId,
    sessionId: lastProgramState?.sessionId || snap.sessionId || roomId,
    lifecycle: connection,
    roster: snap.roster || [],
    outputs: snap.outputs || [],
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
    screenShare: lastProgramState?.screenShare || null,
    screenHealth: mountedProgramTiles.get("__screen__")?.health || lastProgramState?.screenShare?.state || "inactive",
    activity: lastProgramState?.audioActivity || [],
    programAudio: programMixer.state()
  };
}

async function startOutputDebugMedia() {
  if (new URLSearchParams(window.location.search).get("debugMedia") !== "1") return;
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
