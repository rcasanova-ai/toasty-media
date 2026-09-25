// Controller for studio/plan.html — the Session Planner wizard (section 2). Creates one canonical
// durable session early (reusing js/session-manager.js's createSession — the same live_sessions row
// Studio itself opens later) so every step below attaches to that same session, not a draft that gets
// thrown away.
import { studioRequest } from "./studio-api.js";
import { createSession } from "./session-manager.js";
import { computeSpeakerReadiness, ReadinessItem } from "./speaker-readiness.js";
import { requiredConsentKeysFor } from "./consent-policy.js";

const STEPS = ["basics", "audience", "speakers", "sponsors", "runofshow", "assets", "readiness"];
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
    deliveryMode: "live",
    description: "",
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
      plan = { ...defaultPlan(), ...(session.plan || {}), audience: { ...defaultPlan().audience, ...(session.plan?.audience || {}) }, readinessChecklist: { ...defaultPlan().readinessChecklist, ...(session.plan?.readinessChecklist || {}) } };
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
  wireNav();
  goToStep(plan.wizardStep && STEPS.includes(plan.wizardStep) ? plan.wizardStep : "basics");
}

function wireNav() {
  nav.querySelectorAll("[data-step]").forEach((btn) => {
    btn.addEventListener("click", () => goToStep(btn.dataset.step));
  });
}

function goToStep(step) {
  currentStep = step;
  plan.wizardStep = step;
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
  const renderers = { basics: renderBasics, audience: renderAudience, speakers: renderSpeakers, sponsors: renderSponsors, runofshow: renderRunOfShow, assets: renderAssets, readiness: renderReadiness };
  (renderers[step] || renderBasics)();
}

function field(label, inputHtml) {
  return `<div class="plan-field"><label>${label}</label>${inputHtml}</div>`;
}

// ---------- A. Session Basics ----------
function renderBasics() {
  main.innerHTML = `
    <h1>Session Basics</h1>
    ${field("Title", `<input id="pTitle" value="${escapeAttr(session.title)}">`)}
    ${field("Description", `<textarea id="pDescription">${escapeHtml(plan.description)}</textarea>`)}
    <div class="plan-grid-3">
      ${field("Session type", `<select id="pSessionType">${["podcast", "panel", "webinar", "demo", "workshop", "ama", "product_launch", "community_call", "investor_update", "focus_group"].map((t) => `<option value="${t}" ${plan.sessionType === t ? "selected" : ""}>${t.replace(/_/g, " ")}</option>`).join("")}</select>`)}
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
    <div class="plan-check"><input type="checkbox" id="pRegistration" ${plan.registrationRequired ? "checked" : ""}> <label for="pRegistration">Registration required</label></div>
    <div class="plan-actions"><span></span><button class="xp-btn" id="basicsNext">Save & continue</button></div>
    <p class="plan-status" id="basicsStatus"></p>
  `;
  document.getElementById("basicsNext").addEventListener("click", async () => {
    plan.description = document.getElementById("pDescription").value;
    plan.sessionType = document.getElementById("pSessionType").value;
    plan.deliveryMode = document.getElementById("pDeliveryMode").value;
    plan.visibility = document.getElementById("pVisibility").value;
    plan.scheduledAt = document.getElementById("pScheduledAt").value;
    plan.timezone = document.getElementById("pTimezone").value;
    plan.expectedDurationMinutes = Number(document.getElementById("pDuration").value) || 60;
    plan.hostName = document.getElementById("pHost").value;
    plan.producerName = document.getElementById("pProducer").value;
    plan.registrationRequired = document.getElementById("pRegistration").checked;
    const title = document.getElementById("pTitle").value.trim() || "Untitled event";
    const statusEl = document.getElementById("basicsStatus");
    statusEl.textContent = "Saving…";
    try {
      await saveTitle(title);
      await savePlan();
      goToStep("audience");
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
  document.getElementById("audienceBack").addEventListener("click", () => goToStep("basics"));
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
    try { await savePlan(); goToStep("speakers"); } catch (error) { statusEl.textContent = error.message; statusEl.classList.add("err"); }
  });
}

// ---------- C. Speakers ----------
function renderSpeakers() {
  main.innerHTML = `
    <h1>Speakers</h1>
    <div id="speakerList"></div>
    <p class="plan-status" id="speakerStatus"></p>
    <div class="plan-grid-3">
      ${field("Name", `<input id="newSpeakerName">`)}
      ${field("Email", `<input id="newSpeakerEmail" type="email">`)}
      ${field("Role", `<input id="newSpeakerRole" placeholder="e.g. Guest, Panelist">`)}
    </div>
    <button class="xp-btn xp-btn-small" id="addSpeakerBtn">Add speaker</button>
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="speakersBack">Back</button><button class="xp-btn" id="speakersNext">Continue</button></div>
  `;
  renderSpeakerList();
  document.getElementById("speakersBack").addEventListener("click", () => goToStep("audience"));
  document.getElementById("speakersNext").addEventListener("click", () => goToStep("sponsors"));
  document.getElementById("addSpeakerBtn").addEventListener("click", async () => {
    const email = document.getElementById("newSpeakerEmail").value.trim();
    const statusEl = document.getElementById("speakerStatus");
    if (!email) { statusEl.textContent = "Email is required to invite a speaker."; statusEl.classList.add("err"); return; }
    try {
      await studioRequest(`/api/sessions/${session.id}/speakers`, {
        method: "POST",
        body: JSON.stringify({ email, displayName: document.getElementById("newSpeakerName").value.trim(), sessionRole: document.getElementById("newSpeakerRole").value.trim() })
      });
      document.getElementById("newSpeakerName").value = "";
      document.getElementById("newSpeakerEmail").value = "";
      document.getElementById("newSpeakerRole").value = "";
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
      <div><strong>${escapeHtml(s.displayName || s.email)}</strong><small>${escapeHtml(s.sessionRole || "Speaker")} · ${escapeHtml(s.email)}</small></div>
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
  document.getElementById("sponsorsBack").addEventListener("click", () => goToStep("speakers"));
  document.getElementById("sponsorsNext").addEventListener("click", () => goToStep("runofshow"));
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

// ---------- E. Run of Show ----------
function renderRunOfShow() {
  main.innerHTML = `
    <h1>Run of Show</h1>
    <p style="color:#8f857b">A lightweight outline for planning. The live Run of Show during the session itself is Studio's own runtime tool.</p>
    <div id="rosList"></div>
    <div class="plan-grid-3">
      ${field("Segment", `<input id="newRosLabel" placeholder="e.g. Sponsor: Acme">`)}
      ${field("Start (min)", `<input id="newRosOffset" type="number" min="0">`)}
      ${field("Notes", `<input id="newRosNotes">`)}
    </div>
    <button class="xp-btn xp-btn-small" id="addRosBtn">Add segment</button>
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="rosBack">Back</button><button class="xp-btn" id="rosNext">Save & continue</button></div>
    <p class="plan-status" id="rosStatus"></p>
  `;
  renderRosList();
  document.getElementById("rosBack").addEventListener("click", () => goToStep("sponsors"));
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
  document.getElementById("rosNext").addEventListener("click", async () => {
    const statusEl = document.getElementById("rosStatus");
    try { await savePlan(); goToStep("assets"); } catch (error) { statusEl.textContent = error.message; statusEl.classList.add("err"); }
  });
}

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
  document.getElementById("assetsBack").addEventListener("click", () => goToStep("runofshow"));
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
    try { await savePlan(); goToStep("readiness"); } catch (error) { statusEl.textContent = error.message; statusEl.classList.add("err"); }
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
  document.getElementById("readinessBack").addEventListener("click", () => goToStep("assets"));
  main.querySelectorAll("[data-checklist]").forEach((box) => box.addEventListener("change", async () => {
    plan.readinessChecklist[box.dataset.checklist] = box.checked;
    await savePlan();
    renderReadiness();
  }));
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(value) {
  return escapeHtml(value);
}

init();
