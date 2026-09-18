import { BackgroundMode, VideoEngine, getRoomIdFromUrl, isValidRoomId } from "./video-engine.js";
import { applyBrandTheme, getInitialBrandTheme } from "./brand-themes.js";
import { startDevicePreview } from "./device-picker.js";

// Guest lifecycle — mirrors js/host-state.js's Host state machine (same five states, same reasoning: no
// control should ever be gated on "the page is open" or "an iframe loaded" when it actually means "the
// guest has a confirmed live connection"). Kept local rather than importing HostState — same shape, but a
// name like "HostState" reading through a guest file invites confusion for zero benefit.
const GuestLifecycle = Object.freeze({
  PREJOIN_LOADING: "prejoin-loading",
  PREJOIN_READY: "prejoin-ready",
  JOINING: "joining",
  IN_STUDIO: "in-studio",
  LEAVING: "leaving"
});

function log(...args) { console.debug("[Guest]", ...args); }

const state = {
  roomId: getRoomIdFromUrl(),
  brandTheme: getInitialBrandTheme(window.location.search, { useStorage: false }),
  brandLabel: "Studio",
  previewStream: null,
  guestLogoUrl: null,
  selectedBackground: BackgroundMode.NONE,
  micMuted: false,
  cameraOff: false,
  screenSharing: false,
  streamId: null,
  flipping: false,
  lifecycle: GuestLifecycle.PREJOIN_LOADING,
  // Generated once per page load, kept for the life of this guest session — see the diagnostics panel and
  // this pass's report ("IDENTITY BINDING CHANGE") for why this exists even though VDO.Ninja's own &label
  // remains the only channel that actually reaches the director's browser (a guest's phone and the
  // director's desktop are different devices with no other shared channel in this architecture — see
  // report for the honest caveat on this).
  participantId: `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
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
  guestTransportFrame: document.querySelector("#guestTransportFrame"),
  joinedRoom: document.querySelector("#joinedRoom"),
  guestLiveIdentityName: document.querySelector("#guestLiveIdentityName"),
  guestLiveIdentityRole: document.querySelector("#guestLiveIdentityRole"),
  guestToggleMic: document.querySelector("#guestToggleMic"),
  guestToggleCamera: document.querySelector("#guestToggleCamera"),
  guestFlipCamera: document.querySelector("#guestFlipCamera"),
  guestToggleScreen: document.querySelector("#guestToggleScreen"),
  guestEndSession: document.querySelector("#guestEndSession"),
  diagLog: document.querySelector("#guestDiagLog")
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
  if (!isValidRoomId(state.roomId)) {
    elements.joinStudio.disabled = true;
    elements.guestStatus.textContent = "This Studio invite has an invalid or expired room ID. Ask the host for a fresh invite.";
    return;
  }
  diag(`participantId: ${state.participantId}`);
  diag(`roomId: ${state.roomId}`);
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
  elements.guestFlipCamera.addEventListener("click", flipCamera);
  elements.guestToggleScreen.addEventListener("click", toggleScreen);
  elements.guestEndSession.addEventListener("click", leaveSession);
}

async function startPreview() {
  setLifecycle(GuestLifecycle.PREJOIN_LOADING);
  elements.joinStudio.disabled = true;
  elements.guestStatus.dataset.error = "false";
  elements.guestStatus.textContent = "Requesting camera preview…";
  diag("[1] requesting camera/mic preview…");
  try {
    state.previewStream = await startDevicePreview({
      videoEl: elements.cameraPreview,
      cameraSelect: elements.cameraSelect,
      microphoneSelect: elements.microphoneSelect,
      previousStream: state.previewStream
    });
    const videoTracks = state.previewStream.getVideoTracks();
    const audioTracks = state.previewStream.getAudioTracks();
    diag(`[2] preview stream acquired — id ${state.previewStream.id}, ${videoTracks.length} video track(s), ${audioTracks.length} audio track(s)`);
    if (videoTracks[0]) diag(`[3] video track: label="${videoTracks[0].label}" readyState=${videoTracks[0].readyState}`);
    if (!videoTracks.length) diag("[3] WARNING: zero video tracks in the acquired stream — preview will be blank even though getUserMedia resolved");
    try {
      await elements.cameraPreview.play();
      diag(`[4] video.play() resolved — videoWidth=${elements.cameraPreview.videoWidth} videoHeight=${elements.cameraPreview.videoHeight}`);
    } catch (playError) {
      diag(`[4] video.play() REJECTED — ${playError?.name}: ${playError?.message} (stream is still valid; autoplay policy or similar)`);
    }
    // Only worth offering Flip Camera once we know there's a second camera to flip to (matches VDO.Ninja's
    // own flip-camera button, which likewise hides itself when just one camera is available).
    elements.guestFlipCamera.hidden = elements.cameraSelect.options.length < 2;
    elements.guestStatus.textContent = "Preview ready. Choose a background, then join.";
    elements.joinStudio.disabled = false;
    setLifecycle(GuestLifecycle.PREJOIN_READY);
  } catch (error) {
    diag(`[2] getUserMedia FAILED — name="${error?.name}" message="${error?.message}"`);
    log("getUserMedia FAILED", error?.name, error?.message, error?.stack);
    elements.guestStatus.dataset.error = "true";
    elements.guestStatus.textContent = `Couldn't start the camera/microphone: ${error?.name || "Error"}: ${error?.message || "unknown error"}. Check your browser's site permissions and try again.`;
    // Deliberately stays in PREJOIN_LOADING (Join stays disabled) rather than silently showing an empty
    // preview and a still-enabled Join button — see this repair pass's report for why that was the root
    // cause of a guest looking "joined" with no real camera behind it.
  }
}

function setLifecycle(next) {
  state.lifecycle = next;
  diag(`lifecycle -> ${next}`);
}

function diag(message) {
  const line = `${new Date().toISOString().slice(11, 23)}  ${message}`;
  log(message);
  if (!elements.diagLog) return;
  const row = document.createElement("div");
  row.textContent = line;
  elements.diagLog.appendChild(row);
  elements.diagLog.scrollTop = elements.diagLog.scrollHeight;
}

// Name is REQUIRED — the HTML `required` attribute alone does nothing here since #joinStudio is a plain
// button, not a <form> submit (no native constraint validation ever runs).
async function joinStudio() {
  if (state.lifecycle !== GuestLifecycle.PREJOIN_READY) return;
  const guestName = elements.guestName.value.trim();
  if (!guestName) {
    elements.guestStatus.textContent = "Enter your name before joining.";
    elements.guestStatus.dataset.error = "true";
    elements.guestName.focus();
    return;
  }
  const guestTitle = elements.guestTitleField.value.trim();
  const guestCompany = elements.guestCompany.value.trim();
  const role = [guestTitle, guestCompany].filter(Boolean).join(", ");
  const label = role ? `${guestName} · ${role}` : guestName;

  setLifecycle(GuestLifecycle.JOINING);
  elements.joinState.textContent = "Joining";
  elements.guestStatus.dataset.error = "false";
  elements.guestStatus.textContent = "Connecting…";
  elements.joinStudio.disabled = true;
  const backgroundNote = getBackgroundNote(state.selectedBackground);

  // Device LABEL, not .value (a MediaDevices deviceId) — see video-engine.js's mountDirectorFrame
  // comment for why a deviceId read here can't reliably resolve inside VDO.Ninja's cross-origin iframe.
  const videoDeviceLabel = elements.cameraSelect.selectedOptions[0]?.textContent;
  const audioDeviceLabel = elements.microphoneSelect.selectedOptions[0]?.textContent;
  diag(`[5] JOIN clicked — name="${guestName}" videoDeviceLabel="${videoDeviceLabel || "(none)"}" audioDeviceLabel="${audioDeviceLabel || "(none)"}"`);

  // Deliberately NOT stopping state.previewStream here — same fix as the Host's joinAsHost: the visible
  // preview the guest has already been looking at is the SAME stream that stays live through Join, instead
  // of being torn down and replaced by whatever VDO.Ninja's iframe happens to render.
  state.streamId = engine.mountGuestFrame(elements.guestTransportFrame, {
    roomId: state.roomId,
    guestName: label,
    backgroundMode: state.selectedBackground,
    videoDeviceLabel,
    audioDeviceLabel
  });
  diag(`[6] transport mounted (hidden) — push id "${state.streamId}"`);

  const result = await engine.confirmPublishing("guest", state.streamId);
  if (!result.confirmed) {
    diag(`[7] publish NOT confirmed after retries — VDO never reported videoTrack:true for "${state.streamId}"`);
    elements.guestStatus.dataset.error = "true";
    elements.guestStatus.textContent = "Couldn't confirm the connection started. Check your internet connection and try again.";
    elements.joinStudio.disabled = false;
    elements.joinState.textContent = "Not joined";
    setLifecycle(GuestLifecycle.PREJOIN_READY);
    return;
  }
  diag(`[7] publish CONFIRMED — VDO reports videoTrack:true for "${state.streamId}"`);

  // Toasty-owned name/title under the live tile — see css/studio.css's .guest-live-identity comment for
  // why this is separate from VDO.Ninja's own showlabels overlay.
  elements.guestLiveIdentityName.textContent = guestName;
  elements.guestLiveIdentityRole.textContent = role;
  // Move the SAME preview node (not a clone — a live <video> with srcObject already set) into the joined
  // view, so the guest keeps looking at the exact stream that's now actually being published, with no
  // VDO.Ninja iframe ever visible anywhere on this page.
  elements.joinedRoom.insertBefore(elements.previewStage, elements.guestLiveIdentity);
  elements.previewStage.classList.add("preview-stage--live");
  // The check-in form (name/title/company/device pickers/background swatches) has done its job —
  // once joined, guests should see only the live feed and the mute/camera/screen-share dock.
  elements.guestCheckin.hidden = true;
  elements.joinedRoom.hidden = false;
  elements.guestStatus.textContent = backgroundNote || `Joined. The ${state.brandLabel} room is open below.`;
  elements.joinState.textContent = "Joined";
  setLifecycle(GuestLifecycle.IN_STUDIO);
}

// Remounts the SAME push connection (same streamId — see mountGuestFrame's comment) with the next camera
// in the list. VDO.Ninja doesn't expose a live in-place device swap over its iframe API (only its own
// internal flip-camera UI button, which cleanoutput hides), so this is a brief reconnect rather than a
// seamless swap — the guest's tile will blink for a moment on Program Output/Director too. Also restarts
// the VISIBLE local preview with the new device so what the guest sees stays truthful to what's live.
async function flipCamera() {
  if (state.flipping || state.lifecycle !== GuestLifecycle.IN_STUDIO) return;
  const options = [...elements.cameraSelect.options];
  if (options.length < 2) return;
  state.flipping = true;
  elements.guestFlipCamera.disabled = true;
  const currentIndex = options.findIndex((option) => option.value === elements.cameraSelect.value);
  const next = options[(currentIndex + 1) % options.length];
  elements.cameraSelect.value = next.value;
  const videoDeviceLabel = next.textContent;
  const audioDeviceLabel = elements.microphoneSelect.selectedOptions[0]?.textContent;
  diag(`flip camera -> "${videoDeviceLabel}"`);
  try {
    state.previewStream = await startDevicePreview({
      videoEl: elements.cameraPreview,
      cameraSelect: elements.cameraSelect,
      microphoneSelect: elements.microphoneSelect,
      previousStream: state.previewStream
    });
  } catch (error) {
    diag(`flip camera: local preview restart failed — ${error?.name}: ${error?.message}`);
  }
  engine.mountGuestFrame(elements.guestTransportFrame, {
    roomId: state.roomId,
    guestName: [elements.guestLiveIdentityName.textContent, elements.guestLiveIdentityRole.textContent].filter(Boolean).join(" · "),
    backgroundMode: state.selectedBackground,
    videoDeviceLabel,
    audioDeviceLabel,
    streamId: state.streamId
  });
  state.flipping = false;
  elements.guestFlipCamera.disabled = false;
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

// Mirrors the Host's Leave Studio: stop local tracks, destroy the transport, return cleanly to PREJOIN
// with a fresh preview request — not just flip some UI back and leave the old connection dangling.
async function leaveSession() {
  setLifecycle(GuestLifecycle.LEAVING);
  engine.disconnectAll();
  stopPreview();
  elements.joinState.textContent = "Left";
  elements.guestStatus.textContent = "You left the Studio session.";
  elements.joinedRoom.hidden = true;
  elements.guestCheckin.hidden = false;
  elements.previewStage.classList.remove("preview-stage--live");
  // Restore original prejoin order (eyebrow, THEN preview, then the name field) — insertBefore the name
  // field's label, not prepend, which would put the preview above the room eyebrow instead.
  elements.guestName.closest("label").before(elements.previewStage);
  state.streamId = null;
  await startPreview();
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

// tally fires on every speaking/activity change — far too frequent to log without flooding the (also
// temporary) diagnostics panel; everything else VDO.Ninja posts is infrequent enough to log in full.
function handleVdoMessage(message) {
  if (!message) return;
  if (message.action !== "tally") diag(`vdo message: ${JSON.stringify(message).slice(0, 160)}`);
  if (message.action === "view-connection" && message.value === false) {
    elements.joinState.textContent = "Host disconnected";
    elements.guestStatus.textContent = "The host connection was lost. Keep this page open if you plan to reconnect.";
  } else if (message.action === "push-connection" && message.value === false) {
    elements.joinState.textContent = "Disconnected";
  }
}
