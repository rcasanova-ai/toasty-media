import { BackgroundMode, VideoEngine, getRoomIdFromUrl, isValidRoomId, createGuestStreamId } from "./video-engine.js";
import { applyBrandTheme, getInitialBrandTheme, normalizeBrandTheme } from "./brand-themes.js";
import { startDevicePreview, selectedDeviceLabel, classifyCameraFacing } from "./device-picker.js";
import { RoomPresence } from "./room-presence.js";
import { RemoteMediaState, REMOTE_MEDIA_STATE_LABEL } from "./remote-media-state.js";
import { studioApiEndpoint } from "./studio-api.js";
import { syncParticipantStage, clearParticipantStage } from "./participant-stage.js";
import { BUILD_ID } from "./build-info.js";
import { PublisherState, derivePublisherState, pickLocalPublisherEntry } from "./publisher-state.js";
import { MediaCommandType, commandTargetsParticipant } from "./session-control.js";

const MAX_GUESTS_PER_ROOM = 3;

// Same UA class VDO.Ninja's own source checks to decide session.mobile (see js/video-engine.js's
// mountGuestFrame comment on &ar=portrait) — used here for two purposes that are DISPLAY/CAPTURE
// decisions Toasty makes on ITS OWN side, not something read from or written to VDO: friendly camera
// names in the picker, and requesting a portrait capture aspect ratio instead of VDO's landscape default.
const IS_MOBILE_DEVICE = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

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

const PUBLISH_TIMEOUT_MS = 20000;
const PUBLISH_POLL_MS = 1000;

function emptyPublisherSignals() {
  return {
    iframePresent: false,
    iframeLoaded: false,
    pushConnection: null,
    detailedSelf: null,
    lastError: "",
    pollTimer: null,
    timeoutTimer: null
  };
}

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
  // "user" (front/selfie) or "environment" (back/rear) — the ONE explicit, logical camera selection
  // flipCamera reasons about. Set from the ACTUAL granted camera's raw label (classifyCameraFacing) after
  // every successful acquisition, never assumed or inferred from array position — see flipCamera's own
  // comment. Stays null until the first real preview resolves, or if the label can't be classified at all
  // (flipCamera then refuses to guess and no-ops rather than picking an arbitrary "other" camera).
  selectedFacing: null,
  // js/participant-stage.js's syncParticipantStage's persistent state — participantId -> {tile,
  // videoContainer, frameId, transportSourceId} for every currently-mounted OTHER participant tile on this
  // Guest's own participant stage.
  mountedRemoteTiles: new Map(),
  remoteMediaState: RemoteMediaState.WAITING_FOR_PARTICIPANT,
  presence: null,
  selfLabel: null,
  lifecycle: GuestLifecycle.PREJOIN_LOADING,
  participantId: `guest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  publisher: emptyPublisherSignals(),
  executedCommandIds: new Set(),
  mediaRequest: null
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
  guestEndSession: document.querySelector("#guestEndSession"),
  guestMediaRequest: document.querySelector("#guestMediaRequest"),
  guestMediaRequestText: document.querySelector("#guestMediaRequestText"),
  guestMediaRequestConfirm: document.querySelector("#guestMediaRequestConfirm"),
  guestMediaRequestDismiss: document.querySelector("#guestMediaRequestDismiss")
};

init();

// VISUAL STATE ONLY — never touches VDO, camera, mic, participant registry, or the room connection. A
// live session's brand is Host/Producer-controlled shared state (see js/live-session.js's
// changeBrandTheme), not this guest's own independent choice — this is the one place that actually
// repaints the page, so both the initial resolve and every later live update in joinStudio's
// onRosterChange go through it.
function applyGuestBrandTheme(brandId) {
  state.brandTheme = normalizeBrandTheme(brandId);
  const theme = applyBrandTheme(state.brandTheme, {
    root: document.body,
    brandLink: elements.studioBrandLink,
    logoImg: elements.studioBrandLogo,
    logoText: elements.studioBrandText,
    poweredBy: elements.poweredBy
  });
  state.brandLabel = theme.textLogo || `${theme.label} Studio`;
}

async function init() {
  try {
    applyGuestBrandTheme(state.brandTheme);
    elements.roomLabel.textContent = state.roomId ? state.roomId : "Missing room";
    if (!isValidRoomId(state.roomId)) {
      elements.joinStudio.disabled = true;
      elements.guestStatus.textContent = "This Studio invite has an invalid or expired room ID. Ask the host for a fresh invite.";
      return;
    }
    // Late-joiner correction: the invite link's own ?brand= is only a snapshot from whenever it was
    // copied — if the Host has changed the session's theme since, this repaints BEFORE the guest ever
    // sees the prejoin screen, rather than leaving them on a stale brand until their first post-join
    // heartbeat (see the onRosterChange handler in joinStudio for the live/post-join half of this).
    // Unauthenticated, same endpoint the capacity preflight already calls — best-effort, same as that
    // preflight: a failure here just leaves the invite-link brand in place, never blocks prejoin.
    try {
      const response = await fetch(`${studioApiEndpoint()}/api/presence/room?roomId=${encodeURIComponent(state.roomId)}`);
      if (response.ok) {
        const data = await response.json();
        if (data.brandId) applyGuestBrandTheme(data.brandId);
      }
    } catch (error) {
      log("live brand resolve failed, using invite-link brand", error?.message);
    }
    bindControls();
    engine.onMessage(handleVdoMessage);
    await startPreview();
  } catch (error) {
    log("init() THREW", error);
  }
  // Observational only — must never block or break Join. Dynamic import so a missing
  // media-diagnostics.js (404 on a partial deploy) cannot take down the guest module graph.
  void startGuestDebugMedia();
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
  elements.guestMediaRequestConfirm?.addEventListener("click", confirmMediaRequest);
  elements.guestMediaRequestDismiss?.addEventListener("click", dismissMediaRequest);
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
      previousStream: state.previewStream,
      friendlyCameraLabels: IS_MOBILE_DEVICE
    });
    try {
      await elements.cameraPreview.play();
    } catch (playError) {
      log("preview video.play() rejected", playError?.name, playError?.message);
    }
    // Only worth offering Flip Camera once we know there's a second camera to flip to (matches VDO.Ninja's
    // own flip-camera button, which likewise hides itself when just one camera is available).
    elements.guestFlipCamera.hidden = elements.cameraSelect.options.length < 2;
    // Ground truth from what was ACTUALLY granted (covers the initial load AND the guest manually picking
    // a different camera from the dropdown pre-join) — flipCamera's target is always "the other one" from
    // whatever this really is, never assumed.
    state.selectedFacing = classifyCameraFacing(selectedDeviceLabel(elements.cameraSelect));
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

  elements.joinStudio.disabled = true;
  setLifecycle(GuestLifecycle.JOINING);
  elements.joinState.textContent = "Joining";
  elements.guestStatus.dataset.error = "false";
  elements.guestStatus.textContent = "Connecting…";
  const backgroundNote = getBackgroundNote(state.selectedBackground);

  // Capacity preflight — checked BEFORE transport ever mounts, per "do not silently connect them to VDO
  // and then hide them." This is a UX nicety only, not the authoritative enforcement: presence_upsert on
  // the backend (see scripts/toasty-auth-db.py) refuses a 4th guest's actual presence announce regardless
  // of whether this preflight ran or raced against another guest joining at the same moment — that backend
  // check is what makes capacity real server/session policy, not this one.
  try {
    const response = await fetch(`${studioApiEndpoint()}/api/presence/room?roomId=${encodeURIComponent(state.roomId)}`);
    if (response.ok) {
      const data = await response.json();
      const guestCount = (data.roster || []).filter((entry) => entry.role === "guest").length;
      if (guestCount >= MAX_GUESTS_PER_ROOM) {
        setLifecycle(GuestLifecycle.PREJOIN_READY);
        elements.joinStudio.disabled = false;
        elements.joinState.textContent = "Full";
        elements.guestStatus.dataset.error = "true";
        elements.guestStatus.textContent = "This session is currently full.";
        return;
      }
    }
  } catch (error) {
    log("capacity preflight check failed, proceeding — backend still enforces capacity", error?.message);
  }

  // Device LABEL, not .value (a MediaDevices deviceId) — see video-engine.js's mountDirectorFrame
  // comment for why a deviceId read here can't reliably resolve inside VDO.Ninja's cross-origin iframe.
  // Always the RAW label (selectedDeviceLabel reads dataset.rawLabel, not the option's visible text) —
  // mobile shows "Front Camera"/"Back Camera" in the picker (see startPreview's friendlyCameraLabels) but
  // VDO must still be told the real device string 511a6cd's matching fix depends on.
  const videoDeviceLabel = selectedDeviceLabel(elements.cameraSelect);
  const audioDeviceLabel = selectedDeviceLabel(elements.microphoneSelect);

  // Kept as plain state, not shown — the visible .guest-live-identity spans now label the REMOTE
  // participant on the main stage. Still needed here for VDO's own &label on this guest's OWN push
  // (flipCamera reuses it when remounting after a camera switch) — metadata/fallback only, never what
  // Toasty itself reads for identity.
  state.selfLabel = label;

  // Planned VDO push id — same generator mountGuestFrame uses — so presence can admit THIS identity
  // BEFORE the iframe exists. Real-device three-guest failure: Device 3 could receive Mac+Device 2
  // while Mac's guest count (VDO getGuestList, not Toasty presence) never saw Device 3. Code order
  // before this change was mountGuestFrame → fire-and-forget presence.start → IN_STUDIO regardless
  // of announce outcome, which is exactly "start VDO transport, discover afterward that presence
  // admission failed." Desired order, proven from this file not assumed from the symptom: admit →
  // only then mount transport → heartbeat → IN_STUDIO.
  const plannedStreamId = createGuestStreamId(state.roomId);

  state.presence = new RoomPresence({
    roomId: state.roomId,
    participantId: state.participantId,
    role: "guest",
    displayName: guestName,
    title: guestTitle,
    company: guestCompany
  });
  state.presence.setMediaState({ micEnabled: !state.micMuted, cameraEnabled: !state.cameraOff });
  state.presence.onRosterChange((roster) => {
    renderRemoteParticipants(roster);
    const liveBrandId = state.presence?.brandId;
    if (liveBrandId && liveBrandId !== state.brandTheme) applyGuestBrandTheme(liveBrandId);
  });
  state.presence.onControlChange((bundle) => handleControlBundle(bundle));
  // See js/room-presence.js's onRejected comment — 403/409/410 are terminal for THIS admission specifically
  // (kicked / session full / session ended), not a network hiccup to silently retry past. Each shows a real
  // message and tears the connection down; none of them auto-rejoin.
  state.presence.onRejected((status, errorMessage) => handlePresenceRejected(status, errorMessage));
  const admitted = await state.presence.admit(plannedStreamId);
  if (!admitted) {
    if (state.lifecycle === GuestLifecycle.JOINING) {
      await state.presence?.leave();
      state.presence = null;
      setLifecycle(GuestLifecycle.PREJOIN_READY);
      elements.joinStudio.disabled = false;
      elements.joinState.textContent = "Not joined";
      elements.guestStatus.dataset.error = "true";
      elements.guestStatus.textContent = "Couldn't join the session. Check your connection and try again.";
    }
    return;
  }

  // Move the SAME preview node (not a clone) into the joined view as the small self PiP — see
  // css/studio.css's .lv-participant-stage comment: PARTICIPANT VIEW puts the OTHER person on the
  // main stage and your own camera in a corner.
  elements.guestParticipantStage.appendChild(elements.previewStage);
  elements.previewStage.classList.remove("preview-stage--live");
  elements.previewStage.classList.add("lv-stage-pip");

  // ROOT CAUSE of Device 3 never appearing in Host VDO getGuestList (simultaneous three-device run,
  // room tmu8vbpzb1sqa34): this used to keep the native previewStream live AND mount VDO's publisher
  // into a 2×2 off-screen iframe. Chrome/Android can dual-capture the same camera (Guest #2 published).
  // Exclusive-camera phones cannot: the parent page holds 480×640 live tracks, the hidden vdo.ninja
  // iframe never finishes push, and getGuestList never lists that source. flipCamera() already
  // documented this and released native tracks before asking VDO to switch — Join did not.
  // Release native capture first, then mount the publisher into this visible PiP so VDO can actually
  // acquire the camera, show a permission prompt if needed, and encode. Self-view becomes VDO's
  // local preview; Toasty composition/presence/scene=0 are unchanged.
  stopPreview();
  elements.cameraPreview.hidden = true;
  elements.guestTransportFrame.hidden = false;
  elements.previewStage.classList.add("preview-stage--publishing");
  state.streamId = engine.mountGuestFrame(elements.guestTransportFrame, {
    roomId: state.roomId,
    guestName: label,
    backgroundMode: state.selectedBackground,
    videoDeviceLabel,
    audioDeviceLabel,
    streamId: plannedStreamId,
    micMuted: state.micMuted,
    isMobile: IS_MOBILE_DEVICE
  });
  watchPublisherCompletion(engine.frames.get("guest"));
  state.presence.startHeartbeat();

  // The check-in form (name/title/company/device pickers/background swatches) has done its job —
  // once joined, guests should see only the live feed and the mute/camera/screen-share dock.
  elements.guestCheckin.hidden = true;
  elements.joinedRoom.hidden = false;
  elements.guestStatus.textContent = backgroundNote || `Joined. The ${state.brandLabel} room is open below.`;
  setLifecycle(GuestLifecycle.IN_STUDIO);
  applyPublisherUi();
}

// PARTICIPANT VIEW — "who Tukta is talking to," never Program Output (a separate concept entirely; see
// studio/listener.html/js/listener.js for that). A Guest sees EVERY other connected participant (Host +
// up to 2 other Guests), not only the Host — see js/participant-stage.js's syncParticipantStage (the SAME
// reconciler js/live-session.js uses for its mirror-image stage) and js/program-composition.js's
// composeParticipantView for the ordering/layout rules both share. Per-participant identity labels are
// drawn directly on each tile by syncParticipantStage now, not this page's own single identity line.
function renderRemoteParticipants(roster) {
  syncParticipantStage({
    stage: elements.guestRemoteFrame,
    engine,
    roomId: state.roomId,
    // roster already IS "everyone in the room" (self included) in js/room-presence.js's shape — matches
    // js/participant-registry.js's shape closely enough (participantId/role/connectionStatus[absent =
    // connected]/transportSourceId/joinedAt) that no separate mapping step is needed.
    participants: roster,
    selfParticipantId: state.participantId,
    mounted: state.mountedRemoteTiles,
    frameIdPrefix: "remoteview",
    onEmpty: () => setRemoteMediaState(RemoteMediaState.WAITING_FOR_PARTICIPANT)
  });
  if (roster.some((entry) => entry.participantId !== state.participantId)) {
    setRemoteMediaState(RemoteMediaState.REMOTE_MEDIA_LIVE);
  }
}

function setRemoteMediaState(next) {
  if (state.remoteMediaState === next) return;
  state.remoteMediaState = next;
  elements.guestRemoteStageEmptyText.textContent = REMOTE_MEDIA_STATE_LABEL[next] || "";
  elements.guestRemoteStageEmpty.hidden = next === RemoteMediaState.REMOTE_MEDIA_LIVE;
}

// Asks VDO.Ninja's OWN existing publisher to switch cameras — engine.changeGuestVideoDevice, the iframe-
// API equivalent of VDO's own hidden mobile flip-camera button (see video-engine.js's own comment) —
// instead of destroying and recreating the whole guest iframe the way this used to work. A full iframe
// remount is a full WebRTC teardown+reconnect, racing Toasty's own separate native-preview getUserMedia
// call for the SAME physical camera; that race is what a real-device retest of 3380991 showed as the
// remote disconnecting on flip, the phone's own preview freezing/blacking, and the front camera eventually
// stopping coming back at all. VDO's own in-place switch uses RTCRtpSender.replaceTrack on the ALREADY-
// ESTABLISHED connection (confirmed in lib.js — see changeGuestVideoDevice's comment), so the room
// connection, Mac's remote view, and the guest's own streamId never change across a flip; and it never
// touches the audio track/sender at all, so mute state (already handled once at mount by &muted) simply
// has nothing to lose here — there's no reapply step because nothing about audio is ever touched.
//
// selectedFacing ("user"/"environment") is the one explicit, logical selection this function reasons
// about — never array position (see state.selectedFacing's own comment). The target camera is located
// TWICE, independently: once against VDO's OWN live device list (for changeGuestVideoDevice's index —
// deviceId is origin-salted and can't be compared against Toasty's own enumeration, see
// mountDirectorFrame's comment in video-engine.js) and once against Toasty's own cameraSelect (for the
// native preview) — both via the SAME classifyCameraFacing heuristic against each side's own raw labels,
// so the two origins always agree on which physical camera "front"/"back" means even though their device
// lists can never be compared by id. Neither side falls back to a guess: if a target facing genuinely
// isn't found in a given list, this no-ops rather than picking an arbitrary "other" camera.
async function flipCamera() {
  if (state.flipping || state.lifecycle !== GuestLifecycle.IN_STUDIO) return;
  if (elements.cameraSelect.options.length < 2 || !state.selectedFacing) return;
  const targetFacing = state.selectedFacing === "user" ? "environment" : "user";
  const nativeTarget = [...elements.cameraSelect.options].find(
    (option) => classifyCameraFacing(option.dataset.rawLabel || option.textContent) === targetFacing
  );
  if (!nativeTarget) {
    log("flip camera: no local camera classified as", targetFacing);
    return;
  }

  state.flipping = true;
  elements.guestFlipCamera.disabled = true;
  elements.guestFlipCamera.setAttribute("aria-busy", "true");
  try {
    const vdoVideoInputs = (await engine.requestGuestDeviceList()).filter((device) => device.kind === "videoinput");
    const vdoIndex = vdoVideoInputs.findIndex((device) => classifyCameraFacing(device.label) === targetFacing);
    if (vdoIndex === -1) {
      log("flip camera: VDO's own device list has no camera classified as", targetFacing);
      return;
    }

    // In-studio self-view is the VDO publisher iframe (native tracks were released at Join so this
    // phone's camera is free). Do not re-acquire a native preview here — that would steal the camera
    // back from VDO, which is the Device 3 publish failure. VDO's changeVideoDevice uses replaceTrack
    // on the already-established publisher; mute/audio is untouched.
    engine.changeGuestVideoDevice(vdoIndex);
    elements.cameraSelect.value = nativeTarget.value;
    state.selectedFacing = classifyCameraFacing(nativeTarget.dataset.rawLabel || nativeTarget.textContent) || targetFacing;
  } catch (error) {
    log("flip camera failed", error?.name, error?.message);
  } finally {
    state.flipping = false;
    elements.guestFlipCamera.disabled = false;
    elements.guestFlipCamera.removeAttribute("aria-busy");
  }
}

function stopPreview() {
  state.previewStream?.getTracks().forEach((track) => track.stop());
  state.previewStream = null;
  if (elements.cameraPreview) elements.cameraPreview.srcObject = null;
}

function currentPublisher() {
  return derivePublisherState(state.publisher);
}

function stopPublisherWatch({ reset = false } = {}) {
  if (state.publisher.pollTimer) {
    clearInterval(state.publisher.pollTimer);
    state.publisher.pollTimer = null;
  }
  if (state.publisher.timeoutTimer) {
    clearTimeout(state.publisher.timeoutTimer);
    state.publisher.timeoutTimer = null;
  }
  if (reset) state.publisher = emptyPublisherSignals();
}

function applyPublisherUi() {
  if (state.lifecycle !== GuestLifecycle.IN_STUDIO && state.lifecycle !== GuestLifecycle.JOINING) return;
  const { state: pubState, reason } = currentPublisher();
  if (pubState === PublisherState.LIVE) {
    elements.joinState.textContent = "Joined";
    if (elements.guestStatus.dataset.error === "true" && /publish|push-connection|iframe/i.test(elements.guestStatus.textContent || "")) {
      elements.guestStatus.dataset.error = "false";
      elements.guestStatus.textContent = getBackgroundNote(state.selectedBackground) || `Joined. The ${state.brandLabel} room is open below.`;
    }
    return;
  }
  if (pubState === PublisherState.ERROR) {
    elements.joinState.textContent = "Publish failed";
    elements.guestStatus.dataset.error = "true";
    elements.guestStatus.textContent = `This phone has camera/mic, but the studio did not receive the stream (${reason || "publisher-error"}). Leave and join again.`;
    return;
  }
  elements.joinState.textContent = "Publishing…";
}

function watchPublisherCompletion(iframe) {
  stopPublisherWatch();
  state.publisher = {
    ...emptyPublisherSignals(),
    iframePresent: Boolean(iframe),
    iframeLoaded: Boolean(iframe && iframe.contentWindow && iframe.getAttribute("src") && iframe.dataset.loaded === "1")
  };
  applyPublisherUi();
  if (!iframe) {
    state.publisher.lastError = "publisher-iframe-missing";
    applyPublisherUi();
    return;
  }
  const markLoaded = () => {
    state.publisher.iframeLoaded = true;
    iframe.dataset.loaded = "1";
    applyPublisherUi();
    void pollPublisherState();
  };
  iframe.addEventListener("load", markLoaded, { once: true });
  try {
    if (iframe.contentDocument?.readyState === "complete") markLoaded();
  } catch (_) {
    // Cross-origin vdo.ninja — load event is the only completion signal.
  }
  state.publisher.pollTimer = setInterval(() => { void pollPublisherState(); }, PUBLISH_POLL_MS);
  state.publisher.timeoutTimer = setTimeout(() => {
    const { state: pubState } = currentPublisher();
    if (pubState === PublisherState.LIVE) return;
    const ice = state.publisher.detailedSelf?.iceConnectionState || state.publisher.detailedSelf?.connectionState || "";
    state.publisher.lastError = ice ? `publish-timeout ice:${ice}` : "publish-timeout";
    applyPublisherUi();
  }, PUBLISH_TIMEOUT_MS);
}

async function pollPublisherState() {
  if (state.lifecycle !== GuestLifecycle.IN_STUDIO && state.lifecycle !== GuestLifecycle.JOINING) return;
  const detailed = await engine.requestPublisherDetailedState();
  if (detailed && typeof detailed === "object") {
    state.publisher.detailedSelf = pickLocalPublisherEntry(detailed, state.streamId) || state.publisher.detailedSelf;
  }
  applyPublisherUi();
  if (currentPublisher().state === PublisherState.LIVE) stopPublisherWatch();
}

// PRIVACY-CRITICAL — must fail closed. Real-device retest of 6a451ee found live mute unreliable: audio
// kept reaching the Mac after pressing Mute. Traced as far as source alone can prove: VDO.Ninja's own
// toggleMute (lib.js) disables audio by setting session.streamSrc.getAudioTracks()[...].enabled = false,
// but the SAME file's sender-reconciliation code (senderAudioUpdate, getSenderSourceTrack,
// replaceAudioTrackSafely — built for VDO's mixMinus multi-audio-track feature) tracks "the source track
// logically feeding a given RTCRtpSender" as a SEPARATE concept from sender.track itself, including
// clone()-based "muted track" substitution in some paths. That means "disable session.streamSrc's track"
// is not guaranteed to be the same object actually attached to the sender transmitting to the Mac in every
// internal code path — a plausible, source-grounded explanation, not a proven one. There is no way to
// verify from here either way: getDetailedState (lib.js) only reports REMOTE peers' mute state, never the
// local publisher's own outgoing state, confirmed by reading its full source — VDO exposes no self-mute
// confirmation channel at all.
// Given that lack of any confirmation channel, this fails closed rather than trusting a single fire-and-
// forget command: (1) the MUTE direction sends {mic:false} twice, back to back, zero added delay — cheap
// insurance against one dropped postMessage, not a timed retry; (2) engine.setGuestMicrophone's return
// value (previously discarded entirely) is now checked — if the command could not even be dispatched
// (send() returns false, e.g. the frame is somehow gone), state.micMuted is forced to true and the guest
// is shown an explicit "couldn't confirm" warning instead of a confident "Muted" the transport was never
// told about. This cannot prove the mic is actually silent on the wire — only a real-device retest can.
function publishLocalMedia() {
  state.presence?.setMediaState({ micEnabled: !state.micMuted, cameraEnabled: !state.cameraOff });
  state.presence?.publishNow();
}

function handleControlBundle(bundle = {}) {
  for (const command of bundle.commands || []) {
    if (!commandTargetsParticipant(command, { participantId: state.participantId, transportSourceId: state.streamId || state.presence?.transportSourceId })) continue;
    if (state.executedCommandIds.has(command.id)) continue;
    executeMediaCommand(command);
  }
}

function executeMediaCommand(command) {
  if (command.type === MediaCommandType.MUTE_MIC) {
    applyLocalMic(false);
    finishCommand(command);
    return;
  }
  if (command.type === MediaCommandType.CAMERA_OFF) {
    applyLocalCamera(false);
    finishCommand(command);
    return;
  }
  if (command.type === MediaCommandType.UNMUTE_MIC_REQUEST) {
    state.executedCommandIds.add(command.id);
    state.presence?.ackCommands([command.id]);
    showMediaRequest({ kind: "mic", command });
    state.presence?.publishNow();
    return;
  }
  if (command.type === MediaCommandType.CAMERA_ON_REQUEST) {
    state.executedCommandIds.add(command.id);
    state.presence?.ackCommands([command.id]);
    showMediaRequest({ kind: "camera", command });
    state.presence?.publishNow();
  }
}

function finishCommand(command) {
  state.executedCommandIds.add(command.id);
  state.presence?.ackCommands([command.id]);
  publishLocalMedia();
}

function showMediaRequest(request) {
  state.mediaRequest = request;
  if (!elements.guestMediaRequest) return;
  elements.guestMediaRequest.hidden = false;
  if (elements.guestMediaRequestText) {
    elements.guestMediaRequestText.textContent = request.kind === "camera"
      ? "Producer asked you to turn your camera on."
      : "Producer asked you to unmute.";
  }
  if (elements.guestMediaRequestConfirm) {
    elements.guestMediaRequestConfirm.textContent = request.kind === "camera" ? "Turn camera on" : "Unmute";
  }
}

function confirmMediaRequest() {
  const request = state.mediaRequest;
  if (!request) return;
  if (request.kind === "camera") applyLocalCamera(true);
  else applyLocalMic(true);
  hideMediaRequest();
  publishLocalMedia();
}

function dismissMediaRequest() {
  hideMediaRequest();
}

function hideMediaRequest() {
  state.mediaRequest = null;
  if (elements.guestMediaRequest) elements.guestMediaRequest.hidden = true;
}

function applyLocalMic(enabled) {
  const wantMuted = !enabled;
  const dispatched = engine.setGuestMicrophone(enabled);
  if (wantMuted && dispatched) engine.setGuestMicrophone(false);
  if (!dispatched) {
    state.micMuted = true;
    elements.guestStatus.dataset.error = "true";
    elements.guestStatus.textContent = "Couldn't confirm mute — check your connection, then try again.";
    updatePressed(elements.guestToggleMic, true, "Mute mic", "Unmute mic");
    return false;
  }
  state.micMuted = wantMuted;
  if (elements.guestStatus.textContent === "Couldn't confirm mute — check your connection, then try again.") {
    elements.guestStatus.dataset.error = "false";
    elements.guestStatus.textContent = "";
  }
  updatePressed(elements.guestToggleMic, state.micMuted, "Mute mic", "Unmute mic");
  return true;
}

function applyLocalCamera(enabled) {
  state.cameraOff = !enabled;
  engine.setGuestCamera(enabled);
  updatePressed(elements.guestToggleCamera, state.cameraOff, "Camera off", "Camera on");
}

function toggleMic() {
  const ok = applyLocalMic(state.micMuted);
  if (ok) publishLocalMedia();
}

function toggleCamera() {
  applyLocalCamera(state.cameraOff);
  publishLocalMedia();
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
  stopPublisherWatch({ reset: true });
  engine.disconnectAll();
  stopPreview();
  restoreNativePreviewSlot();
  await state.presence?.leave();
  state.presence = null;
  hideMediaRequest();
  clearParticipantStage({ engine, mounted: state.mountedRemoteTiles });
  state.remoteMediaState = RemoteMediaState.WAITING_FOR_PARTICIPANT;
  elements.guestRemoteStageEmptyText.textContent = REMOTE_MEDIA_STATE_LABEL[RemoteMediaState.WAITING_FOR_PARTICIPANT];
  elements.joinState.textContent = "Left";
  elements.guestStatus.textContent = "You left the Studio session.";
  elements.joinedRoom.hidden = true;
  elements.guestCheckin.hidden = false;
  // Restore original prejoin order (eyebrow, THEN preview, then the name field) — insertBefore the name
  // field's label, not prepend, which would put the preview above the room eyebrow instead.
  elements.guestName.closest("label").before(elements.previewStage);
  state.streamId = null;
  await startPreview();
}

// See js/room-presence.js's onRejected comment. All three (kicked/full/ended) tear the connection down
// the same way, but unlike leaveSession() this does NOT re-enable Join or request a fresh preview —
// showing a real terminal state and stopping here is the whole point ("cannot simply reconnect with the
// same active connection"). A guest who genuinely wants back in reloads the page, which is a deliberate
// new admission attempt (a fresh participant_id — see state.participantId's Date.now()-based generation),
// not this same rejected one silently retrying.
function handlePresenceRejected(status, errorMessage) {
  setLifecycle(GuestLifecycle.LEAVING);
  stopPublisherWatch({ reset: true });
  engine.disconnectAll();
  stopPreview();
  restoreNativePreviewSlot();
  state.presence = null;
  hideMediaRequest();
  clearParticipantStage({ engine, mounted: state.mountedRemoteTiles });
  const messages = {
    403: "You have been removed from this session.",
    409: "This session is currently full.",
    410: "This session has ended."
  };
  const labels = { 403: "Removed", 409: "Full", 410: "Ended" };
  elements.joinState.textContent = labels[status] || "Disconnected";
  elements.guestStatus.dataset.error = "true";
  elements.guestStatus.textContent = messages[status] || errorMessage || "You were disconnected from this session.";
  elements.joinedRoom.hidden = true;
  elements.guestCheckin.hidden = false;
  elements.joinStudio.disabled = true;
  elements.guestName.closest("label").before(elements.previewStage);
  state.streamId = null;
}

function restoreNativePreviewSlot() {
  elements.previewStage.classList.remove("preview-stage--publishing", "lv-stage-pip");
  elements.guestTransportFrame.hidden = true;
  elements.guestTransportFrame.replaceChildren();
  elements.cameraPreview.hidden = false;
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

function guestDiagnosticsSnapshot(trackSnapshot, videoElementSnapshot) {
  const presence = state.presence?.snapshot() || {};
  const remotes = (presence.roster || []).filter((entry) => entry.participantId !== state.participantId).map((entry) => {
    const mounted = state.mountedRemoteTiles.get(entry.participantId);
    return {
      participantId: entry.participantId,
      role: entry.role,
      requestedSourceId: entry.transportSourceId,
      mounted: Boolean(mounted),
      mediaState: mounted ? "iframe-mounted" : "not-mounted",
      error: entry.transportSourceId ? "" : "no-source-id"
    };
  });
  const requestedFacing = state.selectedFacing || classifyCameraFacing(selectedDeviceLabel(elements.cameraSelect));
  const derived = currentPublisher();
  const detailed = state.publisher.detailedSelf || {};
  const iframe = elements.guestTransportFrame?.querySelector("iframe");
  return {
    buildId: BUILD_ID,
    role: "guest",
    roomId: state.roomId,
    lifecycle: state.lifecycle,
    self: {
      participantId: state.participantId,
      presenceState: presence.presenceState || "idle",
      heartbeatStatus: presence.heartbeatStatus || "idle",
      lastHttpStatus: presence.lastHttpStatus,
      rosterContainsSelf: presence.rosterContainsSelf === true,
      transportSourceId: presence.transportSourceId || state.streamId,
      publisherSourceId: state.streamId,
      videoTrack: trackSnapshot(state.previewStream, "video"),
      audioTrack: trackSnapshot(state.previewStream, "audio"),
      transportState: derived.state,
      publisherReason: derived.reason || "",
      iframeLoaded: state.publisher.iframeLoaded === true,
      pushConnection: state.publisher.pushConnection,
      ice: detailed.iceConnectionState || detailed.connectionState || "",
      signaling: detailed.signalingState || "",
      iframeName: iframe?.name || "",
      requested: { video: requestedFacing ? `facingMode:${requestedFacing}` : "deviceId-exact-or-default" },
      nativePreview: videoElementSnapshot(elements.cameraPreview),
      vdoAr: IS_MOBILE_DEVICE ? "portrait" : "none"
    },
    remotes
  };
}

async function startGuestDebugMedia() {
  const debugMedia = new URLSearchParams(window.location.search).get("debugMedia") === "1";
  if (!debugMedia) return;
  try {
    const { startMediaDiagnostics, trackSnapshot, videoElementSnapshot } = await import("./media-diagnostics.js");
    startMediaDiagnostics(() => {
      try {
        return guestDiagnosticsSnapshot(trackSnapshot, videoElementSnapshot);
      } catch (err) {
        console.error("[Guest] debugMedia snapshot failed", err);
        return { role: "guest", error: String(err?.message || err) };
      }
    });
  } catch (err) {
    console.error("[Guest] debugMedia failed open; join continues", err);
  }
}

function handleVdoMessage(message, source) {
  if (!message) return;
  const fromPublisher = Boolean(source && source === engine.getFrameWindow("guest"));
  if (fromPublisher && message.action === "push-connection") {
    state.publisher.pushConnection = message.value === true;
    if (message.value === false) state.publisher.lastError = "push-connection-false";
    applyPublisherUi();
    if (message.value === true) stopPublisherWatch();
    return;
  }
  if (fromPublisher && (message.detailedState || (message.getDetailedState && typeof message.getDetailedState === "object"))) {
    const detailed = message.detailedState || message.getDetailedState;
    state.publisher.detailedSelf = pickLocalPublisherEntry(detailed, state.streamId) || state.publisher.detailedSelf;
    applyPublisherUi();
    if (currentPublisher().state === PublisherState.LIVE) stopPublisherWatch();
  }
  if (message.action === "view-connection" && message.value === false) {
    elements.joinState.textContent = "Host disconnected";
    elements.guestStatus.textContent = "The host connection was lost. Keep this page open if you plan to reconnect.";
  }
}
