import {
  VideoEngine,
  createDisposableRoomId,
  getGuestInviteUrl,
  getRoomIdFromUrl
} from "./video-engine.js";
import { LocalIsolatedRecorder } from "./recording.js";
import { Soundboard } from "./soundboard.js";

const state = {
  roomId: getRoomIdFromUrl() || createDisposableRoomId(),
  micMuted: false,
  cameraOff: false,
  screenSharing: false,
  recordingActive: false,
  recordingStartedAt: null,
  timerId: null,
  recorder: null
};

const engine = new VideoEngine();

const elements = {
  hostFrame: document.querySelector("#hostFrame"),
  guestFrame: document.querySelector("#guestFrame"),
  roomLabel: document.querySelector("#roomLabel"),
  connectionState: document.querySelector("#connectionState"),
  guestInvite: document.querySelector("#guestInvite"),
  copyInvite: document.querySelector("#copyInvite"),
  newRoom: document.querySelector("#newRoom"),
  toggleMic: document.querySelector("#toggleMic"),
  toggleCamera: document.querySelector("#toggleCamera"),
  toggleScreen: document.querySelector("#toggleScreen"),
  toggleRecording: document.querySelector("#toggleRecording"),
  recordingState: document.querySelector("#recordingState"),
  recordingLabel: document.querySelector("#recordingLabel"),
  recordingTimer: document.querySelector("#recordingTimer"),
  recordingNote: document.querySelector("#recordingNote"),
  endSession: document.querySelector("#endSession"),
  soundboard: document.querySelector("#soundboard"),
  soundboardVolume: document.querySelector("#soundboardVolume")
};

init();

function init() {
  mountRoom();
  bindControls();
  new Soundboard({
    container: elements.soundboard,
    volumeInput: elements.soundboardVolume
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
  elements.copyInvite.addEventListener("click", copyInvite);
  elements.newRoom.addEventListener("click", createNewRoom);
  elements.toggleMic.addEventListener("click", toggleMic);
  elements.toggleCamera.addEventListener("click", toggleCamera);
  elements.toggleScreen.addEventListener("click", toggleScreen);
  elements.toggleRecording.addEventListener("click", toggleRecording);
  elements.endSession.addEventListener("click", endSession);
}

async function copyInvite() {
  await navigator.clipboard.writeText(elements.guestInvite.value);
  elements.copyInvite.textContent = "Copied";
  window.setTimeout(() => {
    elements.copyInvite.textContent = "Copy";
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
    recordingStartedAt: null
  });
  updatePressed(elements.toggleMic, false, "Mute mic", "Unmute mic");
  updatePressed(elements.toggleCamera, false, "Camera off", "Camera on");
  updatePressed(elements.toggleScreen, false, "Share screen", "Stop sharing");
  updateRecordingUi();
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
  updatePressed(elements.toggleScreen, state.screenSharing, "Share screen", "Stop sharing");
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
  elements.connectionState.textContent = "Session ended";
}

function updatePressed(button, pressed, offLabel, onLabel) {
  button.setAttribute("aria-pressed", String(pressed));
  button.textContent = pressed ? onLabel : offLabel;
}

function updateRecordingUi() {
  elements.toggleRecording.setAttribute("aria-pressed", String(state.recordingActive));
  elements.toggleRecording.textContent = state.recordingActive ? "Stop recording" : "Start recording";
  elements.recordingState.dataset.active = String(state.recordingActive);
  elements.recordingLabel.textContent = state.recordingActive ? "Recording locally" : "Recording idle";
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

function handleVdoMessage(message) {
  if (message.action === "push-connection" && message.value === true) {
    elements.connectionState.textContent = "Guest connected";
  } else if (message.action === "push-connection" && message.value === false) {
    elements.connectionState.textContent = "Guest disconnected";
  } else if (message.action === "view-connection" && message.value === false) {
    elements.connectionState.textContent = "Viewer disconnected";
  } else if (message.action || message.getDetailedState) {
    elements.connectionState.textContent = "Room active";
  }
}

function humanizeError(error) {
  if (error?.name === "NotAllowedError") return "camera or microphone permission was denied.";
  if (error?.name === "NotFoundError") return "no camera or microphone device was found.";
  if (error?.name === "NotReadableError") return "camera or microphone is already in use or unavailable.";
  return error?.message || "unknown browser recording error.";
}

updateRecordingUi();
