import { BackgroundMode, VideoEngine, getRoomIdFromUrl } from "./video-engine.js";

const state = {
  roomId: getRoomIdFromUrl(),
  previewStream: null,
  selectedBackground: BackgroundMode.NONE
};

const engine = new VideoEngine();

const elements = {
  roomLabel: document.querySelector("#guestRoomLabel"),
  joinState: document.querySelector("#joinState"),
  cameraPreview: document.querySelector("#cameraPreview"),
  previewStage: document.querySelector("#previewStage"),
  guestName: document.querySelector("#guestName"),
  microphoneSelect: document.querySelector("#microphoneSelect"),
  cameraSelect: document.querySelector("#cameraSelect"),
  joinStudio: document.querySelector("#joinStudio"),
  guestStatus: document.querySelector("#guestStatus"),
  joinedRoom: document.querySelector("#joinedRoom"),
  guestFrame: document.querySelector("#guestFrame")
};

init();

async function init() {
  elements.roomLabel.textContent = state.roomId ? state.roomId : "Missing room";
  elements.joinStudio.disabled = !state.roomId;
  bindControls();
  await startPreview();
}

function bindControls() {
  document.querySelectorAll("input[name='background']").forEach((input) => {
    input.addEventListener("change", () => {
      state.selectedBackground = input.value;
      elements.previewStage.dataset.background = input.value;
    });
  });

  elements.cameraSelect.addEventListener("change", startPreview);
  elements.microphoneSelect.addEventListener("change", startPreview);
  elements.joinStudio.addEventListener("click", joinStudio);
}

async function startPreview() {
  try {
    stopPreview();
    const constraints = {
      video: deviceConstraint(elements.cameraSelect.value),
      audio: deviceConstraint(elements.microphoneSelect.value)
    };
    state.previewStream = await navigator.mediaDevices.getUserMedia(constraints);
    elements.cameraPreview.srcObject = state.previewStream;
    await hydrateDevices();
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
  }
}

function deviceConstraint(deviceId) {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

function joinStudio() {
  const guestName = elements.guestName.value.trim() || "Guest";
  elements.joinState.textContent = "Joining";
  elements.joinStudio.disabled = true;
  stopPreview();
  engine.mountGuestFrame(elements.guestFrame, {
    roomId: state.roomId,
    guestName,
    backgroundMode: state.selectedBackground
  });
  elements.joinedRoom.hidden = false;
  elements.guestStatus.textContent = "Joined. The Toasty Studio room is open below.";
  elements.joinState.textContent = "Joined";
}

function stopPreview() {
  state.previewStream?.getTracks().forEach((track) => track.stop());
  state.previewStream = null;
}
