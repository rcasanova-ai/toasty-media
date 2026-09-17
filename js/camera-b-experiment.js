// Synthetic Camera B — isolated technical spike (see studio/experimental-camera-b.html).
//
// Deliberately standalone: no import from live-session.js, video-engine.js, program-sync.js, or any
// other Live Studio module. This page cannot affect a real show even by accident — it has its own
// getUserMedia call, its own auth check, and its own local-only state. Nothing here is wired into the
// real Program Output or guest/source model; SyntheticCameraSource below is the CONCEPTUAL shape a real
// integration would use later, not a live registration.
import { studioRequest } from "./studio-api.js";

const els = {};

document.addEventListener("DOMContentLoaded", () => {
  [
    "cameraBGate", "cameraBApp", "cameraBConsent", "cameraBPreview", "cameraBCanvas",
    "cameraBReferenceImg", "cameraBStageEmpty", "cameraBCapture", "cameraBGenerate",
    "cameraBStatus", "cameraBSourceJson"
  ].forEach((id) => { els[id] = document.getElementById(id); });

  els.cameraBConsent.addEventListener("change", () => {
    els.cameraBCapture.disabled = !els.cameraBConsent.checked;
  });
  els.cameraBCapture.addEventListener("click", captureReference);

  checkHostAuth();
});

let participantId = null;
let currentSource = null;

// Host-only, per Task 2B: reuses the EXISTING Studio session check (js/studio-auth.js's same endpoint)
// rather than inventing a parallel auth mechanism. No guest, ever, can reach the capture UI below.
async function checkHostAuth() {
  try {
    const session = await studioRequest("/auth/session", { method: "GET" });
    if (!session.authenticated) {
      els.cameraBGate.innerHTML = `<p>Sign in to Toasty Studio first — <a href="./">go to Studio sign-in</a>.</p>`;
      return;
    }
    participantId = session.user?.id || "host";
    els.cameraBGate.hidden = true;
    els.cameraBApp.hidden = false;
  } catch (error) {
    els.cameraBGate.innerHTML = `<p>Studio account service is unavailable — try again shortly.</p>`;
  }
}

// A capture SEPARATE from the Studio's own VDO.Ninja camera pipeline on purpose: the host's live camera
// feed lives inside a cross-origin VDO.Ninja iframe (see js/video-engine.js), whose pixels this page
// cannot and should not read via canvas (cross-origin tainting, and it's out of scope to touch that
// transport per this session's boundaries anyway). This is its own short-lived local getUserMedia call,
// used only long enough to grab one still frame, then immediately stopped.
async function captureReference() {
  els.cameraBStatus.textContent = "Requesting camera…";
  els.cameraBCapture.disabled = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 }, audio: false });
  } catch (error) {
    els.cameraBStatus.textContent = "Camera permission is needed to capture a reference frame.";
    els.cameraBCapture.disabled = false;
    return;
  }
  const video = els.cameraBPreview;
  video.srcObject = stream;
  await video.play();
  // One frame is genuinely all this needs — see the research note in the page for why this stops here
  // instead of continuous capture (Task 2A explicitly asks not to assume continuous generation).
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const canvas = els.cameraBCanvas;
  canvas.width = video.videoWidth || 1280;
  canvas.height = video.videoHeight || 720;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  stream.getTracks().forEach((track) => track.stop());
  video.srcObject = null;

  els.cameraBReferenceImg.src = dataUrl;
  els.cameraBReferenceImg.hidden = false;
  els.cameraBStageEmpty.hidden = true;

  currentSource = buildSyntheticCameraSource({ participantId, referenceDataUrl: dataUrl });
  els.cameraBSourceJson.textContent = JSON.stringify({ ...currentSource, referenceDataUrl: "<omitted from debug view, kept only in-memory>" }, null, 2);
  els.cameraBStatus.textContent = "Reference captured. Stored only in this browser tab — nothing was uploaded.";
  els.cameraBCapture.disabled = false;
}

// The conceptual shape from Task 2C ("SOURCE ABSTRACTION") — matches Toasty's existing production
// source vocabulary (see js/live-session.js's guestSeats) closely enough that a real integration would
// slot in as another selectable source, not a parallel renderer. NOT registered with any real session,
// NOT sent anywhere — this is what the record would look like if/when this graduates past a spike.
function buildSyntheticCameraSource({ participantId, referenceDataUrl }) {
  return {
    sourceId: `synthetic-camera-${Date.now().toString(36)}`,
    participantId,
    sourceType: "synthetic-camera",
    label: "Camera B",
    provenance: "synthetic",
    consent: { granted: true, grantedAt: new Date().toISOString(), scope: "single-reference-frame" },
    // What this would eventually hand to Toasty Peeps Dub (see Task 2E / this session's report) —
    // a single consented reference image plus its own provenance trail, nothing Dub doesn't already
    // model for a DigitalDouble's inputs. No dub integration exists yet; this is documentation, not a call.
    dubEligibleAssets: referenceDataUrl ? ["reference-frame"] : []
  };
}
