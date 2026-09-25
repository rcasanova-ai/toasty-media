// Renders a published (or, in preview, draft) Event Page from the SAME block data the organizer's
// Event Page editor (js/event-page-editor.js) writes — this is the "real public landing-page route"
// item 2 requires; there is no separate mock/preview-only template.
import { applyBrandTheme } from "./brand-themes.js";
import { studioApiEndpoint } from "./studio-api.js";
import { blockOf } from "./event-page-blocks.js";

const params = new URLSearchParams(window.location.search);
const slug = params.get("slug");
const previewSessionId = params.get("previewSession");
const isPreview = Boolean(previewSessionId);
const root = document.getElementById("epRoot");

async function apiFetch(path) {
  const response = await fetch(`${studioApiEndpoint()}${path}`, { credentials: "include" });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) throw new Error(payload.error || "Couldn't load this event.");
  return payload;
}

async function load() {
  if (isPreview) {
    document.getElementById("epPreviewBanner").hidden = false;
    try {
      const result = await apiFetch(`/api/sessions/${previewSessionId}/landing-page`);
      if (!result.landingPage) return renderError("This event doesn't have a page yet. Go back to the Event Page editor and save a draft first.");
      render(result.landingPage, { recordViews: false });
    } catch (error) {
      renderError(error.message || "You need to be signed in as this event's organizer to preview it.");
    }
    return;
  }
  if (!slug) return renderError("This event page link is incomplete.");
  try {
    const result = await apiFetch(`/api/landing-pages/${encodeURIComponent(slug)}`);
    render(result.landingPage, { recordViews: true });
  } catch (error) {
    renderError("This event page isn't available. It may not be published yet, or the link may be out of date.");
  }
}

function renderError(message) {
  root.innerHTML = `<div class="ep-error"><h1>Event page not found</h1><p>${escapeHtml(message)}</p></div>`;
}

let currentSessionId = null;

function render(landingPage, { recordViews }) {
  currentSessionId = landingPage.sessionId || null;
  applyBrandTheme(landingPage.baseThemeId || "toasty");
  const hero = blockOf(landingPage.blocks, "hero")?.content || {};
  const description = blockOf(landingPage.blocks, "description")?.content || {};
  const speakersBlock = blockOf(landingPage.blocks, "speakers")?.content?.items || [];
  const sponsorsBlock = blockOf(landingPage.blocks, "sponsors")?.content?.items || [];
  const cta = blockOf(landingPage.blocks, "cta")?.content || {};
  const replay = blockOf(landingPage.blocks, "replay")?.content || null;
  const share = blockOf(landingPage.blocks, "share")?.content || {};

  document.title = share.shareTitle || hero.title || "Toasty Event";
  setMeta("description", share.shareDescription || hero.shortDescription || "");
  setMeta("og:title", share.shareTitle || hero.title || "", true);
  setMeta("og:description", share.shareDescription || hero.shortDescription || "", true);
  if (hero.heroImageUrl) setMeta("og:image", hero.heroImageUrl, true);

  const when = hero.scheduledAt ? new Date(hero.scheduledAt).toLocaleString() : "";

  root.innerHTML = `
    <section class="ep-hero">
      ${hero.heroImageUrl ? `<img class="hero-img" src="${escapeAttr(hero.heroImageUrl)}" alt="">` : ""}
      <h1>${escapeHtml(hero.title || "Toasty Event")}</h1>
      ${hero.shortDescription ? `<p>${escapeHtml(hero.shortDescription)}</p>` : ""}
      ${when ? `<div class="ep-meta">${escapeHtml(when)}${hero.timezone ? ` (${escapeHtml(hero.timezone)})` : ""}</div>` : ""}
      ${renderCtas(cta)}
    </section>
    <div class="ep-body">
      ${description.body ? `<section class="ep-section"><h2>About this event</h2><p class="ep-desc">${escapeHtml(description.body)}</p></section>` : ""}
      ${speakersBlock.length ? `<section class="ep-section"><h2>Speakers</h2><div class="ep-people">${speakersBlock.map(renderPerson).join("")}</div></section>` : ""}
      ${sponsorsBlock.length ? `<section class="ep-section"><h2>Sponsors</h2><div class="ep-sponsors">${sponsorsBlock.map(renderSponsor).join("")}</div></section>` : ""}
      ${replay?.enabled ? `<section class="ep-section"><h2>Replay</h2><p class="ep-replay-note">A replay will be available here after the event, once it's ready.</p></section>` : ""}
    </div>
    <p class="ep-share">Produced with Toasty</p>
  `;

  root.querySelectorAll("[data-cta]").forEach((btn) => {
    btn.addEventListener("click", () => recordEvent("CTA_CLICK", { ctaKind: btn.dataset.cta }));
  });

  if (recordViews) recordEvent("PAGE_VIEW", { source: params.get("src") || params.get("source") || "", campaign: params.get("campaign") || "" });
}

function renderCtas(cta) {
  const buttons = [];
  if (cta.primary?.label && cta.primary?.url) buttons.push(`<a class="ep-btn" data-cta="primary" href="${escapeAttr(cta.primary.url)}" target="_blank" rel="noopener">${escapeHtml(cta.primary.label)}</a>`);
  if (cta.secondary?.label && cta.secondary?.url) buttons.push(`<a class="ep-btn secondary" data-cta="secondary" href="${escapeAttr(cta.secondary.url)}" target="_blank" rel="noopener">${escapeHtml(cta.secondary.label)}</a>`);
  return buttons.length ? `<div class="ep-ctas">${buttons.join("")}</div>` : "";
}

function renderPerson(person) {
  return `
    <div class="ep-person">
      ${person.headshotReference ? `<img src="${escapeAttr(person.headshotReference)}" alt="">` : ""}
      <strong>${escapeHtml(person.displayName || "Speaker")}</strong>
      <small>${escapeHtml([person.title, person.company].filter(Boolean).join(" · ") || person.sessionRole || "")}</small>
      ${person.bioShort ? `<p style="margin:8px 0 0;font-size:13px;color:var(--brand-text-muted,#9c8d7c)">${escapeHtml(person.bioShort)}</p>` : ""}
    </div>`;
}

function renderSponsor(sponsor) {
  const inner = `${sponsor.logoReference ? `<img src="${escapeAttr(sponsor.logoReference)}" alt="">` : ""}<span>${escapeHtml(sponsor.companyName || "Sponsor")}</span>`;
  return sponsor.website ? `<a href="${escapeAttr(sponsor.website)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="ep-sponsor-item" style="display:flex;align-items:center;gap:10px;background:var(--brand-surface,#171210);border:1px solid var(--brand-border,rgba(255,255,255,.1));border-radius:10px;padding:10px 16px">${inner}</div>`;
}

function setMeta(name, content, isProperty = false) {
  if (!content) return;
  const attr = isProperty ? "property" : "name";
  let tag = document.head.querySelector(`meta[${attr}="${name}"]`);
  if (!tag) {
    tag = document.createElement("meta");
    tag.setAttribute(attr, name);
    document.head.append(tag);
  }
  tag.setAttribute("content", content);
}

function visitorAnonymousId() {
  try {
    const key = "toastyEventVisitorId";
    let id = window.localStorage.getItem(key);
    if (!id) {
      id = `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      window.localStorage.setItem(key, id);
    }
    return id;
  } catch {
    return `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  }
}

async function recordEvent(eventType, { source = "", campaign = "", ctaKind = "" } = {}) {
  if (!landingPageSessionId()) return;
  try {
    await fetch(`${studioApiEndpoint()}/api/audience/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Toasty-CSRF": "1" },
      body: JSON.stringify({
        sessionId: landingPageSessionId(),
        anonymousId: visitorAnonymousId(),
        eventType,
        source,
        campaign,
        metadata: ctaKind ? { ctaKind } : {}
      })
    });
  } catch {
    // Analytics is best-effort — never blocks the event page itself from rendering or the CTA link from
    // working (the <a> navigates regardless of whether this fetch succeeds).
  }
}

function landingPageSessionId() { return currentSessionId; }

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(value) {
  return escapeHtml(value);
}

load();
