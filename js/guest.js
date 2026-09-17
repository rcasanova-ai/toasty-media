import { BackgroundMode, VideoEngine, getRoomIdFromUrl, isValidRoomId } from "./video-engine.js";
import { applyBrandTheme, getInitialBrandTheme } from "./brand-themes.js";
import { startDevicePreview } from "./device-picker.js";

const state = {
  roomId: getRoomIdFromUrl(),
  brandTheme: getInitialBrandTheme(window.location.search, { useStorage: false }),
  brandLabel: "Studio",
  previewStream: null,
  guestLogoUrl: null,
  selectedBackground: BackgroundMode.NONE,
  micMuted: false,
  cameraOff: false,
  screenSharing: false
};

const engine = new VideoEngine();

const elements = {
  roomLabel: document.querySelector("#guestRoomLabel"),
  joinState: document.querySelector("#joinState"),
  studioBrandLink: document.querySelector("#studioBrandLink"),
  studioBrandLogo: document.querySelector("#studioBrandLogo"),
  studioBrandText: document.querySelector("#studioBrandText"),
  poweredBy: document.querySelector("#poweredBy"),
  cameraPreview: document.querySelector("#cameraPreview"),
  previewStage: document.querySelector("#previewStage"),
  guestCheckin: document.querySelector("#guestCheckin"),
  guestName: document.querySelector("#guestName"),
  guestTitleField: document.querySelector("#guestTitleField"),
  guestCompany: document.querySelector("#guestCompany"),
  guestLogoUpload: document.querySelector("#guestLogoUpload"),
  microphoneSelect: document.querySelector("#microphoneSelect"),
  cameraSelect: document.querySelector("#cameraSelect"),
  joinStudio: document.querySelector("#joinStudio"),
  guestStatus: document.querySelector("#guestStatus"),
  joinedRoom: document.querySelector("#joinedRoom"),
  guestFrame: document.querySelector("#guestFrame"),
  guestToggleMic: document.querySelector("#guestToggleMic"),
  guestToggleCamera: document.querySelector("#guestToggleCamera"),
  guestToggleScreen: document.querySelector("#guestToggleScreen"),
  guestEndSession: document.querySelector("#guestEndSession")
};

init();

async function init() {
  const theme = applyBrandTheme(state.brandTheme, {
    root: document.body,
    brandLink: elements.studioBrandLink,
    logoImg: elements.studioBrandLogo,
    logoText: elements.studioBrandText,
    poweredBy: elements.poweredBy
  });
  state.brandLabel = theme.textLogo || `${theme.label} Studio`;
  elements.roomLabel.textContent = state.roomId ? state.roomId : "Missing room";
  elements.joinStudio.disabled = !isValidRoomId(state.roomId);
  if (!isValidRoomId(state.roomId)) {
    elements.guestStatus.textContent = "This Studio invite has an invalid or expired room ID. Ask the host for a fresh invite.";
  }
  bindControls();
  engine.onMessage(handleVdoMessage);
  await startPreview();
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
  // Local-only for now: there is no metadata side-channel from guest to director yet (VDO.Ninja's
  // label field, the only thing that round-trips, can't carry an image). Kept on state so it's at
  // least available to this page and ready to wire up once a real channel exists.
  elements.guestLogoUpload.addEventListener("change", () => {
    const file = elements.guestLogoUpload.files?.[0];
    if (state.guestLogoUrl) URL.revokeObjectURL(state.guestLogoUrl);
    state.guestLogoUrl = file ? URL.createObjectURL(file) : null;
  });
  elements.joinStudio.addEventListener("click", joinStudio);
  elements.guestToggleMic.addEventListener("click", toggleMic);
  elements.guestToggleCamera.addEventListener("click", toggleCamera);
  elements.guestToggleScreen.addEventListener("click", toggleScreen);
  elements.guestEndSession.addEventListener("click", leaveSession);
}

async function startPreview() {
  try {
    state.previewStream = await startDevicePreview({
      videoEl: elements.cameraPreview,
      cameraSelect: elements.cameraSelect,
      microphoneSelect: elements.microphoneSelect,
      previousStream: state.previewStream
    });
    elements.guestStatus.textContent = "Preview ready. Choose a background, then join.";
  } catch (error) {
    elements.guestStatus.textContent = "Camera or microphone permission is needed before joining.";
  }
}

function joinStudio() {
  const guestName = elements.guestName.value.trim() || "Guest";
  const guestTitle = elements.guestTitleField.value.trim();
  const guestCompany = elements.guestCompany.value.trim();
  const role = [guestTitle, guestCompany].filter(Boolean).join(", ");
  const label = role ? `${guestName} · ${role}` : guestName;
  elements.joinState.textContent = "Joining";
  elements.joinStudio.disabled = true;
  const backgroundNote = getBackgroundNote(state.selectedBackground);
  const videoDeviceId = elements.cameraSelect.value;
  const audioDeviceId = elements.microphoneSelect.value;
  stopPreview();
  engine.mountGuestFrame(elements.guestFrame, {
    roomId: state.roomId,
    guestName: label,
    backgroundMode: state.selectedBackground,
    videoDeviceId,
    audioDeviceId
  });
  // The check-in form (name/title/company/device pickers/background swatches) has done its job —
  // once joined, guests should see only the live feed and the mute/camera/screen-share dock.
  elements.guestCheckin.hidden = true;
  elements.joinedRoom.hidden = false;
  elements.guestStatus.textContent = backgroundNote || `Joined. The ${state.brandLabel} room is open below.`;
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

function leaveSession() {
  engine.disconnectAll();
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

function getBackgroundNote(background) {
  if (background === BackgroundMode.BLUR) {
    return "Joined with VDO.Ninja blur requested. Browser support depends on VDO.Ninja and device capability.";
  }
  if (background !== BackgroundMode.NONE) {
    return "Joined. Preset backgrounds are preview-only in this hosted VDO.Ninja MVP; production replacement needs hosted image-list support.";
  }
  return "";
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
