import { BackgroundMode, VideoEngine, getRoomIdFromUrl, isValidRoomId } from "./video-engine.js";
import { applyBrandTheme, getInitialBrandTheme } from "./brand-themes.js";
import { LocalIsolatedRecorder } from "./recording.js";

const state = {
  roomId: getRoomIdFromUrl(),
  brandTheme: getInitialBrandTheme(window.location.search, { useStorage: false }),
  previewStream: null,
  selectedBackground: BackgroundMode.NONE,
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
  roomLabel: document.querySelector("#guestRoomLabel"),
  joinState: document.querySelector("#joinState"),
  studioBrandLogo: document.querySelector("#studioBrandLogo"),
  studioBrandText: document.querySelector("#studioBrandText"),
  poweredBy: document.querySelector("#poweredBy"),
  cameraPreview: document.querySelector("#cameraPreview"),
  previewStage: document.querySelector("#previewStage"),
  guestName: document.querySelector("#guestName"),
  microphoneSelect: document.querySelector("#microphoneSelect"),
  cameraSelect: document.querySelector("#cameraSelect"),
  joinStudio: document.querySelector("#joinStudio"),
  guestStatus: document.querySelector("#guestStatus"),
  joinedRoom: document.querySelector("#joinedRoom"),
  guestFrame: document.querySelector("#guestFrame"),
  guestToggleMic: document.querySelector("#guestToggleMic"),
  guestToggleCamera: document.querySelector("#guestToggleCamera"),
  guestToggleScreen: document.querySelector("#guestToggleScreen"),
  guestToggleRecording: document.querySelector("#guestToggleRecording"),
  guestEndSession: document.querySelector("#guestEndSession"),
  guestRecordingState: document.querySelector("#guestRecordingState"),
  guestRecordingLabel: document.querySelector("#guestRecordingLabel"),
  guestRecordingTimer: document.querySelector("#guestRecordingTimer")
};

init();

async function init() {
  applyBrandTheme(state.brandTheme, {
    root: document.body,
    logoImg: elements.studioBrandLogo,
    logoText: elements.studioBrandText,
    poweredBy: elements.poweredBy
  });
  elements.roomLabel.textContent = state.roomId ? state.roomId : "Missing room";
  elements.joinStudio.disabled = !isValidRoomId(state.roomId);
  if (!isValidRoomId(state.roomId)) {
    elements.guestStatus.textContent = "This Studio invite has an invalid or expired room ID. Ask the host for a fresh invite.";
  }
  bindControls();
  engine.onMessage(handleVdoMessage);
  await startPreview();
  if (!LocalIsolatedRecorder.isSupported()) {
    elements.guestStatus.textContent = "Recording is unavailable in this browser. Use current Chrome for the recording proof.";
    elements.guestToggleRecording.disabled = true;
  }
}

function bindControls() {
  document.querySelectorAll(".bg-swatch").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".bg-swatch").forEach((other) => other.setAttribute("aria-pressed", "false"));
      button.setAttribute("aria-pressed", "true");
      state.selectedBackground = button.dataset.background;
      elements.previewStage.dataset.background = button.dataset.background;
    });
  });

  elements.cameraSelect.addEventListener("change", startPreview);
  elements.microphoneSelect.addEventListener("change", startPreview);
  elements.joinStudio.addEventListener("click", joinStudio);
  elements.guestToggleMic.addEventListener("click", toggleMic);
  elements.guestToggleCamera.addEventListener("click", toggleCamera);
  elements.guestToggleScreen.addEventListener("click", toggleScreen);
  elements.guestToggleRecording.addEventListener("click", toggleRecording);
  elements.guestEndSession.addEventListener("click", leaveSession);
}

async function startPreview() {
  try {
    stopPreview();
    const cameraBeforeHydration = elements.cameraSelect.value;
    const constraints = {
      video: deviceConstraint(elements.cameraSelect.value),
      audio: deviceConstraint(elements.microphoneSelect.value)
    };
    state.previewStream = await navigator.mediaDevices.getUserMedia(constraints);
    elements.cameraPreview.srcObject = state.previewStream;
    await hydrateDevices();
    if (elements.cameraSelect.value && elements.cameraSelect.value !== cameraBeforeHydration) {
      await restartPreviewWithSelectedDevices();
    } else {
      await replaceCamoDefault();
    }
    elements.guestStatus.textContent = "Preview ready. Choose a background, then join.";
  } catch (error) {
    elements.guestStatus.textContent = "Camera or microphone permission is needed before joining.";
  }
}

async function hydrateDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillSelect(
    elements.microphoneSelect,
    devices.filter((device) => device.kind === "audioinput"),
    "Microphone"
  );
  fillSelect(
    elements.cameraSelect,
    devices.filter((device) => device.kind === "videoinput"),
    "Camera"
  );
}

function fillSelect(select, devices, fallbackLabel) {
  const selected = select.value;
  const preferredDeviceId = fallbackLabel === "Camera" ? preferredCamera(devices)?.deviceId : "";
  select.replaceChildren(
    ...devices.map((device, index) => {
      const option = document.createElement("option");
      option.value = device.deviceId;
      option.textContent = device.label || `${fallbackLabel} ${index + 1}`;
      return option;
    })
  );
  if (devices.some((device) => device.deviceId === selected)) {
    select.value = selected;
  } else if (preferredDeviceId) {
    select.value = preferredDeviceId;
  }
}

async function replaceCamoDefault() {
  const selectedCamera = selectedDeviceLabel(elements.cameraSelect);
  if (!selectedCamera || !isCamoCamera(selectedCamera)) return;
  const betterCamera = [...elements.cameraSelect.options].find((option) => !isCamoCamera(option.textContent));
  if (!betterCamera) return;
  elements.cameraSelect.value = betterCamera.value;
  await restartPreviewWithSelectedDevices();
}

async function restartPreviewWithSelectedDevices() {
  stopPreview();
  state.previewStream = await navigator.mediaDevices.getUserMedia({
    video: deviceConstraint(elements.cameraSelect.value),
    audio: deviceConstraint(elements.microphoneSelect.value)
  });
  elements.cameraPreview.srcObject = state.previewStream;
}

function selectedDeviceLabel(select) {
  return select.selectedOptions[0]?.textContent || "";
}

function preferredCamera(devices) {
  return (
    devices.find((device) => /facetime|studio display|built-?in|integrated/i.test(device.label)) ||
    devices.find((device) => !isCamoCamera(device.label)) ||
    devices[0]
  );
}

function isCamoCamera(label = "") {
  return /camo/i.test(label);
}

function deviceConstraint(deviceId) {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

function joinStudio() {
  const guestName = elements.guestName.value.trim() || "Guest";
  elements.joinState.textContent = "Joining";
  elements.joinStudio.disabled = true;
  const backgroundNote = getBackgroundNote(state.selectedBackground);
  stopPreview();
  engine.mountGuestFrame(elements.guestFrame, {
    roomId: state.roomId,
    guestName,
    backgroundMode: state.selectedBackground
  });
  elements.joinedRoom.hidden = false;
  elements.guestStatus.textContent = backgroundNote || "Joined. The Toasty Studio room is open below.";
  elements.joinState.textContent = "Joined";
}

function stopPreview() {
  state.previewStream?.getTracks().forEach((track) => track.stop());
  state.previewStream = null;
}

function toggleMic() {
  state.micMuted = !state.micMuted;
  engine.setGuestMicrophone(!state.micMuted);
  updatePressed(elements.guestToggleMic, state.micMuted, "Mute mic", "Unmute mic");
}

function toggleCamera() {
  state.cameraOff = !state.cameraOff;
  engine.setGuestCamera(!state.cameraOff);
  updatePressed(elements.guestToggleCamera, state.cameraOff, "Camera off", "Camera on");
}

function toggleScreen() {
  state.screenSharing = !state.screenSharing;
  engine.setGuestScreenShare(state.screenSharing);
  updatePressed(elements.guestToggleScreen, state.screenSharing, "Share screen", "Stop sharing");
}

async function toggleRecording() {
  try {
    if (state.recordingActive) {
      elements.guestToggleRecording.disabled = true;
      await state.recorder.stop();
      state.recordingActive = false;
      stopRecordingTimer();
      updateRecordingUi();
      elements.guestToggleRecording.disabled = false;
      return;
    }

    state.recorder = new LocalIsolatedRecorder({
      role: "guest-1",
      roomId: state.roomId,
      status: (message) => {
        elements.guestStatus.textContent = message;
      }
    });
    await state.recorder.start({
      audioDeviceId: elements.microphoneSelect.value,
      videoDeviceId: elements.cameraSelect.value
    });
    state.recordingActive = true;
    state.recordingStartedAt = Date.now();
    state.timerId = window.setInterval(updateRecordingTimer, 1000);
    updateRecordingUi();
  } catch (error) {
    state.recordingActive = false;
    stopRecordingTimer();
    updateRecordingUi();
    elements.guestStatus.textContent = `Recording failed: ${humanizeError(error)}`;
    elements.guestToggleRecording.disabled = false;
  }
}

function leaveSession() {
  engine.disconnectAll();
  stopRecordingTimer();
  state.recordingActive = false;
  updateRecordingUi();
  elements.joinState.textContent = "Left";
  elements.guestStatus.textContent = "You left the Studio session.";
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
  elements.guestToggleRecording.setAttribute("aria-pressed", String(state.recordingActive));
  elements.guestToggleRecording.textContent = state.recordingActive ? "Stop recording" : "Start recording";
  elements.guestRecordingState.dataset.active = String(state.recordingActive);
  elements.guestRecordingLabel.textContent = state.recordingActive ? "Recording locally" : "Local capture ready";
  updateRecordingTimer();
}

function updateRecordingTimer() {
  if (!state.recordingStartedAt) {
    elements.guestRecordingTimer.textContent = "00:00:00";
    return;
  }
  const elapsed = Math.floor((Date.now() - state.recordingStartedAt) / 1000);
  const hours = String(Math.floor(elapsed / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
  const seconds = String(elapsed % 60).padStart(2, "0");
  elements.guestRecordingTimer.textContent = `${hours}:${minutes}:${seconds}`;
}

function stopRecordingTimer() {
  if (state.timerId) {
    window.clearInterval(state.timerId);
    state.timerId = null;
  }
  state.recordingStartedAt = null;
}

function getBackgroundNote(background) {
  if (background === BackgroundMode.BLUR) {
    return "Joined with VDO.Ninja blur requested. Browser support depends on VDO.Ninja and device capability.";
  }
  if (background !== BackgroundMode.NONE) {
    return "Joined. Preset backgrounds are preview-only in this hosted VDO.Ninja MVP; production replacement needs hosted image-list support.";
  }
  return "";
}

function humanizeError(error) {
  if (error?.name === "NotAllowedError") return "camera or microphone permission was denied.";
  if (error?.name === "NotFoundError") return "no camera or microphone device was found.";
  if (error?.name === "NotReadableError") return "camera or microphone is already in use or unavailable.";
  return error?.message || "unknown browser recording error.";
}

function handleVdoMessage(message) {
  if (!message) return;
  if (message.action === "view-connection" && message.value === false) {
    elements.joinState.textContent = "Host disconnected";
    elements.guestStatus.textContent = "The host connection was lost. Keep this page open if you plan to reconnect.";
  } else if (message.action === "push-connection" && message.value === false) {
    elements.joinState.textContent = "Disconnected";
  } else if (message.action || message.getDetailedState) {
    elements.joinState.textContent = "Joined";
  }
}

updateRecordingUi();
