// Make My Video: the simple front end of the Automatic Director. Pick a recording, pick a style, optionally say what you want,
// press one button; preview the finished video, ask for changes in plain English, and export. The editing itself lives in
// js/director/ (no UI there); this file only wires the page to it. Everything runs on this computer.
import { STYLES, STYLE_IDS, defaultSettings, describePlan, makeEdit, openSession, renderEdit, reviseEdit } from "./director/index.js";
import { renderCapabilities, loadImage } from "./clip-renderer.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const slug = (s) => String(s || "video").toLowerCase().replace(/\.[a-z0-9]{2,4}$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "video";

const state = { style: "clean", busy: false, abort: null, session: null, edit: null, results: [], broll: [], logo: null, lastStatus: "" };
window.__toastyDirector = state;

const api = () => window.__toastyClipsApi;
const clipsState = () => api()?.state;

function setStatus(text) { $("mmvStatus").textContent = text; state.lastStatus = text; }
function setReply(el, applied = [], unsupported = []) {
  el.innerHTML = [...applied.map((a) => `<li>${esc(a)}</li>`), ...unsupported.map((u) => `<li class="is-ignored">Could not do: ${esc(u)}</li>`)].join("");
}

function renderStyles() {
  $("mmvStyles").innerHTML = STYLE_IDS.map((id) => { const s = STYLES[id], t = s.theme; return `<button type="button" class="mmv-style" role="radio" aria-checked="${id === state.style}" data-style="${id}"><span class="tc-swatch"><i style="background:${t.bg}"></i><i style="background:${t.accent}"></i><i style="background:${t.accent2}"></i><i style="background:${t.fg}"></i></span><strong>${esc(s.name)}</strong><small>${esc(s.blurb)}</small></button>`; }).join("");
}

function refreshReady() {
  const caps = renderCapabilities(), have = Boolean(clipsState()?.source);
  $("mmvMake").disabled = state.busy || !have || !caps.supported;
  $("mmvSupport").textContent = caps.supported ? `Exports ${caps.container.toUpperCase()} on this computer. Keep this tab open while it renders.` : "This browser cannot render videos. Use a current Chrome, Edge or Safari.";
  $("mmvSource").textContent = have ? `${clipsState().source.name} · ${fmt(clipsState().source.duration || 0)}` : "No recording chosen yet.";
}

async function loadLibrary() {
  const ul = $("mmvLibrary");
  try {
    const items = await api().listLibrary();
    ul.innerHTML = items.length ? items.map((i) => `<li><button type="button" data-recording="${esc(i.id)}">${esc(i.label)}</button></li>`).join("") : '<li class="tc-muted">No Studio recordings on this computer yet. Record in the Studio, or choose a video.</li>';
  } catch (error) { ul.innerHTML = `<li class="tc-muted">Could not read the library: ${esc(error?.message || error)}</li>`; }
}

async function videoSize(blob) {
  const v = document.createElement("video"), url = URL.createObjectURL(blob); v.preload = "metadata"; v.src = url;
  await new Promise((res) => { v.onloadedmetadata = res; v.onerror = res; setTimeout(res, 8000); });
  const out = { width: v.videoWidth || 1280, height: v.videoHeight || 720, duration: Number.isFinite(v.duration) ? v.duration : 0 };
  v.removeAttribute("src"); v.load(); URL.revokeObjectURL(url);
  return out;
}

async function addBroll(files) {
  for (const f of files) {
    const size = await videoSize(f);
    state.broll.push({ id: `b${state.broll.length + 1}`, name: f.name, blob: f, duration: size.duration, tags: null });
  }
  renderBroll();
}
function renderBroll() {
  $("mmvBrollList").innerHTML = state.broll.map((b, i) => `<li><span>${esc(b.name)}</span><input type="text" data-broll="${i}" aria-label="Tags for ${esc(b.name)}" placeholder="tags, comma separated" value="${esc((b.tags || []).join(", "))}"></li>`).join("");
}
function brollFiles() {
  return state.broll.map((b) => ({ id: b.id, name: b.name, blob: b.blob, duration: b.duration, tags: (b.tags || []).map((t) => t.trim().toLowerCase()).filter(Boolean) }));
}

function aspect() { return document.querySelector("input[name=mmvAspect]:checked")?.value || "16:9"; }

function audioLine(a) {
  if (!a) return "";
  const out = a.measuredAfter, parts = [];
  if (out && Number.isFinite(out.integratedLufs)) parts.push(`Audio ${out.integratedLufs.toFixed(1)} LUFS, peak ${out.truePeakDbtp.toFixed(1)} dBTP`);
  if (a.enhanced && Number.isFinite(a.appliedGainDb) && Math.abs(a.appliedGainDb) >= 1) parts.push(`${a.appliedGainDb > 0 ? "raised" : "lowered"} ${Math.abs(a.appliedGainDb).toFixed(0)} dB${a.noiseReduction ? ", noise reduced" : ""}`);
  if (a.corrected) parts.push("level corrected after a check");
  const warn = (a.messages || []).filter(Boolean);
  return `<span class="tc-audio${warn.length || a.ok === false ? " is-warn" : ""}">${esc(parts.join(" · "))}${warn.length ? " · " + esc(warn.join(" ")) : ""}</span>`;
}

function showResults() {
  state.results.forEach((r) => { if (r.__url) URL.revokeObjectURL(r.__url); });
  $("mmvVideos").innerHTML = "";
  state.results.forEach((r, i) => {
    r.__url = URL.createObjectURL(r.blob);
    const name = `${slug(state.session.name)}-${state.edit.settings.style}-${r.aspect.replace(":", "x")}${state.results.length > 1 ? `-${i + 1}` : ""}.${r.container}`;
    const card = document.createElement("div"); card.className = "mmv-vid"; card.dataset.index = String(i);
    card.innerHTML = `<video controls playsinline preload="auto" src="${r.__url}" aria-label="Preview ${i + 1}"></video><div class="tc-row"><span class="tc-muted">${esc(r.plan.styleName)} · ${r.width}×${r.height} · ${r.seconds.toFixed(0)} s · ${(r.blob.size / 1048576).toFixed(1)} MB · ${r.container.toUpperCase()}</span><a class="tc-btn tc-primary" href="${r.__url}" download="${esc(name)}" data-export>Export</a></div>${audioLine(r.audio)}`;
    $("mmvVideos").appendChild(card);
  });
  const plan = state.results[0]?.plan;
  $("mmvPlanSummary").innerHTML = state.results.map((r) => describePlan(r.plan).map((l) => `<p class="tc-muted">${esc(l)}</p>`).join("")).join("");
  $("mmvDecisions").innerHTML = (plan?.decisions || []).slice(0, 80).map((d) => `<li><b>${fmt(d.t)}</b> ${esc(d.rule.replace(/-/g, " "))}: ${esc(d.action)}</li>`).join("") + ((plan?.warnings || []).map((w) => `<li class="is-ignored">${esc(w)}</li>`).join(""));
  $("mmvResult").hidden = false;
}

function progressText(p) {
  const n = p.count > 1 ? ` (video ${p.index + 1} of ${p.count})` : "";
  if (p.phase === "measuring") return `Measuring the audio level${n}…`;
  if (p.phase === "preparing") return `Preparing music and sound accents${n}…`;
  if (p.phase === "correcting") return `Adjusting the audio level and rendering again${n}…`;
  return `Rendering${n}: ${p.phase === "content" ? "your edit" : p.phase === "intro" ? "title" : "end card"}, ${Math.round(p.t)} of ${Math.round(p.total)} s. Keep this tab open.`;
}

async function renderCurrent() {
  state.abort = new AbortController();
  const planTotal = state.edit.plans.reduce((s, p) => s + p.timeline.total, 0);
  let done = 0, idx = 0;
  $("mmvProgress").hidden = false; $("mmvProgress").value = 0; $("mmvCancel").hidden = false;
  try {
    const results = await renderEdit(state.session, state.edit, {
      signal: state.abort.signal, logo: state.logo,
      onProgress: (p) => { if (p.index !== idx) { done += state.edit.plans[idx].timeline.total; idx = p.index; } $("mmvProgress").value = Math.min(1, (done + (p.phase === "measuring" || p.phase === "preparing" ? 0 : p.t)) / planTotal); setStatus(progressText(p)); }
    });
    state.results = results;
    showResults();
    setStatus(`Done. ${results.length === 1 ? "Your video is ready below." : `${results.length} videos are ready below.`} It stayed on this computer.`);
  } finally { $("mmvProgress").hidden = true; $("mmvCancel").hidden = true; state.abort = null; }
}

async function makeMyVideo() {
  if (state.busy || !clipsState()?.source) return;
  state.busy = true; refreshReady(); $("mmvResult").hidden = true; setReply($("mmvReply"));
  const source = clipsState().source, useModels = $("mmvModels").checked;
  try {
    // 1. understand the recording (reuses the analysis already done for this file)
    const cs = clipsState();
    $("tcUseModels").checked = useModels; $("tcUseModels").dispatchEvent(new Event("change"));
    if (!cs.analysis || cs.analysisFor !== source.id) {
      $("mmvProgress").hidden = false; $("mmvProgress").value = 0; $("mmvCancel").hidden = false;
      state.abort = { abort: () => api().cancelAnalysis(), signal: { aborted: false } };
      setStatus("Moxie is watching and listening to your recording…");
      await api().analyze({ onProgress: (p) => { $("mmvProgress").value = p.fraction * 0.5; if (p.message) setStatus(p.message); } });
      state.abort = null;
      if (!cs.analysis || cs.analysisFor !== source.id) throw new DOMException("Analysis cancelled", "AbortError");
    }
    // 2. decide the edit
    setStatus("Moxie is deciding the edit…");
    const size = await videoSize(source.blob);
    state.session = await openSession({ blob: source.blob, name: source.name, analysis: { ...cs.analysis, lines: cs.analysis.lines?.length ? cs.analysis.lines : source.lines }, width: size.width, height: size.height, duration: size.duration || source.duration, brollFiles: brollFiles() });
    state.edit = makeEdit(state.session, { style: state.style, aspect: aspect(), instruction: $("mmvInstruction").value });
    if (state.edit.settings.style !== state.style) { state.style = state.edit.settings.style; renderStyles(); }
    if (state.edit.settings.aspect !== aspect()) { const r = document.querySelector(`input[name=mmvAspect][value="${state.edit.settings.aspect}"]`); if (r) r.checked = true; }
    setReply($("mmvReply"), state.edit.reply.applied, state.edit.reply.unsupported);
    // 3. render it, with the audio measured
    await renderCurrent();
  } catch (error) {
    setStatus(error?.name === "AbortError" ? "Cancelled. Nothing was kept." : `Could not finish: ${error?.message || error}`);
  } finally { state.busy = false; $("mmvProgress").hidden = true; $("mmvCancel").hidden = true; refreshReady(); }
}

async function revise() {
  const text = $("mmvRevision").value.trim();
  if (!text || state.busy || !state.edit) return;
  const next = reviseEdit(state.session, state.edit, text);
  setReply($("mmvRevisionReply"), next.reply.applied, next.reply.unsupported);
  if (next.unchanged) { setStatus("Nothing was changed, so the video is the same."); return; }
  state.edit = next; state.busy = true; refreshReady();
  if (next.settings.style !== state.style) { state.style = next.settings.style; renderStyles(); }
  try { await renderCurrent(); $("mmvRevision").value = ""; }
  catch (error) { setStatus(error?.name === "AbortError" ? "Cancelled. The previous video is still below." : `Could not finish: ${error?.message || error}`); }
  finally { state.busy = false; refreshReady(); }
}

function downloadPlan() {
  const plans = state.results.map((r) => r.plan);
  const blob = new Blob([JSON.stringify(plans.length === 1 ? plans[0] : plans, null, 1)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = `${slug(state.session.name)}-edit-plan.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function bind() {
  $("mmvStyles").onclick = (e) => { const b = e.target.closest("[data-style]"); if (!b) return; state.style = b.dataset.style; renderStyles(); };
  $("mmvFile").onchange = (e) => { const f = e.target.files[0]; if (f) api().setSource({ id: `upload-${f.name}-${f.size}`, name: f.name, blob: f }); };
  const drop = $("mmvDrop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("is-over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f && /video|\.(mp4|mov|webm|m4v)$/i.test(f.type + f.name)) api().setSource({ id: `upload-${f.name}-${f.size}`, name: f.name, blob: f }); });
  $("mmvLibrary").onclick = (e) => { const b = e.target.closest("[data-recording]"); if (b) api().openRecording(b.dataset.recording); };
  $("mmvBroll").onchange = (e) => addBroll([...e.target.files]);
  $("mmvBrollList").oninput = (e) => { const i = e.target.dataset.broll; if (i != null) state.broll[i].tags = e.target.value.split(","); };
  $("mmvMake").onclick = makeMyVideo;
  $("mmvModels").onchange = () => { const t = $("tcUseModels"); t.checked = $("mmvModels").checked; t.dispatchEvent(new Event("change")); };
  $("mmvCancel").onclick = () => { setStatus("Cancelling…"); state.abort?.abort(); };
  $("mmvRevise").onclick = revise;
  $("mmvRevision").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); revise(); } };
  $("mmvPlanJson").onclick = downloadPlan;
  document.addEventListener("toasty:source", () => { state.results = []; $("mmvResult").hidden = true; setReply($("mmvReply")); setStatus(""); refreshReady(); });
}

async function init() {
  renderStyles(); bind(); refreshReady();
  try { state.logo = await loadImage("../shared/brand/toasty-media/ToastyMediaStudio.png"); } catch (_) {}
  if (api()) { loadLibrary(); setTimeout(() => { const t = $("tcUseModels"); if (t) $("mmvModels").checked = t.checked; }, 0); } else setStatus("The Clips workspace did not load.");
}
init();
