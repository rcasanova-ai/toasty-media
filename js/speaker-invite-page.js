// Controller for studio/speaker-invite.html — the no-account guest speaker flow (section 3-5).
import { studioRequest } from "./studio-api.js";
import { RequiredConsentKey, OptionalConsentKey, requiredConsentKeysFor } from "./consent-policy.js";
import { computeSpeakerReadiness, ReadinessItem } from "./speaker-readiness.js";

const token = new URLSearchParams(window.location.search).get("token") || "";
const steps = ["stepLoading", "stepError", "stepIntro", "stepProfile", "stepTechCheck", "stepConsent", "stepReady"];
let eventName = "this event";
let speaker = null;
let techCheckResult = null;

function showStep(id) {
  for (const step of steps) {
    document.getElementById(step).classList.toggle("is-active", step === id);
  }
}

const CONSENT_LABELS = {
  [RequiredConsentKey.TERMS_OF_SERVICE]: "I agree to the Toasty Terms of Service.",
  [RequiredConsentKey.PRIVACY_POLICY]: "I agree to the Privacy Policy.",
  [RequiredConsentKey.RECORDING]: "I consent to audio/video recording of this session.",
  [RequiredConsentKey.DISTRIBUTION_REPLAY]: "I acknowledge this session may be distributed and made available as a replay.",
  [RequiredConsentKey.TRANSCRIPTION]: "I consent to transcription of this session.",
  [RequiredConsentKey.AI_PROCESSING]: "I consent to AI-assisted processing of this session.",
  [OptionalConsentKey.PROMOTIONAL_CLIPS]: "Toasty and the organizer may reuse short clips from this session for promotion/social media.",
  [OptionalConsentKey.RETAIN_PROFILE]: "Retain my profile information for future sessions with this organizer.",
  [OptionalConsentKey.PEEPS_PROFILE]: "Create/connect a Toasty Peeps profile from this session.",
  [OptionalConsentKey.MARKETING_COMMUNICATIONS]: "Send me marketing communications about future events."
};

async function init() {
  if (!token) {
    document.getElementById("errorMessage").textContent = "No invite token was provided — check the link you were sent.";
    showStep("stepError");
    return;
  }
  try {
    const result = await studioRequest(`/api/speaker-invites/${encodeURIComponent(token)}`);
    speaker = result.speaker;
    eventName = result.event?.title || "this event";
    document.getElementById("introEventName").textContent = `You've been invited as a speaker for ${eventName}`;
    prefillProfileForm(speaker);
    showStep("stepIntro");
  } catch (error) {
    document.getElementById("errorMessage").textContent = error.message || "This invitation link is no longer valid.";
    showStep("stepError");
  }
}

function prefillProfileForm(s) {
  if (!s) return;
  const set = (id, value) => { const el = document.getElementById(id); if (el && value) el.value = value; };
  set("fDisplayName", s.displayName);
  set("fTitle", s.title);
  set("fCompany", s.company);
  set("fOnscreenTitle", s.onscreenTitle);
  set("fBioShort", s.bioShort);
  set("fBioLong", s.bioLong);
  set("fHeadshot", s.headshotReference);
  set("fPronouns", s.pronouns);
  set("fLocation", s.location);
  set("fTimezone", s.speakerTimezone);
  set("fPronunciation", s.pronunciationNotes);
  const links = s.links || {};
  set("lLinkedin", links.linkedin);
  set("lX", links.x);
  set("lWebsite", links.website);
  set("lInstagram", links.instagram);
  set("lTiktok", links.tiktok);
  set("lYoutube", links.youtube);
  set("lGithub", links.github);
  set("lTelegram", links.telegram);
  updatePreview();
}

function updatePreview() {
  const name = document.getElementById("fDisplayName").value || "Your name";
  const title = document.getElementById("fOnscreenTitle").value
    || [document.getElementById("fTitle").value, document.getElementById("fCompany").value].filter(Boolean).join(", ");
  document.getElementById("previewName").textContent = name;
  document.getElementById("previewTitle").textContent = title || "Title, Company";
}

document.getElementById("startProfileBtn").addEventListener("click", () => showStep("stepProfile"));
document.getElementById("profileForm").addEventListener("input", updatePreview);

document.getElementById("profileForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const statusEl = document.getElementById("profileStatus");
  statusEl.textContent = "Saving…";
  statusEl.classList.remove("is-error");
  const val = (id) => document.getElementById(id).value.trim();
  const links = {};
  for (const [id, key] of [["lLinkedin", "linkedin"], ["lX", "x"], ["lWebsite", "website"], ["lInstagram", "instagram"], ["lTiktok", "tiktok"], ["lYoutube", "youtube"], ["lGithub", "github"], ["lTelegram", "telegram"]]) {
    const v = val(id);
    if (v) links[key] = v;
  }
  const fields = {
    displayName: val("fDisplayName"),
    title: val("fTitle"),
    company: val("fCompany"),
    onscreenTitle: val("fOnscreenTitle"),
    bioShort: val("fBioShort"),
    bioLong: val("fBioLong"),
    headshotReference: val("fHeadshot"),
    pronouns: val("fPronouns"),
    location: val("fLocation"),
    speakerTimezone: val("fTimezone"),
    pronunciationNotes: val("fPronunciation"),
    links
  };
  try {
    const result = await studioRequest(`/api/speaker-invites/${encodeURIComponent(token)}/profile`, { method: "POST", body: JSON.stringify({ fields }) });
    speaker = result.speaker;
    statusEl.textContent = "";
    showStep("stepTechCheck");
  } catch (error) {
    statusEl.textContent = error.message || "Could not save your profile.";
    statusEl.classList.add("is-error");
  }
});

document.getElementById("runTechCheckBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("techCheckStatus");
  statusEl.textContent = "Testing…";
  statusEl.classList.remove("is-error");
  const browserSupported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  document.getElementById("tcBrowser").textContent = browserSupported ? "Supported" : "Not supported";
  let cameraOk = false;
  let micOk = false;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    cameraOk = stream.getVideoTracks().length > 0;
    micOk = stream.getAudioTracks().length > 0;
    stream.getTracks().forEach((track) => track.stop());
  } catch (error) {
    statusEl.textContent = "Camera/microphone permission was denied or unavailable.";
    statusEl.classList.add("is-error");
  }
  document.getElementById("tcCamera").textContent = cameraOk ? "Working" : "Unavailable";
  document.getElementById("tcMic").textContent = micOk ? "Working" : "Unavailable";
  techCheckResult = { cameraOk, micOk, browserSupported, connectionOutcome: cameraOk && micOk ? "good" : "incomplete" };
  try {
    await studioRequest(`/api/speaker-invites/${encodeURIComponent(token)}/tech-check`, {
      method: "POST",
      body: JSON.stringify({ ...techCheckResult, deviceLabels: [] })
    });
    if (!statusEl.classList.contains("is-error")) statusEl.textContent = "Tech check complete.";
    document.getElementById("techCheckContinueBtn").disabled = false;
  } catch (error) {
    statusEl.textContent = error.message || "Could not record tech check.";
    statusEl.classList.add("is-error");
  }
});

document.getElementById("techCheckContinueBtn").addEventListener("click", () => {
  renderConsentStep();
  showStep("stepConsent");
});

function renderConsentStep() {
  // No session plan is exposed to the guest invite read yet, so this uses the baseline required set
  // (session-type customization is designed in js/consent-policy.js for when that plumbing exists).
  const required = requiredConsentKeysFor({ sessionType: "default" });
  const optional = Object.values(OptionalConsentKey);
  const requiredList = document.getElementById("requiredConsentList");
  const optionalList = document.getElementById("optionalConsentList");
  requiredList.innerHTML = required.map((key) => consentRow(key, true)).join("");
  optionalList.innerHTML = optional.map((key) => consentRow(key, false)).join("");
}

function consentRow(key, required) {
  const label = CONSENT_LABELS[key] || key;
  return `<div class="eg-check-row"><input type="checkbox" id="consent-${key}" data-consent-key="${key}" data-required="${required}"><label for="consent-${key}">${label}</label></div>`;
}

document.getElementById("submitConsentBtn").addEventListener("click", async () => {
  const statusEl = document.getElementById("consentStatus");
  const boxes = [...document.querySelectorAll("[data-consent-key]")];
  const requiredKeys = boxes.filter((b) => b.dataset.required === "true");
  const missingRequired = requiredKeys.some((b) => !b.checked);
  if (missingRequired) {
    statusEl.textContent = "Please accept all required items before continuing.";
    statusEl.classList.add("is-error");
    return;
  }
  const requiredAcceptances = requiredKeys.filter((b) => b.checked).map((b) => b.dataset.consentKey);
  const optionalPermissions = boxes.filter((b) => b.dataset.required === "false" && b.checked).map((b) => b.dataset.consentKey);
  statusEl.textContent = "Submitting…";
  statusEl.classList.remove("is-error");
  try {
    await studioRequest(`/api/speaker-invites/${encodeURIComponent(token)}/consent`, {
      method: "POST",
      body: JSON.stringify({ requiredAcceptances, optionalPermissions })
    });
    showReadyStep();
    showStep("stepReady");
  } catch (error) {
    statusEl.textContent = error.message || "Could not record consent.";
    statusEl.classList.add("is-error");
  }
});

function showReadyStep() {
  document.getElementById("readyHeadline").textContent = `You're ready for ${eventName}`;
  const readiness = computeSpeakerReadiness({
    speaker,
    techCheck: techCheckResult,
    consentRecords: [{ participantId: speaker.id, acceptedAt: new Date().toISOString(), requiredAcceptances: requiredConsentKeysFor({ sessionType: "default" }) }],
    requirementConfig: { sessionType: "default" },
    calendarConfirmed: true,
    sessionLinkSent: true
  });
  const labels = {
    [ReadinessItem.PROFILE]: "Profile",
    [ReadinessItem.PHOTO]: "Photo",
    [ReadinessItem.CONSENT]: "Consent",
    [ReadinessItem.RELEASE]: "Release",
    [ReadinessItem.TECH_CHECK]: "Tech check",
    [ReadinessItem.CALENDAR]: "Calendar",
    [ReadinessItem.SESSION_LINK]: "Session link"
  };
  document.getElementById("readinessList").innerHTML = Object.entries(readiness.items)
    .map(([key, ok]) => `<div><span>${labels[key] || key}</span><span class="${ok ? "ok" : "pending"}">${ok ? "✓" : "Pending"}</span></div>`)
    .join("");
}

init();
