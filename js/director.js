import {
  VideoEngine,
  createDisposableRoomId,
  getOrCreateRoomId,
  getGuestInviteUrl,
} from "./video-engine.js";
import { LocalIsolatedRecorder } from "./recording.js";
import { Soundboard } from "./soundboard.js";

const state = {
  roomId: getOrCreateRoomId(),
  micMuted: false,
  cameraOff: false,
  screenSharing: false,
  recordingActive: false,
  recordingStartedAt: null,
  timerId: null,
  recorder: null,
  guestConnected: false
};

const engine = new VideoEngine();

const elements = {
  hostFrame: document.querySelector("#hostFrame"),
  guestFrame: document.querySelector("#guestFrame"),
  roomLabel: document.querySelector("#roomLabel"),
  sessionStartedAt: document.querySelector("#sessionStartedAt"),
  connectionState: document.querySelector("#connectionState"),
  connectionChip: document.querySelector("#connectionChip"),
  streamConnectionValue: document.querySelector("#streamConnectionValue"),
  streamFormatValue: document.querySelector("#streamFormatValue"),
  hostPanelStatus: document.querySelector("#hostPanelStatus"),
  guestPanelStatus: document.querySelector("#guestPanelStatus"),
  guestStageEmpty: document.querySelector("#guestStageEmpty"),
  participantGuestDot: document.querySelector("#participantGuestDot"),
  participantGuestStatus: document.querySelector("#participantGuestStatus"),
  guestInvite: document.querySelector("#guestInvite"),
  inviteGuestBtn: document.querySelector("#inviteGuestBtn"),
  copyInvite: document.querySelector("#copyInvite"),
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
  mountRoom();
  bindControls();
  new Soundboard({
    container: elements.soundboard,
    volumeInput: elements.soundboardVolume,
    tabsContainer: elements.soundboardTabs,
    searchInput: elements.soundboardSearch
  });

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
  elements.roomLabel.textContent = state.roomId;
  elements.guestInvite.value = getGuestInviteUrl(state.roomId);
  elements.sessionStartedAt.textContent = formatClock(new Date());
  elements.hostPanelStatus.textContent = "Live";
  elements.hostPanelStatus.dataset.state = "connected";
  engine.mountDirectorFrame(elements.hostFrame, {
    roomId: state.roomId,
    label: "Toasty Host"
  });
  engine.mountRoomFrame(elements.guestFrame, { roomId: state.roomId });

  const url = new URL(window.location.href);
  url.searchParams.set("room", state.roomId);
  history.replaceState({}, "", url);
}

function bindControls() {
  elements.inviteGuestBtn.addEventListener("click", inviteGuest);
  elements.copyInvite.addEventListener("click", copyInvite);
  elements.newRoom.addEventListener("click", createNewRoom);
  elements.toggleMic.addEventListener("click", toggleMic);
  elements.toggleCamera.addEventListener("click", toggleCamera);
  elements.toggleScreen.addEventListener("click", toggleScreen);
  elements.toggleScreenQuick?.addEventListener("click", toggleScreen);
  elements.toggleRecording.addEventListener("click", toggleRecording);
  elements.endSession.addEventListener("click", endSession);
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

function createNewRoom() {
  state.roomId = createDisposableRoomId();
  stopRecordingTimer();
  Object.assign(state, {
    micMuted: false,
    cameraOff: false,
    screenSharing: false,
    recordingActive: false,
    recordingStartedAt: null,
    guestConnected: false
  });
  updatePressed(elements.toggleMic, false, "Mute mic", "Unmute mic");
  updatePressed(elements.toggleCamera, false, "Camera off", "Camera on");
  [elements.toggleScreen, elements.toggleScreenQuick].forEach((btn) => {
    if (btn) updatePressed(btn, false, "Share screen", "Stop sharing");
  });
  updateRecordingUi();
  updateGuestPresence(false, "Waiting");
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
      elements.streamFormatValue.textContent = "—";
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
    elements.streamFormatValue.textContent = state.recorder.mimeType || "—";
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
  updateGuestPresence(false, "Disconnected");
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
  elements.recordingLabel.textContent = state.recordingActive ? "Recording locally" : "Recording idle";
  elements.recordingWaveform.dataset.active = String(state.recordingActive);
  if (!state.recordingActive && LocalIsolatedRecorder.isSupported()) {
    elements.recordingNote.textContent = "Records this host browser's isolated mic and camera to local files.";
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
  elements.streamConnectionValue.textContent = text;
  elements.connectionChip.dataset.state = level;
}

function updateGuestPresence(connected, statusText) {
  state.guestConnected = connected;
  elements.participantGuestDot.dataset.state = connected ? "active" : "idle";
  elements.participantGuestStatus.textContent = statusText;
  elements.guestPanelStatus.textContent = statusText;
  elements.guestPanelStatus.dataset.state = connected ? "connected" : "idle";
  elements.guestStageEmpty.hidden = connected;
}

function handleVdoMessage(message) {
  if (message.action === "push-connection" && message.value === true) {
    setConnectionStatus("Guest connected", "connected");
    updateGuestPresence(true, "Connected");
  } else if (message.action === "push-connection" && message.value === false) {
    setConnectionStatus("Guest disconnected", "idle");
    updateGuestPresence(false, "Disconnected");
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

updateRecordingUi();
