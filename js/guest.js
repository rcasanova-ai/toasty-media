import { BackgroundMode, VideoEngine, getRoomIdFromUrl, isValidRoomId } from "./video-engine.js";
import { applyBrandTheme, getInitialBrandTheme } from "./brand-themes.js";
import { startDevicePreview } from "./device-picker.js";

// INSTRUMENTATION BUILD MARKER — bump this string on every deploy meant to be checked against a real
// device screenshot. A phone showing an OLD value here (or the debug panel missing entirely) means the
// device is running stale/cached code, not the build actually being debugged — rule that out FIRST, before
// reading anything else off the panel. See #toastyDebugPanel in studio/guest.html.
const BUILD_ID = "guest-diag-2026-09-18-01";

// Set true at the very top of module evaluation — if this ever reads NO on a real device, the module
// itself failed to load/parse/execute (network failure, JS syntax error, import failure, etc.), which is a
// completely different failure class than "the button doesn't work."
window.__toastyGuestJsLoaded = true;
const READY_STATE_AT_MODULE_RUN = document.readyState;

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
  hostViewUnsub: null,
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
  guestParticipantStage: document.querySelector("#guestParticipantStage"),
  guestRemoteFrame: document.querySelector("#guestRemoteFrame"),
  guestRemoteStageEmpty: document.querySelector("#guestRemoteStageEmpty"),
  guestLiveIdentityName: document.querySelector("#guestLiveIdentityName"),
  guestLiveIdentityRole: document.querySelector("#guestLiveIdentityRole"),
  guestToggleMic: document.querySelector("#guestToggleMic"),
  guestToggleCamera: document.querySelector("#guestToggleCamera"),
  guestFlipCamera: document.querySelector("#guestFlipCamera"),
  guestToggleScreen: document.querySelector("#guestToggleScreen"),
  guestEndSession: document.querySelector("#guestEndSession"),
  diagLog: document.querySelector("#guestDiagLog"),
  debugFields: document.querySelector("#toastyDebugFields")
};

// ---- Instrumentation: live debug panel (see studio/guest.html's #toastyDebugPanel) ----
// Every field here is read fresh at render time from real DOM/state, never cached, so the panel can never
// show a stale answer for something checkable right now (Join disabled, stream tracks, hit-test target).
const debug = {
  clickListenerAttached: false,
  pointerdownCount: 0,
  touchstartCount: 0,
  clickCount: 0,
  lastAction: "(none yet)",
  lastError: ""
};

function renderDebugPanel() {
  if (!elements.debugFields) return;
  let hitTest = "(button not in DOM)";
  const btn = elements.joinStudio;
  if (btn) {
    const rect = btn.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const atPoint = document.elementFromPoint(cx, cy);
    hitTest = atPoint
      ? `<${atPoint.tagName.toLowerCase()}${atPoint.id ? ` id="${atPoint.id}"` : ""}${atPoint.className && typeof atPoint.className === "string" ? ` class="${atPoint.className}"` : ""}>${atPoint === btn ? "  <- IS the button" : "  <- NOT the button (something is covering it)"}`
      : "(nothing found at button center — off-screen?)";
  }
  const rows = [
    ["BUILD", BUILD_ID],
    ["guest.js loaded", "YES"],
    ["document.readyState at module run", READY_STATE_AT_MODULE_RUN],
    ["Join element found", btn ? "YES" : "NO"],
    ["Join disabled", btn ? String(btn.disabled) : "(n/a)"],
    ["current lifecycle state", state.lifecycle],
    ["local stream exists", String(Boolean(state.previewStream))],
    ["video tracks", String(state.previewStream?.getVideoTracks().length ?? "(no stream)")],
    ["audio tracks", String(state.previewStream?.getAudioTracks().length ?? "(no stream)")],
    ["click listener attached (addEventListener)", debug.clickListenerAttached ? "YES" : "NO"],
    ["pointerdown count", String(debug.pointerdownCount)],
    ["touchstart count", String(debug.touchstartCount)],
    ["click count", String(debug.clickCount)],
    ["element at Join center", hitTest],
    ["last action", debug.lastAction],
    ["last error", debug.lastError || "(none)"]
  ];
  elements.debugFields.replaceChildren(...rows.map(([label, value]) => {
    const row = document.createElement("div");
    if (label === "last error" && debug.lastError) row.className = "debug-error";
    row.textContent = `${label}: ${value}`;
    return row;
  }));
}

function setLastAction(text) {
  debug.lastAction = text;
  diag(text);
  renderDebugPanel();
}

// Fires on the REAL button element regardless of how the tap arrives (inline onclick, addEventListener, or
// neither) — capturing phase, before anything else can intercept or stop the event, so these counts answer
// "did the tap physically reach the button at all" independent of whether our own handlers are broken.
function wireHitTestCounters() {
  const btn = elements.joinStudio;
  if (!btn) return;
  btn.addEventListener("pointerdown", () => { debug.pointerdownCount++; renderDebugPanel(); }, { capture: true });
  btn.addEventListener("touchstart", () => { debug.touchstartCount++; renderDebugPanel(); }, { capture: true, passive: true });
  btn.addEventListener("click", () => { debug.clickCount++; renderDebugPanel(); }, { capture: true });
}

// The globally-exposed diagnostic entry point — see studio/guest.html's inline onclick on #joinStudio.
// Deliberately bypasses addEventListener ambiguity: an inline onclick attribute is guaranteed to fire on a
// real click/tap if the browser executes JS on this page AT ALL, independent of whether our own
// addEventListener binding (bindControls -> joinStudio) succeeded. The very first lines below run before
// any async work, so "does the phone ever show CLICK RECEIVED" answers, on its own, whether execution
// reaches this handler at all.
window.__toastyGuestJoinDiagnostic = async function toastyGuestJoinDiagnostic(event) {
  debug.clickCount++; // inline onclick fires independently of the capturing click counter above
  const originalLabel = elements.joinStudio?.textContent;
  if (elements.joinStudio) elements.joinStudio.textContent = "CLICK RECEIVED";
  setLastAction("INLINE CLICK RECEIVED");
  try {
    setLastAction("CALLING joinStudio()");
    await joinStudio();
    setLastAction("joinStudio() RETURNED");
    // Only restore the button's label if we're still on the prejoin card — a successful join already
    // moved past needing "Join Studio" text at all (see joinStudio's IN_STUDIO transition).
    if (elements.joinStudio && state.lifecycle !== GuestLifecycle.IN_STUDIO) {
      elements.joinStudio.textContent = originalLabel || "Join Studio";
    }
  } catch (error) {
    const firstStackLine = (error?.stack || "").split("\n")[1]?.trim() || "(no stack)";
    debug.lastError = `${error?.name || "Error"}: ${error?.message || "(no message)"} — ${firstStackLine}`;
    setLastAction("joinStudio() THREW — see last error");
    log("joinStudio THREW", error);
    if (elements.joinStudio) elements.joinStudio.textContent = originalLabel || "Join Studio";
    elements.guestStatus.dataset.error = "true";
    elements.guestStatus.textContent = `Join failed: ${error?.name || "Error"}: ${error?.message || "unknown error"}`;
  }
};

// Render the panel IMMEDIATELY, before anything else runs — if init() throws below, this first paint is
// still on screen showing "guest.js loaded: YES" and whatever state existed at that point, instead of the
// panel never appearing at all (which on a real device is indistinguishable from the whole script failing).
renderDebugPanel();
window.setInterval(renderDebugPanel, 1000);

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
      renderDebugPanel();
      return;
    }
    diag(`participantId: ${state.participantId}`);
    diag(`roomId: ${state.roomId}`);
    bindControls();
    wireHitTestCounters();
    engine.onMessage(handleVdoMessage);
    renderDebugPanel();
    await startPreview();
  } catch (error) {
    const firstStackLine = (error?.stack || "").split("\n")[1]?.trim() || "(no stack)";
    debug.lastError = `init() THREW: ${error?.name || "Error"}: ${error?.message || "(no message)"} — ${firstStackLine}`;
    log("init() THREW", error);
    renderDebugPanel();
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
  // NOT the primary path on this diagnostic build (the inline onclick in studio/guest.html is), but kept
  // and tracked so the panel can show whether addEventListener itself succeeded, independent of the inline
  // handler — a real difference between them (e.g. a CSP blocking inline handlers but not addEventListener,
  // or vice versa) is exactly the kind of thing this build exists to catch.
  try {
    elements.joinStudio.addEventListener("click", joinStudio);
    debug.clickListenerAttached = true;
  } catch (error) {
    debug.clickListenerAttached = false;
    debug.lastError = `addEventListener THREW: ${error?.name}: ${error?.message}`;
  }
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
// button, not a <form> submit (no native constraint validation ever runs). Synchronous end to end — no
// await, matching joinAsHost's own immediate mount-then-transition shape exactly.
function joinStudio() {
  setLastAction("J1 ENTER joinStudio");
  if (state.lifecycle !== GuestLifecycle.PREJOIN_READY) {
    setLastAction(`J1 ABORTED — lifecycle was "${state.lifecycle}", not prejoin-ready`);
    return;
  }
  setLastAction("J2 STATE CHECK PASSED (lifecycle is prejoin-ready)");
  const guestName = elements.guestName.value.trim();
  if (!guestName) {
    setLastAction("J2 ABORTED — no name entered");
    elements.guestStatus.textContent = "Enter your name before joining.";
    elements.guestStatus.dataset.error = "true";
    elements.guestName.focus();
    return;
  }
  setLastAction(`J3 STREAM CHECK — previewStream exists: ${Boolean(state.previewStream)}, video tracks: ${state.previewStream?.getVideoTracks().length ?? 0}`);
  const guestTitle = elements.guestTitleField.value.trim();
  const guestCompany = elements.guestCompany.value.trim();
  const role = [guestTitle, guestCompany].filter(Boolean).join(", ");
  const label = role ? `${guestName} · ${role}` : guestName;

  setLastAction("J4 DISABLING BUTTON");
  elements.joinStudio.disabled = true;
  setLastAction("J5 STATE = JOINING");
  setLifecycle(GuestLifecycle.JOINING);
  elements.joinState.textContent = "Joining";
  elements.guestStatus.dataset.error = "false";
  elements.guestStatus.textContent = "Connecting…";
  const backgroundNote = getBackgroundNote(state.selectedBackground);

  // Device LABEL, not .value (a MediaDevices deviceId) — see video-engine.js's mountDirectorFrame
  // comment for why a deviceId read here can't reliably resolve inside VDO.Ninja's cross-origin iframe.
  const videoDeviceLabel = elements.cameraSelect.selectedOptions[0]?.textContent;
  const audioDeviceLabel = elements.microphoneSelect.selectedOptions[0]?.textContent;

  setLastAction("J6 MOVING PREVIEW (relocating #previewStage into stage as self PiP)");
  // Toasty-owned name/title under the live tile — see css/studio.css's .guest-live-identity comment for
  // why this is separate from VDO.Ninja's own showlabels overlay.
  elements.guestLiveIdentityName.textContent = guestName;
  elements.guestLiveIdentityRole.textContent = role;
  // Move the SAME preview node (not a clone — a live <video> with srcObject already set) into the joined
  // view as the small self PiP — see css/studio.css's .lv-participant-stage comment ("solve the
  // remote-source primitive once"): PARTICIPANT VIEW puts the OTHER person on the main stage and your own
  // camera in a corner, the reverse of what this page showed before.
  elements.guestParticipantStage.appendChild(elements.previewStage);
  elements.previewStage.classList.remove("preview-stage--live");
  elements.previewStage.classList.add("lv-stage-pip");

  setLastAction(`J7 MOUNTING TRANSPORT — videoDeviceLabel="${videoDeviceLabel || "(none)"}" audioDeviceLabel="${audioDeviceLabel || "(none)"}"`);
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
  setLastAction(`J8 TRANSPORT MOUNT RETURNED — push id "${state.streamId}"`);

  // NOT waiting for any publish confirmation here — mirrors live-session.js's joinAsHost exactly, which
  // mounts the Host's hidden transport frame and calls setHostState(IN_STUDIO) immediately, with no
  // confirmation step at all. A previous version of this file added a confirmPublishing() wait Host never
  // had; on a real device that showed as "click Join, nothing happens for up to ~30s" — an invented
  // abstraction, not something proven by the one path that actually works. Removed rather than tuned.

  // PARTICIPANT VIEW of the Host — the other half of "solve the remote-source primitive once": the Host's
  // stream id is always roomId+"h" (see js/video-engine.js's mountDirectorFrame), a fixed convention this
  // codebase already relies on elsewhere, not something discovered — a guest has no director permissions
  // to enumerate room membership the way js/live-session.js's requestGuestList does for the Host/Director.
  // Mounted speculatively (the Host may not have joined yet); mountRemoteHostView's own connection-message
  // listener (see below) toggles the "Waiting for host" placeholder off once real video actually arrives,
  // separately from whether the iframe merely loaded.
  mountRemoteHostView();

  // The check-in form (name/title/company/device pickers/background swatches) has done its job —
  // once joined, guests should see only the live feed and the mute/camera/screen-share dock.
  elements.guestCheckin.hidden = true;
  elements.joinedRoom.hidden = false;
  elements.guestStatus.textContent = backgroundNote || `Joined. The ${state.brandLabel} room is open below.`;
  elements.joinState.textContent = "Joined";
  setLastAction("J9 STATE = IN_STUDIO");
  setLifecycle(GuestLifecycle.IN_STUDIO);
  setLastAction("J10 COMPLETE");
}

// PARTICIPANT VIEW ONLY — this is "who Tukta is talking to," never Program Output (a separate concept
// entirely; see studio/listener.html/js/listener.js for that, which this page has no connection to).
// Mounts a clean &view=<hostStreamId> of the Host and listens for THIS SPECIFIC mounted frame's own
// connection messages (video-engine.js's handleMessage now passes event.source through for exactly this
// kind of per-frame attribution) to distinguish "iframe exists" from "a real person is actually visible" —
// the same distinction whose absence was the root cause chased earlier this pass on the Host side.
function mountRemoteHostView() {
  const hostStreamId = `${state.roomId}h`;
  elements.guestRemoteStageEmpty.hidden = false;
  const iframe = engine.mountParticipantView(elements.guestRemoteFrame, { streamId: hostStreamId }, "hostview");
  diag(`mounted remote Host view — streamId="${hostStreamId}"`);
  // Tracked so leaveSession can unsubscribe — without this, rejoining (Leave, then Join again) would stack
  // a new listener on top of the old one every cycle instead of replacing it.
  state.hostViewUnsub = engine.onMessage((message, source) => {
    if (source !== iframe.contentWindow) return;
    diag(`hostview message: ${JSON.stringify(message).slice(0, 160)}`);
    if (message?.action === "view-connection") {
      elements.guestRemoteStageEmpty.hidden = Boolean(message.value);
    }
  });
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
  state.hostViewUnsub?.();
  state.hostViewUnsub = null;
  engine.unmountFrame(elements.guestRemoteFrame, "hostview", "Waiting for host to join");
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
