// Controller for studio/event-page.html — the structured Event Page editor. Reuses the SAME durable
// session/plan/speakers/sponsors/landing-page backend the Session Planner (js/session-planner-page.js)
// already writes to; this is a second entry point onto that same data, not a parallel system.
import { studioRequest } from "./studio-api.js";
import { buildLandingBlocks, speakerToFeatured, sponsorToFeatured, blockOf } from "./event-page-blocks.js";

const params = new URLSearchParams(window.location.search);
const sessionId = params.get("session");
const orgParam = params.get("org");
const main = document.getElementById("eventPageMain");
const backNav = document.getElementById("eventPageBack");

let session = null;
let speakers = [];
let sponsors = [];
let landingPage = null;
let statusMessage = { text: "", kind: "" };

async function init() {
  if (!sessionId) {
    main.innerHTML = `<h1>Event Page</h1><p class="plan-hint">Open the Event Page from a session's Readiness Review so it knows which session to edit.</p><a class="eg-btn" href="./dashboard.html">Back to dashboard</a>`;
    return;
  }
  backNav.innerHTML = `<a href="./plan.html?session=${encodeURIComponent(sessionId)}${orgParam ? `&org=${encodeURIComponent(orgParam)}` : ""}">&larr; Back to Planner</a>`;
  try {
    const [sessionResult, speakersResult, sponsorsResult, landingResult] = await Promise.all([
      studioRequest(`/api/sessions/${sessionId}`),
      studioRequest(`/api/sessions/${sessionId}/speakers`),
      studioRequest(`/api/sessions/${sessionId}/sponsors`),
      studioRequest(`/api/sessions/${sessionId}/landing-page`)
    ]);
    session = sessionResult.session;
    speakers = speakersResult.speakers || [];
    sponsors = sponsorsResult.sponsors || [];
    landingPage = landingResult.landingPage;
  } catch (error) {
    main.innerHTML = `<h1>Event Page</h1><p class="plan-status err">${escapeHtml(error?.message || "Couldn't load this session.")}</p>`;
    return;
  }
  render();
}

function defaultSlug() {
  const base = (session.title || "event").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  const withMinLength = base.length >= 3 ? base : `${base || "event"}-${session.id.slice(-6)}`;
  return withMinLength;
}

function existingField(type, key, fallback = "") {
  const block = blockOf(landingPage?.blocks, type);
  return block?.content?.[key] ?? fallback;
}

function render() {
  const plan = session.plan || {};
  const hero = blockOf(landingPage?.blocks, "hero")?.content || {};
  const description = blockOf(landingPage?.blocks, "description")?.content || {};
  const cta = blockOf(landingPage?.blocks, "cta")?.content || {};
  const share = blockOf(landingPage?.blocks, "share")?.content || {};
  const featuredSpeakerIds = new Set((blockOf(landingPage?.blocks, "speakers")?.content?.items || []).map((s) => s.id));
  const featuredSponsorIds = new Set((blockOf(landingPage?.blocks, "sponsors")?.content?.items || []).map((s) => s.id));
  const slug = landingPage?.slug || defaultSlug();
  const status = landingPage?.status || "draft";
  const publicUrl = `${window.location.origin}/studio/e.html?slug=${encodeURIComponent(slug)}`;

  main.innerHTML = `
    <h1>Event Page</h1>
    <p class="sub">A structured page for this event — not a page builder. What you fill in below is exactly what the audience sees.</p>

    <div class="plan-field"><label>Status</label>
      <div class="readonly-box">
        <span class="plan-pill ${status === "published" ? "good" : "warn"}">${status === "published" ? "Published" : "Draft — not publicly visible"}</span>
        ${status === "published" ? `<div style="margin-top:8px"><a href="${publicUrl}" target="_blank" rel="noopener" style="color:#f5a67b">${publicUrl}</a></div>` : ""}
      </div>
    </div>

    <div class="plan-field"><label>Event title</label><input id="epTitle" value="${escapeAttr(session.title)}"></div>
    <div class="plan-field"><label>Page URL (slug)</label><input id="epSlug" value="${escapeAttr(slug)}" pattern="[a-z0-9][a-z0-9-]{2,79}"></div>
    <p class="plan-hint">Published at ${escapeHtml(window.location.origin)}/studio/e.html?slug=&lt;this&gt;. Custom domains aren't available yet — coming soon.</p>

    <div class="plan-field"><label>Short description</label><textarea id="epShort" maxlength="200">${escapeHtml(existingField("hero", "shortDescription", hero.shortDescription || ""))}</textarea></div>
    <div class="plan-field"><label>Full description</label><textarea id="epLong" style="min-height:140px">${escapeHtml(description.body || "")}</textarea></div>
    <div class="plan-field"><label>Hero image URL</label><input id="epHero" type="url" value="${escapeAttr(hero.heroImageUrl || "")}" placeholder="https://…"></div>

    <div class="plan-field"><label>Date, time &amp; timezone</label>
      <div class="readonly-box">${plan.scheduledAt ? escapeHtml(new Date(plan.scheduledAt).toLocaleString()) : "Not set yet"} ${plan.timezone ? `(${escapeHtml(plan.timezone)})` : ""}</div>
    </div>
    <p class="plan-hint">Set in Session Planner &rarr; Session Basics. <a href="./plan.html?session=${encodeURIComponent(sessionId)}" style="color:#f5a67b">Edit there</a>.</p>

    <div class="plan-section-title">Speakers to feature</div>
    <div id="epSpeakers">${speakers.length ? speakers.map((s) => `
      <div class="plan-list-item">
        <label><input type="checkbox" data-speaker="${s.id}" ${featuredSpeakerIds.has(s.id) ? "checked" : ""}> ${escapeHtml(s.displayName || s.email)}</label>
        <span class="plan-pill ${s.inviteStatus === "accepted" ? "good" : "warn"}">${escapeHtml(s.inviteStatus.replace(/_/g, " "))}</span>
      </div>`).join("") : `<p class="plan-hint">No speakers added yet — add them in Session Planner &rarr; Speakers.</p>`}</div>

    <div class="plan-section-title">Sponsors to feature</div>
    <div id="epSponsors">${sponsors.length ? sponsors.map((s) => `
      <div class="plan-list-item">
        <label><input type="checkbox" data-sponsor="${s.id}" ${featuredSponsorIds.has(s.id) ? "checked" : ""}> ${escapeHtml(s.companyName)}</label>
        <span class="plan-pill ${s.approvalStatus === "approved" ? "good" : "warn"}">${escapeHtml(s.approvalStatus)}</span>
      </div>`).join("") : `<p class="plan-hint">No sponsors added yet — add them in Session Planner &rarr; Sponsors.</p>`}</div>

    <div class="plan-section-title">Registration / call to action</div>
    <div class="plan-grid-2">
      <div class="plan-field"><label>Primary button label</label><input id="epCtaLabel" value="${escapeAttr(cta.primary?.label || plan.audience?.ctaDefault || "")}"></div>
      <div class="plan-field"><label>Primary button URL</label><input id="epCtaUrl" type="url" value="${escapeAttr(cta.primary?.url || "")}" placeholder="https://…"></div>
    </div>
    <div class="plan-grid-2">
      <div class="plan-field"><label>Secondary button label (optional)</label><input id="epCta2Label" value="${escapeAttr(cta.secondary?.label || "")}"></div>
      <div class="plan-field"><label>Secondary button URL (optional)</label><input id="epCta2Url" type="url" value="${escapeAttr(cta.secondary?.url || "")}" placeholder="https://…"></div>
    </div>

    <div class="plan-section-title">Social / share</div>
    <div class="plan-field"><label>Share title</label><input id="epShareTitle" value="${escapeAttr(share.shareTitle || session.title || "")}"></div>
    <div class="plan-field"><label>Share description</label><textarea id="epShareDesc">${escapeHtml(share.shareDescription || "")}</textarea></div>

    <div class="plan-field"><label>Visibility &amp; replay</label>
      <div class="readonly-box">Visibility: ${escapeHtml(plan.visibility || "public")} · Replay after event: ${plan.audience?.replayEnabled ? "enabled" : "disabled"} <span style="opacity:.7">(set in Session Planner)</span></div>
    </div>

    <div class="plan-actions">
      <div>
        <button class="eg-btn eg-btn-ghost plan-btn-small" id="epPreview" type="button">Preview</button>
      </div>
      <div style="display:flex;gap:10px">
        <button class="eg-btn eg-btn-ghost plan-btn-small" id="epSaveDraft" type="button">Save draft</button>
        ${status === "published"
          ? `<button class="eg-btn eg-btn-ghost plan-btn-small" id="epUnpublish" type="button">Unpublish</button>`
          : `<button class="eg-btn plan-btn-small" id="epPublish" type="button">Publish</button>`}
      </div>
    </div>
    <p class="plan-status ${statusMessage.kind}" id="epStatus">${escapeHtml(statusMessage.text)}</p>
  `;

  document.getElementById("epSaveDraft").addEventListener("click", () => saveDraft());
  document.getElementById("epPreview").addEventListener("click", () => openPreview());
  document.getElementById("epPublish")?.addEventListener("click", () => publish());
  document.getElementById("epUnpublish")?.addEventListener("click", () => unpublish());
}

function readForm() {
  const featuredSpeakers = [...document.querySelectorAll("#epSpeakers [data-speaker]:checked")]
    .map((el) => speakers.find((s) => s.id === el.dataset.speaker))
    .filter(Boolean)
    .map(speakerToFeatured);
  const featuredSponsors = [...document.querySelectorAll("#epSponsors [data-sponsor]:checked")]
    .map((el) => sponsors.find((s) => s.id === el.dataset.sponsor))
    .filter(Boolean)
    .map(sponsorToFeatured);
  return {
    title: document.getElementById("epTitle").value.trim() || "Untitled event",
    slug: document.getElementById("epSlug").value.trim().toLowerCase(),
    shortDescription: document.getElementById("epShort").value.trim(),
    longDescription: document.getElementById("epLong").value.trim(),
    heroImageUrl: document.getElementById("epHero").value.trim(),
    scheduledAt: session.plan?.scheduledAt || "",
    timezone: session.plan?.timezone || "",
    sessionType: session.plan?.sessionType || "",
    featuredSpeakers,
    featuredSponsors,
    ctaPrimary: { label: document.getElementById("epCtaLabel").value.trim(), url: document.getElementById("epCtaUrl").value.trim() },
    ctaSecondary: { label: document.getElementById("epCta2Label").value.trim(), url: document.getElementById("epCta2Url").value.trim() },
    replayEnabled: Boolean(session.plan?.audience?.replayEnabled),
    shareTitle: document.getElementById("epShareTitle").value.trim(),
    shareDescription: document.getElementById("epShareDesc").value.trim()
  };
}

async function persistLandingPage(form) {
  const blocks = buildLandingBlocks(form);
  const result = await studioRequest(`/api/sessions/${sessionId}/landing-page`, {
    method: "POST",
    body: JSON.stringify({ slug: form.slug, blocks })
  });
  landingPage = result.landingPage;
}

async function saveDraft({ silent = false } = {}) {
  // Read the form BEFORE touching statusMessage/render() below — re-rendering rebuilds every input from
  // current state, which would silently discard whatever the organizer just typed if read afterward.
  const form = readForm();
  if (!silent) {
    const statusEl = document.getElementById("epStatus");
    if (statusEl) { statusEl.textContent = "Saving…"; statusEl.className = "plan-status"; }
  }
  try {
    if (form.title !== session.title) {
      await studioRequest(`/api/sessions/${sessionId}/title`, { method: "POST", body: JSON.stringify({ title: form.title }) });
      session.title = form.title;
    }
    await persistLandingPage(form);
    statusMessage = { text: "Draft saved.", kind: "ok" };
    render();
    return true;
  } catch (error) {
    statusMessage = { text: error?.message || "Couldn't save.", kind: "err" };
    render();
    return false;
  }
}

async function openPreview() {
  // The organizer's own authenticated session — never the public slug route — so Preview always shows
  // the current draft exactly, whether or not it's been published yet.
  const saved = await saveDraft({ silent: true });
  if (!saved) return;
  window.open(`./e.html?previewSession=${encodeURIComponent(sessionId)}`, "_blank", "noopener");
}

async function publish() {
  const saved = await saveDraft({ silent: true });
  if (!saved) return;
  try {
    const result = await studioRequest(`/api/sessions/${sessionId}/landing-page/publish`, { method: "POST", body: "{}" });
    landingPage = result.landingPage;
    statusMessage = { text: "Published.", kind: "ok" };
  } catch (error) {
    statusMessage = { text: error?.message || "Couldn't publish.", kind: "err" };
  }
  render();
}

async function unpublish() {
  try {
    const result = await studioRequest(`/api/sessions/${sessionId}/landing-page/unpublish`, { method: "POST", body: "{}" });
    landingPage = result.landingPage;
    statusMessage = { text: "Unpublished — the public page is no longer visible.", kind: "ok" };
  } catch (error) {
    statusMessage = { text: error?.message || "Couldn't unpublish.", kind: "err" };
  }
  render();
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(value) {
  return escapeHtml(value);
}

init();
