// Personal Recording page (studio/record.html). Wiring only: the recording logic lives in
// personal-recording.js, the upload pipeline in recording-uploader.js, the picture in program-compositor.js.

import { studioRequest } from "./studio-api.js";
import { getInitialBrandTheme, populateBrandThemeSelect, normalizeBrandTheme } from "./brand-themes.js";
import { ProgramCompositor, PERSONAL_LAYOUT_LABELS, PersonalLayout } from "./program-compositor.js";
import { ProgramServerSubscriber } from "./program-server-sync.js";
import {
  PersonalRecordingSession,
  PersonalRecordingState,
  compositorStateFromProgram,
  recoverInterruptedRecording
} from "./personal-recording.js";
import { RecordingApiClient, createDefaultChunkStore, recallActiveRecording } from "./recording-uploader.js";

const $ = (id) => document.getElementById(id);
const api = new RecordingApiClient();
const store = createDefaultChunkStore();
const params = new URLSearchParams(window.location.search);
const roomId = params.get("room") || "";

const page = { user: null, stream: null, compositor: null, session: null, brandLocked: false, timer: null, subscriber: null, scene: "live" };

function sessionIdForPage() {
  const fromUrl = params.get("session");
  if (fromUrl && /^[a-z0-9][a-z0-9._-]{0,80}$/i.test(fromUrl)) return fromUrl;
  try {
    let id = window.sessionStorage.getItem("toastyPersonalSessionId");
    if (!id) {
      id = `ps-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      window.sessionStorage.setItem("toastyPersonalSessionId", id);
    }
    return id;
  } catch {
    return `ps-${Date.now().toString(36)}`;
  }
}

function setStatus(text) { $("recStatus").textContent = text; }
function fmtTime(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${m}:${s}` : `${m}:${s}`;
}
function fmtBytes(bytes) {
  if (!bytes) return "0 MB";
  return bytes > 1024 * 1024 * 1024 ? `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function participantFromForm() {
  return {
    participantId: "host",
    role: "host",
    displayName: $("recName").value.trim(),
    title: $("recTitle").value.trim(),
    company: $("recCompany").value.trim(),
    onProgram: true
  };
}

function endCardFromForm() {
  const base = page.user?.endCard || {};
  return {
    ...base,
    headline: $("recEndHeadline").value.trim() || base.headline || "THANKS FOR WATCHING",
    message: $("recEndMessage").value.trim() || base.message || "",
    website: $("recEndWebsite").value.trim() || base.website || ""
  };
}

function pushLocalState(extra = {}) {
  const patch = {
    participants: [participantFromForm()],
    layout: $("recLayout").value,
    lowerThird: { visible: $("recLowerThird").checked },
    endCard: endCardFromForm(),
    ...extra
  };
  if (page.session?.state === PersonalRecordingState.RECORDING) page.session.setProgramState(patch);
  else page.compositor?.setState(patch);
}

async function populateDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (select, kind, label) => {
      const current = select.value;
      select.replaceChildren(...devices.filter((d) => d.kind === kind).map((d, i) => new Option(d.label || `${label} ${i + 1}`, d.deviceId)));
      if (current) select.value = current;
    };
    fill($("recCameraSelect"), "videoinput", "Camera");
    fill($("recMicSelect"), "audioinput", "Microphone");
  } catch { /* devices unavailable until permission is granted */ }
}

async function startCamera() {
  stopCamera();
  setStatus("Starting camera…");
  const video = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
  if ($("recCameraSelect").value) video.deviceId = { exact: $("recCameraSelect").value };
  const audio = $("recMicSelect").value ? { deviceId: { exact: $("recMicSelect").value } } : true;
  try {
    page.stream = await navigator.mediaDevices.getUserMedia({ video, audio });
  } catch (error) {
    setStatus(error?.name === "NotAllowedError" ? "Camera or microphone permission was blocked. Allow access and try again." : `Could not open camera: ${error?.message || error}`);
    return;
  }
  await populateDevices();
  page.compositor = new ProgramCompositor({
    canvas: $("recCanvas"),
    resolution: $("recQuality").value,
    state: {
      brandTheme: $("recBrand").value,
      layout: $("recLayout").value,
      participants: [participantFromForm()],
      endCard: endCardFromForm(),
      scene: page.scene
    }
  });
  await page.compositor.attachStream(page.stream);
  page.compositor.start();
  $("recCanvasEmpty").hidden = true;
  $("recStartBtn").disabled = !PersonalRecordingSession.isSupported();
  setStatus("Ready. Check how you look, then start recording.");
}

function stopCamera() {
  page.compositor?.stop();
  page.stream?.getTracks().forEach((track) => track.stop());
  page.compositor = null;
  page.stream = null;
  $("recCanvasEmpty").hidden = false;
  $("recStartBtn").disabled = true;
}

function linkMoxie() {
  if (!roomId) return;
  $("recMoxieNote").hidden = false;
  $("recSceneCard").open = true;
  page.subscriber = new ProgramServerSubscriber({
    roomId,
    onProgram: (program) => {
      const patch = compositorStateFromProgram(program, { brandTheme: $("recBrand").value, lockBrand: true, endCard: endCardFromForm() });
      if (page.session?.state === PersonalRecordingState.RECORDING) page.session.setProgramState(patch);
      else page.compositor?.setState(patch);
      document.querySelectorAll(".rec-chip").forEach((chip) => chip.classList.toggle("is-active", chip.dataset.scene === patch.scene));
    }
  });
  page.subscriber.start();
}

async function startRecording() {
  if (!page.stream || !page.compositor) return;
  $("recStartBtn").disabled = true;
  page.session = new PersonalRecordingSession({
    api,
    store,
    sessionId: sessionIdForPage(),
    participant: participantFromForm(),
    brandTheme: $("recBrand").value,
    layout: $("recLayout").value,
    resolution: $("recQuality").value,
    endCard: endCardFromForm(),
    status: setStatus,
    onUploadState: renderUploadState
  });
  try {
    await page.session.start({ stream: page.stream, compositor: page.compositor });
  } catch (error) {
    setStatus(`Could not start recording: ${error?.message || error}`);
    $("recStartBtn").disabled = false;
    return;
  }
  $("recStartBtn").hidden = true;
  $("recStopBtn").hidden = false;
  $("recMarkerBtn").hidden = false;
  $("recLiveBadge").hidden = false;
  $("recUpload").hidden = false;
  $("recResult").hidden = true;
  ["recBrand", "recQuality", "recCameraSelect", "recMicSelect"].forEach((id) => { $(id).disabled = true; });
  page.timer = setInterval(() => { $("recTimer").textContent = fmtTime(page.session.elapsedMs); }, 500);
  window.addEventListener("beforeunload", warnBeforeUnload);
}

function warnBeforeUnload(event) {
  if (page.session?.state !== PersonalRecordingState.RECORDING) return;
  // Chunks already uploaded are safe either way; this protects only the last couple of seconds.
  event.preventDefault();
  event.returnValue = "";
}

function renderUploadState(stats) {
  const total = stats.uploadedBytes + stats.queuedBytes;
  $("recUploadFill").style.width = `${total ? Math.round((stats.uploadedBytes / total) * 100) : 100}%`;
  $("recUploadText").textContent = stats.lastError
    ? `Reconnecting… ${stats.queued} chunk(s) saved on this device (${fmtBytes(stats.queuedBytes)}), ${fmtBytes(stats.uploadedBytes)} already safe in Toasty.`
    : `${fmtBytes(stats.uploadedBytes)} safe in Toasty${stats.queued ? ` · ${stats.queued} uploading` : ""}.`;
}

async function stopRecording() {
  $("recStopBtn").disabled = true;
  clearInterval(page.timer);
  window.removeEventListener("beforeunload", warnBeforeUnload);
  $("recLiveBadge").hidden = true;
  $("recMarkerBtn").hidden = true;
  const result = await page.session.stop();
  $("recStopBtn").hidden = true;
  $("recStopBtn").disabled = false;
  $("recStartBtn").hidden = false;
  $("recStartBtn").disabled = false;
  ["recBrand", "recQuality", "recCameraSelect", "recMicSelect"].forEach((id) => { $(id).disabled = page.brandLocked && id === "recBrand"; });
  showResult({ title: "Preparing your recording…", note: "Your recording is saved. We're making the MP4 now — you can leave this page." });
  if (result.recoverable) {
    showResult({ title: "Almost saved", note: "Some chunks are still waiting for a connection. They're stored on this device and will finish uploading the next time you open Record." });
    return;
  }
  try {
    const recording = await page.session.waitForFinalization();
    showRecording(recording);
    await refreshLibrary();
  } catch (error) {
    showResult({ title: "Still processing", note: error.message });
  }
}

function showResult({ title, note }) {
  $("recResult").hidden = false;
  $("recResultTitle").textContent = title;
  $("recResultNote").textContent = note || "";
  $("recResultFiles").replaceChildren();
}

const TRACK_LABELS = { program: "Program Output (ready to use)", camera: "Camera only", microphone: "Microphone only" };

async function downloadTrack(recording, track, kind = "final") {
  const blob = await api.downloadTrack(recording.sessionId, recording.recordingId, track.participantId, track.trackId, { kind });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  const ext = kind === "source" ? "webm" : (track.final.file || "").split(".").pop();
  link.download = `${recording.recordingId}-${track.trackId}.${ext}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function trackRow(recording, track) {
  const li = document.createElement("li");
  const label = document.createElement("div");
  label.innerHTML = `<strong></strong><small></small>`;
  label.querySelector("strong").textContent = TRACK_LABELS[track.trackId] || track.label || track.type;
  label.querySelector("small").textContent = track.final.file
    ? `${track.final.file.split(".").pop().toUpperCase()} · ${fmtBytes(track.final.bytes)}${track.state === "partial" ? " · incomplete" : ""}`
    : (track.final.error || "Not available");
  li.append(label);
  if (track.final.file) {
    const button = document.createElement("button");
    button.className = "rec-btn";
    button.type = "button";
    button.textContent = "Download";
    button.addEventListener("click", () => downloadTrack(recording, track).catch((e) => setStatus(e.message)));
    li.append(button);
  }
  return li;
}

function showRecording(recording) {
  const ok = recording.state === "finalized";
  showResult({
    title: ok ? "Your recording is ready" : (recording.state === "partial" ? "Your recording is ready (part of it was incomplete)" : "We couldn't finish this recording"),
    note: ok ? `Recorded ${fmtTime(recording.durationMs || 0)}. Your camera and microphone are also saved as separate files for editing.` : "Whatever uploaded is kept. Try the downloads below."
  });
  const ordered = [...recording.tracks].sort((a, b) => (a.role === "composed" ? -1 : 1) - (b.role === "composed" ? -1 : 1));
  $("recResultFiles").replaceChildren(...ordered.map((track) => trackRow(recording, track)));
}

async function refreshLibrary() {
  try {
    const { recordings } = await api.listRecordings();
    const list = $("recLibrary");
    if (!recordings.length) { list.innerHTML = '<li class="rec-note">Nothing recorded yet.</li>'; return; }
    list.replaceChildren(...recordings.slice(0, 12).map((rec) => {
      const li = document.createElement("li");
      const info = document.createElement("div");
      info.innerHTML = "<strong></strong><small class='rec-note'></small>";
      info.querySelector("strong").textContent = new Date(rec.startedAt).toLocaleString();
      info.querySelector("small").textContent = ` ${rec.state} · ${fmtTime(rec.durationMs || 0)}`;
      li.append(info);
      const links = document.createElement("div");
      links.className = "rec-links";
      for (const track of rec.tracks.filter((t) => t.final?.file)) {
        const button = document.createElement("button");
        button.className = "rec-link";
        button.type = "button";
        button.textContent = `${TRACK_LABELS[track.trackId] ? track.trackId : track.type} .${track.final.file.split(".").pop()}`;
        button.addEventListener("click", () => downloadTrack({ ...rec }, track).catch((e) => setStatus(e.message)));
        links.append(button);
      }
      li.append(links);
      return li;
    }));
  } catch { /* library is a convenience */ }
}

async function recoverLastRecording() {
  if (!recallActiveRecording()) return;
  const banner = $("recRecovery");
  banner.hidden = false;
  banner.textContent = "Finishing your last recording — it was interrupted, but everything already uploaded is safe…";
  try {
    const result = await recoverInterruptedRecording({ api, store });
    banner.textContent = result?.recovered
      ? "Your interrupted recording was recovered. Its MP4 will appear under Recent recordings in a moment."
      : "Part of your last recording is still waiting to upload. Stay online and reload this page to finish it.";
  } catch (error) {
    banner.textContent = `Could not finish your last recording yet: ${error.message}`;
  }
  setTimeout(refreshLibrary, 4000);
}

async function init() {
  const auth = await studioRequest("/auth/session", { method: "GET" }).catch(() => ({ authenticated: false }));
  if (!auth.authenticated) {
    window.location.href = `./sessions.html?next=${encodeURIComponent(window.location.href)}`;
    return;
  }
  page.user = auth.user;
  $("recLoading").hidden = true;
  $("recApp").hidden = false;
  if (!PersonalRecordingSession.isSupported()) $("recUnsupported").hidden = false;

  $("recName").value = auth.user?.name || "";
  const locked = auth.user?.branding?.mode === "locked" && auth.user.branding.brandId;
  populateBrandThemeSelect($("recBrand"), locked ? normalizeBrandTheme(auth.user.branding.brandId) : getInitialBrandTheme());
  if (locked) { page.brandLocked = true; $("recBrand").disabled = true; }
  $("recLayout").replaceChildren(...Object.entries(PERSONAL_LAYOUT_LABELS).map(([value, label]) => new Option(label, value)));
  $("recLayout").value = PersonalLayout.SINGLE;

  $("recCameraBtn").addEventListener("click", startCamera);
  $("recCameraSelect").addEventListener("change", () => { if (page.stream && !page.session) startCamera(); });
  $("recMicSelect").addEventListener("change", () => { if (page.stream && !page.session) startCamera(); });
  $("recQuality").addEventListener("change", () => { if (page.stream && !page.session) startCamera(); });
  $("recBrand").addEventListener("change", () => pushLocalState({ brandTheme: $("recBrand").value }));
  $("recLayout").addEventListener("change", () => pushLocalState());
  ["recName", "recTitle", "recCompany", "recLowerThird", "recEndHeadline", "recEndMessage", "recEndWebsite"].forEach((id) => $(id).addEventListener("input", () => pushLocalState()));
  document.querySelectorAll(".rec-chip").forEach((chip) => chip.addEventListener("click", () => {
    page.scene = chip.dataset.scene;
    document.querySelectorAll(".rec-chip").forEach((c) => c.classList.toggle("is-active", c === chip));
    pushLocalState({ scene: page.scene });
  }));
  $("recAssetShow").addEventListener("click", () => {
    const title = $("recAssetTitle").value.trim();
    if (!title) return;
    pushLocalState({
      asset: {
        id: `asset-${Date.now().toString(36)}`, status: "live", title,
        preview: { kind: "card", title, sourceName: $("recAssetSource").value.trim(), excerpt: $("recAssetExcerpt").value.trim(), imageUrl: null },
        media: { kind: "card", src: null }
      },
      layout: $("recLayout").value === PersonalLayout.SINGLE || $("recLayout").value === PersonalLayout.FULLBLEED ? PersonalLayout.ASSET_SPEAKER : $("recLayout").value
    });
    $("recLayout").value = page.compositor?.state.layout || $("recLayout").value;
  });
  $("recAssetHide").addEventListener("click", () => pushLocalState({ asset: null }));
  const syncTicker = () => pushLocalState({ ticker: { enabled: $("recTickerOn").checked, text: $("recTickerText").value.trim(), speed: 16 } });
  $("recTickerOn").addEventListener("change", syncTicker);
  $("recTickerText").addEventListener("input", syncTicker);
  $("recStartBtn").addEventListener("click", startRecording);
  $("recStopBtn").addEventListener("click", () => stopRecording().catch((error) => setStatus(`Stop failed: ${error.message}`)));
  $("recMarkerBtn").addEventListener("click", () => { const m = page.session?.addMarker("manual", "Marker"); if (m) setStatus(`Marker added at ${fmtTime(m.offsetMs)}`); });

  linkMoxie();
  await populateDevices();
  await refreshLibrary();
  await recoverLastRecording();
}

document.addEventListener("DOMContentLoaded", init);
