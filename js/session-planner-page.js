// Controller for studio/plan.html — the Session Planner wizard (section 2). Creates one canonical
// durable session early (reusing js/session-manager.js's createSession — the same live_sessions row
// Studio itself opens later) so every step below attaches to that same session, not a draft that gets
// thrown away.
import { studioRequest } from "./studio-api.js";
import { createSession } from "./session-manager.js";
import { computeSpeakerReadiness, ReadinessItem } from "./speaker-readiness.js";
import { requiredConsentKeysFor } from "./consent-policy.js";
import { renderEpisodeStep, renderStoryStep, episodeReviewHtml, isEpisodeMode, enableEpisodeMode, loadShows } from "./episode-planner-steps.js";
import { SESSION_TEMPLATES, SESSION_TYPES, applyTemplate, emptyLit, emptyHostPrep, emptyBriefing, buildGuestBriefing, buildPrepSummary, splitLines } from "./session-plan-model.js";

// Guided path first (type, information, guests, host preparation, invitations, review), then the optional event extras.
const STEPS = ["type", "basics", "episode", "story", "speakers", "hostprep", "invite", "review", "audience", "sponsors", "assets", "readiness"];
const main = document.getElementById("planMain");
const nav = document.getElementById("stepNav");

let session = null;
let plan = defaultPlan();
let speakers = [];
let sponsors = [];
let currentStep = "basics";
let organizationId = null;

function defaultPlan() {
  return {
    sessionType: "podcast",
    template: "",
    deliveryMode: "live",
    description: "",
    objectives: "",
    topics: "",
    hostPrep: emptyHostPrep(),
    guestBriefing: emptyBriefing(),
    scheduledAt: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    expectedDurationMinutes: 60,
    hostName: "",
    producerName: "",
    visibility: "public",
    registrationRequired: false,
    audience: {
      landingPageEnabled: true,
      replayEnabled: true,
      audienceChat: true,
      qAndA: true,
      polls: false,
      ctaDefault: "",
      campaignTracking: true
    },
    runOfShow: [],
    assets: [],
    readinessChecklist: {
      hostReady: false,
      producerReady: false,
      assetsReady: false,
      runOfShowReady: false,
      brandingReady: false,
      recordingConfigured: false
    }
  };
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  const existingId = params.get("session");
  const requestedOrg = params.get("org");
  try {
    if (existingId) {
      const result = await studioRequest(`/api/sessions/${existingId}`);
      session = result.session;
      organizationId = session.organizationId || null;
      plan = { ...defaultPlan(), ...(session.plan || {}), hostPrep: { ...emptyHostPrep(), ...(session.plan?.hostPrep || {}) }, guestBriefing: { ...emptyBriefing(), ...(session.plan?.guestBriefing || {}) }, ...(session.plan?.lit ? { lit: { ...emptyLit(), ...session.plan.lit } } : {}), audience: { ...defaultPlan().audience, ...(session.plan?.audience || {}) }, readinessChecklist: { ...defaultPlan().readinessChecklist, ...(session.plan?.readinessChecklist || {}) } };
    } else {
      // The Session Planner never shows its own organization picker — it always inherits the
      // organization the dashboard's own switcher had selected (studio/dashboard.html appends
      // ?org=<selected> to the Plan Session link). Landing here without that param means the
      // planner wasn't reached through the dashboard, so we refuse to guess which organization
      // to create the session in rather than silently defaulting to the user's owner org.
      if (!requestedOrg) {
        main.innerHTML = `
          <h1>Plan a session</h1>
          <p style="color:#8f857b">Open Session Planner from your Toasty dashboard so we know which organization this session belongs to.</p>
          <a class="xp-btn" href="./dashboard.html">Back to dashboard</a>
        `;
        return;
      }
      organizationId = requestedOrg;
      session = await createSession({ title: "Untitled event", organizationId });
      await savePlan();
      history.replaceState(null, "", `?session=${session.id}&org=${encodeURIComponent(organizationId)}`);
    }
  } catch (error) {
    main.innerHTML = `
      <h1>Plan a session</h1>
      <p style="color:#e58686">${escapeHtml(error?.message || "Couldn't open the Session Planner for that organization.")}</p>
      <a class="xp-btn" href="./dashboard.html">Back to dashboard</a>
    `;
    return;
  }
  await refreshSpeakers();
  await refreshSponsors();
  await loadShows();
  wireNav();
  const requestedStep = new URLSearchParams(window.location.search).get("step");
  goToStep(requestedStep && STEPS.includes(requestedStep) ? requestedStep : plan.wizardStep && STEPS.includes(plan.wizardStep) ? plan.wizardStep : (plan.template ? "review" : "type"));
}

function wireNav() {
  nav.querySelectorAll("[data-step]").forEach((btn) => {
    btn.addEventListener("click", () => goToStep(btn.dataset.step));
  });
}

function episodeContext() {
  return { main, get plan() { return plan; }, get session() { return session; }, organizationId, goToStep, savePlan, saveTitle };
}

function syncEpisodeNav() {
  const on = isEpisodeMode(plan);
  nav.querySelectorAll("[data-episode-step]").forEach((btn) => { btn.hidden = !on; });
}

function goToStep(step) {
  currentStep = step;
  plan.wizardStep = step;
  syncEpisodeNav();
  nav.querySelectorAll("[data-step]").forEach((btn) => btn.classList.toggle("active", btn.dataset.step === step));
  renderStep(step);
}

async function savePlan() {
  const result = await studioRequest(`/api/sessions/${session.id}/plan`, { method: "POST", body: JSON.stringify({ plan }) });
  session = result.session;
}

async function saveTitle(title) {
  await studioRequest(`/api/sessions/${session.id}/title`, { method: "POST", body: JSON.stringify({ title }) });
  session.title = title;
}

async function refreshSpeakers() {
  const result = await studioRequest(`/api/sessions/${session.id}/speakers`);
  speakers = result.speakers || [];
}

async function refreshSponsors() {
  const result = await studioRequest(`/api/sessions/${session.id}/sponsors`);
  sponsors = result.sponsors || [];
}

function renderStep(step) {
  const renderers = { type: renderType, basics: renderBasics, episode: () => renderEpisodeStep(episodeContext()), story: () => renderStoryStep(episodeContext()), speakers: renderSpeakers, hostprep: renderHostPrep, invite: renderInvite, review: renderReview, audience: renderAudience, sponsors: renderSponsors, assets: renderAssets, readiness: renderReadiness };
  (renderers[step] || renderType)();
}

function field(label, inputHtml) {
  return `<div class="plan-field"><label>${label}</label>${inputHtml}</div>`;
}

// ---------- A. Session Basics ----------
function renderBasics() {
  main.innerHTML = `
    <h1>Session information</h1>
    ${field("Title", `<input id="pTitle" value="${escapeAttr(session.title)}">`)}
    ${field("Description", `<textarea id="pDescription">${escapeHtml(plan.description)}</textarea>`)}
    <div class="plan-grid-3">
      ${field("Session type", `<select id="pSessionType">${SESSION_TYPES.map((t) => `<option value="${t}" ${plan.sessionType === t ? "selected" : ""}>${t.replace(/_/g, " ")}</option>`).join("")}</select>`)}
      ${field("Delivery", `<select id="pDeliveryMode">${["live", "prerecorded", "scheduled_premiere"].map((t) => `<option value="${t}" ${plan.deliveryMode === t ? "selected" : ""}>${t.replace(/_/g, " ")}</option>`).join("")}</select>`)}
      ${field("Visibility", `<select id="pVisibility">${["public", "private"].map((t) => `<option value="${t}" ${plan.visibility === t ? "selected" : ""}>${t}</option>`).join("")}</select>`)}
    </div>
    <div class="plan-grid-3">
      ${field("Date & time", `<input id="pScheduledAt" type="datetime-local" value="${plan.scheduledAt || ""}">`)}
      ${field("Timezone", `<input id="pTimezone" value="${escapeAttr(plan.timezone)}">`)}
      ${field("Duration (min)", `<input id="pDuration" type="number" min="5" value="${plan.expectedDurationMinutes || 60}">`)}
    </div>
    <div class="plan-grid-2">
      ${field("Host", `<input id="pHost" value="${escapeAttr(plan.hostName)}">`)}
      ${field("Producer", `<input id="pProducer" value="${escapeAttr(plan.producerName)}">`)}
    </div>
    ${field("Objectives", `<textarea id="pObjectives" placeholder="What should this session achieve?">${escapeHtml(plan.objectives)}</textarea>`)}
    ${field("Topics", `<textarea id="pTopics" placeholder="One topic per line">${escapeHtml(plan.topics)}</textarea>`)}
    ${plan.template === "lit" || plan.sessionType === "book_club" ? litPanelHtml() : ""}
    <div class="plan-check"><input type="checkbox" id="pIsEpisode" ${isEpisodeMode(plan) ? "checked" : ""}> <label for="pIsEpisode">This is an episode of a show (adds show, season and story map steps)</label></div>
    <div class="plan-check"><input type="checkbox" id="pRegistration" ${plan.registrationRequired ? "checked" : ""}> <label for="pRegistration">Registration required</label></div>
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="basicsBack">Back</button><button class="xp-btn" id="basicsNext">Save & continue</button></div>
    <p class="plan-status" id="basicsStatus"></p>
  `;
  document.getElementById("basicsBack").addEventListener("click", () => goToStep("type"));
  document.getElementById("basicsNext").addEventListener("click", async () => {
    plan.description = document.getElementById("pDescription").value;
    plan.objectives = document.getElementById("pObjectives").value;
    plan.topics = document.getElementById("pTopics").value;
    readLitPanel();
    plan.sessionType = document.getElementById("pSessionType").value;
    plan.deliveryMode = document.getElementById("pDeliveryMode").value;
    plan.visibility = document.getElementById("pVisibility").value;
    plan.scheduledAt = document.getElementById("pScheduledAt").value;
    plan.timezone = document.getElementById("pTimezone").value;
    plan.expectedDurationMinutes = Number(document.getElementById("pDuration").value) || 60;
    plan.hostName = document.getElementById("pHost").value;
    plan.producerName = document.getElementById("pProducer").value;
    plan.registrationRequired = document.getElementById("pRegistration").checked;
    const episodeOn = document.getElementById("pIsEpisode").checked;
    if (episodeOn) enableEpisodeMode(plan); else if (isEpisodeMode(plan)) delete plan.episode;
    const title = document.getElementById("pTitle").value.trim() || "Untitled event";
    const statusEl = document.getElementById("basicsStatus");
    statusEl.textContent = "Saving…";
    try {
      await saveTitle(title);
      await savePlan();
      goToStep(episodeOn ? "episode" : "speakers");
    } catch (error) {
      statusEl.textContent = error.message;
      statusEl.classList.add("err");
    }
  });
}

// ---------- B. Audience / Event ----------
function renderAudience() {
  const a = plan.audience;
  main.innerHTML = `
    <h1>Audience / Event</h1>
    <div class="plan-check"><input type="checkbox" id="aLanding" ${a.landingPageEnabled ? "checked" : ""}> <label for="aLanding">Landing page enabled</label></div>
    <div class="plan-check"><input type="checkbox" id="aReplay" ${a.replayEnabled ? "checked" : ""}> <label for="aReplay">Replay enabled</label></div>
    <div class="plan-check"><input type="checkbox" id="aChat" ${a.audienceChat ? "checked" : ""}> <label for="aChat">Audience chat</label></div>
    <div class="plan-check"><input type="checkbox" id="aQa" ${a.qAndA ? "checked" : ""}> <label for="aQa">Q&amp;A</label></div>
    <div class="plan-check"><input type="checkbox" id="aPolls" ${a.polls ? "checked" : ""}> <label for="aPolls">Polls</label></div>
    <div class="plan-check"><input type="checkbox" id="aCampaign" ${a.campaignTracking ? "checked" : ""}> <label for="aCampaign">Campaign tracking</label></div>
    ${field("Default CTA", `<input id="aCta" value="${escapeAttr(a.ctaDefault)}" placeholder="e.g. Book a demo">`)}
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="audienceBack">Back</button><button class="xp-btn" id="audienceNext">Save & continue</button></div>
    <p class="plan-status" id="audienceStatus"></p>
  `;
  document.getElementById("audienceBack").addEventListener("click", () => goToStep("review"));
  document.getElementById("audienceNext").addEventListener("click", async () => {
    plan.audience = {
      landingPageEnabled: document.getElementById("aLanding").checked,
      replayEnabled: document.getElementById("aReplay").checked,
      audienceChat: document.getElementById("aChat").checked,
      qAndA: document.getElementById("aQa").checked,
      polls: document.getElementById("aPolls").checked,
      campaignTracking: document.getElementById("aCampaign").checked,
      ctaDefault: document.getElementById("aCta").value
    };
    const statusEl = document.getElementById("audienceStatus");
    try { await savePlan(); goToStep("review"); } catch (error) { statusEl.textContent = error.message; statusEl.classList.add("err"); }
  });
}

// ---------- C. Speakers ----------
function renderSpeakers() {
  main.innerHTML = `
    <h1>Guests</h1>
    <p style="color:#8f857b">Add the people joining you. You will invite them to prepare in a later step.</p>
    <div id="speakerList"></div>
    <p class="plan-status" id="speakerStatus"></p>
    <div class="plan-grid-3">
      ${field("Name", `<input id="newSpeakerName">`)}
      ${field("Email", `<input id="newSpeakerEmail" type="email">`)}
      ${field("Role", `<input id="newSpeakerRole" placeholder="e.g. Guest, Panelist">`)}
    </div>
    ${field("Relevant background", `<textarea id="newSpeakerBackground" placeholder="Why this guest, and what you already know about them. Only you and your producer see this."></textarea>`)}
    <button class="xp-btn xp-btn-small" id="addSpeakerBtn">Add guest</button>
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="speakersBack">Back</button><button class="xp-btn" id="speakersNext">Continue</button></div>
  `;
  renderSpeakerList();
  document.getElementById("speakersBack").addEventListener("click", () => goToStep(isEpisodeMode(plan) ? "story" : "basics"));
  document.getElementById("speakersNext").addEventListener("click", () => goToStep("hostprep"));
  document.getElementById("addSpeakerBtn").addEventListener("click", async () => {
    const email = document.getElementById("newSpeakerEmail").value.trim();
    const statusEl = document.getElementById("speakerStatus");
    if (!email) { statusEl.textContent = "Email is required to invite a speaker."; statusEl.classList.add("err"); return; }
    try {
      await studioRequest(`/api/sessions/${session.id}/speakers`, {
        method: "POST",
        body: JSON.stringify({ email, displayName: document.getElementById("newSpeakerName").value.trim(), sessionRole: document.getElementById("newSpeakerRole").value.trim() })
      }).then(async (created) => {
        const background = document.getElementById("newSpeakerBackground").value.trim();
        if (background && created?.speaker?.id) await studioRequest(`/api/speakers/${created.speaker.id}/update`, { method: "POST", body: JSON.stringify({ fields: { hostBackground: background } }) });
      });
      document.getElementById("newSpeakerName").value = "";
      document.getElementById("newSpeakerEmail").value = "";
      document.getElementById("newSpeakerRole").value = "";
      document.getElementById("newSpeakerBackground").value = "";
      statusEl.textContent = "";
      statusEl.classList.remove("err");
      await refreshSpeakers();
      renderSpeakerList();
    } catch (error) {
      statusEl.textContent = error.message;
      statusEl.classList.add("err");
    }
  });
}

function renderSpeakerList() {
  const listEl = document.getElementById("speakerList");
  if (!speakers.length) { listEl.innerHTML = `<p style="color:#8f857b">No speakers added yet.</p>`; return; }
  listEl.innerHTML = speakers.map((s) => `
    <div class="plan-list-item">
      <div><strong>${escapeHtml(s.displayName || s.email)}</strong><small>${escapeHtml(s.sessionRole || "Guest")} · ${escapeHtml(s.email)}</small>${s.hostBackground ? `<small>${escapeHtml(s.hostBackground)}</small>` : ""}</div>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="plan-pill ${s.inviteStatus === "accepted" ? "good" : s.inviteStatus === "sent" ? "warn" : ""}">${s.inviteStatus.replace(/_/g, " ")}</span>
        <button class="xp-btn xp-btn-ghost plan-btn-small" data-invite="${s.id}">${s.inviteStatus === "not_sent" ? "Send Speaker Profile Request" : "Resend invite"}</button>
      </div>
    </div>`).join("");
  listEl.querySelectorAll("[data-invite]").forEach((btn) => btn.addEventListener("click", () => sendSpeakerInvite(btn.dataset.invite, btn)));
}

async function sendSpeakerInvite(speakerId, btn) {
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const result = await studioRequest(`/api/speakers/${speakerId}/invite`, { method: "POST", body: "{}" });
    const url = `${window.location.origin}${result.inviteUrl}`;
    await navigator.clipboard?.writeText?.(url).catch(() => {});
    btn.textContent = "Invite link copied";
    await refreshSpeakers();
  } catch (error) {
    btn.textContent = "Failed — retry";
    btn.disabled = false;
  }
}

// ---------- D. Sponsors ----------
function renderSponsors() {
  main.innerHTML = `
    <h1>Sponsors</h1>
    <div id="sponsorList"></div>
    <p class="plan-status" id="sponsorStatus"></p>
    <div class="plan-grid-3">
      ${field("Company", `<input id="newSponsorCompany">`)}
      ${field("Contact name", `<input id="newSponsorContact">`)}
      ${field("Contact email", `<input id="newSponsorEmail" type="email">`)}
    </div>
    <button class="xp-btn xp-btn-small" id="addSponsorBtn">Add sponsor</button>
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="sponsorsBack">Back</button><button class="xp-btn" id="sponsorsNext">Continue</button></div>
  `;
  renderSponsorList();
  document.getElementById("sponsorsBack").addEventListener("click", () => goToStep("review"));
  document.getElementById("sponsorsNext").addEventListener("click", () => goToStep("review"));
  document.getElementById("addSponsorBtn").addEventListener("click", async () => {
    const companyName = document.getElementById("newSponsorCompany").value.trim();
    const statusEl = document.getElementById("sponsorStatus");
    if (!companyName) { statusEl.textContent = "Company name is required."; statusEl.classList.add("err"); return; }
    try {
      await studioRequest(`/api/sessions/${session.id}/sponsors`, {
        method: "POST",
        body: JSON.stringify({ companyName, contactName: document.getElementById("newSponsorContact").value.trim(), contactEmail: document.getElementById("newSponsorEmail").value.trim() })
      });
      document.getElementById("newSponsorCompany").value = "";
      document.getElementById("newSponsorContact").value = "";
      document.getElementById("newSponsorEmail").value = "";
      statusEl.textContent = "";
      statusEl.classList.remove("err");
      await refreshSponsors();
      renderSponsorList();
    } catch (error) {
      statusEl.textContent = error.message;
      statusEl.classList.add("err");
    }
  });
}

function renderSponsorList() {
  const listEl = document.getElementById("sponsorList");
  if (!sponsors.length) { listEl.innerHTML = `<p style="color:#8f857b">No sponsors added yet.</p>`; return; }
  listEl.innerHTML = sponsors.map((s) => `
    <div class="plan-list-item">
      <div><strong>${escapeHtml(s.companyName)}</strong><small>${escapeHtml(s.contactName || "")} ${s.contactEmail ? "· " + escapeHtml(s.contactEmail) : ""}</small></div>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="plan-pill ${s.approvalStatus === "approved" ? "good" : "warn"}">${s.approvalStatus}</span>
        <button class="xp-btn xp-btn-ghost plan-btn-small" data-sponsor-invite="${s.id}">${s.inviteStatus === "not_invited" ? "Invite sponsor kit" : "Resend"}</button>
        ${s.approvalStatus !== "approved" ? `<button class="xp-btn plan-btn-small" data-sponsor-approve="${s.id}">Approve</button>` : ""}
      </div>
    </div>`).join("");
  listEl.querySelectorAll("[data-sponsor-invite]").forEach((btn) => btn.addEventListener("click", () => sendSponsorInvite(btn.dataset.sponsorInvite, btn)));
  listEl.querySelectorAll("[data-sponsor-approve]").forEach((btn) => btn.addEventListener("click", () => approveSponsor(btn.dataset.sponsorApprove)));
}

async function sendSponsorInvite(sponsorId, btn) {
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    const result = await studioRequest(`/api/sponsors/${sponsorId}/invite`, { method: "POST", body: "{}" });
    const url = `${window.location.origin}${result.inviteUrl}`;
    await navigator.clipboard?.writeText?.(url).catch(() => {});
    btn.textContent = "Invite link copied";
    await refreshSponsors();
  } catch (error) {
    btn.textContent = "Failed — retry";
    btn.disabled = false;
  }
}

async function approveSponsor(sponsorId) {
  await studioRequest(`/api/sponsors/${sponsorId}/approve`, { method: "POST", body: JSON.stringify({ approvalStatus: "approved" }) });
  await refreshSponsors();
  renderSponsorList();
}

// ---------- Host preparation (run of show lives here) ----------
function renderRosList() {
  const listEl = document.getElementById("rosList");
  if (!plan.runOfShow.length) { listEl.innerHTML = `<p style="color:#8f857b">No segments yet.</p>`; return; }
  listEl.innerHTML = plan.runOfShow.map((item) => `
    <div class="plan-list-item">
      <div><strong>+${item.startOffset}m — ${escapeHtml(item.label)}</strong><small>${escapeHtml(item.notes || "")}</small></div>
      <button class="xp-btn xp-btn-ghost plan-btn-small" data-remove-ros="${item.id}">Remove</button>
    </div>`).join("");
  listEl.querySelectorAll("[data-remove-ros]").forEach((btn) => btn.addEventListener("click", () => {
    plan.runOfShow = plan.runOfShow.filter((i) => i.id !== btn.dataset.removeRos);
    renderRosList();
  }));
}

// ---------- F. Assets ----------
function renderAssets() {
  main.innerHTML = `
    <h1>Assets</h1>
    <div id="assetList"></div>
    <div class="plan-grid-3">
      ${field("Name", `<input id="newAssetName">`)}
      ${field("URL", `<input id="newAssetUrl" type="url">`)}
      ${field("Kind", `<select id="newAssetKind">${["logo", "speaker_photo", "video", "b_roll", "slides", "intro_outro", "audio", "graphic", "qr_destination"].map((k) => `<option value="${k}">${k.replace(/_/g, " ")}</option>`).join("")}</select>`)}
    </div>
    <button class="xp-btn xp-btn-small" id="addAssetBtn">Add asset</button>
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="assetsBack">Back</button><button class="xp-btn" id="assetsNext">Save & continue</button></div>
    <p class="plan-status" id="assetsStatus"></p>
  `;
  renderAssetList();
  document.getElementById("assetsBack").addEventListener("click", () => goToStep("review"));
  document.getElementById("addAssetBtn").addEventListener("click", () => {
    const name = document.getElementById("newAssetName").value.trim();
    const url = document.getElementById("newAssetUrl").value.trim();
    if (!name || !url) return;
    plan.assets.push({ id: `asset_${Date.now().toString(36)}`, name, url, kind: document.getElementById("newAssetKind").value });
    document.getElementById("newAssetName").value = "";
    document.getElementById("newAssetUrl").value = "";
    renderAssetList();
  });
  document.getElementById("assetsNext").addEventListener("click", async () => {
    const statusEl = document.getElementById("assetsStatus");
    try { await savePlan(); goToStep("review"); } catch (error) { statusEl.textContent = error.message; statusEl.classList.add("err"); }
  });
}

function renderAssetList() {
  const listEl = document.getElementById("assetList");
  if (!plan.assets.length) { listEl.innerHTML = `<p style="color:#8f857b">No assets yet.</p>`; return; }
  listEl.innerHTML = plan.assets.map((a) => `
    <div class="plan-list-item">
      <div><strong>${escapeHtml(a.name)}</strong><small>${escapeHtml(a.kind.replace(/_/g, " "))} · <a href="${escapeAttr(a.url)}" target="_blank" rel="noopener" style="color:#f5a67b">link</a></small></div>
      <button class="xp-btn xp-btn-ghost plan-btn-small" data-remove-asset="${a.id}">Remove</button>
    </div>`).join("");
  listEl.querySelectorAll("[data-remove-asset]").forEach((btn) => btn.addEventListener("click", () => {
    plan.assets = plan.assets.filter((a) => a.id !== btn.dataset.removeAsset);
    renderAssetList();
  }));
}

// ---------- G. Readiness Review ----------
async function renderReadiness() {
  main.innerHTML = `<h1>Readiness Review</h1><p>Checking readiness…</p>`;
  const [consentResult, landingResult] = await Promise.all([
    studioRequest(`/api/sessions/${session.id}/consent`).catch(() => ({ consentRecords: [] })),
    studioRequest(`/api/sessions/${session.id}/landing-page`).catch(() => ({ landingPage: null }))
  ]);
  const consentRecords = consentResult.consentRecords || [];
  const techChecks = await Promise.all(speakers.map((s) => studioRequest(`/api/speakers/${s.id}/tech-check`).then((r) => r.techCheck).catch(() => null)));

  const speakerReadiness = speakers.map((s, i) => ({
    speaker: s,
    readiness: computeSpeakerReadiness({
      speaker: s,
      techCheck: techChecks[i],
      consentRecords,
      requirementConfig: { sessionType: plan.sessionType },
      calendarConfirmed: s.inviteStatus === "accepted",
      sessionLinkSent: s.inviteStatus !== "not_sent"
    })
  }));
  const allSpeakersReady = speakers.length > 0 && speakerReadiness.every((r) => r.readiness.ready);
  const allSponsorsApproved = sponsors.length === 0 || sponsors.every((s) => s.approvalStatus === "approved");
  // Guarded the same way allSpeakersReady is (Array.prototype.every is vacuously true on an empty array) —
  // with zero speakers, "Consent complete" showing Ready would be misleading, not honest.
  const allConsentComplete = speakers.length > 0 && speakerReadiness.every((r) => r.readiness.items[ReadinessItem.CONSENT]);
  const landingPublished = Boolean(landingResult.landingPage?.publishedAt);
  const endCardReady = Boolean(session.endCard?.headline);
  const checklist = plan.readinessChecklist;

  const rows = [
    ["Host ready", checklist.hostReady, "hostReady"],
    ["Producer ready", checklist.producerReady, "producerReady"],
    ["Speakers ready", allSpeakersReady, null],
    ["Sponsors ready", allSponsorsApproved, null],
    ["Consent complete", allConsentComplete, null],
    ["Assets ready", checklist.assetsReady, "assetsReady"],
    ["Run of Show ready", checklist.runOfShowReady, "runOfShowReady"],
    ["Landing page published", landingPublished, null],
    ["Program branding ready", checklist.brandingReady, "brandingReady"],
    ["Recording configured", checklist.recordingConfigured, "recordingConfigured"],
    ["End Card ready", endCardReady, null]
  ];

  main.innerHTML = `
    <h1>Readiness Review</h1>
    ${rows.map(([label, ok, key]) => `
      <div class="plan-readiness-row">
        <span>${label}</span>
        ${key
          ? `<label style="display:flex;align-items:center;gap:8px"><input type="checkbox" data-checklist="${key}" ${ok ? "checked" : ""}> <span class="plan-pill ${ok ? "good" : "warn"}">${ok ? "Ready" : "Pending"}</span></label>`
          : `<span class="plan-pill ${ok ? "good" : "warn"}">${ok ? "Ready" : "Pending"}</span>`}
      </div>`).join("")}
    <p style="color:#8f857b;margin-top:16px;font-size:13px">Speakers/Sponsors/Consent/Landing page/End Card are computed from real data. Host/Producer/Assets/Run of Show/Branding/Recording are organizer self-attestation checkboxes. None of these — including the growth items below — block opening Studio; they're here so you don't forget them, not gates.</p>

    <div class="plan-section-title" style="margin:26px 0 10px;font-weight:800;color:#e8ded4;font-size:15px">Grow this event</div>
    <div class="plan-grid-2">
      <a class="xp-btn xp-btn-ghost" style="text-align:center" href="./event-page.html?session=${session.id}${organizationId ? `&org=${encodeURIComponent(organizationId)}` : ""}">Event Page ${landingPublished ? "(published)" : "(draft)"}</a>
      <a class="xp-btn xp-btn-ghost" style="text-align:center" href="./session-growth.html?session=${session.id}${organizationId ? `&org=${encodeURIComponent(organizationId)}` : ""}">Audience, Campaign Links &amp; Sponsor Analytics</a>
    </div>

    <div class="plan-actions">
      <button class="xp-btn xp-btn-ghost plan-btn-small" id="readinessBack">Back</button>
      <a class="xp-btn" id="openStudioBtn" href="./director.html?session=${session.id}">Open Studio</a>
    </div>
  `;
  document.getElementById("readinessBack").addEventListener("click", () => goToStep("review"));
  main.querySelectorAll("[data-checklist]").forEach((box) => box.addEventListener("change", async () => {
    plan.readinessChecklist[box.dataset.checklist] = box.checked;
    await savePlan();
    renderReadiness();
  }));
}


// ---------- 1. Session type ----------
function renderType() {
  main.innerHTML = `
    <h1>What are you planning?</h1>
    <p style="color:#8f857b">Pick the closest match. It sets up a starting run of show you can change.</p>
    <div class="plan-type-grid">
      ${SESSION_TEMPLATES.map((t) => `<button type="button" class="plan-type-card ${plan.template === t.id ? "active" : ""}" data-template="${t.id}"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(t.blurb)}</small></button>`).join("")}
    </div>
    <p class="plan-status" id="typeStatus"></p>
  `;
  main.querySelectorAll("[data-template]").forEach((btn) => btn.addEventListener("click", async () => {
    plan = applyTemplate(plan, btn.dataset.template);
    if (btn.dataset.template === "story") enableEpisodeMode(plan);
    const statusEl = document.getElementById("typeStatus");
    try { await savePlan(); goToStep("basics"); } catch (error) { statusEl.textContent = error.message; statusEl.classList.add("err"); }
  }));
}

// ---------- Toasty Lit (book club) template fields ----------
const LIT_FIELDS = [
  ["bookTitle", "Book title", "input"], ["author", "Author", "input"], ["genre", "Genre", "input"],
  ["synopsis", "Synopsis (your own words)", "textarea"], ["mainCharacters", "Main characters (one per line)", "textarea"], ["majorThemes", "Major themes (one per line)", "textarea"],
  ["discussionTopics", "Discussion topics (one per line)", "textarea"], ["suggestedQuestions", "Suggested questions (one per line, host only)", "textarea"], ["hostNotes", "Host notes (private)", "textarea"]
];
function litPanelHtml() {
  const lit = { ...emptyLit(), ...(plan.lit || {}) };
  return `<div class="plan-section-title" style="margin:22px 0 10px;font-weight:800;color:#e8ded4;font-size:15px">Book details</div>
    <p style="color:#8f857b">Write the briefing in your own words. Guests do not need to have read the whole book, so keep it to the premise, characters, themes and topics.</p>
    ${LIT_FIELDS.map(([key, label, kind]) => field(label, kind === "input" ? `<input id="lit_${key}" value="${escapeAttr(lit[key])}">` : `<textarea id="lit_${key}">${escapeHtml(lit[key])}</textarea>`)).join("")}`;
}
function readLitPanel() {
  if (!document.getElementById("lit_bookTitle")) return;
  plan.lit = Object.fromEntries(LIT_FIELDS.map(([key]) => [key, document.getElementById(`lit_${key}`).value]));
}

// ---------- 4. Host preparation ----------
function renderHostPrep() {
  const hp = plan.hostPrep || emptyHostPrep();
  main.innerHTML = `
    <h1>Prepare your part</h1>
    <p style="color:#8f857b">What you want to cover, in the order you want to cover it. This stays with you and your producer and is available in the studio while you record.</p>
    ${field("Discussion topics", `<textarea id="hpTopics" placeholder="One topic per line">${escapeHtml(plan.topics)}</textarea>`)}
    ${field("Opening questions", `<textarea id="hpOpening" placeholder="One question per line">${escapeHtml(hp.openingQuestions)}</textarea>`)}
    ${field("Talking points", `<textarea id="hpPoints" placeholder="One point per line">${escapeHtml(hp.talkingPoints)}</textarea>`)}
    ${field("Special instructions", `<textarea id="hpInstructions" placeholder="Anything your producer or Moxie should know">${escapeHtml(hp.specialInstructions)}</textarea>`)}
    <div class="plan-section-title" style="margin:22px 0 10px;font-weight:800;color:#e8ded4;font-size:15px">Segments and run of show</div>
    <div id="rosList"></div>
    <div class="plan-grid-3">
      ${field("Segment", `<input id="newRosLabel" placeholder="e.g. The book in brief">`)}
      ${field("Start (min)", `<input id="newRosOffset" type="number" min="0">`)}
      ${field("Notes", `<input id="newRosNotes">`)}
    </div>
    <button class="xp-btn xp-btn-small" id="addRosBtn">Add segment</button>
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="hpBack">Back</button><button class="xp-btn" id="hpNext">Save & continue</button></div>
    <p class="plan-status" id="hpStatus"></p>
  `;
  renderRosList();
  document.getElementById("hpBack").addEventListener("click", () => goToStep("speakers"));
  document.getElementById("addRosBtn").addEventListener("click", () => {
    const label = document.getElementById("newRosLabel").value.trim();
    if (!label) return;
    plan.runOfShow.push({ id: `ros_${Date.now().toString(36)}`, label, startOffset: Number(document.getElementById("newRosOffset").value) || 0, notes: document.getElementById("newRosNotes").value.trim() });
    plan.runOfShow.sort((a, b) => a.startOffset - b.startOffset);
    document.getElementById("newRosLabel").value = "";
    document.getElementById("newRosOffset").value = "";
    document.getElementById("newRosNotes").value = "";
    renderRosList();
  });
  document.getElementById("hpNext").addEventListener("click", async () => {
    plan.topics = document.getElementById("hpTopics").value;
    plan.hostPrep = { openingQuestions: document.getElementById("hpOpening").value, talkingPoints: document.getElementById("hpPoints").value, specialInstructions: document.getElementById("hpInstructions").value };
    const statusEl = document.getElementById("hpStatus");
    try { await savePlan(); goToStep("invite"); } catch (error) { statusEl.textContent = error.message; statusEl.classList.add("err"); }
  });
}

// ---------- 5. Invite guests ----------
function renderInvite() {
  const briefing = plan.guestBriefing && (plan.guestBriefing.intro || plan.guestBriefing.sections?.length) ? plan.guestBriefing : { ...emptyBriefing(), ...buildGuestBriefing(plan, { title: session.title, hostName: plan.hostName }) };
  plan.guestBriefing = briefing;
  main.innerHTML = `
    <h1>Invite your guests</h1>
    <p style="color:#8f857b">Review the briefing guests will receive. Each guest gets a private link by email, with no Toasty account needed, and fills in their own preparation form.</p>
    ${field("Introduction", `<textarea id="gbIntro">${escapeHtml(briefing.intro)}</textarea>`)}
    <div id="gbSections">${(briefing.sections || []).map((sec, i) => `<div class="plan-brief-section" data-i="${i}">${field("Section title", `<input data-gb="title" value="${escapeAttr(sec.title)}">`)}${field("Text", `<textarea data-gb="body">${escapeHtml(sec.body)}</textarea>`)}<button type="button" class="xp-btn xp-btn-ghost plan-btn-small" data-gb-remove="${i}">Remove section</button></div>`).join("")}</div>
    <div class="plan-actions" style="justify-content:flex-start;gap:10px"><button type="button" class="xp-btn xp-btn-ghost plan-btn-small" id="gbAdd">Add section</button><button type="button" class="xp-btn xp-btn-ghost plan-btn-small" id="gbRegen">Rebuild from my plan</button></div>
    <div class="plan-check"><input type="checkbox" id="gbApproved" ${briefing.approved ? "checked" : ""}> <label for="gbApproved">I have reviewed this briefing and it can be sent to guests</label></div>
    <div class="plan-section-title" style="margin:22px 0 10px;font-weight:800;color:#e8ded4;font-size:15px">Guests</div>
    <div id="inviteList"></div>
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="inviteBack">Back</button><span style="display:flex;gap:10px"><button class="xp-btn xp-btn-ghost plan-btn-small" id="inviteSave">Save briefing</button><button class="xp-btn" id="inviteSendAll">Send invitations</button></span></div>
    <p class="plan-status" id="inviteStatus"></p>
  `;
  const collect = () => {
    plan.guestBriefing = {
      intro: document.getElementById("gbIntro").value,
      sections: [...document.querySelectorAll("#gbSections .plan-brief-section")].map((el) => ({ title: el.querySelector('[data-gb="title"]').value, body: el.querySelector('[data-gb="body"]').value })).filter((x) => x.title || x.body),
      approved: document.getElementById("gbApproved").checked,
      approvedAt: document.getElementById("gbApproved").checked ? new Date().toISOString() : null
    };
  };
  const statusEl = document.getElementById("inviteStatus");
  const save = async () => { collect(); await savePlan(); };
  renderInviteList();
  document.getElementById("inviteBack").addEventListener("click", () => goToStep("hostprep"));
  document.getElementById("gbAdd").addEventListener("click", () => { collect(); plan.guestBriefing.sections.push({ title: "", body: "" }); renderInvite(); });
  document.getElementById("gbRegen").addEventListener("click", () => { plan.guestBriefing = { ...emptyBriefing(), ...buildGuestBriefing(plan, { title: session.title, hostName: plan.hostName }) }; renderInvite(); });
  main.querySelectorAll("[data-gb-remove]").forEach((btn) => btn.addEventListener("click", () => { collect(); plan.guestBriefing.sections.splice(Number(btn.dataset.gbRemove), 1); renderInvite(); }));
  document.getElementById("inviteSave").addEventListener("click", async () => { try { await save(); statusEl.textContent = "Briefing saved."; statusEl.classList.remove("err"); } catch (error) { statusEl.textContent = error.message; statusEl.classList.add("err"); } });
  document.getElementById("inviteSendAll").addEventListener("click", async () => {
    collect();
    if (!speakers.length) { statusEl.textContent = "Add at least one guest first."; statusEl.classList.add("err"); return; }
    if (!plan.guestBriefing.approved) { statusEl.textContent = "Review the briefing and tick the box to approve it before sending."; statusEl.classList.add("err"); return; }
    statusEl.classList.remove("err");
    statusEl.textContent = "Sending…";
    try {
      await savePlan();
      let emailed = 0;
      for (const sp of speakers) {
        const result = await studioRequest(`/api/speakers/${sp.id}/invite`, { method: "POST", body: "{}" });
        if (result.emailed) emailed += 1;
      }
      await refreshSpeakers();
      renderInviteList();
      statusEl.textContent = `Invitations created for ${speakers.length} guest${speakers.length === 1 ? "" : "s"}; ${emailed} emailed. You can copy any guest's private link below.`;
    } catch (error) { statusEl.textContent = error.message; statusEl.classList.add("err"); }
  });
}

function renderInviteList() {
  const listEl = document.getElementById("inviteList");
  if (!speakers.length) { listEl.innerHTML = `<p style="color:#8f857b">No guests yet. <a href="#" id="toGuests" style="color:#f5a67b">Add guests</a>.</p>`; document.getElementById("toGuests")?.addEventListener("click", (e) => { e.preventDefault(); goToStep("speakers"); }); return; }
  listEl.innerHTML = speakers.map((s) => `
    <div class="plan-list-item">
      <div><strong>${escapeHtml(s.displayName || s.email)}</strong><small>${escapeHtml(s.email)}</small></div>
      <div style="display:flex;align-items:center;gap:10px">
        <span class="plan-pill ${s.profileSubmittedAt ? "good" : s.inviteStatus === "sent" ? "warn" : ""}">${s.profileSubmittedAt ? "Preparation received" : s.inviteStatus.replace(/_/g, " ")}</span>
        <button class="xp-btn xp-btn-ghost plan-btn-small" data-copy="${s.id}">Copy private link</button>
      </div>
    </div>`).join("");
  listEl.querySelectorAll("[data-copy]").forEach((btn) => btn.addEventListener("click", () => sendSpeakerInvite(btn.dataset.copy, btn)));
}

// ---------- 6. Review the combined plan ----------
function renderReview() {
  const summary = buildPrepSummary(plan, speakers);
  const list = (items) => items.length ? `<ul>${items.map((i) => `<li>${escapeHtml(i)}</li>`).join("")}</ul>` : `<p style="color:#8f857b">None yet.</p>`;
  const edit = (step, label = "Edit") => `<button type="button" class="xp-btn xp-btn-ghost plan-btn-small" data-edit-step="${step}">${label}</button>`;
  main.innerHTML = `
    <h1>Review your plan</h1>
    <p style="color:#8f857b">This is the plan you and your producer will see in the studio, together with what your guests tell you. Edit anything before you go.</p>
    <div class="plan-review">
      <section><div class="plan-review-head"><h2>${escapeHtml(session.title || "Untitled session")}</h2>${edit("basics")}</div>
        <p>${escapeHtml(summary.sessionType.replace(/_/g, " "))}${summary.scheduledAt ? ` · ${escapeHtml(summary.scheduledAt.replace("T", " "))}` : ""}${summary.durationMinutes ? ` · ${summary.durationMinutes} min` : ""}</p>
        ${summary.description ? `<p>${escapeHtml(summary.description)}</p>` : ""}${summary.objectives ? `<p><strong>Objectives:</strong> ${escapeHtml(summary.objectives)}</p>` : ""}</section>
      ${episodeReviewHtml(plan)}
      ${summary.book ? `<section><div class="plan-review-head"><h3>Book</h3>${edit("basics")}</div><p><strong>${escapeHtml(summary.book.title || "Untitled")}</strong>${summary.book.author ? ` by ${escapeHtml(summary.book.author)}` : ""}</p>${summary.book.synopsis ? `<p>${escapeHtml(summary.book.synopsis)}</p>` : ""}</section>` : ""}
      <section><div class="plan-review-head"><h3>Your preparation</h3>${edit("hostprep")}</div>
        <h4>Topics</h4>${list(summary.topics)}<h4>Opening questions</h4>${list(summary.openingQuestions)}<h4>Talking points</h4>${list(summary.talkingPoints)}
        ${summary.specialInstructions ? `<h4>Special instructions</h4><p>${escapeHtml(summary.specialInstructions)}</p>` : ""}
        <h4>Run of show</h4>${summary.segments.length ? `<ol>${summary.segments.map((x) => `<li>+${x.startOffset}m ${escapeHtml(x.label)}${x.notes ? ` (${escapeHtml(x.notes)})` : ""}</li>`).join("")}</ol>` : `<p style="color:#8f857b">No segments yet.</p>`}</section>
      <section><div class="plan-review-head"><h3>Guests</h3>${edit("speakers", "Add guests")}${edit("invite", "Invitations")}</div>
        ${summary.guests.length ? summary.guests.map((g) => `<div class="plan-guest" data-guest="${escapeAttr(g.id)}">
          <strong>${escapeHtml(g.name)}</strong> <span class="plan-pill ${g.submitted ? "good" : ""}">${g.submitted ? "Preparation received" : "Waiting for guest"}</span>
          ${g.role ? `<small>${escapeHtml(g.role)}</small>` : ""}${g.background ? `<p><em>Your note:</em> ${escapeHtml(g.background)}</p>` : ""}
          ${field("Introduce as", `<textarea data-prep="preferredIntro">${escapeHtml(g.preferredIntro)}</textarea>`)}
          ${field("Expertise", `<textarea data-prep="expertise">${escapeHtml(g.expertise)}</textarea>`)}
          ${field("Wants to discuss", `<textarea data-prep="topicsToDiscuss">${escapeHtml(g.topicsToDiscuss.join("\n"))}</textarea>`)}
          ${field("Prefers to avoid", `<textarea data-prep="topicsToAvoid">${escapeHtml(g.topicsToAvoid.join("\n"))}</textarea>`)}
          ${field("Links", `<textarea data-prep="supportingLinks">${escapeHtml(g.links.join("\n"))}</textarea>`)}
          ${field("Notes", `<textarea data-prep="additionalNotes">${escapeHtml(g.notes)}</textarea>`)}
          <button type="button" class="xp-btn xp-btn-ghost plan-btn-small" data-save-guest="${escapeAttr(g.id)}">Save changes to this guest</button> <span class="plan-status" data-guest-status></span>
        </div>`).join("") : `<p style="color:#8f857b">No guests yet.</p>`}</section>
    </div>
    <div class="plan-section-title" style="margin:26px 0 10px;font-weight:800;color:#e8ded4;font-size:15px">More options</div>
    <div class="plan-grid-2">
      <button type="button" class="xp-btn xp-btn-ghost" data-edit-step="audience">Audience and event page</button>
      <button type="button" class="xp-btn xp-btn-ghost" data-edit-step="sponsors">Sponsors</button>
      <button type="button" class="xp-btn xp-btn-ghost" data-edit-step="assets">Assets</button>
      <button type="button" class="xp-btn xp-btn-ghost" data-edit-step="readiness">Readiness check</button>
    </div>
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="reviewBack">Back</button><a class="xp-btn" href="./director.html?session=${session.id}">Open Studio</a></div>
  `;
  main.querySelectorAll("[data-edit-step]").forEach((btn) => btn.addEventListener("click", () => goToStep(btn.dataset.editStep)));
  document.getElementById("reviewBack").addEventListener("click", () => goToStep("invite"));
  main.querySelectorAll("[data-save-guest]").forEach((btn) => btn.addEventListener("click", async () => {
    const box = btn.closest("[data-guest]");
    const prep = {};
    box.querySelectorAll("[data-prep]").forEach((el) => { prep[el.dataset.prep] = el.value; });
    const statusEl = box.querySelector("[data-guest-status]");
    try {
      await studioRequest(`/api/speakers/${btn.dataset.saveGuest}/update`, { method: "POST", body: JSON.stringify({ fields: { prep } }) });
      await refreshSpeakers();
      statusEl.textContent = "Saved.";
    } catch (error) { statusEl.textContent = error.message; statusEl.classList.add("err"); }
  }));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(value) {
  return escapeHtml(value);
}

init();
