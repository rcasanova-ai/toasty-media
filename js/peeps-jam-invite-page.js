// Controller for peeps/jam-invite.html — the Jam Lobby: a single, no-account screen that takes a
// participant from "Invite URL" through name + consent + camera/mic preview to "Join Jam", per the
// Jam Lobby + Join Flow brief. Reuses existing infrastructure end to end rather than building a parallel
// device-capture or branding system:
//   - js/device-picker.js for camera enumeration/hydration/Camo-avoidance (getUserMediaWithFallback,
//     deviceConstraint, hydrateDevices, selectedDeviceLabel, isCamoCamera) — everything except the audio
//     constraint itself, which the brief pins to the canonical clean-mic target below.
//   - js/microphone-capture.js for the canonical clean mic constraint + live level meter — the exact
//     module merged in 6e99ec464ea29c2c44382ffe57d5085959d2e551, not a second implementation.
//   - js/org-brand.js + js/brand-themes.js for the org's own logo when the Jam's organization has a
//     configured BrandProfile (same public, guest-safe brand-profile endpoint Studio guest/listener use);
//     otherwise the page keeps its default Toasty Peeps identity untouched.
import { RequiredConsentKey } from "./consent-policy.js";
import { getJamInvite, acceptJamInvite, submitJamConsent } from "./peeps-jam-api.js";
import { getUserMediaWithFallback, deviceConstraint, hydrateDevices, selectedDeviceLabel, isCamoCamera } from "./device-picker.js";
import { cleanMicAudioConstraint, createMicMeter } from "./microphone-capture.js";
import { ensureOrgTheme } from "./org-brand.js";
import { applyBrandTheme } from "./brand-themes.js";

const token = new URLSearchParams(window.location.search).get("token") || "";
const $ = (id) => document.getElementById(id);
const STEPS = ["stepLoading", "stepError", "stepLobby"];

let jam = null;
let previewStream = null;
let micMeter = null;
let micMuted = false;
let cameraOff = false;

function showStep(id) {
  for (const step of STEPS) $(step).classList.toggle("is-active", step === id);
}

function fail(message) {
  $("errorMessage").textContent = message || "This invitation could not be loaded.";
  showStep("stepError");
}

function money(compensation) {
  if (!compensation || !compensation.amount) return "";
  return `This Jam offers ${compensation.amount} ${compensation.currency || "USD"} for the engagement, not a particular answer or outcome.`;
}

// ---- Camera/mic preview — same enumerate/request/hydrate/Camo-swap lifecycle as
// device-picker.js's startDevicePreview, with one deliberate divergence: the audio request always uses
// the canonical clean mic constraint (mono/48kHz/echoCancellation+noiseSuppression on/autoGainControl
// off), not device-picker's own "raw pro audio" constraint used by the Studio host/guest prejoin. ----

async function requestPreviewStream(cameraId, micId) {
  return getUserMediaWithFallback({
    video: deviceConstraint(cameraId, "video"),
    audio: cleanMicAudioConstraint(micId)
  });
}

function setPreviewStream(stream) {
  if (previewStream) previewStream.getTracks().forEach((track) => track.stop());
  previewStream = stream;
  micMeter?.stop();
  micMeter = createMicMeter(stream, { onSample: renderMicMeter });
  applyMicMuted();
  applyCameraOff();
}

function applyMicMuted() {
  previewStream?.getAudioTracks().forEach((track) => { track.enabled = !micMuted; });
}

function applyCameraOff() {
  previewStream?.getVideoTracks().forEach((track) => { track.enabled = !cameraOff; });
  $("previewVideo").classList.toggle("is-off", cameraOff);
  $("previewOff").classList.toggle("is-active", cameraOff);
}

function renderMicMeter(sample) {
  const fill = $("micMeterFill");
  if (!fill) return;
  const db = Number.isFinite(sample.rmsDbfs) ? sample.rmsDbfs : -120;
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  fill.style.width = `${pct}%`;
}

async function startPreview() {
  const videoEl = $("previewVideo");
  const cameraSelect = $("cameraSelect");
  const microphoneSelect = $("microphoneSelect");
  try {
    const cameraBefore = cameraSelect.value;
    let stream = await requestPreviewStream(cameraSelect.value, microphoneSelect.value);
    videoEl.srcObject = stream;
    await hydrateDevices(microphoneSelect, cameraSelect);
    if (cameraSelect.value && cameraSelect.value !== cameraBefore) {
      stream.getTracks().forEach((track) => track.stop());
      stream = await requestPreviewStream(cameraSelect.value, microphoneSelect.value);
      videoEl.srcObject = stream;
    } else {
      const currentCameraLabel = selectedDeviceLabel(cameraSelect);
      if (currentCameraLabel && isCamoCamera(currentCameraLabel)) {
        const better = [...cameraSelect.options].find((option) => !isCamoCamera(option.dataset.rawLabel || option.textContent));
        if (better) {
          cameraSelect.value = better.value;
          stream.getTracks().forEach((track) => track.stop());
          stream = await requestPreviewStream(cameraSelect.value, microphoneSelect.value);
          videoEl.srcObject = stream;
        }
      }
    }
    setPreviewStream(stream);
    $("deviceStatus").textContent = "Camera and microphone ready.";
  } catch (error) {
    $("deviceStatus").textContent = "Could not access your camera/microphone — check your browser's permission prompt.";
  }
  updateJoinEnabled();
}

async function restartPreviewForDeviceChange() {
  const cameraSelect = $("cameraSelect");
  const microphoneSelect = $("microphoneSelect");
  try {
    const stream = await requestPreviewStream(cameraSelect.value, microphoneSelect.value);
    $("previewVideo").srcObject = stream;
    setPreviewStream(stream);
  } catch (error) {
    $("deviceStatus").textContent = "Could not switch devices — check your browser's permission prompt.";
  }
}

$("cameraToggle").addEventListener("click", () => {
  cameraOff = !cameraOff;
  applyCameraOff();
  $("cameraToggle").textContent = cameraOff ? "Camera off" : "Camera on";
  $("cameraToggle").classList.toggle("is-off", cameraOff);
});

$("micToggle").addEventListener("click", () => {
  micMuted = !micMuted;
  applyMicMuted();
  $("micToggle").textContent = micMuted ? "Mic off" : "Mic on";
  $("micToggle").classList.toggle("is-off", micMuted);
});

$("cameraSelect").addEventListener("change", restartPreviewForDeviceChange);
$("microphoneSelect").addEventListener("change", restartPreviewForDeviceChange);

// ---- Lobby load ----

function updateJoinEnabled() {
  const nameOk = $("displayName").value.trim().length > 0;
  const consentOk = $("consentCheckbox").checked;
  $("joinBtn").disabled = !(jam && nameOk && consentOk && previewStream);
}

$("displayName").addEventListener("input", updateJoinEnabled);
$("consentCheckbox").addEventListener("change", updateJoinEnabled);

async function init() {
  if (!token) {
    fail("No invite token was provided — check the link you were sent.");
    return;
  }
  let result;
  try {
    result = await getJamInvite(token);
  } catch (error) {
    fail(error.message);
    return;
  }
  jam = result.jam;
  const participant = result.participant;
  if (!jam) {
    fail("This Jam is no longer available.");
    return;
  }
  if (jam.status === "canceled") {
    fail("This Jam has been canceled by the organizer.");
    return;
  }
  $("jamTitle").textContent = jam.title ? `You're invited: ${jam.title}` : "You're invited to a Toasty Peeps Jam";
  $("jamHost").textContent = jam.organizationName ? `Hosted by ${jam.organizationName}` : "";
  $("jamObjective").textContent = jam.objective || "";
  $("jamCompensation").textContent = money(jam.compensation);
  $("displayName").value = participant?.displayName || "";
  showStep("stepLobby");
  updateJoinEnabled();
  startPreview();
  acceptJamInvite(token).catch(() => {});
  if (jam.organizationId) {
    ensureOrgTheme(`org:${jam.organizationId}`)
      .then((theme) => { if (theme) applyBrandTheme(theme.id, { logoImg: $("brandLogo") }); })
      .catch(() => {});
  }
}

function persistDevicePrefs() {
  try {
    sessionStorage.setItem(`toasty:jam:${jam.id}:devicePrefs`, JSON.stringify({
      cameraLabel: selectedDeviceLabel($("cameraSelect")),
      microphoneLabel: selectedDeviceLabel($("microphoneSelect")),
      micMuted,
      cameraOff
    }));
  } catch {
    // sessionStorage unavailable (private mode, etc) — room.html falls back to its own defaults.
  }
}

$("joinBtn").addEventListener("click", async () => {
  const btn = $("joinBtn");
  btn.disabled = true;
  const statusEl = $("joinStatus");
  statusEl.textContent = "Joining…";
  statusEl.classList.remove("is-error");
  try {
    const displayName = $("displayName").value.trim();
    // The single Lobby consent checkbox is the participant-facing surface for whatever this Jam actually
    // requires — it satisfies every key in jam.consentRequirements (never fewer) plus "recording", since
    // the checkbox copy itself already covers recording/session-insights use. This is the smallest
    // persistence that fits the existing consent gate handleJamParticipantConfirm enforces, not a new
    // consent system.
    const requiredAcceptances = [...new Set([...(jam.consentRequirements || []), RequiredConsentKey.RECORDING])];
    const result = await submitJamConsent(token, {
      displayName,
      requiredAcceptances,
      optionalPermissions: [],
      agreementVersion: "lobby-v1"
    });
    if (!result.consentSatisfied) {
      statusEl.textContent = "Could not confirm consent — please try again.";
      statusEl.classList.add("is-error");
      btn.disabled = false;
      return;
    }
    persistDevicePrefs();
    window.location.href = `./room.html?jam=${encodeURIComponent(jam.id)}&invite=${encodeURIComponent(token)}`;
  } catch (error) {
    statusEl.textContent = error.message || "Could not join this Jam.";
    statusEl.classList.add("is-error");
    btn.disabled = false;
  }
});

init();
