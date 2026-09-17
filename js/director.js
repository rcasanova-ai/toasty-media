// No ?v= cache-busting suffix on these imports on purpose: the root .htaccess forces
// Cache-Control: no-cache on every first-party .js/.css, so a deploy is always visible on next
// load without anyone remembering to bump a version string per file. See .htaccess.
import { normalizeBrandTheme } from "./brand-themes.js";
import { AIProductionController } from "./ai-production.js";
import { ToastyBroadcastController } from "./broadcast-client.js";
import { LiveSession } from "./live-session.js";
import { HostView } from "./host-view.js";
import { ProducerView } from "./producer-view.js";

const session = new LiveSession();
// Dev diagnostics only — never rendered in Host/Producer UI. In devtools: session.aiProducerService.diagnostics()
// for the speech-complete -> result-rendered latency breakdown of recent AI Producer requests.
window.__toastyLiveSession = session;

const elements = {
  liveConsole: document.querySelector("#liveConsole"),
  viewButtons: [...document.querySelectorAll("[data-lv-view-btn]")],
  hostFrame: document.querySelector("#lvHostFrame"),
  guestFrame: document.querySelector("#lvGuestFrame"),
  directorControlFrame: document.querySelector("#directorControlFrame"),
  recChip: document.querySelector("#lvRecChip"),
  recChipTime: document.querySelector("#lvRecChipTime"),
  policyChip: document.querySelector("#lvPolicyChip"),
  sessionDate: document.querySelector("#sessionDate"),
  sessionTime: document.querySelector("#sessionTime"),
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
  newRoom: document.querySelector("#newRoom"),
  toggleScreenQuick: document.querySelector("#toggleScreenQuick"),
  lvSessionType: document.querySelector("#lvSessionType"),
  lvJamPolicyFields: document.querySelector("#lvJamPolicyFields"),
  lvJamPrivacy: document.querySelector("#lvJamPrivacy"),
  lvJamCapturePolicy: document.querySelector("#lvJamCapturePolicy"),
  lvJamAiAllowed: document.querySelector("#lvJamAiAllowed"),
  lvJamRecordAllowed: document.querySelector("#lvJamRecordAllowed"),
  lvForceHeuristicMode: document.querySelector("#lvForceHeuristicMode")
};

init();

function init() {
  applySelectedBrand();
  session.start({ host: elements.hostFrame, roomPreview: elements.guestFrame, control: elements.directorControlFrame });

  new HostView({ session }).init();
  new ProducerView({ session }).init();

  new AIProductionController({
    getBrandTheme: () => session.brandTheme,
    onBrandChange: (brandTheme) => { elements.brandThemeSelect.value = normalizeBrandTheme(brandTheme); session.changeBrandTheme(brandTheme); }
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
  elements.brandThemeSelect.addEventListener("change", () => session.changeBrandTheme(elements.brandThemeSelect.value));
  elements.newRoom.addEventListener("click", () => session.createNewRoom());
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
}
