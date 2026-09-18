import { BackgroundMode, VideoEngine, getRoomIdFromUrl, isValidRoomId } from "./video-engine.js";
import { applyBrandTheme, getInitialBrandTheme } from "./brand-themes.js";
import { startDevicePreview } from "./device-picker.js";
import { RoomPresence } from "./room-presence.js";
import { RemoteMediaState, REMOTE_MEDIA_STATE_LABEL } from "./remote-media-state.js";

function log(...args) { console.debug("[Guest]", ...args); }

// Guest lifecycle — mirrors js/host-state.js's Host state machine (same five states, same reasoning: no
// control should ever be gated on "the page is open" or "an iframe loaded" when it actually means "the
// guest has a confirmed live connection").
const GuestLifecycle = Object.freeze({
  PREJOIN_LOADING: "prejoin-loading",
  PREJOIN_READY: "prejoin-ready",
  JOINING: "joining",
  IN_STUDIO: "in-studio",
  LEAVING: "leaving"
});

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
  // The currently-mounted remote participant view, if any — {participantId, transportSourceId} — so
  // renderRemoteParticipants can tell "still the same remote person, leave it mounted" apart from "a
  // different remote source now, remount" instead of tearing down/rebuilding on every roster poll tick.
  mountedRemote: null,
  remoteMediaState: RemoteMediaState.WAITING_FOR_PARTICIPANT,
  remoteMediaTimerId: null,
  presence: null,
  selfLabel: null,
  lifecycle: GuestLifecycle.PREJOIN_LOADING,
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
  guestParticipantStage: document.querySelector("#guestParticipantStage"),
  guestRemoteFrame: document.querySelector("#guestRemoteFrame"),
  guestRemoteStageEmpty: document.querySelector("#guestRemoteStageEmpty"),
  guestRemoteStageEmptyText: document.querySelector("#guestRemoteStageEmptyText"),
  guestLiveIdentityName: document.querySelector("#guestLiveIdentityName"),
  guestLiveIdentityRole: document.querySelector("#guestLiveIdentityRole"),
  guestToggleMic: document.querySelector("#guestToggleMic"),
  guestToggleCamera: document.querySelector("#guestToggleCamera"),
  guestFlipCamera: document.querySelector("#guestFlipCamera"),
  guestToggleScreen: document.querySelector("#guestToggleScreen"),
  guestEndSession: document.querySelector("#guestEndSession")
};

init();

async function init() {
  try {
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
    bindControls();
    engine.onMessage(handleVdoMessage);
    await startPreview();
  } catch (error) {
    log("init() THREW", error);
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
  try {
    state.previewStream = await startDevicePreview({
      videoEl: elements.cameraPreview,
      cameraSelect: elements.cameraSelect,
      microphoneSelect: elements.microphoneSelect,
      previousStream: state.previewStream
    });
    try {
      await elements.cameraPreview.play();
    } catch (playError) {
      log("preview video.play() rejected", playError?.name, playError?.message);
    }
    // Only worth offering Flip Camera once we know there's a second camera to flip to (matches VDO.Ninja's
    // own flip-camera button, which likewise hides itself when just one camera is available).
    elements.guestFlipCamera.hidden = elements.cameraSelect.options.length < 2;
    elements.guestStatus.textContent = "Preview ready. Choose a background, then join.";
    elements.joinStudio.disabled = false;
    setLifecycle(GuestLifecycle.PREJOIN_READY);
  } catch (error) {
    log("getUserMedia FAILED", error?.name, error?.message, error?.stack);
    elements.guestStatus.dataset.error = "true";
    elements.guestStatus.textContent = `Couldn't start the camera/microphone: ${error?.name || "Error"}: ${error?.message || "unknown error"}. Check your browser's site permissions and try again.`;
    // Deliberately stays in PREJOIN_LOADING (Join stays disabled) rather than silently showing an empty
    // preview and a still-enabled Join button.
  }
}

function setLifecycle(next) {
  state.lifecycle = next;
}

// Name is REQUIRED — the HTML `required` attribute alone does nothing here since #joinStudio is a plain
// button, not a <form> submit (no native constraint validation ever runs). Synchronous end to end — no
// await, matching joinAsHost's own immediate mount-then-transition shape exactly.
function joinStudio() {
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

  elements.joinStudio.disabled = true;
  setLifecycle(GuestLifecycle.JOINING);
  elements.joinState.textContent = "Joining";
  elements.guestStatus.dataset.error = "false";
  elements.guestStatus.textContent = "Connecting…";
  const backgroundNote = getBackgroundNote(state.selectedBackground);

  // Device LABEL, not .value (a MediaDevices deviceId) — see video-engine.js's mountDirectorFrame
  // comment for why a deviceId read here can't reliably resolve inside VDO.Ninja's cross-origin iframe.
  const videoDeviceLabel = elements.cameraSelect.selectedOptions[0]?.textContent;
  const audioDeviceLabel = elements.microphoneSelect.selectedOptions[0]?.textContent;

  // Kept as plain state, not shown — the visible .guest-live-identity spans now label the REMOTE
  // participant on the main stage. Still needed here for VDO's own &label on this guest's OWN push
  // (flipCamera reuses it when remounting after a camera switch) — metadata/fallback only, never what
  // Toasty itself reads for identity.
  state.selfLabel = label;
  // Move the SAME preview node (not a clone — a live <video> with srcObject already set) into the joined
  // view as the small self PiP — see css/studio.css's .lv-participant-stage comment ("solve the
  // remote-source primitive once"): PARTICIPANT VIEW puts the OTHER person on the main stage and your own
  // camera in a corner.
  elements.guestParticipantStage.appendChild(elements.previewStage);
  elements.previewStage.classList.remove("preview-stage--live");
  elements.previewStage.classList.add("lv-stage-pip");

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

  // PARTICIPANT VIEW of the room — Toasty Presence (js/room-presence.js) is the source of truth for "who
  // is actually in this room and which transportSourceId is theirs"; VDO.Ninja stays pure media transport.
  // Announces this guest's OWN presence (now that the real push id is known) and renders whoever presence
  // says is here except self on every roster update.
  state.presence = new RoomPresence({
    roomId: state.roomId,
    participantId: state.participantId,
    role: "guest",
    displayName: guestName,
    title: guestTitle,
    company: guestCompany
  });
  state.presence.onRosterChange((roster) => {
    renderRemoteParticipants(roster);
  });
  state.presence.start(state.streamId);

  // The check-in form (name/title/company/device pickers/background swatches) has done its job —
  // once joined, guests should see only the live feed and the mute/camera/screen-share dock.
  elements.guestCheckin.hidden = true;
  elements.joinedRoom.hidden = false;
  elements.guestStatus.textContent = backgroundNote || `Joined. The ${state.brandLabel} room is open below.`;
  elements.joinState.textContent = "Joined";
  setLifecycle(GuestLifecycle.IN_STUDIO);
}

// PARTICIPANT VIEW ONLY — this is "who Tukta is talking to," never Program Output (a separate concept
// entirely; see studio/listener.html/js/listener.js for that). Renders the current room roster minus self
// on the single main-stage slot this page has today. Only remounts the VDO &view= iframe when the actual
// remote id changes (state.mountedRemote), not on every poll tick, so a steady connection never flickers.
function renderRemoteParticipants(roster) {
  const others = roster.filter((entry) => entry.participantId !== state.participantId);
  const remote = others[0] || null;

  if (!remote || !remote.transportSourceId) {
    setRemoteMediaState(RemoteMediaState.WAITING_FOR_PARTICIPANT);
    elements.guestLiveIdentityName.textContent = "";
    elements.guestLiveIdentityRole.textContent = "";
    if (state.mountedRemote) {
      stopRemoteMediaPolling();
      engine.unmountFrame(elements.guestRemoteFrame, "remoteview", "");
      state.mountedRemote = null;
    }
    return;
  }

  // The visible identity line names whoever is on the main stage (the OTHER participant), not this guest.
  elements.guestLiveIdentityName.textContent = remote.displayName;
  elements.guestLiveIdentityRole.textContent = [remote.title, remote.company].filter(Boolean).join(", ");

  if (state.mountedRemote?.transportSourceId === remote.transportSourceId) return; // already showing them

  setRemoteMediaState(RemoteMediaState.CONNECTING_REMOTE_MEDIA);
  const iframe = engine.mountParticipantView(elements.guestRemoteFrame, { roomId: state.roomId, streamId: remote.transportSourceId }, "remoteview");
  state.mountedRemote = { participantId: remote.participantId, transportSourceId: remote.transportSourceId };
  // Tracked so leaveSession can unsubscribe — without this, rejoining (Leave, then Join again) would stack
  // a new listener on top of the old one every cycle instead of replacing it.
  state.hostViewUnsub?.();
  state.hostViewUnsub = engine.onMessage((message, source) => {
    if (source !== iframe.contentWindow) return;
    if (message?.action === "view-connection" && message.value === false) {
      log("remoteview lost connection");
    }
  });

  startRemoteMediaPolling(remote.transportSourceId);
}

function setRemoteMediaState(next) {
  if (state.remoteMediaState === next) return;
  state.remoteMediaState = next;
  elements.guestRemoteStageEmptyText.textContent = REMOTE_MEDIA_STATE_LABEL[next] || "";
  elements.guestRemoteStageEmpty.hidden = next === RemoteMediaState.REMOTE_MEDIA_LIVE;
}

const REMOTE_MEDIA_POLL_MS = 2000;
const REMOTE_MEDIA_ERROR_AFTER_MS = 15000;

// Polls the mounted &view= frame's own getDetailedState for the remote peer's videoVisible field (see
// VideoEngine.requestPeerVideoState) — the real signal for "a video element for this peer actually exists
// and is visible", distinct from "presence confirms they're in the room" (see js/remote-media-state.js).
async function pollRemoteMediaState(streamId, startedAt) {
  const entry = await engine.requestPeerVideoState("remoteview", streamId);
  if (entry?.videoVisible) {
    setRemoteMediaState(RemoteMediaState.REMOTE_MEDIA_LIVE);
    stopRemoteMediaPolling();
    return;
  }
  if (Date.now() - startedAt <= REMOTE_MEDIA_ERROR_AFTER_MS) return;
  setRemoteMediaState(RemoteMediaState.REMOTE_MEDIA_ERROR);
  stopRemoteMediaPolling();
}

function startRemoteMediaPolling(streamId) {
  stopRemoteMediaPolling();
  const startedAt = Date.now();
  state.remoteMediaTimerId = window.setInterval(() => pollRemoteMediaState(streamId, startedAt), REMOTE_MEDIA_POLL_MS);
}

function stopRemoteMediaPolling() {
  if (state.remoteMediaTimerId) {
    window.clearInterval(state.remoteMediaTimerId);
    state.remoteMediaTimerId = null;
  }
}

// Remounts the SAME push connection (same streamId) with the next camera in the list. VDO.Ninja doesn't
// expose a live in-place device swap over its iframe API (only its own internal flip-camera UI button,
// which cleanoutput hides), so this is a brief reconnect rather than a seamless swap — the guest's tile
// will blink for a moment on Program Output/Director too. Also restarts the VISIBLE local preview with the
// new device so what the guest sees stays truthful to what's live.
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
  try {
    state.previewStream = await startDevicePreview({
      videoEl: elements.cameraPreview,
      cameraSelect: elements.cameraSelect,
      microphoneSelect: elements.microphoneSelect,
      previousStream: state.previewStream
    });
  } catch (error) {
    log("flip camera: local preview restart failed", error?.name, error?.message);
  }
  engine.mountGuestFrame(elements.guestTransportFrame, {
    roomId: state.roomId,
    guestName: state.selfLabel,
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
  await state.presence?.leave();
  state.presence = null;
  state.mountedRemote = null;
  stopRemoteMediaPolling();
  state.remoteMediaState = RemoteMediaState.WAITING_FOR_PARTICIPANT;
  state.hostViewUnsub?.();
  state.hostViewUnsub = null;
  engine.unmountFrame(elements.guestRemoteFrame, "remoteview", "");
  elements.guestRemoteStageEmptyText.textContent = REMOTE_MEDIA_STATE_LABEL[RemoteMediaState.WAITING_FOR_PARTICIPANT];
  elements.guestLiveIdentityName.textContent = "";
  elements.guestLiveIdentityRole.textContent = "";
  elements.joinState.textContent = "Left";
  elements.guestStatus.textContent = "You left the Studio session.";
  elements.joinedRoom.hidden = true;
  elements.guestCheckin.hidden = false;
  elements.previewStage.classList.remove("lv-stage-pip");
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

function handleVdoMessage(message) {
  if (!message) return;
  if (message.action === "view-connection" && message.value === false) {
    elements.joinState.textContent = "Host disconnected";
    elements.guestStatus.textContent = "The host connection was lost. Keep this page open if you plan to reconnect.";
  } else if (message.action === "push-connection" && message.value === false) {
    elements.joinState.textContent = "Disconnected";
  }
}
