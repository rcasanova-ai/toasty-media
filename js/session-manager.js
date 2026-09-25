// Toasty's durable LiveSession layer on the frontend — see scripts/toasty-auth-db.py's live_sessions
// table for the backend model this talks to.
//
// resolveSession() gates director.js BEFORE LiveSession.applyDurableSession / joinAsHost.
// ENDED sessions never resolve as live. View Session is a read-only artifacts surface.

import { studioRequest } from "./studio-api.js";
import { getGuestInviteUrl, getListenerInviteUrl, createDisposableRoomId } from "./video-engine.js";
import {
  StudioHomeAction,
  StudioHomeCollectionId,
  STUDIO_HOME_COLLECTIONS,
  canOpenLiveStudio,
  duplicateSessionConfig,
  isTerminalSession,
  loadHomeOverlay,
  moveSessionToCollection,
  organizeStudioHome,
  renameHomeSession,
  saveHomeOverlay,
  sessionDisplayTitle,
  setCollectionCollapsed
} from "./studio-home.js";
import { loadSessionArtifacts } from "./session-artifacts.js";

function log(...args) { console.debug("[SessionManager]", ...args); }

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

function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function guestInviteUrlFor(session) {
  return getGuestInviteUrl(session.roomId, session.brandId || undefined);
}

export function listenerInviteUrlFor(session) {
  return getListenerInviteUrl(session.roomId, session.brandId || undefined);
}

export function openPreviewTab(session) {
  window.open(listenerInviteUrlFor(session), "_blank", "noopener");
}

async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function copyGuestInvite(session) {
  return copyToClipboard(guestInviteUrlFor(session));
}

export async function copyListenerInvite(session) {
  return copyToClipboard(listenerInviteUrlFor(session));
}

export async function endSession(sessionId) {
  return studioRequest(`/api/sessions/${sessionId}/end`, { method: "POST", body: "{}" });
}

export async function createSession({ title, brandId, setup, endCard, organizationId } = {}) {
  const roomId = createDisposableRoomId();
  const result = await studioRequest("/api/sessions", {
    method: "POST",
    body: JSON.stringify({
      roomId,
      title: title || "",
      brandId: brandId || "",
      ...(setup ? { setup } : {}),
      ...(endCard ? { endCard } : {}),
      // Only sent when a caller (e.g. the Session Planner, which reads the dashboard's selected
      // organization from ?org=) knows which organization this session belongs in. The server
      // validates real membership and otherwise falls back to the caller's own owner org — this
      // client never guesses or defaults on its own.
      ...(organizationId ? { organizationId } : {})
    })
  });
  return result.session;
}

export async function renameSession(sessionId, title) {
  const result = await studioRequest(`/api/sessions/${sessionId}/title`, {
    method: "POST",
    body: JSON.stringify({ title: title || "" })
  });
  return result.session;
}

export async function deleteSession(sessionId) {
  return studioRequest(`/api/sessions/${sessionId}/delete`, { method: "POST", body: "{}" });
}

export async function duplicateSession(session, overlay) {
  const config = duplicateSessionConfig(session, overlay);
  const roomId = createDisposableRoomId();
  const result = await studioRequest(`/api/sessions/${session.id}/duplicate`, {
    method: "POST",
    body: JSON.stringify({ roomId, title: config.title })
  });
  return result.session;
}

async function fetchSessions(status) {
  const query = status ? `?status=${status}` : "";
  const result = await studioRequest(`/api/sessions${query}`, { method: "GET" });
  return result.sessions || [];
}

export function resolveSession({ brandId }) {
  return new Promise((resolve) => {
    const params = new URLSearchParams(window.location.search);
    const existingId = params.get("session");
    if (existingId) {
      resolveExisting(existingId, resolve, brandId);
      return;
    }
    showHome(resolve, brandId);
  });
}

async function resolveExisting(id, resolve, brandId) {
  try {
    const result = await studioRequest(`/api/sessions/${id}`, { method: "GET" });
    if (result.session && isTerminalSession(result.session)) {
      resolve({ mode: "artifacts", session: result.session });
      return;
    }
    if (result.session && result.session.status !== "ENDED") {
      resolve({ mode: "live", session: result.session });
      return;
    }
    log("session from URL is missing, falling back to Studio Home", id);
  } catch (error) {
    log("could not resolve session from URL, falling back to Studio Home", error);
  }
  showHome(resolve, brandId);
}

function setUrlSession(id, { view = null } = {}) {
  const url = new URL(window.location.href);
  url.searchParams.set("session", id);
  if (view) url.searchParams.set("view", view);
  else url.searchParams.delete("view");
  window.history.replaceState({}, "", url);
  if (window.parent !== window) {
    window.parent.postMessage({ type: "toasty:session-selected", sessionId: id, view: view || null }, window.location.origin);
  }
}

function el(id) { return document.getElementById(id); }

async function showHome(resolve, brandId) {
  const gate = el("sessionGate");
  if (!gate) {
    resolve({ mode: "live", session: await createSession({ title: "", brandId }) });
    return;
  }
  hideArtifacts();
  gate.hidden = false;
  document.body.classList.add("session-gate-open");
  document.body.classList.remove("session-artifacts-open");
  // Studio Home itself is a fully resolved authenticated destination. Tell the
  // top-level shell immediately so its first-paint curtain does not wait for a
  // live session to be selected.
  if (window.parent !== window) {
    window.parent.postMessage({ type: "toasty:studio-ready", surface: "home" }, window.location.origin);
  }

  const statusEl = el("sessionGateStatus");
  const board = el("studioHomeBoard");
  const titleInput = el("sessionGateTitle");
  const createBtn = el("sessionGateCreate");
  let overlay = loadHomeOverlay();
  let lastHome = { liveNow: [] };

  function finishLive(session) {
    if (!canOpenLiveStudio(session) || isTerminalSession(session)) {
      statusEl.textContent = "This session has ended. Use View Session.";
      return;
    }
    gate.hidden = true;
    document.body.classList.remove("session-gate-open");
    setUrlSession(session.id);
    resolve({ mode: "live", session });
  }

  function finishArtifacts(session) {
    gate.hidden = true;
    document.body.classList.remove("session-gate-open");
    setUrlSession(session.id, { view: "artifacts" });
    resolve({ mode: "artifacts", session });
  }

  async function refresh() {
    statusEl.textContent = "Loading sessions…";
    try {
      const [active, ended] = await Promise.all([fetchSessions("active"), fetchSessions("ended")]);
      const allSessions = [...active, ...ended];
      overlay = loadHomeOverlay(allSessions[0]?.ownerUserId);
      lastHome = organizeStudioHome(allSessions, overlay);
      statusEl.textContent = "";
      renderStudioHome(board, lastHome, overlay, {
        onOpen: finishLive,
        onView: finishArtifacts,
        onRefresh: refresh,
        statusEl,
        brandId,
        ownerUserId: allSessions[0]?.ownerUserId
      });
    } catch (error) {
      statusEl.textContent = `Couldn't load sessions: ${error.message}`;
    }
  }

  createBtn.onclick = async () => {
    const liveNow = lastHome.liveNow || [];
    if (liveNow.length) {
      const live = liveNow[0];
      const choice = await chooseLiveConflict(live.title);
      if (choice === "cancel" || !choice) return;
      if (choice === "resume") {
        finishLive(live.session);
        return;
      }
      if (choice === "replace") {
        createBtn.disabled = true;
        statusEl.textContent = "Ending live session…";
        try {
          await endSession(live.session.id);
        } catch (error) {
          statusEl.textContent = `Couldn't end live session: ${error.message}`;
          createBtn.disabled = false;
          return;
        }
      }
    }
    createBtn.disabled = true;
    statusEl.textContent = "Creating session…";
    try {
      const session = await createSession({ title: titleInput.value.trim(), brandId });
      finishLive(session);
    } catch (error) {
      statusEl.textContent = `Couldn't create session: ${error.message}`;
      createBtn.disabled = false;
    }
  };

  await refresh();
}

function persistOverlay(overlay, ownerUserId) {
  return saveHomeOverlay(ownerUserId, overlay);
}

function renderStudioHome(board, home, overlay, ctx) {
  if (!board) return;
  const fragments = [];
  if (home.liveNow?.length) fragments.push(renderLiveNowSection(home.liveNow, overlay, ctx));
  fragments.push(renderSystemSection("Recent", home.recent.slice(0, 3), overlay, ctx, { empty: "No recent sessions." }));
  const homeCollectionIds = new Set([
    StudioHomeCollectionId.SHOWS,
    StudioHomeCollectionId.FOCUS_GROUPS,
    StudioHomeCollectionId.MEETINGS
  ]);
  home.collections.forEach((collection) => {
    if (collection.hidden || !homeCollectionIds.has(collection.id)) return;
    fragments.push(renderCollectionSection(collection, overlay, ctx));
  });
  board.replaceChildren(...fragments);
}

function renderLiveNowSection(items, overlay, ctx) {
  const section = document.createElement("section");
  section.className = "studio-home-section studio-home-live-now";
  section.innerHTML = `<p class="session-gate-label">Live Now</p>`;
  const list = document.createElement("div");
  list.className = "studio-home-grid";
  list.append(...items.map((item) => renderLiveNowCard(item, overlay, ctx)));
  section.append(list);
  return section;
}

function renderLiveNowCard(item, overlay, ctx) {
  const { session, title } = item;
  const card = document.createElement("article");
  card.className = "session-card session-card--live-now";
  card.dataset.lifecycle = "ACTIVE";
  card.dataset.status = session.status;
  card.innerHTML = `
    <div class="session-card-main">
      <p class="session-live-badge" aria-label="Live">LIVE</p>
      <h2 class="session-card-title">${escapeHtml(title)}</h2>
      <p class="session-card-meta">${escapeHtml(liveNowMeta(session))}</p>
    </div>
    <div class="session-card-actions">
      <button type="button" class="lv-mini-btn lv-mini-btn--primary" data-action="resume">Resume Live Session</button>
      <button type="button" class="lv-mini-btn lv-mini-btn--danger" data-action="end">End Session</button>
    </div>
  `;
  card.querySelector('[data-action="resume"]').addEventListener("click", () => ctx.onOpen(session));
  card.querySelector('[data-action="end"]').addEventListener("click", () => endLiveCard(session, overlay, ctx));
  return card;
}

function liveNowMeta(session) {
  const parts = [];
  const duration = fmtDuration(session.startedAt);
  if (duration) parts.push(duration);
  if (session.participantCount != null) parts.push(`${session.participantCount} participant${session.participantCount === 1 ? "" : "s"}`);
  else parts.push("Live room");
  return parts.join(" · ");
}

function fmtDuration(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return "Active just now";
  if (mins < 60) return `Active ${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem ? `Active ${hours}h ${rem}m` : `Active ${hours}h`;
}

function chooseLiveConflict(title) {
  return new Promise((resolve) => {
    const existing = document.querySelector(".studio-live-conflict");
    existing?.remove();
    const dialog = document.createElement("div");
    dialog.className = "studio-live-conflict";
    dialog.setAttribute("role", "dialog");
    dialog.innerHTML = `
      <div class="studio-live-conflict-card">
        <p>You already have a live session: ${escapeHtml(title)}.</p>
        <div class="session-card-actions">
          <button type="button" class="lv-mini-btn lv-mini-btn--primary" data-choice="resume">Resume Live Session</button>
          <button type="button" class="lv-mini-btn lv-mini-btn--danger" data-choice="replace">End & Create New</button>
          <button type="button" class="lv-mini-btn" data-choice="cancel">Cancel</button>
        </div>
      </div>
    `;
    const finish = (choice) => {
      dialog.remove();
      resolve(choice);
    };
    dialog.addEventListener("click", (event) => {
      const choice = event.target?.dataset?.choice;
      if (choice) finish(choice);
    });
    document.body.append(dialog);
  });
}

function confirmEndSession(title) {
  return Promise.resolve(window.confirm(`End “${title}”?\n\nThe live room will close. This session cannot be resumed.`));
}

async function endLiveCard(session, overlay, ctx) {
  const title = sessionDisplayTitle(session, overlay);
  const ok = await confirmEndSession(title);
  if (!ok) return;
  ctx.statusEl.textContent = "Ending session…";
  const button = document.querySelector(`.session-card--live-now [data-action="end"]`);
  if (button) { button.disabled = true; button.textContent = "Ending…"; }
  try {
    await endSession(session.id);
    window.location.reload();
    return;
  } catch (error) {
    if (button) { button.disabled = false; button.textContent = "End Session"; }
    ctx.statusEl.textContent = `Couldn't end session: ${error.message}`;
  }
}

function renderSystemSection(label, items, overlay, ctx, { empty }) {
  const section = document.createElement("section");
  section.className = "studio-home-section";
  section.innerHTML = `<p class="session-gate-label">${escapeHtml(label)}</p>`;
  const list = document.createElement("div");
  list.className = "studio-home-grid";
  if (!items.length) list.append(placeholder(empty));
  else list.append(...items.map((item) => renderSessionCard(item, overlay, ctx)));
  section.append(list);
  return section;
}

function renderCollectionSection(collection, overlay, ctx) {
  const section = document.createElement("section");
  section.className = "studio-home-section";
  section.dataset.collection = collection.id;
  const head = document.createElement("div");
  head.className = "studio-home-section-head";
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "session-gate-label studio-home-collapse";
  toggle.textContent = collection.label;
  toggle.setAttribute("aria-expanded", String(!collection.collapsed));
  toggle.addEventListener("click", () => {
    persistOverlay(setCollectionCollapsed(overlay, collection.id, !collection.collapsed), ctx.ownerUserId);
    ctx.onRefresh();
  });
  head.append(toggle);
  section.append(head);
  if (collection.collapsed) return section;
  const list = document.createElement("div");
  list.className = "studio-home-list";
  const visibleItems = collection.items.slice(0, 3);
  if (!visibleItems.length) list.append(placeholder("Nothing in this collection yet."));
  else list.append(...visibleItems.map((item) => renderSessionCard(item, overlay, ctx)));
  section.append(list);
  if (collection.items.length > 3) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "studio-home-more";
    more.textContent = `More ${collection.label}`;
    more.addEventListener("click", () => {
      const expanded = more.getAttribute("aria-expanded") === "true";
      more.setAttribute("aria-expanded", String(!expanded));
      more.textContent = expanded ? `More ${collection.label}` : "Show less";
      list.replaceChildren(...(expanded ? visibleItems : collection.items).map((item) => renderSessionCard(item, overlay, ctx)));
    });
    section.append(more);
  }
  return section;
}

function renderSessionCard(item, overlay, ctx) {
  const { session, lifecycle, title, action } = item;
  const card = document.createElement("article");
  card.className = "session-card";
  card.dataset.lifecycle = lifecycle;
  card.dataset.status = session.status;
  const primaryLabel = action === StudioHomeAction.VIEW_SESSION
    ? "View Session"
    : action === StudioHomeAction.USE_SESSION
      ? "Use Session"
      : action === StudioHomeAction.RESUME_LIVE_SESSION
        ? "Resume Live Session"
        : "Open Studio";
  card.innerHTML = `
    <div class="session-card-main">
      <p class="session-card-kicker">${escapeHtml(lifecycle)}</p>
      <h2 class="session-card-title">${escapeHtml(title)}</h2>
      <p class="session-card-meta">${escapeHtml(cardMeta(session, lifecycle))}</p>
    </div>
    <div class="session-card-actions">
      <button type="button" class="lv-mini-btn lv-mini-btn--primary" data-action="primary">${primaryLabel}</button>
      ${canOpenLiveStudio(session) ? `<button type="button" class="lv-mini-btn" data-action="preview">Preview</button>` : ""}
      <details class="session-card-menu">
        <summary>Manage</summary>
        <button type="button" data-menu="rename">Rename</button>
        <button type="button" data-menu="move">Move to…</button>
        <button type="button" data-menu="duplicate">Duplicate</button>
        <button type="button" data-menu="archive">Archive</button>
        <button type="button" data-menu="delete">Delete</button>
      </details>
    </div>
  `;
  card.querySelector('[data-action="primary"]').addEventListener("click", async () => {
    if (action === StudioHomeAction.VIEW_SESSION) {
      ctx.onView(session);
      return;
    }
    if (action === StudioHomeAction.USE_SESSION) {
      await duplicateFrom(session, overlay, ctx, { open: true });
      return;
    }
    if (isTerminalSession(session)) {
      ctx.onView(session);
      return;
    }
    ctx.onOpen(session);
  });
  card.querySelector('[data-action="preview"]')?.addEventListener("click", () => openPreviewTab(session));
  card.querySelector('[data-menu="rename"]').addEventListener("click", () => renameCard(session, overlay, ctx));
  card.querySelector('[data-menu="move"]').addEventListener("click", () => moveCard(session, overlay, ctx));
  card.querySelector('[data-menu="duplicate"]').addEventListener("click", () => duplicateFrom(session, overlay, ctx, { open: false }));
  card.querySelector('[data-menu="archive"]').addEventListener("click", () => archiveCard(session, overlay, ctx));
  card.querySelector('[data-menu="delete"]').addEventListener("click", () => deleteCard(session, overlay, ctx));
  return card;
}

function cardMeta(session, lifecycle) {
  if (lifecycle === "ENDED" || session.status === "ENDED") {
    return `Ended ${fmtRelative(session.endedAt)} · Created ${fmtDate(session.createdAt)}`;
  }
  const count = session.participantCount != null ? `${session.participantCount}/4 participants · ` : "";
  return `${count}Created ${fmtDate(session.createdAt)} · Active ${fmtRelative(session.lastActiveAt)}`;
}

function renameCard(session, overlay, ctx) {
  const nextTitle = window.prompt("Rename session", sessionDisplayTitle(session, overlay));
  if (nextTitle == null) return;
  const trimmed = String(nextTitle).trim();
  ctx.statusEl.textContent = "Renaming…";
  renameSession(session.id, trimmed)
    .then((updated) => {
      persistOverlay(renameHomeSession(overlay, session.id, updated?.title ?? trimmed), session.ownerUserId);
      ctx.statusEl.textContent = "";
      return ctx.onRefresh();
    })
    .catch((error) => {
      ctx.statusEl.textContent = `Couldn't rename: ${error.message}`;
    });
}

function moveCard(session, overlay, ctx) {
  const options = STUDIO_HOME_COLLECTIONS.map((item) => item.label).join("\n");
  const picked = window.prompt(`Move to collection:\n${options}`, "Shows");
  if (!picked) return;
  const match = STUDIO_HOME_COLLECTIONS.find((item) => item.label.toLowerCase() === picked.trim().toLowerCase() || item.id === picked.trim().toLowerCase());
  if (!match) {
    ctx.statusEl.textContent = "Unknown collection.";
    return;
  }
  persistOverlay(moveSessionToCollection(overlay, session.id, match.id), session.ownerUserId);
  ctx.onRefresh();
}

async function duplicateFrom(session, overlay, ctx, { open }) {
  ctx.statusEl.textContent = "Creating new session…";
  try {
    const created = await duplicateSession(session, overlay);
    ctx.statusEl.textContent = "";
    if (open && canOpenLiveStudio(created)) ctx.onOpen(created);
    else await ctx.onRefresh();
  } catch (error) {
    ctx.statusEl.textContent = `Couldn't duplicate: ${error.message}`;
  }
}

function archiveCard(session, overlay, ctx) {
  persistOverlay(moveSessionToCollection(overlay, session.id, StudioHomeCollectionId.ARCHIVE), session.ownerUserId);
  ctx.onRefresh();
}

function deleteCard(session, overlay, ctx) {
  const ok = window.confirm(
    `Delete “${sessionDisplayTitle(session, overlay)}”?\n\nThis permanently removes the session from the server. Recordings stored in this browser (IndexedDB) are not deleted automatically.\n\nContinue?`
  );
  if (!ok) return;
  ctx.statusEl.textContent = "Deleting…";
  deleteSession(session.id)
    .then(() => {
      persistOverlay(moveSessionToCollection(overlay, session.id, StudioHomeCollectionId.ARCHIVE), session.ownerUserId);
      ctx.statusEl.textContent = "";
      return ctx.onRefresh();
    })
    .catch((error) => {
      ctx.statusEl.textContent = `Couldn't delete: ${error.message}`;
    });
}

function placeholder(text) {
  const p = document.createElement("p");
  p.className = "session-gate-empty";
  p.textContent = text;
  return p;
}

function hideArtifacts() {
  const pane = el("sessionArtifacts");
  if (pane) pane.hidden = true;
}

export async function showSessionArtifacts(session) {
  const pane = el("sessionArtifacts");
  const gate = el("sessionGate");
  if (gate) {
    gate.hidden = true;
    document.body.classList.remove("session-gate-open");
  }
  if (!pane) return;
  document.body.classList.add("session-artifacts-open");
  pane.hidden = false;
  const body = el("sessionArtifactsBody");
  const title = el("sessionArtifactsTitle");
  if (title) title.textContent = session.title || "Session";
  if (body) body.textContent = "Loading artifacts…";
  const pack = await loadSessionArtifacts(session);
  if (!body) return;
  body.replaceChildren(...pack.sections.map(renderArtifactSection));
}

function renderArtifactSection(section) {
  const article = document.createElement("article");
  article.className = "session-artifact-section";
  const heading = document.createElement("h3");
  heading.textContent = section.title;
  article.append(heading);
  if (section.id === "recordings" && section.data?.blob) {
    const video = document.createElement("video");
    video.controls = true;
    video.src = URL.createObjectURL(section.data.blob);
    article.append(video);
    const meta = document.createElement("p");
    meta.textContent = `${section.data.mimeType} · ${Math.round((section.data.bytes || 0) / 1024)} KB · ${section.data.durationSeconds || "—"}s`;
    article.append(meta);
    return article;
  }
  const pre = document.createElement("pre");
  pre.className = "session-artifact-json";
  pre.textContent = summarizeArtifact(section);
  article.append(pre);
  return article;
}

function summarizeArtifact(section) {
  if (section.id === "metadata") {
    const d = section.data;
    return [`${d.title}`, `Status ${d.status}`, `Created ${d.createdAt || "—"}`, `Ended ${d.endedAt || "—"}`, d.brandId ? `Brand ${d.brandId}` : ""].filter(Boolean).join("\n");
  }
  if (section.id === "clips") {
    return (section.data.momentMarkers.length ? section.data.momentMarkers : section.data.markers)
      .slice(0, 12)
      .map((item) => `${item.label || item.reason || item.type} · ${item.offsetSeconds ?? item.timestamp ?? ""}`)
      .join("\n") || "No markers.";
  }
  if (section.id === "participants") {
    return section.data.map((item) => `${item.role || ""} ${item.displayName || item.participantId}`).join("\n");
  }
  if (section.id === "show-assets") {
    const lines = (section.data.assetsUsed || []).map((item) => item.title || item.sourceUrl || item.id);
    if (section.data.endCard) lines.push(`End card: ${section.data.endCard.headline || "saved"}`);
    return lines.join("\n") || "No retained assets.";
  }
  if (section.id === "run-of-show") {
    return section.data.productionActions.slice(0, 20).map((item) => `${item.type} @ ${item.offsetSeconds ?? ""}s`).join("\n");
  }
  return JSON.stringify(section.data, null, 2).slice(0, 1200);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
