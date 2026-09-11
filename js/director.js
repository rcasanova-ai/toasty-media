import {
  VideoEngine,
  createDisposableRoomId,
  getOrCreateRoomId,
  getGuestInviteUrl,
  getListenerInviteUrl,
} from "./video-engine.js";
import {
  applyBrandTheme,
  getInitialBrandTheme,
  normalizeBrandTheme,
  saveBrandTheme,
} from "./brand-themes.js";
import { AIProductionController } from "./ai-production.js";
import { LocalIsolatedRecorder } from "./recording.js";
import { Soundboard } from "./soundboard.js";
import { ToastyBroadcastController } from "./broadcast-client.js?v=auth-20260911";

const state = {
  roomId: getOrCreateRoomId(),
  brandTheme: getInitialBrandTheme(),
  micMuted: false,
  cameraOff: false,
  screenSharing: false,
  recordingActive: false,
  recordingStartedAt: null,
  timerId: null,
  recorder: null,
  guestCount: 0
};

const engine = new VideoEngine();

const elements = {
  hostFrame: document.querySelector("#hostFrame"),
  guestFrame: document.querySelector("#guestFrame"),
  sessionDate: document.querySelector("#sessionDate"),
  sessionTime: document.querySelector("#sessionTime"),
  connectionState: document.querySelector("#connectionState"),
  connectionChip: document.querySelector("#connectionChip"),
  hostPanelStatus: document.querySelector("#hostPanelStatus"),
  guestPanelStatus: document.querySelector("#guestPanelStatus"),
  guestStageEmpty: document.querySelector("#guestStageEmpty"),
  participantGuestDot: document.querySelector("#participantGuestDot"),
  participantGuestStatus: document.querySelector("#participantGuestStatus"),
  participantGuest2Dot: document.querySelector("#participantGuest2Dot"),
  participantGuest2Status: document.querySelector("#participantGuest2Status"),
  participantGuest3Dot: document.querySelector("#participantGuest3Dot"),
  participantGuest3Status: document.querySelector("#participantGuest3Status"),
  guestInvite: document.querySelector("#guestInvite"),
  listenerInvite: document.querySelector("#listenerInvite"),
  inviteGuestBtn: document.querySelector("#inviteGuestBtn"),
  copyInvite: document.querySelector("#copyInvite"),
  copyListenerInvite: document.querySelector("#copyListenerInvite"),
  brandThemeSelect: document.querySelector("#brandThemeSelect"),
  studioBrandLogo: document.querySelector("#studioBrandLogo"),
  studioBrandText: document.querySelector("#studioBrandText"),
  poweredBy: document.querySelector("#poweredBy"),
  atmosphereBrandWord: document.querySelector("#atmosphereBrandWord"),
  atmosphereProductWord: document.querySelector("#atmosphereProductWord"),
  newRoom: document.querySelector("#newRoom"),
  toggleMic: document.querySelector("#toggleMic"),
  toggleCamera: document.querySelector("#toggleCamera"),
  toggleScreen: document.querySelector("#toggleScreen"),
  toggleScreenQuick: document.querySelector("#toggleScreenQuick"),
  toggleRecording: document.querySelector("#toggleRecording"),
  recordingState: document.querySelector("#recordingState"),
  recordingLabel: document.querySelector("#recordingLabel"),
  recordingTimer: document.querySelector("#recordingTimer"),
  recordingNote: document.querySelector("#recordingNote"),
  recordingWaveform: document.querySelector("#recordingWaveform"),
  endSession: document.querySelector("#endSession"),
  soundboard: document.querySelector("#soundboard"),
  soundboardVolume: document.querySelector("#soundboardVolume"),
  soundboardTabs: document.querySelector("#soundboardTabs"),
  soundboardSearch: document.querySelector("#soundboardSearch")
};

init();

function init() {
  applySelectedBrand();
  mountRoom();
  bindControls();
  new Soundboard({
    container: elements.soundboard,
    volumeInput: elements.soundboardVolume,
    tabsContainer: elements.soundboardTabs,
    searchInput: elements.soundboardSearch
  });
  new AIProductionController({
    getBrandTheme: () => state.brandTheme,
    onBrandChange: changeBrandThemeFromProduction
  }).init();
  new ToastyBroadcastController({
    getProgramUrl: () => elements.listenerInvite.value,
    requireLegacyAuthGate: false
  }).init();

  engine.onMessage((message) => {
    if (!message) return;
    handleVdoMessage(message);
  });

  window.setInterval(() => engine.requestDetailedState(), 5000);
  if (!LocalIsolatedRecorder.isSupported()) {
    elements.recordingNote.textContent = "Recording is unavailable in this browser. Use current Chrome for the recording proof.";
    elements.toggleRecording.disabled = true;
  }
}

function mountRoom() {
  const now = new Date();
  elements.sessionDate.textContent = formatDate(now);
  elements.sessionTime.textContent = formatClock(now);
  elements.hostPanelStatus.textContent = "Live";
  elements.hostPanelStatus.dataset.state = "connected";
  engine.mountDirectorFrame(elements.hostFrame, {
    roomId: state.roomId,
    label: "Toasty Host"
  });
  engine.mountRoomFrame(elements.guestFrame, { roomId: state.roomId });

  updateInviteAndHistory();
}

function updateInviteAndHistory() {
  elements.guestInvite.value = getGuestInviteUrl(state.roomId, state.brandTheme);
  elements.listenerInvite.value = getListenerInviteUrl(state.roomId, state.brandTheme);
  const url = new URL(window.location.href);
  url.searchParams.set("room", state.roomId);
  url.searchParams.set("brand", state.brandTheme);
  history.replaceState({}, "", url);
}

function bindControls() {
  elements.inviteGuestBtn.addEventListener("click", inviteGuest);
  elements.copyInvite.addEventListener("click", copyInvite);
  elements.copyListenerInvite.addEventListener("click", copyListenerInvite);
  elements.brandThemeSelect.addEventListener("change", changeBrandTheme);
  elements.newRoom.addEventListener("click", createNewRoom);
  elements.toggleMic.addEventListener("click", toggleMic);
  elements.toggleCamera.addEventListener("click", toggleCamera);
  elements.toggleScreen.addEventListener("click", toggleScreen);
  elements.toggleScreenQuick?.addEventListener("click", toggleScreen);
  elements.toggleRecording.addEventListener("click", toggleRecording);
  elements.endSession.addEventListener("click", endSession);
}

function changeBrandTheme() {
  state.brandTheme = normalizeBrandTheme(elements.brandThemeSelect.value);
  saveBrandTheme(state.brandTheme);
  applySelectedBrand();
  updateInviteAndHistory();
}

function changeBrandThemeFromProduction(brandTheme) {
  elements.brandThemeSelect.value = normalizeBrandTheme(brandTheme);
  changeBrandTheme();
}

async function inviteGuest() {
  const url = elements.guestInvite.value;
  if (navigator.share) {
    try {
      await navigator.share({ title: "Join Toasty Studio", url });
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  await copyInvite();
}

async function copyInvite() {
  await navigator.clipboard.writeText(elements.guestInvite.value);
  setLabel(elements.copyInvite, "Copied");
  window.setTimeout(() => {
    setLabel(elements.copyInvite, "Copy Link");
  }, 1400);
}

async function copyListenerInvite() {
  await navigator.clipboard.writeText(elements.listenerInvite.value);
  setLabel(elements.copyListenerInvite, "Copied");
  window.setTimeout(() => {
    setLabel(elements.copyListenerInvite, "Copy Listener Link");
  }, 1400);
}

function createNewRoom() {
  state.roomId = createDisposableRoomId();
  stopRecordingTimer();
  Object.assign(state, {
    micMuted: false,
    cameraOff: false,
    screenSharing: false,
    recordingActive: false,
    recordingStartedAt: null,
    guestCount: 0
  });
  updatePressed(elements.toggleMic, false, "Mute mic", "Unmute mic");
  updatePressed(elements.toggleCamera, false, "Camera off", "Camera on");
  [elements.toggleScreen, elements.toggleScreenQuick].forEach((btn) => {
    if (btn) updatePressed(btn, false, "Share screen", "Stop sharing");
  });
  updateRecordingUi();
  updateGuestPresence(0);
  setConnectionStatus("Ready", "idle");
  mountRoom();
}

function toggleMic() {
  state.micMuted = !state.micMuted;
  engine.setMicrophone(!state.micMuted);
  updatePressed(elements.toggleMic, state.micMuted, "Mute mic", "Unmute mic");
}

function toggleCamera() {
  state.cameraOff = !state.cameraOff;
  engine.setCamera(!state.cameraOff);
  updatePressed(elements.toggleCamera, state.cameraOff, "Camera off", "Camera on");
}

function toggleScreen() {
  state.screenSharing = !state.screenSharing;
  engine.setScreenShare(state.screenSharing);
  [elements.toggleScreen, elements.toggleScreenQuick].forEach((btn) => {
    if (btn) updatePressed(btn, state.screenSharing, "Share screen", "Stop sharing");
  });
}

async function toggleRecording() {
  try {
    if (state.recordingActive) {
      elements.toggleRecording.disabled = true;
      await state.recorder.stop();
      state.recordingActive = false;
      stopRecordingTimer();
      updateRecordingUi();
      elements.toggleRecording.disabled = false;
      return;
    }

    state.recorder = new LocalIsolatedRecorder({
      role: "host",
      roomId: state.roomId,
      status: (message) => {
        elements.recordingNote.textContent = message;
      }
    });
    await state.recorder.start();
    state.recordingActive = true;
    state.recordingStartedAt = Date.now();
    state.timerId = window.setInterval(updateRecordingTimer, 1000);
    updateRecordingUi();
  } catch (error) {
    state.recordingActive = false;
    stopRecordingTimer();
    updateRecordingUi();
    elements.recordingNote.textContent = `Recording failed: ${humanizeError(error)}`;
    elements.toggleRecording.disabled = false;
  }
}

function endSession() {
  engine.disconnectAll();
  stopRecordingTimer();
  state.recordingActive = false;
  updateRecordingUi();
  updateGuestPresence(0);
  setConnectionStatus("Session ended", "idle");
}

function setLabel(button, text) {
  const label = button.querySelector(".btn-label");
  if (label) {
    label.textContent = text;
  } else {
    button.textContent = text;
  }
}

function updatePressed(button, pressed, offLabel, onLabel) {
  const label = pressed ? onLabel : offLabel;
  button.setAttribute("aria-pressed", String(pressed));
  button.setAttribute("title", label);
  const labelEl = button.querySelector(".dock-label");
  if (labelEl) {
    labelEl.textContent = label;
  } else {
    button.textContent = label;
  }
}

function updateRecordingUi() {
  elements.toggleRecording.setAttribute("aria-pressed", String(state.recordingActive));
  elements.toggleRecording.textContent = state.recordingActive ? "Stop recording" : "Start recording";
  elements.recordingState.dataset.active = String(state.recordingActive);
  elements.recordingLabel.textContent = state.recordingActive
    ? "Recording isolated host media locally."
    : "Record the host camera and microphone locally.";
  elements.recordingTimer.hidden = !state.recordingActive;
  elements.recordingWaveform.dataset.active = String(state.recordingActive);
  if (!state.recordingActive && LocalIsolatedRecorder.isSupported()) {
    elements.recordingNote.textContent = "Host track only here. Guest tracks are captured from the guest page.";
  }
  updateRecordingTimer();
}

function updateRecordingTimer() {
  if (!state.recordingStartedAt) {
    elements.recordingTimer.textContent = "00:00:00";
    return;
  }
  const elapsed = Math.floor((Date.now() - state.recordingStartedAt) / 1000);
  const hours = String(Math.floor(elapsed / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");
  elements.recordingTimer.textContent = `${hours}:${minutes}:${seconds}`;
}

function stopRecordingTimer() {
  if (state.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
  state.recordingStartedAt = null;
}

function setConnectionStatus(text, level) {
  elements.connectionState.textContent = text;
  elements.connectionChip.dataset.state = level;
}

function applySelectedBrand() {
  state.brandTheme = normalizeBrandTheme(state.brandTheme);
  elements.brandThemeSelect.value = state.brandTheme;
  applyBrandTheme(state.brandTheme, {
    root: document.body,
    logoImg: elements.studioBrandLogo,
    logoText: elements.studioBrandText,
    poweredBy: elements.poweredBy,
    atmosphereBrandWord: elements.atmosphereBrandWord,
    atmosphereProductWord: elements.atmosphereProductWord
  });
}

function updateGuestPresence(count) {
  state.guestCount = Math.max(0, Math.min(3, count));
  const seats = [
    [elements.participantGuestDot, elements.participantGuestStatus],
    [elements.participantGuest2Dot, elements.participantGuest2Status],
    [elements.participantGuest3Dot, elements.participantGuest3Status]
  ];
  seats.forEach(([dot, label], index) => {
    const occupied = index < state.guestCount;
    dot.dataset.state = occupied ? "active" : "idle";
    label.textContent = occupied ? "Connected" : index === 0 ? "Waiting" : "Open";
  });

  const hasGuests = state.guestCount > 0;
  elements.guestPanelStatus.textContent = hasGuests ? `${state.guestCount} connected` : "Waiting";
  elements.guestPanelStatus.dataset.state = hasGuests ? "connected" : "idle";
  elements.guestStageEmpty.hidden = hasGuests;
}

function handleVdoMessage(message) {
  if (message.action === "push-connection" && message.value === true) {
    setConnectionStatus("Guest connected", "connected");
    updateGuestPresence(state.guestCount + 1);
  } else if (message.action === "push-connection" && message.value === false) {
    setConnectionStatus("Guest disconnected", "idle");
    updateGuestPresence(state.guestCount - 1);
  } else if (message.action === "view-connection" && message.value === false) {
    setConnectionStatus("Viewer disconnected", "idle");
  } else if (message.action || message.getDetailedState) {
    setConnectionStatus("Live", "connected");
  }
}

function humanizeError(error) {
  if (error?.name === "NotAllowedError") return "camera or microphone permission was denied.";
  if (error?.name === "NotFoundError") return "no camera or microphone device was found.";
  if (error?.name === "NotReadableError") return "camera or microphone is already in use or unavailable.";
  return error?.message || "unknown browser recording error.";
}

function formatClock(date) {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDate(date) {
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

updateRecordingUi();
