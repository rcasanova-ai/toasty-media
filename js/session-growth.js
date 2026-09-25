// Controller for studio/session-growth.html — Audience Analytics, Campaign Link Management, basic
// Sponsor Analytics, and the post-event Session Results surface, all for ONE session. Reads/writes the
// same Event Growth backend the Session Planner and Event Page editor already use.
import { studioRequest } from "./studio-api.js";

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session");
const orgParam = params.get("org");

const AUDIENCE_METRIC_GROUPS = [
  { title: "Reach", keys: ["PAGE_VIEW", "REGISTERED", "RSVP"] },
  { title: "Live participation", keys: ["JOINED_LIVE", "LEFT_LIVE", "WATCH_TIME", "RETURNED"] },
  { title: "Engagement", keys: ["CHAT_MESSAGE", "QUESTION", "POLL_RESPONSE", "REACTION"] },
  { title: "Calls to action", keys: ["CTA_CLICK", "QR_CLICK", "QR_REDIRECT", "BOOKING_CLICK"] },
  { title: "Replay & clips", keys: ["REPLAY_VIEW", "CLIP_VIEW"] },
  { title: "Sponsors", keys: ["SPONSOR_IMPRESSION", "SPONSOR_CTA"] },
  { title: "Growth", keys: ["SHARE", "REFERRAL", "PEEPS_SIGNUP"] }
];
const METRIC_LABELS = {
  PAGE_VIEW: "Page views", REGISTERED: "Registrations", RSVP: "RSVPs",
  JOINED_LIVE: "Joined live", LEFT_LIVE: "Left live", WATCH_TIME: "Watch-time pings", RETURNED: "Returning visits",
  CHAT_MESSAGE: "Chat messages", QUESTION: "Questions", POLL_RESPONSE: "Poll responses", REACTION: "Reactions",
  CTA_CLICK: "CTA clicks", QR_CLICK: "QR clicks", QR_REDIRECT: "QR redirects", BOOKING_CLICK: "Booking clicks",
  REPLAY_VIEW: "Replay views", CLIP_VIEW: "Clip views",
  SPONSOR_IMPRESSION: "Sponsor impressions", SPONSOR_CTA: "Sponsor CTA clicks",
  SHARE: "Shares", REFERRAL: "Referrals", PEEPS_SIGNUP: "Peeps sign-ups"
};

let session = null;
let sponsors = [];
let campaignLinks = [];
let audienceSummary = { countsByType: {}, uniqueVisitors: 0 };
let audienceEvents = [];
let artifacts = [];

async function init() {
  if (!sessionId) {
    document.getElementById("growthLoading").textContent = "Open Growth from a session's Readiness Review.";
    return;
  }
  const orgSuffix = orgParam ? `&org=${encodeURIComponent(orgParam)}` : "";
  document.getElementById("growthBack").href = `./plan.html?session=${encodeURIComponent(sessionId)}${orgSuffix}`;
  try {
    await refreshAll();
  } catch (error) {
    document.getElementById("growthLoading").textContent = error?.message || "Couldn't load this session's growth data.";
    return;
  }
  document.getElementById("growthTitle").textContent = `Growth — ${session.title || "Untitled event"}`;
  wireTabs();
  renderAudience();
  renderCampaign();
  renderSponsors();
  renderPostEvent();
  document.getElementById("growthLoading").hidden = true;
  document.getElementById("growthApp").hidden = false;
}

async function refreshAll() {
  const [sessionResult, sponsorsResult, linksResult, summaryResult, eventsResult, artifactsResult] = await Promise.all([
    studioRequest(`/api/sessions/${sessionId}`),
    studioRequest(`/api/sessions/${sessionId}/sponsors`),
    studioRequest(`/api/sessions/${sessionId}/campaign-links`),
    studioRequest(`/api/sessions/${sessionId}/audience/summary`),
    studioRequest(`/api/sessions/${sessionId}/audience/events`),
    studioRequest(`/api/sessions/${sessionId}/artifacts`)
  ]);
  session = sessionResult.session;
  sponsors = sponsorsResult.sponsors || [];
  campaignLinks = linksResult.campaignLinks || [];
  audienceSummary = summaryResult;
  audienceEvents = eventsResult.events || [];
  artifacts = artifactsResult.artifacts || [];
}

function wireTabs() {
  document.querySelectorAll("#growthTabs [data-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#growthTabs [data-tab]").forEach((b) => b.classList.toggle("is-active", b === btn));
      document.querySelectorAll(".growth-panel").forEach((p) => p.classList.toggle("is-active", p.dataset.panel === btn.dataset.tab));
    });
  });
}

// ---------- Audience Analytics ----------
function renderAudience() {
  const panel = document.getElementById("panelAudience");
  const counts = audienceSummary.countsByType || {};
  panel.innerHTML = `
    <div class="metric-row">
      <div class="metric-box"><span>Unique visitors</span><strong>${audienceSummary.uniqueVisitors || 0}</strong></div>
      <div class="metric-box unavailable"><span>Identified vs anonymous</span><strong>Unavailable — requires per-visitor identity lookup not yet exposed in bulk</strong></div>
    </div>
    ${AUDIENCE_METRIC_GROUPS.map((group) => `
      <h3 style="margin:18px 0 8px;font-size:.95rem">${group.title}</h3>
      <div class="metric-row">
        ${group.keys.map((key) => `<div class="metric-box"><span>${METRIC_LABELS[key]}</span><strong>${counts[key] || 0}</strong></div>`).join("")}
      </div>
    `).join("")}
    <h3 style="margin:18px 0 8px;font-size:.95rem">Recent activity</h3>
    <div class="timeline" id="audienceTimeline"></div>
  `;
  const timeline = document.getElementById("audienceTimeline");
  const recent = [...audienceEvents].sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt)).slice(0, 25);
  if (!recent.length) {
    timeline.innerHTML = `<p class="hint">No audience activity recorded yet — nothing has visited this event's public page.</p>`;
    return;
  }
  timeline.innerHTML = recent.map((ev) => `
    <div class="timeline-row">
      <span>${escapeHtml(METRIC_LABELS[ev.eventType] || ev.eventType)}${ev.source ? ` · ${escapeHtml(ev.source)}` : ""}${ev.campaign ? ` · ${escapeHtml(ev.campaign)}` : ""}</span>
      <small>${fmtRelative(ev.occurredAt)}</small>
    </div>`).join("");
}

// ---------- Campaign Link Management ----------
function renderCampaign() {
  const panel = document.getElementById("panelCampaign");
  panel.innerHTML = `
    <div class="growth-card">
      <h3>Create a campaign link</h3>
      <div class="growth-form">
        <input id="clSlug" placeholder="link slug (e.g. ricardo-ref)">
        <input id="clSource" placeholder="source (e.g. newsletter)">
        <input id="clCampaign" placeholder="campaign (e.g. launch-day)">
        <input id="clDestination" placeholder="https://destination-url" type="url">
        <select id="clSponsor"><option value="">No sponsor</option>${sponsors.map((s) => `<option value="${s.id}">${escapeHtml(s.companyName)}</option>`).join("")}</select>
        <button class="btn primary" id="clCreateBtn" type="button">Create link</button>
      </div>
      <p class="msg" id="clMessage"></p>
    </div>
    <table class="growth-table">
      <thead><tr><th>Slug</th><th>Source / Campaign</th><th>Sponsor</th><th>Clicks</th><th>Status</th><th></th></tr></thead>
      <tbody id="clBody"></tbody>
    </table>
    <p class="hint" id="clEmptyHint"></p>
  `;
  document.getElementById("clCreateBtn").addEventListener("click", createCampaignLink);
  renderCampaignRows();
}

function renderCampaignRows() {
  const emptyHint = document.getElementById("clEmptyHint");
  if (emptyHint) emptyHint.textContent = campaignLinks.length ? "" : "No campaign links yet.";
  const body = document.getElementById("clBody");
  body.innerHTML = campaignLinks.map((link) => {
    const sponsor = sponsors.find((s) => s.id === link.sponsorId);
    const url = `${window.location.origin}/api/r/${encodeURIComponent(link.slug)}`;
    return `
      <tr>
        <td><code>${escapeHtml(link.slug)}</code><br><button class="btn small" data-copy="${escapeAttr(url)}" type="button">Copy URL</button></td>
        <td>${escapeHtml(link.source || "—")} ${link.campaign ? `/ ${escapeHtml(link.campaign)}` : ""}</td>
        <td>${sponsor ? escapeHtml(sponsor.companyName) : "—"}</td>
        <td>${link.clickCount}</td>
        <td><span class="g-badge ${link.isActive ? "ok" : "off"}">${link.isActive ? "Active" : "Disabled"}</span></td>
        <td><button class="btn small" data-toggle="${link.id}" data-active="${link.isActive}" type="button">${link.isActive ? "Disable" : "Enable"}</button></td>
      </tr>`;
  }).join("");
  body.querySelectorAll("[data-copy]").forEach((btn) => btn.addEventListener("click", async () => {
    await navigator.clipboard?.writeText?.(btn.dataset.copy).catch(() => {});
    const original = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = original; }, 1500);
  }));
  body.querySelectorAll("[data-toggle]").forEach((btn) => btn.addEventListener("click", () => toggleCampaignLink(btn.dataset.toggle, btn.dataset.active !== "true")));
}

async function createCampaignLink() {
  const statusEl = document.getElementById("clMessage");
  statusEl.className = "msg";
  const slug = document.getElementById("clSlug").value.trim().toLowerCase();
  try {
    const result = await studioRequest(`/api/sessions/${sessionId}/campaign-links`, {
      method: "POST",
      body: JSON.stringify({
        slug,
        source: document.getElementById("clSource").value.trim(),
        campaign: document.getElementById("clCampaign").value.trim(),
        destinationUrl: document.getElementById("clDestination").value.trim(),
        sponsorId: document.getElementById("clSponsor").value || undefined
      })
    });
    campaignLinks.push(result.campaignLink);
    // Refresh only the table (renderCampaignRows), never the whole panel (renderCampaign) here — a full
    // panel re-render would rebuild a fresh #clMessage with no text, wiping the message we're about to
    // set below.
    document.getElementById("clSlug").value = "";
    document.getElementById("clSource").value = "";
    document.getElementById("clCampaign").value = "";
    document.getElementById("clDestination").value = "";
    document.getElementById("clSponsor").value = "";
    renderCampaignRows();
    statusEl.textContent = "Link created.";
    statusEl.classList.add("ok");
  } catch (error) {
    statusEl.textContent = error?.message || "Couldn't create link.";
    statusEl.classList.add("err");
  }
}

async function toggleCampaignLink(id, isActive) {
  try {
    const result = await studioRequest(`/api/campaign-links/${id}/active`, { method: "POST", body: JSON.stringify({ isActive }) });
    campaignLinks = campaignLinks.map((l) => (l.id === id ? result.campaignLink : l));
    renderCampaignRows();
  } catch {
    // Best-effort UI refresh; the table simply keeps its previous state if this fails.
  }
}

// ---------- Basic Sponsor Analytics ----------
function renderSponsors() {
  const panel = document.getElementById("panelSponsors");
  const counts = audienceSummary.countsByType || {};
  if (!sponsors.length) {
    panel.innerHTML = `<p class="hint">No sponsors added to this session yet — add them in Session Planner &rarr; Sponsors.</p>`;
    return;
  }
  panel.innerHTML = `
    <p class="hint">Sponsor impressions and sponsor CTA clicks below are session-wide totals (${counts.SPONSOR_IMPRESSION || 0} impressions, ${counts.SPONSOR_CTA || 0} CTA clicks) — this app doesn't yet attribute those two specific event types to an individual sponsor. Campaign-link clicks ARE attributed per sponsor, below, because each link can be tagged to one. No revenue or ROI figures are shown — Toasty doesn't fabricate financial numbers it wasn't given.</p>
    ${sponsors.map(renderSponsorCard).join("")}
  `;
}

function renderSponsorCard(sponsor) {
  const links = campaignLinks.filter((l) => l.sponsorId === sponsor.id);
  const totalClicks = links.reduce((sum, l) => sum + (l.clickCount || 0), 0);
  return `
    <div class="growth-card">
      <h3>${escapeHtml(sponsor.companyName)}</h3>
      <div class="metric-row">
        <div class="metric-box"><span>Attributed campaign-link clicks</span><strong>${totalClicks}</strong></div>
        <div class="metric-box"><span>Campaign links tagged</span><strong>${links.length}</strong></div>
        <div class="metric-box"><span>Approval</span><strong style="font-size:.95rem">${escapeHtml(sponsor.approvalStatus)}</strong></div>
      </div>
      ${links.length ? `<table class="growth-table"><thead><tr><th>Slug</th><th>Clicks</th><th>Status</th></tr></thead><tbody>${links.map((l) => `<tr><td><code>${escapeHtml(l.slug)}</code></td><td>${l.clickCount}</td><td><span class="g-badge ${l.isActive ? "ok" : "off"}">${l.isActive ? "Active" : "Disabled"}</span></td></tr>`).join("")}</tbody></table>` : `<p class="hint">No campaign links tagged to this sponsor yet — tag one in the Campaign Links tab.</p>`}
    </div>`;
}

// ---------- Post-Event Session Results ----------
const ARTIFACT_TYPES = ["clip", "quote_card", "article_draft", "linkedin_copy", "x_copy", "youtube_description", "newsletter_summary", "speaker_clip", "highlight_reel", "transcript", "chapters"];
const ARTIFACT_STATUS_BADGE = { draft: ["Not generated", "off"], processing: ["Processing", "warn"], ready: ["Available", "ok"], unavailable: ["Unavailable", "off"] };

function renderPostEvent() {
  const panel = document.getElementById("panelPostEvent");
  const counts = audienceSummary.countsByType || {};
  const topLinks = [...campaignLinks].sort((a, b) => b.clickCount - a.clickCount).slice(0, 5);
  panel.innerHTML = `
    <div class="growth-card">
      <h3>Audience summary</h3>
      <div class="metric-row">
        <div class="metric-box"><span>Unique visitors</span><strong>${audienceSummary.uniqueVisitors || 0}</strong></div>
        <div class="metric-box"><span>Registrations</span><strong>${counts.REGISTERED || 0}</strong></div>
        <div class="metric-box"><span>Replay views</span><strong>${counts.REPLAY_VIEW || 0}</strong></div>
        <div class="metric-box"><span>Clip views</span><strong>${counts.CLIP_VIEW || 0}</strong></div>
      </div>
    </div>
    <div class="growth-card">
      <h3>Campaign / referral summary</h3>
      ${topLinks.length ? `<table class="growth-table"><thead><tr><th>Slug</th><th>Clicks</th></tr></thead><tbody>${topLinks.map((l) => `<tr><td><code>${escapeHtml(l.slug)}</code></td><td>${l.clickCount}</td></tr>`).join("")}</tbody></table>` : `<p class="hint">No campaign links created for this session.</p>`}
    </div>
    <div class="growth-card">
      <h3>Sponsor results</h3>
      ${sponsors.length ? `<p class="hint">${sponsors.length} sponsor${sponsors.length === 1 ? "" : "s"} — see the Sponsors tab for per-sponsor attributed clicks.</p>` : `<p class="hint">No sponsors on this session.</p>`}
    </div>
    <div class="growth-card">
      <h3>Artifacts</h3>
      <div class="growth-form">
        <select id="peType">${ARTIFACT_TYPES.map((t) => `<option value="${t}">${t.replace(/_/g, " ")}</option>`).join("")}</select>
        <button class="btn primary" id="peCreateBtn" type="button">Add artifact</button>
      </div>
      <p class="msg" id="peMessage"></p>
      <table class="growth-table">
        <thead><tr><th>Type</th><th>Status</th><th>Reference</th><th></th></tr></thead>
        <tbody id="peBody"></tbody>
      </table>
      <p class="hint" id="peEmptyHint"></p>
    </div>
    <div class="growth-card">
      <h3>Moxie post-event suggestions</h3>
      <p class="hint">Generates draft-only content ideas from this session's real audience/sponsor data — never auto-published. Requires an organization AI provider (BYOK).</p>
      <button class="btn" id="peMoxieBtn" type="button">Generate suggestions</button>
      <p class="msg" id="peMoxieMessage"></p>
      <div id="peMoxieResult"></div>
    </div>
  `;
  document.getElementById("peCreateBtn").addEventListener("click", createArtifact);
  document.getElementById("peMoxieBtn").addEventListener("click", runMoxiePostEventSuggestions);
  renderArtifactRows();
}

function renderArtifactRows() {
  const emptyHint = document.getElementById("peEmptyHint");
  if (emptyHint) emptyHint.textContent = artifacts.length ? "" : `Nothing generated yet. Recording/replay/transcript status shows here honestly — never a fabricated "ready" state — once you or Moxie's post-event suggestions add something.`;
  const body = document.getElementById("peBody");
  body.innerHTML = artifacts.map((a) => {
    const [label, kind] = ARTIFACT_STATUS_BADGE[a.status] || ["Unknown", "off"];
    return `
      <tr>
        <td>${escapeHtml(a.artifactType.replace(/_/g, " "))}</td>
        <td><span class="g-badge ${kind}">${label}</span></td>
        <td>${a.storageReference ? escapeHtml(a.storageReference) : "—"}</td>
        <td>
          ${a.status !== "processing" ? `<button class="btn small" data-status="${a.id}" data-value="processing" type="button">Mark processing</button>` : ""}
          ${a.status !== "ready" ? `<button class="btn small" data-status="${a.id}" data-value="ready" type="button">Mark ready</button>` : ""}
        </td>
      </tr>`;
  }).join("");
  body.querySelectorAll("[data-status]").forEach((btn) => btn.addEventListener("click", () => setArtifactStatus(btn.dataset.status, btn.dataset.value)));
}

async function createArtifact() {
  const statusEl = document.getElementById("peMessage");
  statusEl.className = "msg";
  try {
    const result = await studioRequest(`/api/sessions/${sessionId}/artifacts`, {
      method: "POST",
      body: JSON.stringify({ artifactType: document.getElementById("peType").value })
    });
    artifacts.unshift(result.artifact);
    // renderArtifactRows only (never the full renderPostEvent) — that would rebuild a fresh #peMessage
    // with no text, wiping the message we're about to set below.
    renderArtifactRows();
    statusEl.textContent = "Added as draft.";
    statusEl.classList.add("ok");
  } catch (error) {
    statusEl.textContent = error?.message || "Couldn't add artifact.";
    statusEl.classList.add("err");
  }
}

async function setArtifactStatus(id, status) {
  try {
    const result = await studioRequest(`/api/artifacts/${id}/update`, { method: "POST", body: JSON.stringify({ status }) });
    artifacts = artifacts.map((a) => (a.id === id ? result.artifact : a));
    renderArtifactRows();
  } catch {
    // Best-effort — table keeps previous state if this fails.
  }
}

async function runMoxiePostEventSuggestions() {
  const statusEl = document.getElementById("peMoxieMessage");
  const resultEl = document.getElementById("peMoxieResult");
  statusEl.className = "msg";
  statusEl.textContent = "Generating…";
  resultEl.innerHTML = "";
  try {
    const result = await studioRequest(`/api/sessions/${sessionId}/moxie/post-event-suggestions`, { method: "POST", body: "{}" });
    statusEl.textContent = "";
    resultEl.innerHTML = `<pre style="white-space:pre-wrap;font-size:.85rem;background:#130f0d;border:1px solid var(--public-line);border-radius:8px;padding:12px">${escapeHtml(result.suggestions || "")}</pre>`;
  } catch (error) {
    statusEl.textContent = error?.message || "Couldn't generate suggestions.";
    statusEl.classList.add("err");
  }
}

function fmtRelative(iso) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escapeAttr(value) { return escapeHtml(value); }

init();
