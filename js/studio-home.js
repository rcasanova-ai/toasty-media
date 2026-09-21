// Studio Home organization. Sessions still come from /api/sessions (OPEN / LIVE / ENDED).
// This module never mutates live-session plumbing, RoomPresence, or ProgramSync.
// User-specific collection assignment lives in localStorage so categories are not hard-coded in HTML
// and are not Ricardo's brands as a global taxonomy.

export const StudioLifecycle = Object.freeze({
  DRAFT: "DRAFT",
  SCHEDULED: "SCHEDULED",
  ACTIVE: "ACTIVE",
  ENDED: "ENDED",
  ARCHIVED: "ARCHIVED"
});

export const StudioHomeCollectionId = Object.freeze({
  SHOWS: "shows",
  FOCUS_GROUPS: "focus-groups",
  MEETINGS: "meetings",
  TEMPLATES: "templates",
  ARCHIVE: "archive"
});

export const STUDIO_HOME_COLLECTIONS = Object.freeze([
  { id: StudioHomeCollectionId.SHOWS, label: "Shows", hideEmptyDefault: false },
  { id: StudioHomeCollectionId.FOCUS_GROUPS, label: "Focus Groups", hideEmptyDefault: false },
  { id: StudioHomeCollectionId.MEETINGS, label: "Meetings / Panels", hideEmptyDefault: false },
  { id: StudioHomeCollectionId.TEMPLATES, label: "Templates", hideEmptyDefault: false },
  { id: StudioHomeCollectionId.ARCHIVE, label: "Archive", hideEmptyDefault: true }
]);

export const StudioHomeAction = Object.freeze({
  OPEN_STUDIO: "open-studio",
  VIEW_SESSION: "view-session",
  USE_SESSION: "use-session"
});

const STORAGE_PREFIX = "toastyStudioHome:v1:";

export function homeStorageKey(ownerUserId = "local") {
  return `${STORAGE_PREFIX}${ownerUserId || "local"}`;
}

export function emptyHomeOverlay() {
  return {
    version: 1,
    titles: {},
    collectionBySession: {},
    archived: {},
    templates: {},
    scheduledAt: {},
    collapsed: {},
    hideEmpty: { [StudioHomeCollectionId.ARCHIVE]: true },
    collectionOrder: STUDIO_HOME_COLLECTIONS.map((item) => item.id),
    collectionLabels: {},
    customCollections: []
  };
}

export function loadHomeOverlay(ownerUserId, storage = globalThis.localStorage) {
  const fallback = emptyHomeOverlay();
  try {
    const raw = storage?.getItem?.(homeStorageKey(ownerUserId));
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      ...fallback,
      ...parsed,
      titles: parsed.titles && typeof parsed.titles === "object" ? parsed.titles : {},
      collectionBySession: parsed.collectionBySession && typeof parsed.collectionBySession === "object" ? parsed.collectionBySession : {},
      archived: parsed.archived && typeof parsed.archived === "object" ? parsed.archived : {},
      templates: parsed.templates && typeof parsed.templates === "object" ? parsed.templates : {},
      scheduledAt: parsed.scheduledAt && typeof parsed.scheduledAt === "object" ? parsed.scheduledAt : {},
      collapsed: parsed.collapsed && typeof parsed.collapsed === "object" ? parsed.collapsed : {},
      hideEmpty: { ...fallback.hideEmpty, ...(parsed.hideEmpty || {}) },
      collectionOrder: Array.isArray(parsed.collectionOrder) && parsed.collectionOrder.length
        ? parsed.collectionOrder
        : fallback.collectionOrder,
      collectionLabels: parsed.collectionLabels && typeof parsed.collectionLabels === "object" ? parsed.collectionLabels : {},
      customCollections: Array.isArray(parsed.customCollections) ? parsed.customCollections : []
    };
  } catch (_) {
    return fallback;
  }
}

export function saveHomeOverlay(ownerUserId, overlay, storage = globalThis.localStorage) {
  try {
    storage?.setItem?.(homeStorageKey(ownerUserId), JSON.stringify(overlay));
  } catch (_) {}
  return overlay;
}

export function isTerminalSession(session) {
  return String(session?.status || "").toUpperCase() === "ENDED";
}

export function sessionDisplayTitle(session, overlay = emptyHomeOverlay()) {
  const overlayTitle = overlay.titles?.[session?.id];
  if (overlayTitle) return overlayTitle;
  return String(session?.title || "").trim() || "Untitled session";
}

export function mapSessionLifecycle(session, overlay = emptyHomeOverlay(), now = Date.now()) {
  const id = session?.id;
  if (!id) return StudioLifecycle.DRAFT;
  if (overlay.archived?.[id] || overlay.collectionBySession?.[id] === StudioHomeCollectionId.ARCHIVE) {
    return StudioLifecycle.ARCHIVED;
  }
  if (isTerminalSession(session)) return StudioLifecycle.ENDED;
  const scheduled = overlay.scheduledAt?.[id];
  if (scheduled && new Date(scheduled).getTime() > now) return StudioLifecycle.SCHEDULED;
  const status = String(session.status || "").toUpperCase();
  if (status === "LIVE") return StudioLifecycle.ACTIVE;
  if (status === "OPEN" && !session.startedAt) return StudioLifecycle.DRAFT;
  if (status === "OPEN") return StudioLifecycle.ACTIVE;
  return StudioLifecycle.DRAFT;
}

export function primaryHomeAction(session, overlay = emptyHomeOverlay(), now = Date.now()) {
  if (overlay.templates?.[session?.id] || overlay.collectionBySession?.[session?.id] === StudioHomeCollectionId.TEMPLATES) {
    return StudioHomeAction.USE_SESSION;
  }
  const life = mapSessionLifecycle(session, overlay, now);
  if (life === StudioLifecycle.ENDED || (life === StudioLifecycle.ARCHIVED && isTerminalSession(session))) {
    return StudioHomeAction.VIEW_SESSION;
  }
  if (isTerminalSession(session)) return StudioHomeAction.VIEW_SESSION;
  return StudioHomeAction.OPEN_STUDIO;
}

export function canOpenLiveStudio(session) {
  return Boolean(session?.id) && !isTerminalSession(session);
}

export function duplicateSessionConfig(session, overlay = emptyHomeOverlay()) {
  return {
    title: `Copy of ${sessionDisplayTitle(session, overlay)}`,
    brandId: session?.brandId || "",
    sourceSessionId: session?.id || null,
    copiesHistory: false
  };
}

export function assignedCollectionId(session, overlay = emptyHomeOverlay()) {
  const id = session?.id;
  if (overlay.archived?.[id]) return StudioHomeCollectionId.ARCHIVE;
  if (overlay.templates?.[id]) return StudioHomeCollectionId.TEMPLATES;
  const assigned = overlay.collectionBySession?.[id];
  if (assigned) return assigned;
  return StudioHomeCollectionId.SHOWS;
}

export function listHomeCollections(overlay = emptyHomeOverlay()) {
  const labels = overlay.collectionLabels || {};
  const custom = overlay.customCollections || [];
  const byId = new Map([
    ...STUDIO_HOME_COLLECTIONS.map((item) => [item.id, { ...item, label: labels[item.id] || item.label }]),
    ...custom.map((item) => [item.id, { id: item.id, label: labels[item.id] || item.label || "Untitled", hideEmptyDefault: false }])
  ]);
  const order = overlay.collectionOrder?.length ? overlay.collectionOrder : [...byId.keys()];
  const seen = new Set();
  const list = [];
  for (const id of order) {
    if (!byId.has(id) || seen.has(id)) continue;
    seen.add(id);
    list.push(byId.get(id));
  }
  byId.forEach((item, id) => {
    if (!seen.has(id)) list.push(item);
  });
  return list;
}

export function moveSessionToCollection(overlay, sessionId, collectionId) {
  const next = { ...overlay, collectionBySession: { ...overlay.collectionBySession }, archived: { ...overlay.archived }, templates: { ...overlay.templates } };
  next.collectionBySession[sessionId] = collectionId;
  if (collectionId === StudioHomeCollectionId.ARCHIVE) next.archived[sessionId] = true;
  else delete next.archived[sessionId];
  if (collectionId === StudioHomeCollectionId.TEMPLATES) next.templates[sessionId] = true;
  else delete next.templates[sessionId];
  return next;
}

export function renameHomeSession(overlay, sessionId, title) {
  const next = { ...overlay, titles: { ...overlay.titles } };
  const trimmed = String(title || "").trim();
  if (trimmed) next.titles[sessionId] = trimmed.slice(0, 160);
  else delete next.titles[sessionId];
  return next;
}

export function createHomeCollection(overlay, { id, label } = {}) {
  const collectionId = id || `col-${Date.now().toString(36)}`;
  const next = {
    ...overlay,
    customCollections: [...(overlay.customCollections || []), { id: collectionId, label: String(label || "Untitled").slice(0, 80) }],
    collectionOrder: [...listHomeCollections(overlay).map((item) => item.id), collectionId]
  };
  return { overlay: next, id: collectionId };
}

export function renameHomeCollection(overlay, collectionId, label) {
  return {
    ...overlay,
    collectionLabels: { ...overlay.collectionLabels, [collectionId]: String(label || "").trim().slice(0, 80) }
  };
}

export function reorderHomeCollections(overlay, orderedIds) {
  return { ...overlay, collectionOrder: [...orderedIds] };
}

export function setCollectionCollapsed(overlay, collectionId, collapsed) {
  return { ...overlay, collapsed: { ...overlay.collapsed, [collectionId]: Boolean(collapsed) } };
}

export function setCollectionHideEmpty(overlay, collectionId, hideEmpty) {
  return { ...overlay, hideEmpty: { ...overlay.hideEmpty, [collectionId]: Boolean(hideEmpty) } };
}

function byLastActive(a, b) {
  return new Date(b.lastActiveAt || b.createdAt || 0).getTime() - new Date(a.lastActiveAt || a.createdAt || 0).getTime();
}

export function organizeStudioHome(sessions = [], overlay = emptyHomeOverlay(), now = Date.now()) {
  const items = (sessions || []).map((session) => {
    const lifecycle = mapSessionLifecycle(session, overlay, now);
    return {
      session,
      lifecycle,
      title: sessionDisplayTitle(session, overlay),
      collectionId: assignedCollectionId(session, overlay),
      action: primaryHomeAction(session, overlay, now),
      canOpenLive: canOpenLiveStudio(session)
    };
  });

  const active = items
    .filter((item) => (item.lifecycle === StudioLifecycle.ACTIVE || item.lifecycle === StudioLifecycle.DRAFT) && item.session.status !== "ENDED")
    .sort((a, b) => byLastActive(a.session, b.session));

  const upcoming = items
    .filter((item) => item.lifecycle === StudioLifecycle.SCHEDULED)
    .sort((a, b) => new Date(overlay.scheduledAt[a.session.id]) - new Date(overlay.scheduledAt[b.session.id]));

  const recent = items
    .filter((item) => item.lifecycle !== StudioLifecycle.ARCHIVED)
    .sort((a, b) => byLastActive(a.session, b.session))
    .slice(0, 8);

  const collections = listHomeCollections(overlay).map((collection) => {
    const collectionItems = items.filter((item) => item.collectionId === collection.id);
    const hideEmpty = overlay.hideEmpty?.[collection.id] ?? collection.hideEmptyDefault;
    return {
      ...collection,
      items: collectionItems,
      collapsed: Boolean(overlay.collapsed?.[collection.id]),
      hideEmpty: Boolean(hideEmpty),
      hidden: Boolean(hideEmpty) && collectionItems.length === 0
    };
  });

  return { active, upcoming, recent, collections, items };
}
