// Controller for peeps/jam-invite.html — the no-account participant flow for a Peeps Jam, same
// pattern as js/speaker-invite-page.js (studio/speaker-invite.html) but scoped to a Jam's own
// consentRequirements rather than a session-type baseline.
import { RequiredConsentKey, OptionalConsentKey } from "./consent-policy.js";
import { getJamInvite, acceptJamInvite, submitJamConsent } from "./peeps-jam-api.js";

const token = new URLSearchParams(window.location.search).get("token") || "";
const steps = ["stepLoading", "stepError", "stepIntro", "stepConsent", "stepReady"];
let jam = null;

function showStep(id) {
  for (const step of steps) document.getElementById(step).classList.toggle("is-active", step === id);
}

const CONSENT_LABELS = {
  [RequiredConsentKey.TERMS_OF_SERVICE]: "I agree to the Toasty Terms of Service.",
  [RequiredConsentKey.PRIVACY_POLICY]: "I agree to the Privacy Policy.",
  [RequiredConsentKey.RECORDING]: "I consent to audio/video recording of this Jam, if enabled.",
  [RequiredConsentKey.TRANSCRIPTION]: "I consent to transcription of this Jam, if enabled.",
  [RequiredConsentKey.AI_PROCESSING]: "I consent to AI-assisted processing of this Jam.",
  [RequiredConsentKey.DISTRIBUTION_REPLAY]: "I acknowledge this Jam may be distributed and made available as a replay.",
  [RequiredConsentKey.CONFIDENTIALITY]: "I agree to keep the content of this Jam confidential.",
  [RequiredConsentKey.RESEARCH_PARTICIPATION]: "I consent to participate in this research conversation.",
  [RequiredConsentKey.DATA_USE]: "I consent to my responses being used for the stated research objective.",
  [RequiredConsentKey.CLIENT_RELEASE]: "I agree to the client release terms for this engagement.",
  [OptionalConsentKey.PROMOTIONAL_CLIPS]: "Toasty and the organizer may reuse short clips from this Jam for promotion/social media.",
  [OptionalConsentKey.RETAIN_PROFILE]: "Retain my profile information for future Jams with this organizer.",
  [OptionalConsentKey.PEEPS_PROFILE]: "Create/connect a Toasty Peeps Dub from this Jam.",
  [OptionalConsentKey.MARKETING_COMMUNICATIONS]: "Send me marketing communications about future Jams."
};

function money(compensation) {
  if (!compensation || !compensation.amount) return "";
  return `This Jam offers ${compensation.amount} ${compensation.currency || "USD"} for the engagement, not a particular answer or outcome.`;
}

async function init() {
  if (!token) {
    document.getElementById("errorMessage").textContent = "No invite token was provided — check the link you were sent.";
    showStep("stepError");
    return;
  }
  try {
    const result = await getJamInvite(token);
    jam = result.jam;
    document.getElementById("introJamTitle").textContent = jam?.title ? `You're invited: ${jam.title}` : "You've been invited to a Toasty Peeps Jam";
    document.getElementById("introJamObjective").textContent = jam?.objective || "";
    document.getElementById("introCompensation").textContent = money(jam?.compensation);
    if (result.participant?.consentCapturedAt) {
      showStep("stepReady");
      return;
    }
    showStep("stepIntro");
  } catch (error) {
    document.getElementById("errorMessage").textContent = error.message || "This invitation could not be loaded.";
    showStep("stepError");
  }
}

document.getElementById("acceptBtn").addEventListener("click", async () => {
  const btn = document.getElementById("acceptBtn");
  btn.disabled = true;
  try {
    await acceptJamInvite(token);
    renderConsentStep();
    showStep("stepConsent");
  } catch (error) {
    document.getElementById("errorMessage").textContent = error.message || "Could not accept this invite.";
    showStep("stepError");
  } finally {
    btn.disabled = false;
  }
});

function renderConsentStep() {
  const required = jam?.consentRequirements || [];
  const optional = Object.values(OptionalConsentKey);
  document.getElementById("requiredConsentList").innerHTML = required.map((key) => consentRow(key, true)).join("") || "<p class=\"eg-status\">No specific consent items were configured for this Jam.</p>";
  document.getElementById("optionalConsentList").innerHTML = optional.map((key) => consentRow(key, false)).join("");
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
    statusEl.textContent = "Please accept every required item before continuing.";
    statusEl.classList.add("is-error");
    return;
  }
  const requiredAcceptances = requiredKeys.filter((b) => b.checked).map((b) => b.dataset.consentKey);
  const optionalPermissions = boxes.filter((b) => b.dataset.required === "false" && b.checked).map((b) => b.dataset.consentKey);
  statusEl.textContent = "Submitting…";
  statusEl.classList.remove("is-error");
  try {
    const result = await submitJamConsent(token, { requiredAcceptances, optionalPermissions, agreementVersion: "v1" });
    if (!result.consentSatisfied) {
      statusEl.textContent = "Some required items are still missing — please review and try again.";
      statusEl.classList.add("is-error");
      return;
    }
    showStep("stepReady");
  } catch (error) {
    statusEl.textContent = error.message || "Could not record consent.";
    statusEl.classList.add("is-error");
  }
});

init();
