// No ?v= cache-busting suffix on these imports on purpose: the root .htaccess forces
// Cache-Control: no-cache on every first-party .js/.css, so a deploy is always visible on next
// load without anyone remembering to bump a version string per file. See .htaccess.
import { composeDynamicTheme, normalizeBrandTheme, populateBrandThemeSelect, registerDynamicTheme } from "./brand-themes.js";
import { AIProductionController } from "./ai-production.js";
import { GoLivePanel } from "./go-live-panel.js";
import { LiveSession } from "./live-session.js";
import { HostView } from "./host-view.js";
import { ProducerView } from "./producer-view.js";
import { HostPrejoin } from "./host-prejoin.js";
import { HostState } from "./host-state.js";
import { BUILD_ID } from "./build-info.js";
import { resolveSession, showSessionArtifacts } from "./session-manager.js";

// Set by js/studio-auth.js's openStudio when /auth/session reports a "locked" account (a brand-locked
// customer like Moe @ Superteam Thailand) — a UX nicety only (hides the selector, blocks the local optimistic
// update below), never the security boundary: handleSessionCreate/handleSessionBrand
// (render-production-server.mjs) enforce the lock server-side regardless of whether this flag is even
// present, so a tampered URL still can't actually create or change a session to another brand.
const studioQuery = new URLSearchParams(window.location.search);
const isBrandLocked = studioQuery.get("brandLocked") === "1";
const isPlatformAdmin = studioQuery.get("platformAdmin") === "1";

// hidden attribute + inline style — see isBrandLocked's own call sites for why the attribute alone isn't
// enough here (an existing class-level `display` rule beats it).
function hideElement(el) {
  if (!el) return;
  el.hidden = true;
  el.style.display = "none";
}

const session = new LiveSession();
let goLivePanel = null;
// Dev diagnostics only — never rendered in Host/Producer UI. In devtools: session.aiProducerService.diagnostics()
// for the speech-complete -> result-rendered latency breakdown of recent AI Producer requests.
window.__toastyLiveSession = session;

const elements = {
  liveConsole: document.querySelector("#liveConsole"),
  viewButtons: [...document.querySelectorAll("[data-lv-view-btn]")],
  hostFrame: document.querySelector("#lvHostFrame"),
  hostTransportFrame: document.querySelector("#lvHostTransportFrame"),
  hostScreenTransportFrame: document.querySelector("#lvHostScreenTransport"),
  guestFrame: document.querySelector("#lvGuestFrame"),
  programPreviewStage: document.querySelector("#lvProgramPreviewStage"),
  directorControlFrame: document.querySelector("#directorControlFrame"),
  policyChip: document.querySelector("#lvPolicyChip"),
  topBrand: document.querySelector("#lvTopBrand"),
  topSessionName: document.querySelector("#lvTopSessionName"),
  topLiveState: document.querySelector("#lvTopLiveState"),
  topDestinations: document.querySelector("#lvTopDestinations"),
  topRecordingState: document.querySelector("#lvTopRecordingState"),
  topHealth: document.querySelector("#lvTopHealth"),
  topHost: document.querySelector("#lvTopHost"),
  topProducer: document.querySelector("#lvTopProducer"),
  topRecord: document.querySelector("#lvTopRecord"),
  topShareScreen: document.querySelector("#lvTopShareScreen"),
  bottomGoLive: document.querySelector("#lvBottomGoLive"),
  bottomMode: document.querySelector("#lvBottomMode"),
  topGoLive: document.querySelector("#lvTopGoLive"),
  topProgramOutput: document.querySelector("#lvTopProgramOutput"),
  topSettings: document.querySelector("#lvTopSettings"),
  topEndSession: document.querySelector("#lvTopEndSession"),
  topMore: document.querySelector("#lvTopMore"),
  topMoreMenu: document.querySelector("#lvTopMoreMenu"),
  bottomNavButtons: [...document.querySelectorAll("[data-producer-jump]")],
  producerWorkspaceButtons: [...document.querySelectorAll("[data-producer-workspace]")],
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
  sessionArtifactsHome: document.querySelector("#sessionArtifactsHome"),
  toggleScreenQuick: document.querySelector("#toggleScreenQuick"),
  openSettingsQuick: document.querySelector("#openSettingsQuick"),
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

// Bound unconditionally (not inside bindRailControls/initStudio, which artifacts mode never reaches) —
// same full-reload-drop-?session= recovery as elements.switchSession below, so "Back to Studio Home" from
// a read-only artifacts view works whether or not a live session was ever started this load.
elements.sessionArtifactsHome?.addEventListener("click", () => {
  const url = new URL(window.location.href);
  url.searchParams.delete("session");
  window.location.href = url.toString();
});

// PHASE C reconciliation fix: init() used to be a fire-and-forget top-level call with no .catch() and no
// app-wide unhandledrejection/window.onerror net anywhere in Studio. Since resolveSession() itself never
// rejects (see session-manager.js), the only realistic way to LAND here is a throw somewhere AFTER
// resolution succeeds (showSessionArtifacts, applyDurableSession, loadProfileEndCard, or any controller
// initStudio() constructs) — by which point the entry curtain has already been dismissed by the iframe
// load event, leaving a half-rendered shell with no visible error and no way to recover but reloading
// blind. renderFatalInitError() gives that failure an explicit, logged, retryable state instead of a
// silent one — deliberately narrow (this ONE promise only), not a global trap that would swallow
// unrelated runtime errors or risk looping.
init().catch((error) => {
  console.error("[Toasty Studio] Fatal init() failure", error);
  renderFatalInitError(error);
});

// Session resolution (see js/session-manager.js's resolveSession) gates EVERYTHING below it — no VDO
// frame mounts, no camera prompt, nothing — until a durable session is actually chosen. Replaces the old
// synchronous init() that called getOrCreateRoomId() unconditionally on every load, which is exactly what
// silently created a fresh disposable room each time. applyDurableSession sets session.roomId to the
// resolved session's real roomId BEFORE session.start() ever runs, so mountDirectorFrame/presence/etc. all
// target the right room from the very first frame mount, not a throwaway one that gets swapped out later.
async function init() {
  if (isPlatformAdmin) await loadPlatformBrandCatalog();
  await applySelectedBrand();
  const resolved = await resolveSession({ brandId: session.brandTheme });
  const durableSession = resolved?.session || resolved;
  if (!durableSession?.id) throw new Error("Studio session resolution returned no session.");
  if (resolved?.mode === "artifacts") {
    await showSessionArtifacts(durableSession);
    // ROOT CAUSE (reconciliation pass): this postMessage was missing on one merged branch entirely — the
    // artifacts-mode boot path never told the parent shell Studio was ready, so js/studio-auth.js's
    // "toasty:studio-ready" listener never fired for it and the loading curtain never dismissed for any
    // ended/historical session opened this way. Both other boot paths (home, live) already send it.
    if (window.parent !== window) {
      window.parent.postMessage({ type: "toasty:studio-ready", surface: "artifacts" }, window.location.origin);
    }
    return;
  }
  session.applyDurableSession(durableSession);
  void session.loadProfileEndCard();
  await initStudio();
  // Re-resolve+re-apply AFTER the durable session record is in hand: a direct session link/refresh
  // (director.html?session=xxx with no ?brand= at all) only gets the real brand from record.brandId here,
  // not from the URL applySelectedBrand() already ran with above — see applyDurableSession's own comment.
  // Deliberately explicit rather than relying on session.emit("brand", ...) timing: initStudio() (just
  // above) is what wires the "brand" listener in the first place, so an emit from inside
  // applyDurableSession would already have been missed.
  await applySelectedBrand();
  if (window.parent !== window) {
    window.parent.postMessage({ type: "toasty:studio-ready", surface: "live" }, window.location.origin);
  }
}

// Deliberately narrow: catches only init()'s own rejection, renders a fixed overlay that exists
// unconditionally in the DOM (see studio/director.html #studioFatalError) regardless of which panel
// (session gate, artifacts, live console) was on screen when the failure happened, and offers the same
// full-reload recovery already used elsewhere in this file (see elements.switchSession's click handler)
// rather than inventing a second, untested teardown path.
function renderFatalInitError(error) {
  const overlay = document.querySelector("#studioFatalError");
  if (!overlay) {
    window.alert("Toasty Studio failed to load. Please reload the page.");
    return;
  }
  overlay.hidden = false;
  const detail = overlay.querySelector("#studioFatalErrorDetail");
  if (detail) detail.textContent = String(error?.message || error || "Unknown error");
  overlay.querySelector("#studioFatalErrorRetry")?.addEventListener("click", () => window.location.reload(), { once: true });
}

async function initStudio() {
  session.start({
    host: elements.hostFrame,
    hostTransport: elements.hostTransportFrame,
    hostScreenTransport: elements.hostScreenTransportFrame,
    roomPreview: elements.guestFrame,
    control: elements.directorControlFrame,
    programPreview: elements.programPreviewStage
  });

  new HostView({ session }).init();
  new ProducerView({ session }).init();
  session.loadAssetCatalogue().catch((error) => {
    console.error("[Toasty] Asset Catalogue failed to load", error);
    session.emit("catalogue-error", error);
  });
  const hostPrejoin = new HostPrejoin({ session });
  await hostPrejoin.init();
  // The one place LEAVING is ever emitted is LiveSession.leaveStudio() — see js/host-state.js — so this
  // can't double-fire against startPreview()'s own routine PREJOIN_LOADING transitions (device changes,
  // first load) and trigger a second, redundant getUserMedia call.
  session.on("host-state", (state) => { if (state === HostState.LEAVING) hostPrejoin.resume(); });

  new AIProductionController({
    getBrandTheme: () => session.brandTheme,
    onBrandChange: (brandTheme) => {
      // Same lock this file's own selector respects — Moxie can't do via voice what the hidden dropdown
      // can't do via click. Backend enforces this regardless either way (see isBrandLocked's own comment).
      if (isBrandLocked && normalizeBrandTheme(brandTheme) !== session.brandTheme) return;
      elements.brandThemeSelect.value = normalizeBrandTheme(brandTheme);
      session.changeBrandTheme(brandTheme);
    }
  }).init();

  // GO LIVE destination chooser. Destination credentials live server-side only (see js/broadcast-client.js).
  goLivePanel = new GoLivePanel({ client: session.broadcast, studio: session.studio });

  bindViewSwitch();
  bindRailControls();
  bindPolicyDrawer();
  bindAiProviderDrawer();
  bindPersonaDrawer();
  bindProducerChrome();
  bindProducerWorkspaces();

  session.on("policy", renderPolicyChip);
  session.on("connection", () => { renderBroadcastChip(); renderProducerChrome(); });
  session.on("program", () => { renderBroadcastChip(); renderProducerChrome(); });
  session.on("program-output", renderProducerChrome);
  session.on("recording", renderStudioChrome);
  session.on("studio", () => { renderStudioChrome(); renderBroadcastChip(); });
  session.on("host-profile", renderProducerChrome);
  session.on("host-state", renderProducerChrome);
  session.on("brand", () => { applySelectedBrand(); updateInviteFields(); renderProducerChrome(); });
  session.on("room", () => { updateInviteFields(); renderProducerChrome(); });

  renderPolicyChip(session.policy);
  renderStudioChrome();
  renderBroadcastChip();
  renderProducerChrome();
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
    reconcileDesktopHostControls();
  elements.viewButtons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.lvViewBtn === view)));
  // Queried live (not cached at init time) so panels mounted later by other controllers — e.g. the
  // Producer-only broadcast card injected into .rail-right — are still gated correctly.
  document.querySelectorAll("[data-lv-only]").forEach((panel) => { panel.hidden = panel.dataset.lvOnly !== view; });
}

function bindProducerWorkspaces() {
  const buttons = elements.producerWorkspaceButtons || [];
  const setWorkspace = (workspace = "production") => {
    elements.liveConsole.dataset.producerWorkspace = workspace;
    buttons.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.producerWorkspace === workspace)));
  };
  buttons.forEach((button) => button.addEventListener("click", () => {
    setView("producer");
    setWorkspace(button.dataset.producerWorkspace);
  }));
  setWorkspace("production");
}

function bindProducerChrome() {
  // Record / Go Live / Share Screen: the three primary controls. Record mirrors the persistent bottom-bar
  // Record button (which owns the capture flow and its error messaging) without changing the current view.
  elements.topRecord?.addEventListener("click", () => document.querySelector("#lvRecordToggle")?.click());
  const onGoLiveClick = async () => {
    if (session.studio.mode === "live") {
      if (window.confirm("End the live broadcast? Toasty will stop sending Program to your destinations and finish the automatic recording.")) {
        await session.studio.endLive();
      }
      return;
    }
    await goLivePanel?.open();
  };
  elements.topGoLive?.addEventListener("click", onGoLiveClick);
  elements.bottomGoLive?.addEventListener("click", onGoLiveClick);
  elements.topShareScreen?.addEventListener("click", async () => {
    try { await session.toggleScreenShare(); } catch (error) {
      console.error("[Toasty Studio] Screen share failed", error);
      window.alert(String(error?.message || "Screen share could not start."));
    }
  });
  elements.topProgramOutput?.addEventListener("click", () => document.querySelector("#lvOpenProgramOutput")?.click());
  elements.topSettings?.addEventListener("click", () => {
    window.open("./dashboard.html", "_blank", "noopener");
  });
  elements.topEndSession?.addEventListener("click", () => endCurrentSession(elements.topEndSession));
  elements.topMore?.addEventListener("click", () => {
    const open = elements.topMore?.getAttribute("aria-expanded") === "true";
    elements.topMore?.setAttribute("aria-expanded", String(!open));
    if (elements.topMoreMenu) elements.topMoreMenu.hidden = open;
  });
  elements.bottomNavButtons.forEach((button) => {
    button.addEventListener("click", () => jumpProducerPanel(button.dataset.producerJump));
  });
}

async function endCurrentSession(button) {
  if (!session.durableSession) {
    window.alert("This room has no durable session record, so there is nothing to end.");
    return;
  }
  if (!window.confirm(`End "${session.durableSession.title || "this session"}" for everyone?`)) return;
  const previousLabel = button?.textContent || "End Session";
  if (button) {
    button.disabled = true;
    button.textContent = "Ending…";
  }
  try {
    await session.endDurableSession();
    const url = new URL("./dashboard.html", window.location.href);
    window.location.href = url.toString();
  } catch (error) {
    console.error("[Toasty Studio] End Session failed", error);
    window.alert(`Could not end this session: ${error?.message || error}`);
    if (button) {
      button.disabled = false;
      button.textContent = previousLabel;
    }
  }
}

function jumpProducerPanel(target) {
  setView("producer");
  elements.bottomNavButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.producerJump === target));
  });
  const panel = {
    participants: document.querySelector(".lv-sources"),
    chat: document.querySelector(".lv-ai-producer-pane"),
    assets: document.querySelector(".lv-graphics") || document.querySelector(".lv-audio")
  }[target] || null;
  panel?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  panel?.focus?.({ preventScroll: true });
}

function bindRailControls() {
  elements.inviteGuestBtn.addEventListener("click", inviteGuest);
  elements.copyInvite.addEventListener("click", copyInvite);
  elements.copyListenerInvite.addEventListener("click", copyListenerInvite);
  if (isBrandLocked) {
    // hidden, not removed: ai-production.js's own #aiBrandProfile selector (below) is queried and used
    // directly with no null-guard (addEventListener/replaceChildren/.value= all assume it exists) — that
    // module is Moxie's, not touched here, so this can't risk removing an element it depends on.
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
  elements.endSessionBtn.addEventListener("click", () => endCurrentSession(elements.endSessionBtn));
  // Opens in a new tab, never navigates this frame away — a live session's Host/Producer state must never
  // be disrupted by visiting Settings (see the module comment on why director.html can't safely reload).
  elements.openSettingsQuick?.addEventListener("click", () => {
    window.open("./dashboard.html", "_blank", "noopener");
  });
  elements.toggleScreenQuick?.addEventListener("click", async () => {
    // Disabled state while connecting is driven by the "screenshare" listener below (real share state),
    // not here — see js/host-view.js's identical comment for why re-enabling on promise resolution would
    // be wrong (startScreenShare resolves as soon as the publisher is mounted, before VDO confirms it).
    try {
      await session.toggleScreenShare();
    } catch (error) {
      console.error("[Toasty Studio] Screen share failed", error);
      window.alert(String(error?.message || "Screen share could not start."));
    }
  });
  // No alert() here on failure — js/host-view.js's HostView (always instantiated alongside this, see
  // its constructor call above) already surfaces failures once, and this page runs both simultaneously
  // regardless of which view (Host/Producer) is currently shown, so a second alert here would just be a
  // duplicate popup for the same failure.
  session.on("screenshare", (s) => {
    if (elements.topShareScreen) {
      const state = s?.state || "inactive";
      const connecting = state === "binding" || state === "expected";
      elements.topShareScreen.setAttribute("aria-pressed", String(Boolean(s?.active)));
      elements.topShareScreen.disabled = connecting;
      elements.topShareScreen.textContent = connecting ? "Connecting…" : (s?.active ? "Stop Sharing" : "Share Screen");
    }
    if (elements.toggleScreenQuick) {
      const state = s?.state || "inactive";
      const connecting = state === "binding" || state === "expected";
      const active = Boolean(s?.active);
      elements.toggleScreenQuick.setAttribute("aria-pressed", String(active));
      elements.toggleScreenQuick.disabled = connecting;
      elements.toggleScreenQuick.dataset.shareState = state;
      const label = elements.toggleScreenQuick.querySelector(".dock-label");
      if (label) label.textContent = connecting ? "Connecting…" : (active ? "Stop Sharing" : "Share Screen");
    }
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

function renderPolicyChip(policy) {
  const summary = policy.summary();
  elements.policyChip.hidden = !summary;
  if (summary) elements.policyChip.textContent = `${summary.icon} ${summary.label} · ${summary.detail}`;
}

// BACKSTAGE / RECORDING / LIVE — derived ONLY from the Record/Live orchestrator (session.studio). Camera,
// mic, guests, screen share, Program Output and VDO.Ninja connectivity never reach this function, so none
// of them can make Studio say LIVE.
const DESTINATION_LABELS = { x: "X", youtube: "YouTube", tiktok: "TikTok", instagram: "Instagram", custom: "Custom RTMP" };
function renderStudioChrome() {
  const snapshot = session.studio.snapshot();
  const { mode, recording, destinations } = snapshot;
  const elapsed = recording.active && recording.startedAt ? formatElapsed(Date.now() - recording.startedAt) : "";
  if (elements.topLiveState) {
    elements.topLiveState.dataset.state = mode;
    elements.topLiveState.textContent = mode === "live" ? "● LIVE" : mode === "record" ? `● RECORDING ${elapsed}`.trim() : "BACKSTAGE";
  }
  if (elements.topDestinations) {
    const visible = destinations.filter((d) => d.state !== "stopped" && d.state !== "idle");
    elements.topDestinations.hidden = !visible.length;
    elements.topDestinations.replaceChildren(...visible.map((d) => {
      const chip = document.createElement("span");
      chip.className = "lv-dest-chip";
      chip.dataset.state = d.state;
      const label = DESTINATION_LABELS[d.destination] || d.label || d.destination;
      chip.textContent = d.state === "live" ? `${label} ● LIVE` : d.state === "error" ? `${label} ERROR` : `${label} connecting…`;
      if (d.error) chip.title = d.error;
      return chip;
    }));
  }
  if (elements.topRecordingState) {
    // While LIVE the recording runs automatically and must be visibly on: "● LIVE" + "X ● LIVE" + "● REC".
    const showRec = recording.active && mode === "live";
    elements.topRecordingState.hidden = !showRec;
    elements.topRecordingState.dataset.state = showRec ? "recording" : "off";
    elements.topRecordingState.textContent = recording.origin === "live-auto" ? `● REC ${elapsed} · automatic` : `● REC ${elapsed}`;
  }
  if (elements.topRecord) {
    const saving = session.recording?.status === "saving";
    elements.topRecord.setAttribute("aria-pressed", String(recording.active));
    elements.topRecord.textContent = saving ? "Saving…" : recording.active ? "Stop Recording" : "Record";
    elements.topRecord.disabled = saving || (!session.canRecord() && !recording.active);
  }
  const busy = snapshot.busy;
  const goLiveLabel = mode === "live" ? "End Live" : busy === "going-live" ? "Connecting…" : "Go Live";
  for (const button of [elements.topGoLive, elements.bottomGoLive]) {
    if (!button) continue;
    button.setAttribute("aria-pressed", String(mode === "live"));
    button.textContent = button === elements.bottomGoLive ? goLiveLabel.toUpperCase() : goLiveLabel;
    button.disabled = busy === "going-live" || busy === "ending-live";
  }
  if (elements.bottomMode) {
    elements.bottomMode.dataset.state = mode;
    elements.bottomMode.textContent = mode === "live" ? `● LIVE${recording.active ? " · ● REC" : ""}` : mode === "record" ? `● RECORDING ${elapsed}`.trim() : "BACKSTAGE";
  }
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const sec = String(total % 60).padStart(2, "0");
  return h === "00" ? `${m}:${sec}` : `${h}:${m}:${sec}`;
}

function renderProducerChrome() {
  if (elements.topBrand) {
    const selected = elements.brandThemeSelect?.selectedOptions?.[0]?.textContent?.trim();
    elements.topBrand.textContent = selected || brandLabel(session.brandTheme);
  }
  if (elements.topSessionName) {
    elements.topSessionName.textContent = session.durableSession?.title || "Live Studio";
  }
  if (elements.topHealth) {
    const output = session.programOutput || {};
    const connection = output.connected ? "Output connected" : session.connection?.status === "connected" ? "Studio ready" : session.connection?.label || "Offline";
    const ready = output.readyToRecord ? " · Ready to record" : "";
    elements.topHealth.textContent = `${connection}${ready}`;
  }
  if (elements.topHost) {
    const hostName = session.hostProfile?.displayName || "Not joined";
    const state = session.hostState === HostState.IN_STUDIO ? "Live" : "Waiting";
    elements.topHost.textContent = `Host: ${hostName} · ${state}`;
  }
  if (elements.topProducer) {
    elements.topProducer.textContent = "Producer: Local";
  }
  if (elements.topProgramOutput) {
    const connected = Boolean(session.programOutput?.connected);
    elements.topProgramOutput.dataset.state = connected ? "connected" : "disconnected";
    elements.topProgramOutput.textContent = connected ? "Program Output Connected" : "Program Output";
  }
}

// Legacy ON AIR sign. LIVE only while the orchestrator says an external destination is actually receiving
// Program — not because a Program scene is named "Live", and not because VDO.Ninja is connected.
function renderBroadcastChip() {
  const { mode, destinations } = session.studio.snapshot();
  const errored = destinations.some((d) => d.state === "error");
  const state = mode === "live" ? "live" : errored ? "error" : session.connection.status === "connected" ? "ready" : "offline";
  const label = state === "live" ? "On air" : state === "error" ? "Broadcast error" : state === "ready" ? "Ready" : session.connection.label;
  setBroadcastChip(state, label);
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

function brandLabel(brandTheme) {
  return {
    toasty: "Toasty Media",
    "8alta": "8ALTA",
    santati: "Santati",
    optimai: "OptimAI Network",
    tangem: "Tangem",
    superteam: "Superteam Thailand",
    peeps: "Toasty Peeps"
  }[brandTheme] || "Toasty Media";
}

function sceneLabel(scene) {
  return {
    holding: "STARTING SOON",
    live: "LIVE",
    brb: "BRB",
    "technical-difficulties": "TECH DIFFICULTIES",
    ending: "ENDING"
  }[scene] || String(scene || "holding").toUpperCase();
}

function updateInviteFields() {
  const urls = session.inviteUrls();
  elements.guestInvite.value = urls.guest;
  elements.listenerInvite.value = urls.listener;
}

async function loadPlatformBrandCatalog() {
  try {
    const response = await fetch("/api/organizations/platform-admin/brand-catalog", { credentials: "same-origin" });
    if (!response.ok) return;
    const data = await response.json();
    for (const entry of data.brands || []) {
      if (!entry?.id || !entry?.profile) continue;
      const theme = composeDynamicTheme(entry.id, entry.profile);
      theme.label = entry.organizationName ? `${theme.label} · ${entry.organizationName}` : theme.label;
      registerDynamicTheme(theme);
    }
    populateBrandThemeSelect(elements.brandThemeSelect, session.brandTheme);
    const aiBrandProfile = document.querySelector("#aiBrandProfile");
    if (aiBrandProfile) populateBrandThemeSelect(aiBrandProfile, session.brandTheme);
  } catch (error) {
    console.warn("[Toasty Studio] Platform brand catalog unavailable", error);
  }
}

async function applySelectedBrand() {
  elements.brandThemeSelect.value = session.brandTheme;
  await session.applyBrand({
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

function reconcileDesktopHostControls() {
  const root = document.querySelector(".live-console");
  const graphics = document.querySelector("#lvGraphicsPanel");
  const producer = document.querySelector(".lv-ai-producer");
  if (!root || !graphics || !producer) return;
  const desktopHost = window.matchMedia("(min-width: 1181px)").matches && root.dataset.lvView === "host";
  if (desktopHost) {
    graphics.hidden = false;
    graphics.dataset.hostRail = "true";
    producer.insertAdjacentElement("afterend", graphics);
  } else if (graphics.dataset.hostRail === "true") {
    graphics.hidden = root.dataset.lvView !== "producer";
    graphics.dataset.hostRail = "false";
  }
}


window.addEventListener("resize", reconcileDesktopHostControls);
queueMicrotask(reconcileDesktopHostControls);
