import { normalizeBrandTheme } from "./brand-themes.js?v=studio-20260916d";
import { AIProductionController } from "./ai-production.js?v=studio-20260916d";
import { ToastyBroadcastController } from "./broadcast-client.js?v=auth-20260911";
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
  onlyPanels: [...document.querySelectorAll("[data-lv-only]")],
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

  bindViewSwitch();
  bindRailControls();
  bindPolicyDrawer();
  bindAiProviderDrawer();

  session.on("recording", renderRecChip);
  session.on("policy", renderPolicyChip);
  session.on("connection", renderConnectionChip);
  session.on("brand", () => { applySelectedBrand(); updateInviteFields(); });
  session.on("room", updateInviteFields);

  renderRecChip(session.recording);
  renderPolicyChip(session.policy);
  renderConnectionChip(session.connection);
  updateInviteFields();
  mountTimeOfDay();

  new AIProductionController({
    getBrandTheme: () => session.brandTheme,
    onBrandChange: (brandTheme) => { elements.brandThemeSelect.value = normalizeBrandTheme(brandTheme); session.changeBrandTheme(brandTheme); }
  }).init();

  new ToastyBroadcastController({
    getProgramUrl: () => elements.listenerInvite.value,
    requireLegacyAuthGate: false,
    onStateChange: (broadcastState) => session.setLive(broadcastState === "live")
  }).init();
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
  elements.onlyPanels.forEach((panel) => { panel.hidden = panel.dataset.lvOnly !== view; });
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

function renderConnectionChip(connection) {
  elements.connectionState.textContent = connection.label;
  elements.connectionChip.dataset.state = connection.status;
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
