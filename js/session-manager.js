// Toasty's durable LiveSession layer on the frontend — see scripts/toasty-auth-db.py's live_sessions
// table for the backend model this talks to. Two jobs:
//   1. resolveSession() — the gate director.js's init() awaits BEFORE ever calling
//      LiveSession.applyDurableSession/joinAsHost. Replaces the old "just call getOrCreateRoomId() and go"
//      boot, which silently created a brand-new disposable room on every single page load — that's exactly
//      the "dozens of abandoned rooms" problem. Resolves either from a `?session=<id>` URL param (a
//      bookmarked/reopened session — same id works on another Producer browser, since it's a durable
//      server row, not client state) or from the Producer picking/creating one in the gate UI.
//   2. copyGuestInviteUrl/copyListenerInviteUrl/openPreviewTab — the session-scoped actions the gate list
//      and (once in Studio) the rail both call, sharing one implementation so a link copied from either
//      place is byte-identical.
import { studioRequest } from "./studio-api.js";
import { brandLabel, groupSessions, isTransientFetchError } from "./session-library.js";
import { getGuestInviteUrl, getListenerInviteUrl, createDisposableRoomId } from "./video-engine.js";

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

// Preview Live Stream — see studio/listener.html/js/listener.js, the existing clean audience-facing
// Program Output page (no Producer/Host controls, no diagnostics — already built for exactly this "what
// will the audience see" job, just never wired to a durable session or exposed as a Producer action
// before now). Opens in a NEW tab, deliberately: it's a viewer of the running session, not a new one —
// see getListenerInviteUrl, the SAME url the Listener invite link uses.
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

export async function createSession({ title, brandId }) {
  const roomId = createDisposableRoomId();
  const result = await studioRequest("/api/sessions", {
    method: "POST",
    body: JSON.stringify({ roomId, title: title || "", brandId: brandId || "" })
  });
  return result.session;
}

async function fetchSessions() {
  // ONE list call. The previous gate fired GET ?status=active and GET ?status=ended in parallel,
  // both against nginx's toasty_render zone (6r/m, burst 8, CORS-less 503). Combined with
  // /auth/session on the same zone, that is exactly "Couldn't load sessions: Failed to fetch".
  const result = await studioRequest("/api/sessions", { method: "GET" });
  return result.sessions || [];
}

// The gate — resolves once, with the session director.js should apply. Shows #sessionGate (see
// studio/director.html) and hides it again the moment a session is chosen, so this never has to be
// re-shown mid-Studio; a Producer who wants to switch sessions uses "End Session" or navigates back to a
// fresh Studio load.
export function resolveSession({ brandId }) {
  return new Promise((resolve) => {
    const params = new URLSearchParams(window.location.search);
    const existingId = params.get("session");
    if (existingId) {
      resolveExisting(existingId, resolve, brandId);
      return;
    }
    showGate(resolve, brandId);
  });
}

async function resolveExisting(id, resolve, brandId) {
  try {
    const result = await studioRequest(`/api/sessions/${id}`, { method: "GET" });
    if (result.session && result.session.status !== "ENDED") {
      resolve(result.session);
      return;
    }
    log("session from URL is ended or missing, falling back to gate", id);
  } catch (error) {
    log("could not resolve session from URL, falling back to gate", error);
  }
  showGate(resolve, brandId);
}

function setUrlSession(id) {
  const url = new URL(window.location.href);
  url.searchParams.set("session", id);
  window.history.replaceState({}, "", url);
  // director.html runs inside #studioAppFrame (see js/studio-auth.js's openStudio) — a SEPARATE browsing
  // context from the top-level /studio/ page. replaceState above only updates THIS (the iframe's) address,
  // never the parent's — a real top-level browser refresh reloads /studio/ itself, which rebuilds the
  // iframe src from ITS OWN window.location.search, with no way to see what just happened inside the
  // iframe. Without this bridge, a refresh would silently drop back to the session gate and (if a
  // Producer clicked "+ New Session" instead of picking the one they'd been using) recreate a room —
  // exactly the bug this whole pass exists to fix. studio-auth.js listens for this and updates the
  // top-level URL the same way, so the NEXT full page load already has `?session=` when it reads
  // window.location.search to build the iframe src.
  if (window.parent !== window) {
    window.parent.postMessage({ type: "toasty:session-selected", sessionId: id }, window.location.origin);
  }
}

function el(id) { return document.getElementById(id); }

async function showGate(resolve, brandId) {
  const gate = el("sessionGate");
  if (!gate) {
    // No gate markup on this page (shouldn't happen in director.html) — fail open with a fresh session
    // rather than hang the Studio boot forever.
    resolve(await createSession({ title: "", brandId }));
    return;
  }
  gate.hidden = false;
  document.body.classList.add("session-gate-open");

  const statusEl = el("sessionGateStatus");
  const liveList = el("sessionGateLiveList") || el("sessionGateActiveList");
  const upcomingList = el("sessionGateUpcomingList");
  const recentList = el("sessionGateRecentList");
  const pastList = el("sessionGatePastList") || el("sessionGateEndedList");
  const titleInput = el("sessionGateTitle");
  const createBtn = el("sessionGateCreate");
  const brandSelect = el("sessionGateBrand");
  const sortSelect = el("sessionGateSort");
  if (brandSelect && brandId) brandSelect.value = brandId;

  function finish(session) {
    gate.hidden = true;
    document.body.classList.remove("session-gate-open");
    setUrlSession(session.id);
    resolve(session);
  }

  async function refresh() {
    if (statusEl) statusEl.textContent = "Loading sessions…";
    try {
      const sessions = await fetchSessions();
      if (statusEl) statusEl.textContent = "";
      const grouped = groupSessions(sortSessions(sessions, sortSelect?.value));
      const activeRow = (session) => renderActiveRow(session, finish, refresh, statusEl);
      if (upcomingList) {
        if (liveList) renderList(liveList, grouped.live, "No live sessions.", activeRow);
        renderList(upcomingList, grouped.upcoming, "No upcoming sessions.", activeRow);
      } else if (liveList) {
        renderList(liveList, [...grouped.live, ...grouped.upcoming], "No active sessions yet.", activeRow);
      }
      if (recentList) renderList(recentList, grouped.recent, "Nothing recent.", (session) => renderEndedRow(session, titleInput, refresh, statusEl));
      if (pastList) renderList(pastList, grouped.past, "No past sessions.", (session) => renderEndedRow(session, titleInput, refresh, statusEl));
    } catch (error) {
      const hint = isTransientFetchError(error)
        ? "Studio is rate-limited or unreachable. Waiting and retrying usually clears this."
        : error.message;
      if (statusEl) statusEl.textContent = `Couldn't load sessions: ${hint}`;
    }
  }

  if (sortSelect) sortSelect.onchange = () => refresh();

  if (createBtn) createBtn.onclick = async () => {
    createBtn.disabled = true;
    if (statusEl) statusEl.textContent = "Creating session…";
    try {
      const session = await createSession({
        title: titleInput.value.trim(),
        brandId: brandSelect?.value || brandId
      });
      finish(session);
    } catch (error) {
      if (statusEl) statusEl.textContent = `Couldn't create session: ${error.message}`;
      createBtn.disabled = false;
    }
  };

  await refresh();
}

function renderList(container, sessions, emptyText, renderRow) {
  if (!sessions.length) {
    container.replaceChildren(placeholder(emptyText));
    return;
  }
  container.replaceChildren(...sessions.map(renderRow));
}

function placeholder(text) {
  const p = document.createElement("p");
  p.className = "session-gate-empty";
  p.textContent = text;
  return p;
}

function sortSessions(sessions, sort) {
  const copy = [...sessions];
  if (sort === "title") {
    copy.sort((a, b) => String(a.title || "").localeCompare(String(b.title || "")));
  } else if (sort === "created") {
    copy.sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  } else {
    copy.sort((a, b) => Date.parse(b.lastActiveAt || b.createdAt || 0) - Date.parse(a.lastActiveAt || a.createdAt || 0));
  }
  return copy;
}

function statusLabel(session) {
  return session.status === "LIVE" ? "LIVE" : session.status === "OPEN" ? "Upcoming" : "Completed";
}

function renderActiveRow(session, finish, refresh, statusEl) {
  const row = document.createElement("div");
  row.className = "session-row";
  row.dataset.status = session.status;
  row.innerHTML = `
    <div class="session-row-main">
      <p class="session-row-kicker">${escapeHtml(brandLabel(session.brandId))} · ${statusLabel(session)}</p>
      <p class="session-row-title">${escapeHtml(session.title || "Untitled session")}</p>
      <p class="session-row-meta">${session.participantCount || 0}/4 connected · ${fmtDate(session.createdAt)} · Active ${fmtRelative(session.lastActiveAt)}</p>
    </div>
    <div class="session-row-actions">
      <button type="button" class="lv-mini-btn lv-mini-btn--primary" data-action="open">Produce</button>
      <button type="button" class="lv-mini-btn" data-action="preview">Program Output</button>
      <button type="button" class="lv-mini-btn" data-action="copy-guest">Guest invite</button>
      <button type="button" class="lv-mini-btn" data-action="copy-listener">Listener link</button>
      <button type="button" class="lv-mini-btn lv-mini-btn--danger" data-action="end">End</button>
    </div>
  `;
  row.querySelector('[data-action="open"]').addEventListener("click", () => finish(session));
  row.querySelector('[data-action="preview"]').addEventListener("click", () => openPreviewTab(session));
  row.querySelector('[data-action="copy-guest"]').addEventListener("click", async (event) => {
    const ok = await copyGuestInvite(session);
    event.target.textContent = ok ? "Copied!" : "Copy failed";
    setTimeout(() => { event.target.textContent = "Guest invite"; }, 1500);
  });
  row.querySelector('[data-action="copy-listener"]').addEventListener("click", async (event) => {
    const ok = await copyListenerInvite(session);
    event.target.textContent = ok ? "Copied!" : "Copy failed";
    setTimeout(() => { event.target.textContent = "Listener link"; }, 1500);
  });
  row.querySelector('[data-action="end"]').addEventListener("click", async () => {
    if (!window.confirm(`End "${session.title || "this session"}" for everyone?`)) return;
    statusEl.textContent = "Ending session…";
    try {
      await endSession(session.id);
      await refresh();
    } catch (error) {
      statusEl.textContent = `Couldn't end session: ${error.message}`;
    }
  });
  return row;
}

function renderEndedRow(session, titleInput, refresh, statusEl) {
  const row = document.createElement("div");
  row.className = "session-row session-row--ended";
  row.innerHTML = `
    <div class="session-row-main">
      <p class="session-row-kicker">${escapeHtml(brandLabel(session.brandId))} · Completed</p>
      <p class="session-row-title">${escapeHtml(session.title || "Untitled session")}</p>
      <p class="session-row-meta">Ended ${fmtRelative(session.endedAt)} · Created ${fmtDate(session.createdAt)}</p>
    </div>
    <div class="session-row-actions">
      <button type="button" class="lv-mini-btn" data-action="preview">Program Output</button>
      <button type="button" class="lv-mini-btn" data-action="duplicate">Duplicate</button>
    </div>
  `;
  row.querySelector('[data-action="preview"]')?.addEventListener("click", () => openPreviewTab(session));
  row.querySelector('[data-action="duplicate"]').addEventListener("click", async (event) => {
    event.target.disabled = true;
    statusEl.textContent = "Creating new session…";
    try {
      await createSession({ title: session.title, brandId: session.brandId });
      await refresh();
    } catch (error) {
      statusEl.textContent = `Couldn't create session: ${error.message}`;
      event.target.disabled = false;
    }
  });
  return row;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
