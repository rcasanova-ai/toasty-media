// Controller for studio/sponsor-invite.html — the no-account guest sponsor kit flow (section 8).
import { studioRequest } from "./studio-api.js";

const token = new URLSearchParams(window.location.search).get("token") || "";
const steps = ["stepLoading", "stepError", "stepKit", "stepReady"];
let sponsor = null;
let eventName = "this event";

function showStep(id) {
  for (const step of steps) document.getElementById(step).classList.toggle("is-active", step === id);
}

async function init() {
  if (!token) {
    document.getElementById("errorMessage").textContent = "No invite token was provided — check the link you were sent.";
    showStep("stepError");
    return;
  }
  try {
    const result = await studioRequest(`/api/sponsor-invites/${encodeURIComponent(token)}`);
    sponsor = result.sponsor;
    eventName = result.event?.title || "this event";
    document.getElementById("kitEventName").textContent = `Complete your sponsor kit for ${eventName}`;
    prefill(sponsor);
    showStep("stepKit");
  } catch (error) {
    document.getElementById("errorMessage").textContent = error.message || "This invitation link is no longer valid.";
    showStep("stepError");
  }
}

function prefill(s) {
  const set = (id, value) => { const el = document.getElementById(id); if (el && value) el.value = value; };
  set("fWebsite", s.website);
  set("fLogo", s.logoReference);
  set("fCampaignUrl", s.campaignUrl);
  set("fPromoCode", s.promoCode);
  set("fQrDestination", s.qrDestination);
  set("fTalkingPoints", s.talkingPoints);
  set("fRequiredDisclosure", s.requiredDisclosure);
  set("fDoNotSay", s.doNotSay);
  const links = s.socialLinks || {};
  set("sLinkedin", links.linkedin);
  set("sX", links.x);
  set("sInstagram", links.instagram);
  set("sYoutube", links.youtube);
  updatePreview();
}

function updatePreview() {
  document.getElementById("previewCompany").textContent = sponsor?.companyName || "Company";
  document.getElementById("previewPromo").textContent = document.getElementById("fPromoCode").value || "No promo code yet";
}

document.getElementById("kitForm").addEventListener("input", updatePreview);

document.getElementById("kitForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const statusEl = document.getElementById("kitStatus");
  statusEl.textContent = "Saving…";
  statusEl.classList.remove("is-error");
  const val = (id) => document.getElementById(id).value.trim();
  const socialLinks = {};
  for (const [id, key] of [["sLinkedin", "linkedin"], ["sX", "x"], ["sInstagram", "instagram"], ["sYoutube", "youtube"]]) {
    const v = val(id);
    if (v) socialLinks[key] = v;
  }
  const fields = {
    website: val("fWebsite"),
    logoReference: val("fLogo"),
    campaignUrl: val("fCampaignUrl"),
    promoCode: val("fPromoCode"),
    qrDestination: val("fQrDestination"),
    talkingPoints: val("fTalkingPoints"),
    requiredDisclosure: val("fRequiredDisclosure"),
    doNotSay: val("fDoNotSay"),
    socialLinks
  };
  try {
    await studioRequest(`/api/sponsor-invites/${encodeURIComponent(token)}/kit`, { method: "POST", body: JSON.stringify({ fields }) });
    showStep("stepReady");
  } catch (error) {
    statusEl.textContent = error.message || "Could not save your sponsor kit.";
    statusEl.classList.add("is-error");
  }
});

init();
