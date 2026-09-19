// No ?v= cache-busting suffix on these imports on purpose: the root .htaccess forces
// Cache-Control: no-cache on every first-party .js/.css, so a deploy is always visible on next
// load without anyone remembering to bump a version string per file. See .htaccess.
import { normalizeBrandTheme } from "./brand-themes.js";
import { AIProductionController } from "./ai-production.js";
import { ToastyBroadcastController } from "./broadcast-client.js";
import { LiveSession } from "./live-session.js";
import { HostView } from "./host-view.js";
import { ProducerView } from "./producer-view.js";
import { HostPrejoin } from "./host-prejoin.js";
import { HostState } from "./host-state.js";
import { BUILD_ID } from "./build-info.js";
import { resolveSession } from "./session-manager.js";

// Set by js/studio-auth.js's openStudio when /auth/session reports a "locked" account (a brand-locked
// customer like Moe @ Superteam Thailand) — a UX nicety only (hides the selector, blocks the local optimistic
// update below), never the security boundary: handleSessionCreate/handleSessionBrand
// (render-production-server.mjs) enforce the lock server-side regardless of whether this flag is even
// present, so a tampered URL still can't actually create or change a session to another brand.
const isBrandLocked = new URLSearchParams(window.location.search).get("brandLocked") === "1";

// hidden attribute + inline style — see isBrandLocked's own call sites for why the attribute alone isn't
// enough here (an existing class-level `display` rule beats it).
function hideElement(el) {
  if (!el) return;
  el.hidden = true;
  el.style.display = "none";
}

const session = new LiveSession();
// Dev diagnostics only — never rendered in Host/Producer UI. In devtools: session.aiProducerService.diagnostics()
// for the speech-complete -> result-rendered latency breakdown of recent AI Producer requests.
window.__toastyLiveSession = session;

const elements = {
  liveConsole: document.querySelector("#liveConsole"),
  viewButtons: [...document.querySelectorAll("[data-lv-view-btn]")],
  hostFrame: document.querySelector("#lvHostFrame"),
  hostTransportFrame: document.querySelector("#lvHostTransportFrame"),
  guestFrame: document.querySelector("#lvGuestFrame"),
  programPreviewStage: document.querySelector("#lvProgramPreviewStage"),
  directorControlFrame: document.querySelector("#directorControlFrame"),
  recChip: document.querySelector("#lvRecChip"),
  recChipTime: document.querySelector("#lvRecChipTime"),
  policyChip: document.querySelector("#lvPolicyChip"),
  sessionDate: document.querySelector("#sessionDate"),
  sessionTime: document.querySelector("#sessionTime"),
  buildId: document.querySelector("#buildId"),
  connectionState: document.querySelector("#connectionState"),
  connectionChip: document.querySelector("#connectionChip"),
  guestInvite: document.querySelector("#guestInvite"),
  listenerInvite: document.querySelector("#listenerInvite"),
  inviteGuestBtn: document.querySelector("#inviteGuestBtn"),
  copyInvite: document.querySelector("#copyInvite"),
  copyListenerInvite: document.querySelector("#copyListenerInvite"),
  brandThemeSelect: document.querySelector("#brandThemeSelect"),
  studioBrandLink: document.querySelector("#studioBrandLink"),
  studioBrandLogo: document.querySelector("#studioBrandLogo"),
  studioBrandText: document.querySelector("#studioBrandText"),
  poweredBy: document.querySelector("#poweredBy"),
  atmosphereBrandWord: document.querySelector("#atmosphereBrandWord"),
  atmosphereProductWord: document.querySelector("#atmosphereProductWord"),
  atmosphereMark: document.querySelector(".atmosphere-mark"),
  switchSession: document.querySelector("#switchSession"),
  endSessionBtn: document.querySelector("#endSessionBtn"),
  toggleScreenQuick: document.querySelector("#toggleScreenQuick"),
  lvSessionType: document.querySelector("#lvSessionType"),
  lvJamPolicyFields: document.querySelector("#lvJamPolicyFields"),
  lvJamPrivacy: document.querySelector("#lvJamPrivacy"),
  lvJamCapturePolicy: document.querySelector("#lvJamCapturePolicy"),
  lvJamAiAllowed: document.querySelector("#lvJamAiAllowed"),
  lvJamRecordAllowed: document.querySelector("#lvJamRecordAllowed"),
  lvForceHeuristicMode: document.querySelector("#lvForceHeuristicMode"),
  lvHostRelationship: document.querySelector("#lvHostRelationship"),
  lvShowTone: document.querySelector("#lvShowTone"),
  lvProducerAutonomy: document.querySelector("#lvProducerAutonomy")
};

init();

// Session resolution (see js/session-manager.js's resolveSession) gates EVERYTHING below it — no VDO
// frame mounts, no camera prompt, nothing — until a durable session is actually chosen. Replaces the old
// synchronous init() that called getOrCreateRoomId() unconditionally on every load, which is exactly what
// silently created a fresh disposable room each time. applyDurableSession sets session.roomId to the
// resolved session's real roomId BEFORE session.start() ever runs, so mountDirectorFrame/presence/etc. all
// target the right room from the very first frame mount, not a throwaway one that gets swapped out later.
async function init() {
  applySelectedBrand();
  const durableSession = await resolveSession({ brandId: session.brandTheme });
  session.applyDurableSession(durableSession);
  initStudio();
}

function initStudio() {
  session.start({
    host: elements.hostFrame,
    hostTransport: elements.hostTransportFrame,
    roomPreview: elements.guestFrame,
    control: elements.directorControlFrame,
    programPreview: elements.programPreviewStage
  });

  new HostView({ session }).init();
  new ProducerView({ session }).init();
  const hostPrejoin = new HostPrejoin({ session });
  hostPrejoin.init();
  // The one place LEAVING is ever emitted is LiveSession.leaveStudio() — see js/host-state.js — so this
  // can't double-fire against startPreview()'s own routine PREJOIN_LOADING transitions (device changes,
  // first load) and trigger a second, redundant getUserMedia call.
  session.on("host-state", (state) => { if (state === HostState.LEAVING) hostPrejoin.resume(); });

  new AIProductionController({
    getBrandTheme: () => session.brandTheme,
    onBrandChange: (brandTheme) => {
      // Same lock this file's own selector respects — Hottie can't do via voice what the hidden dropdown
      // can't do via click. Backend enforces this regardless either way (see isBrandLocked's own comment).
      if (isBrandLocked && normalizeBrandTheme(brandTheme) !== session.brandTheme) return;
      elements.brandThemeSelect.value = normalizeBrandTheme(brandTheme);
      session.changeBrandTheme(brandTheme);
    }
  }).init();

  // Mounted before bindViewSwitch()'s initial setView("host") call, so its Producer-only broadcast
  // panel (data-lv-only="producer") exists in the DOM the first time [data-lv-only] elements are queried.
  new ToastyBroadcastController({
    getProgramUrl: () => elements.listenerInvite.value,
    requireLegacyAuthGate: false,
    onStateChange: (broadcastState) => session.setLive(broadcastState === "live"),
    onError: () => renderBroadcastError()
  }).init();

  bindViewSwitch();
  bindRailControls();
  bindPolicyDrawer();
  bindAiProviderDrawer();
  bindPersonaDrawer();

  session.on("recording", renderRecChip);
  session.on("policy", renderPolicyChip);
  session.on("connection", renderBroadcastChip);
  session.on("program", renderBroadcastChip);
  session.on("brand", () => { applySelectedBrand(); updateInviteFields(); });
  session.on("room", updateInviteFields);

  renderRecChip(session.recording);
  renderPolicyChip(session.policy);
  renderBroadcastChip();
  updateInviteFields();
  mountTimeOfDay();
  void startHostDebugMedia();
}

async function startHostDebugMedia() {
  const debugMedia = new URLSearchParams(window.location.search).get("debugMedia") === "1";
  if (!debugMedia) return;
  try {
    const { startMediaDiagnostics } = await import("./media-diagnostics.js");
    startMediaDiagnostics(() => {
      try {
        return { buildId: BUILD_ID, ...session.diagnosticsSnapshot() };
      } catch (err) {
        console.error("[Director] debugMedia snapshot failed", err);
        return { role: "host", error: String(err?.message || err) };
      }
    });
  } catch (err) {
    console.error("[Director] debugMedia failed open; studio continues", err);
  }
}

function bindViewSwitch() {
  elements.viewButtons.forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.lvViewBtn));
  });
  setView("host");
}

function setView(view) {
  elements.liveConsole.dataset.lvView = view;
  elements.viewButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.lvViewBtn === view)));
  // Queried live (not cached at init time) so panels mounted later by other controllers — e.g. the
  // Producer-only broadcast card injected into .rail-right — are still gated correctly.
  document.querySelectorAll("[data-lv-only]").forEach((panel) => { panel.hidden = panel.dataset.lvOnly !== view; });
}

function bindRailControls() {
  elements.inviteGuestBtn.addEventListener("click", inviteGuest);
  elements.copyInvite.addEventListener("click", copyInvite);
  elements.copyListenerInvite.addEventListener("click", copyListenerInvite);
  if (isBrandLocked) {
    // hidden, not removed: ai-production.js's own #aiBrandProfile selector (below) is queried and used
    // directly with no null-guard (addEventListener/replaceChildren/.value= all assume it exists) — that
    // module is Hottie's, not touched here, so this can't risk removing an element it depends on.
    // Both the hidden ATTRIBUTE and an explicit inline style: css/studio.css's own .brand-switcher rule
    // sets display:grid directly on this class, which beats the [hidden] UA-stylesheet rule the attribute
    // alone relies on (author CSS always wins over UA styles at equal specificity, and a class selector's
    // specificity ties an attribute selector's anyway) — confirmed live, the attribute was set correctly
    // but the dropdown still rendered. An inline style always wins over any external stylesheet rule short
    // of !important, closing that gap without touching studio.css's own existing rule at all.
    hideElement(elements.brandThemeSelect.closest(".brand-switcher"));
    // ai-production.js's OWN brand selector (#aiBrandProfile) — a second, independent selector element
    // that populateBrandThemeSelect (brand-themes.js) also fills in, routed through the SAME onBrandChange
    // callback below. Hidden here rather than inside ai-production.js itself since isBrandLocked is this
    // file's own concept, not something that module needs to know about beyond the callback it's already
    // given.
    hideElement(document.querySelector("#aiBrandProfile")?.closest(".ai-brand-control"));
  } else {
    elements.brandThemeSelect.addEventListener("change", () => session.changeBrandTheme(elements.brandThemeSelect.value));
  }
  // Full page reload, deliberately — the simplest reliable teardown of camera/VDO state before showing
  // the Session gate again, rather than trying to hand-roll an equivalent in-JS teardown. Drops the
  // `?session=` param so resolveSession() shows the gate instead of re-resolving the same session.
  elements.switchSession.addEventListener("click", () => {
    const url = new URL(window.location.href);
    url.searchParams.delete("session");
    window.location.href = url.toString();
  });
  elements.endSessionBtn.addEventListener("click", async () => {
    if (!session.durableSession) {
      window.alert("This room has no durable session record (it predates Session Manager) — nothing to end here.");
      return;
    }
    if (!window.confirm(`End "${session.durableSession.title || "this session"}" for everyone?`)) return;
    elements.endSessionBtn.disabled = true;
    await session.endDurableSession();
    elements.endSessionBtn.disabled = false;
  });
  elements.toggleScreenQuick?.addEventListener("click", () => session.toggleScreenShare());
  session.on("screenshare", (s) => {
    if (elements.toggleScreenQuick) elements.toggleScreenQuick.setAttribute("aria-pressed", String(Boolean(s?.active)));
  });
}

function bindPolicyDrawer() {
  elements.lvSessionType.addEventListener("change", () => {
    session.setSessionType(elements.lvSessionType.value);
    elements.lvJamPolicyFields.hidden = elements.lvSessionType.value !== "jam";
    syncJamFieldsFromPolicy();
  });
  [elements.lvJamPrivacy, elements.lvJamCapturePolicy].forEach((select) => {
    select.addEventListener("change", () => session.setPolicy({
      privacy: elements.lvJamPrivacy.value,
      capturePolicy: elements.lvJamCapturePolicy.value
    }));
  });
  [elements.lvJamAiAllowed, elements.lvJamRecordAllowed].forEach((checkbox) => {
    checkbox.addEventListener("change", () => session.setPolicy({
      aiProcessingAllowed: elements.lvJamAiAllowed.checked,
      jamRecordAllowed: elements.lvJamRecordAllowed.checked
    }));
  });
  session.on("policy", syncJamFieldsFromPolicy);
}

function bindAiProviderDrawer() {
  elements.lvForceHeuristicMode.checked = !session.aiUseBackend;
  elements.lvForceHeuristicMode.addEventListener("change", () => {
    session.setAiUseBackend(!elements.lvForceHeuristicMode.checked);
  });
}

// Producer Persona controls (see js/producer-persona.js) — pure Toasty configuration, live-adjustable.
// Switching relationship/tone/autonomy here changes what system prompt the NEXT AI Producer request
// gets; nothing in this file knows or cares which provider ends up answering it.
function bindPersonaDrawer() {
  elements.lvHostRelationship.value = session.hostRelationship;
  elements.lvShowTone.value = session.showTone;
  elements.lvProducerAutonomy.value = session.producerAutonomy;
  elements.lvHostRelationship.addEventListener("change", () => session.setHostRelationship(elements.lvHostRelationship.value));
  elements.lvShowTone.addEventListener("change", () => session.setShowTone(elements.lvShowTone.value));
  elements.lvProducerAutonomy.addEventListener("change", () => session.setProducerAutonomy(elements.lvProducerAutonomy.value));
}

function syncJamFieldsFromPolicy() {
  const state = session.policy.state;
  elements.lvJamPrivacy.value = state.privacy || "confidential";
  elements.lvJamCapturePolicy.value = state.capturePolicy;
  elements.lvJamAiAllowed.checked = Boolean(state.aiProcessingAllowed);
  elements.lvJamRecordAllowed.checked = Boolean(state.jamRecordAllowed);
}

function renderRecChip(recording) {
  elements.recChip.hidden = !recording.active;
  if (recording.active && recording.startedAt) {
    const elapsed = Math.floor((Date.now() - recording.startedAt) / 1000);
    const hours = String(Math.floor(elapsed / 3600)).padStart(2, "0");
    const minutes = String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0");
    const seconds = String(elapsed % 60).padStart(2, "0");
    elements.recChipTime.textContent = `${hours}:${minutes}:${seconds}`;
  }
}

function renderPolicyChip(policy) {
  const summary = policy.summary();
  elements.policyChip.hidden = !summary;
  if (summary) elements.policyChip.textContent = `${summary.icon} ${summary.label} · ${summary.detail}`;
}

// Real broadcast state, not a VDO.Ninja room-connection ping: session.connection tracks whether the
// Studio room itself is up (distinguishes OFFLINE from READY); session.program.live is the actual RTMP
// broadcast flag set by ToastyBroadcastController via session.setLive() (distinguishes READY from ON
// AIR). ERROR is set directly by the broadcast controller's onError callback and persists until the
// next real connection/program change overwrites it — see broadcast-client.js's start()/testService().
function renderBroadcastChip() {
  const state = session.program.live ? "live" : session.connection.status === "connected" ? "ready" : "offline";
  const label = state === "live" ? "On air" : state === "ready" ? "Ready" : session.connection.label;
  setBroadcastChip(state, label);
}

function renderBroadcastError() {
  setBroadcastChip("error", "Broadcast error");
}

function setBroadcastChip(state, label) {
  elements.connectionChip.dataset.state = state;
  elements.connectionState.textContent = label;
  const textEl = elements.connectionChip.querySelector(".on-air-text");
  if (textEl) textEl.textContent = state === "live" ? "ON AIR" : state === "ready" ? "READY" : state === "error" ? "ERROR" : "OFFLINE";
}

async function inviteGuest() {
  const url = elements.guestInvite.value;
  if (navigator.share) {
    try {
      await navigator.share({ title: `Join ${session.brandTheme === "toasty" ? "Toasty Studio" : elements.studioBrandLogo.alt}`, url });
      return;
    } catch (error) {
      if (error?.name === "AbortError") return;
    }
  }
  await copyInvite();
}

async function copyInvite() {
  await navigator.clipboard.writeText(elements.guestInvite.value);
  setLabel(elements.copyInvite, "Copied");
  window.setTimeout(() => setLabel(elements.copyInvite, "Copy Link"), 1400);
}

async function copyListenerInvite() {
  await navigator.clipboard.writeText(elements.listenerInvite.value);
  setLabel(elements.copyListenerInvite, "Copied");
  window.setTimeout(() => setLabel(elements.copyListenerInvite, "Copy Listener Link"), 1400);
}

function setLabel(button, text) {
  const label = button.querySelector(".btn-label");
  if (label) label.textContent = text;
  else button.textContent = text;
}

function updateInviteFields() {
  const urls = session.inviteUrls();
  elements.guestInvite.value = urls.guest;
  elements.listenerInvite.value = urls.listener;
}

function applySelectedBrand() {
  elements.brandThemeSelect.value = session.brandTheme;
  session.applyBrand({
    root: document.body,
    logoImg: elements.studioBrandLogo,
    logoText: elements.studioBrandText,
    brandLink: elements.studioBrandLink,
    poweredBy: elements.poweredBy,
    atmosphereBrandWord: elements.atmosphereBrandWord,
    atmosphereProductWord: elements.atmosphereProductWord,
    atmosphereMark: elements.atmosphereMark
  });
}

function mountTimeOfDay() {
  const now = new Date();
  elements.sessionDate.textContent = now.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  elements.sessionTime.textContent = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (elements.buildId) elements.buildId.textContent = BUILD_ID;
}
