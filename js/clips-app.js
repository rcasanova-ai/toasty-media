// Toasty Clips workspace. Pick a Studio recording or upload a video, let Moxie suggest clips, nudge start and end, describe the
// look in plain English, pick a template, and render to 16:9, 9:16 and 1:1 on this computer. No timeline editor, no upload.
import { listMediaRecords, getMediaBlob } from "./media-store.js";
import { STARTER_TEMPLATES, ASPECTS, applyOverrides, getTemplate, validateTemplate } from "./clip-templates.js";
import { interpretInstruction } from "./clip-instructions.js";
import { decodeMono16k } from "./clip-analysis.js";
import { analyzeRecording } from "./behavior/engine.js";
import { MOMENT_CATEGORIES } from "./behavior/moments.js";
import { parseTranscript } from "./transcript-import.js";
import { CLIP_CATEGORIES } from "./clip-detector.js";
const CATEGORY_LABELS = { ...CLIP_CATEGORIES, ...MOMENT_CATEGORIES };
import { captionWords, captionChunks, computeFrame, planTimeline } from "./clip-timeline.js";
import { drawFrame } from "./clip-draw.js";
import { loadImage, renderBatch, renderCapabilities, renderClip } from "./clip-renderer.js";

const $ = (id) => document.getElementById(id);
const fmt = (s) => { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r < 10 ? "0" : ""}${r.toFixed(1)}`; };
const parseTime = (v) => { const m = String(v).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/); return m ? (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]) : null; };
const slug = (s) => String(s || "clip").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "clip";
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const state = { source: null, clips: [], active: -1, logo: null, busy: false, abort: null, results: [], musicBuffers: new Map(), pcm: null, analysis: null, analyzing: false, analyzeAbort: null };
const PREFS_KEY = "toasty.moxie.prefs";
const loadPrefs = () => { try { return { models: true, visual: true, ...JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") }; } catch (_) { return { models: true, visual: true }; } };
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ models: $("tcUseModels").checked, visual: $("tcUseVisual").checked })); } catch (_) {} };
window.__toastyClips = state;   // read-only handle for tests and diagnostics

const defaultSpec = () => ({ templateId: "toasty-classic", overrides: {}, title: "", subtitle: "", lt: { name: "", role: "" }, custom: [], images: [], musicFile: null, musicStyle: "template", musicGainDb: null, enhance: true, focusX: 0.5, aspects: ["16:9"], logoDefault: true });
const activeClip = () => state.clips[state.active] || null;

async function init() {
  const caps = renderCapabilities();
  $("tcSupport").textContent = caps.supported ? `Renders ${caps.container.toUpperCase()} on this computer.` : "This browser cannot render clips. Use a current Chrome, Edge or Safari.";
  $("tcRender").dataset.supported = caps.supported ? "1" : "0";
  try { state.logo = await loadImage("../shared/brand/toasty-media/ToastyMediaStudio.png"); } catch (_) {}
  const prefs = loadPrefs(); $("tcUseModels").checked = prefs.models; $("tcUseVisual").checked = prefs.visual;
  renderTemplates();
  bind();
  refreshLibrary();
}

// ---------- source ----------
async function refreshLibrary() {
  const list = $("tcLibrary");
  try {
    const records = (await listMediaRecords({ kind: "master-manifest" })).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (!records.length) { list.innerHTML = '<li class="tc-muted">No Studio recordings on this computer yet. Record in the Studio, or upload a video.</li>'; return; }
    const rows = [];
    for (const r of records.slice(0, 20)) {
      let manifest = null; try { manifest = JSON.parse(await (await getMediaBlob(r.id)).text()); } catch (_) {}
      const when = manifest?.startedAt ? new Date(manifest.startedAt).toLocaleString() : (r.updatedAt ? new Date(r.updatedAt).toLocaleString() : "");
      rows.push(`<li><button type="button" data-recording="${esc(r.metadata.recordingId || r.id)}">${esc(when)} · ${manifest?.durationSeconds ? fmt(manifest.durationSeconds).replace(/\.\d$/, "") : "?"}</button></li>`);
    }
    list.innerHTML = rows.join("");
  } catch (error) { list.innerHTML = `<li class="tc-muted">Could not read the library: ${esc(error?.message || error)}</li>`; }
}

async function openRecording(recordingId) {
  const { loadMasterRecording } = await import("./program-recording.js");
  const rec = await loadMasterRecording(recordingId);
  if (!rec.blob) { $("tcFindStatus").textContent = "That recording has no video stored."; return; }
  const manifest = rec.manifest || {};
  const startMs = manifest.startedAt ? Date.parse(manifest.startedAt) : null;
  const lines = (manifest.transcript?.lines || []).filter((l) => l.text && l.timestamp && startMs).map((l) => ({ t: Math.max(0, (new Date(l.timestamp).getTime() - startMs) / 1000), speaker: l.speaker || "", text: l.text }));
  await setSource({ id: recordingId, name: `Studio recording ${manifest.startedAt ? new Date(manifest.startedAt).toLocaleString() : recordingId}`, blob: rec.blob, lines, bookmarks: manifest.clipBookmarks || [] });
}

async function setSource({ id, name, blob, lines = [], bookmarks = [] }) {
  if (state.source?.url) URL.revokeObjectURL(state.source.url);
  const url = URL.createObjectURL(blob);
  if (!lines.length) { try { const cached = JSON.parse(localStorage.getItem(LINES_KEY(id)) || "null"); if (Array.isArray(cached)) lines = cached; } catch (_) {} }
  state.source = { id, name, blob, url, lines, events: [], duration: 0, bookmarks };
  state.clips = []; state.active = -1; state.pcm = null; state.results = []; state.analysis = null; showSignals(null);
  const v = $("tcVideo"); v.src = url;
  await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; setTimeout(r, 8000); });
  state.source.duration = Number.isFinite(v.duration) ? v.duration : 0;
  $("tcTranscriptCard").hidden = false; $("tcFind").disabled = false; $("tcAddHere").disabled = false; $("tcEdit").hidden = true;
  $("tcTranscriptNote").textContent = lines.length ? `${lines.length} transcript lines found${id.startsWith("upload-") ? " from the last analysis" : " from the Studio"}.` : "No transcript yet. Moxie will transcribe it on this computer when you analyze, or you can import one.";
  $("tcFindStatus").textContent = `${name} · ${fmt(state.source.duration).replace(/\.\d$/, "")}`;
  restore();
  renderClips();
}

// ---------- analysis ----------
const LINES_KEY = (id) => `toasty.clips.lines.${id}`;
const ANALYSIS_KEY = (id) => `toasty.clips.analysis.${id}`;

function specFromRecommendation(rec) {
  const sp = defaultSpec();
  if (!rec) return sp;
  sp.templateId = getTemplate(rec.templateId) ? rec.templateId : sp.templateId;
  if (rec.aspect) sp.aspects = [rec.aspect];
  if (rec.captions) sp.overrides = { captions: { style: rec.captions } };
  if (rec.focusX != null) sp.focusX = rec.focusX;
  return sp;
}

function showSignals(analysis) {
  if (!analysis) { $("tcSignalsCard").hidden = true; return; }
  const caps = analysis.engine?.capabilities || {}, on = (k) => caps[k]?.available;
  const row = (ok, text) => `<li class="${ok ? "" : "is-off"}">${esc(text)}</li>`;
  const sem = analysis.engine?.semantic;
  $("tcSignals").innerHTML = [
    row(on("transcript"), on("transcript") ? `Words: ${caps.transcript.detail}` : "Words: none (no transcript)"),
    row(sem === "minilm" || sem === "lexical", sem === "minilm" ? "Meaning: sentence-embedding model (local)" : sem === "lexical" ? "Meaning: shared-vocabulary fallback (no model)" : "Meaning: not analysed"),
    row(on("audio"), on("audio") ? "Voice: level, pitch, pace, pauses, laughter, overlap" : "Voice: audio could not be read"),
    row(on("face"), on("face") ? "Faces: smiles, brows, head turns, nods, leaning" : "Faces: none detected or not tracked"),
    row(on("hands") || on("pose"), on("hands") || on("pose") ? "Hands and posture: tracked" : "Hands and posture: not tracked"),
    row(on("motion"), on("motion") ? "Movement: measured from the picture" : "Movement: not measured")
  ].join("");
  $("tcNotes").innerHTML = (analysis.notes || []).map((n) => `<li>${esc(n)}</li>`).join("");
  $("tcSignalsCard").hidden = false;
}

async function findClips() {
  const s = state.source; if (!s || state.analyzing) return;
  const useModels = $("tcUseModels").checked, useVisual = $("tcUseVisual").checked; savePrefs();
  const hooks = window.__moxieHooks || {};
  state.analyzing = true; state.analyzeAbort = new AbortController();
  $("tcFind").disabled = true; $("tcAnalyzeCancel").hidden = false; $("tcAnalyzeProgress").hidden = false; $("tcAnalyzeProgress").value = 0;
  const weights = { audio: [0, 0.05], transcript: [0.05, 0.4], picture: [0.45, 0.25], voice: [0.7, 0.08], language: [0.78, 0.14], interaction: [0.92, 0.04], moments: [0.96, 0.04] };
  try {
    const res = await analyzeRecording({
      blob: s.blob, lines: s.lines, id: s.id, source: s.id.startsWith("upload-") ? "upload" : "studio", knownDuration: s.duration, signal: state.analyzeAbort.signal,
      deps: hooks.deps || {},
      options: { transcribe: useModels, visual: useVisual, tracker: useModels ? "auto" : "off", embedder: { disableModel: !useModels, ...(hooks.embedder || {}) }, worker: hooks.worker, ...(hooks.options || {}) },
      onProgress: (p) => { const [base, span] = weights[p.stage] || [0, 0]; $("tcAnalyzeProgress").value = Math.min(1, base + span * (p.fraction || 0)); if (p.message) $("tcFindStatus").textContent = p.message; }
    });
    if (res.lines?.length && !s.lines.length) { s.lines = res.lines; try { localStorage.setItem(LINES_KEY(s.id), JSON.stringify(res.lines)); } catch (_) {} }
    state.analysis = res; s.events = [];
    const fromStudio = (s.bookmarks || []).map((b) => ({ ...b, source: b.source || "live", categories: b.categories || [b.category] }));
    const merged = [...fromStudio];
    for (const c of res.clips) if (!fromStudio.some((m) => m.start < c.end && c.start < m.end)) merged.push(c);   // Studio bookmarks win over a Moxie clip on the same stretch
    merged.sort((a, b) => a.start - b.start);
    state.clips = merged.map((c) => ({ ...c, selected: c.source === "command" || (c.tier ? c.tier !== "low" : c.score >= 60), spec: specFromRecommendation(c.recommendation) }));
    // Never leave the list empty because nothing was "strong": the best coherent passages are always offered, labelled as such.
    if (state.clips.length && !state.clips.some((c) => c.selected)) state.clips[0].selected = true;
    const usedWords = res.timeline.has("transcript");
    $("tcFindStatus").textContent = state.clips.length
      ? `Moxie found ${state.clips.length} moment${state.clips.length === 1 ? "" : "s"}${res.fallback ? ", none of them standing out strongly, so these are the most coherent passages" : ""}${usedWords ? "" : " from sound and picture only (no transcript)"}.`
      : `Moxie could not analyse this file: ${(res.notes || []).slice(-1)[0] || "there was no readable speech, sound or picture"}. You can still add a clip at the playhead.`;
    showSignals(res); persistAnalysis();
    if (state.clips.length) selectClip(0);
    renderClips();
    const lineNote = s.lines.length ? `${s.lines.length} transcript lines` : "";
    if (lineNote) $("tcTranscriptNote").textContent = `${lineNote}.`;
  } catch (error) {
    $("tcFindStatus").textContent = error?.name === "AbortError" ? "Analysis cancelled." : (error?.message || String(error));
  } finally { state.analyzing = false; state.analyzeAbort = null; $("tcFind").disabled = false; $("tcAnalyzeCancel").hidden = true; $("tcAnalyzeProgress").hidden = true; }
}

function persistAnalysis() {
  const s = state.source, a = state.analysis; if (!s || !a) return;
  try { localStorage.setItem(ANALYSIS_KEY(s.id), JSON.stringify({ notes: a.notes, engine: a.engine, fallback: a.fallback, capabilities: a.engine?.capabilities })); } catch (_) {}
}

function exportTimeline() {
  const a = state.analysis; if (!a) return;
  const blob = new Blob([JSON.stringify(a.timeline.toJSON(), null, 1)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${slug(state.source.name)}-behavior-timeline.json`; document.body.appendChild(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

async function importTranscript(file) {
  const text = await file.text();
  const lines = parseTranscript(text);
  state.source.lines = lines;
  try { localStorage.setItem(LINES_KEY(state.source.id), JSON.stringify(lines)); } catch (_) {}
  $("tcTranscriptNote").textContent = lines.length ? `Imported ${lines.length} lines from ${file.name}.` : `Could not find timed lines in ${file.name}. Use SRT, VTT, or lines like [00:12] Name: text.`;
}

// ---------- clip list ----------
const TIER_LABEL = { high: "Strong moment", medium: "Good moment", low: "Best available passage" };
function renderClips() {
  const ol = $("tcClips");
  const n = state.clips.filter((c) => c.selected).length;
  $("tcSummary").textContent = state.clips.length ? `${n} of ${state.clips.length} selected` : "";
  $("tcRender").disabled = !n || state.busy || $("tcRender").dataset.supported !== "1";
  ol.innerHTML = state.clips.map((c, i) => {
    const rec = c.recommendation, ev = c.evidence || [];
    return `
    <li class="tc-clip${i === state.active ? " is-active" : ""}" data-i="${i}">
      <div class="tc-clip-head">
        <input type="checkbox" data-act="select" ${c.selected ? "checked" : ""} aria-label="Select clip ${i + 1}">
        <input type="text" data-act="title" value="${esc(c.title)}" aria-label="Clip title">
        <span class="tc-chip">${esc(CATEGORY_LABELS[c.category] || "Moment")}</span>${c.tier ? `<span class="tc-tier is-${c.tier}">${TIER_LABEL[c.tier]}</span>` : ""}<span class="tc-score" title="Moxie's ranking score (0 to 100)">${c.score}</span>
      </div>
      <div class="tc-clip-meta"><span>${fmt(c.start)} – ${fmt(c.end)} (${Math.round(c.end - c.start)} s)</span></div>
      <p class="tc-clip-why">${esc(c.explanation || c.reason || "")}</p>
      ${ev.length ? `<details><summary>Evidence (${ev.length})</summary><ul>${ev.map((e) => `<li>${esc(fmt(e.t))} · ${esc(e.modality)}: ${esc(e.label)}</li>`).join("")}</ul></details>` : ""}
      ${rec ? `<p class="tc-rec">Recommended: ${esc(rec.aspect)}, ${esc((getTemplate(rec.templateId) || {}).name || rec.templateId)}${rec.captions && rec.captions !== "none" ? `, ${esc(rec.captions)} captions` : ""}. ${esc(rec.reason)}</p>` : ""}
      <div class="tc-clip-actions"><button class="tc-btn tc-ghost" data-act="play" type="button">Play</button><button class="tc-btn tc-ghost" data-act="edit" type="button">Edit</button><button class="tc-btn tc-ghost" data-act="remove" type="button">Remove</button></div>
    </li>`;
  }).join("");
}

function selectClip(i) {
  state.active = i; const c = activeClip();
  $("tcEdit").hidden = !c; renderClips(); if (!c) return;
  $("tcStart").value = fmt(c.start); $("tcEnd").value = fmt(c.end); updateLen();
  const sp = c.spec;
  $("tcTitle").value = sp.title || c.title || ""; $("tcSubtitle").value = sp.subtitle || ""; $("tcLtName").value = sp.lt.name; $("tcLtRole").value = sp.lt.role;
  $("tcCustomText").value = sp.custom[0]?.text || ""; $("tcCustomAt").value = sp.custom[0]?.at ?? 2;
  $("tcMusic").value = sp.musicStyle; $("tcMusicFileWrap").hidden = sp.musicStyle !== "file"; $("tcEnhance").checked = sp.enhance; $("tcFocus").value = sp.focusX; $("tcLogoDefault").checked = sp.logoDefault;
  document.querySelectorAll("[data-aspect]").forEach((cb) => { cb.checked = sp.aspects.includes(cb.dataset.aspect); });
  syncTemplateControls(); $("tcUnderstood").innerHTML = "";
  const v = $("tcVideo"); v.currentTime = c.start; drawPreview(0);
}

function resolvedTemplate(c = activeClip()) {
  const sp = c.spec, base = getTemplate(sp.templateId) || getTemplate("toasty-classic");
  const ov = JSON.parse(JSON.stringify(sp.overrides || {}));
  if (sp.musicStyle !== "template" && sp.musicStyle !== "file") ov.music = { ...(ov.music || {}), style: sp.musicStyle };
  if (sp.musicStyle === "file") ov.music = { ...(ov.music || {}), style: "none" };
  if (sp.musicGainDb != null) ov.music = { ...(ov.music || {}), gainDb: sp.musicGainDb };
  ov.overlays = { ...(ov.overlays || {}), logo: sp.logoDefault, lowerThird: Boolean(sp.lt.name) || (ov.overlays?.lowerThird ?? base.overlays.lowerThird) };
  ov.audio = { ...(ov.audio || {}), enhance: sp.enhance };
  return applyOverrides(base, ov);
}

function syncTemplateControls() {
  const c = activeClip(); if (!c) return;
  const tpl = resolvedTemplate(c);
  $("tcCaptions").value = tpl.captions.style; $("tcIntro").checked = tpl.intro.kind !== "none"; $("tcOutro").checked = tpl.outro.kind !== "none";
  $("tcMusicGain").value = c.spec.musicGainDb ?? tpl.music.gainDb; $("tcMusicGainLabel").textContent = `${$("tcMusicGain").value} dB`;
  document.querySelectorAll(".tc-tpl").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.tpl === c.spec.templateId)));
}

function renderTemplates() {
  $("tcTemplates").innerHTML = STARTER_TEMPLATES.map((t) => `<button type="button" class="tc-tpl" role="radio" aria-checked="false" data-tpl="${t.id}"><span class="tc-swatch"><i style="background:${t.theme.bg}"></i><i style="background:${t.theme.accent}"></i><i style="background:${t.theme.accent2}"></i><i style="background:${t.theme.fg}"></i></span><strong>${esc(t.name)}</strong><small>${esc(t.description)}</small></button>`).join("");
}

function updateLen() { const c = activeClip(); if (c) $("tcLen").textContent = `${Math.max(0, c.end - c.start).toFixed(1)} s`; }
function setRange(start, end) {
  const c = activeClip(); if (!c) return;
  const dur = state.source.duration || Infinity;
  start = Math.max(0, Math.min(start, dur)); end = Math.min(dur, Math.max(end, start + 1));
  c.start = Math.round(start * 10) / 10; c.end = Math.round(end * 10) / 10;
  $("tcStart").value = fmt(c.start); $("tcEnd").value = fmt(c.end); updateLen(); renderClips(); drawPreview($("tcScrub").value * planFor(c).total); persist();
}
function planFor(c) { return planTimeline(resolvedTemplate(c), Math.max(1, c.end - c.start)); }

// ---------- preview ----------
let previewToken = 0;
async function drawPreview(t) {
  const c = activeClip(); if (!c || !state.source) return;
  const tpl = resolvedTemplate(c), plan = planFor(c), canvas = $("tcPreview"), aspectKey = c.spec.aspects[0] || "16:9", a = ASPECTS[aspectKey];
  canvas.width = 640; canvas.height = Math.round(640 * a.height / a.width);
  const sec = Math.max(0, Math.min(plan.total, t)), v = $("tcVideo"), token = ++previewToken;
  const clipT = sec - plan.intro;
  if (clipT >= 0 && clipT <= c.end - c.start) { const target = c.start + clipT; if (Math.abs(v.currentTime - target) > 0.05) { v.currentTime = target; await new Promise((r) => { v.onseeked = r; setTimeout(r, 600); }); } }
  if (token !== previewToken) return;
  const lines = state.source.lines, words = captionWords(lines, c.start, c.end);
  const f = computeFrame({ tpl, plan, words, chunks: captionChunks(words, tpl.captions.style), t: sec, vars: { title: c.spec.title || c.title }, spec: frameSpec(c) });
  drawFrame(canvas.getContext("2d"), f, tpl, { W: canvas.width, H: canvas.height, video: v, assets: { logo: state.logo }, focusX: c.spec.focusX, images: imageList(c) });
}
const frameSpec = (c) => ({ title: c.spec.title || c.title, subtitle: c.spec.subtitle || undefined, lowerThird: c.spec.lt.name ? { ...c.spec.lt } : undefined, custom: c.spec.custom.filter((x) => x.text) });
const imageList = (c) => c.spec.images.filter((i) => i.img).map((i) => ({ ...i }));

// ---------- rendering ----------
function buildJobs() {
  const jobs = [];
  for (const c of state.clips.filter((x) => x.selected)) {
    for (const aspect of c.spec.aspects.length ? c.spec.aspects : ["16:9"]) {
      const tpl = resolvedTemplate(c);
      const music = c.spec.musicStyle === "file" && c.spec.musicFile ? { buffer: state.musicBuffers.get(c.spec.musicFile.name) || null, style: "none" } : { style: tpl.music.style };
      jobs.push({ label: `${c.title} (${aspect})`, name: `${slug(c.title)}-${aspect.replace(":", "x")}`, spec: { clip: { start: c.start, end: c.end }, template: tpl, aspect, title: c.spec.title || c.title, subtitle: c.spec.subtitle || undefined, lowerThird: c.spec.lt.name ? { ...c.spec.lt } : undefined, custom: c.spec.custom.filter((x) => x.text), lines: state.source.lines, focusX: c.spec.focusX, enhance: c.spec.enhance, images: imageList(c), logo: c.spec.logoDefault ? state.logo : null, music } });
    }
  }
  return jobs;
}

async function renderSelected() {
  if (state.busy) return;
  const jobs = buildJobs(); if (!jobs.length) return;
  state.busy = true; state.abort = new AbortController(); $("tcRender").disabled = true; $("tcCancel").hidden = false; $("tcProgress").hidden = false; $("tcResults").innerHTML = ""; $("tcDownloadAll").hidden = true;
  const total = jobs.reduce((s, j) => s + planTimeline(j.spec.template, j.spec.clip.end - j.spec.clip.start).total, 0);
  let done = 0, current = 0;
  const results = await renderBatch({ source: state.source.blob, jobs, signal: state.abort.signal, onProgress: (p) => {
    if (p.index !== current) { done += planTimeline(jobs[current].spec.template, jobs[current].spec.clip.end - jobs[current].spec.clip.start).total; current = p.index; }
    $("tcProgress").value = Math.min(1, (done + p.t) / total);
    $("tcRenderStatus").textContent = `Rendering ${p.index + 1} of ${p.count}: ${p.job.label} (${p.phase}, ${Math.round(p.t)} of ${Math.round(p.total)} s). Keep this tab open.`;
  } });
  state.results = results.map((r) => ({ ...r, url: r.ok ? URL.createObjectURL(r.blob) : null, filename: r.ok ? `${r.job.name}.${r.container}` : null }));
  $("tcResults").innerHTML = state.results.map((r, i) => r.ok ? `<li><span>${esc(r.job.label)} · ${r.width}×${r.height} · ${(r.blob.size / 1048576).toFixed(1)} MB · ${r.container.toUpperCase()}</span><a class="tc-btn tc-primary" href="${r.url}" download="${esc(r.filename)}">Download</a></li>` : `<li class="is-error"><span>${esc(r.job.label)}: ${esc(r.error)}</span></li>`).join("");
  const ok = state.results.filter((r) => r.ok).length;
  $("tcRenderStatus").textContent = `${ok} of ${jobs.length} rendered${state.abort.signal.aborted ? " (cancelled)" : ""}. Files are on this computer only.`;
  $("tcDownloadAll").hidden = ok < 2;
  state.busy = false; state.abort = null; $("tcCancel").hidden = true; $("tcProgress").hidden = true; renderClips();
}

async function renderPreviewVideo() {
  const c = activeClip(); if (!c || state.busy) return;
  const btn = $("tcRenderPreview"); btn.disabled = true; state.busy = true;
  try {
    const job = buildPreviewJob(c);
    const r = await renderClip({ source: state.source.blob, spec: job.spec, onProgress: (p) => { btn.textContent = `Rendering preview… ${Math.round(p.t)} / ${Math.round(p.total)} s`; } });
    const pv = $("tcPreviewVideo"); if (pv.src) URL.revokeObjectURL(pv.src); pv.src = URL.createObjectURL(r.blob); pv.hidden = false; pv.play().catch(() => {});
  } catch (error) { btn.textContent = `Preview failed: ${error?.message || error}`; }
  finally { state.busy = false; btn.disabled = false; setTimeout(() => { btn.textContent = "Render a preview (plays in real time)"; }, 4000); renderClips(); }
}
function buildPreviewJob(c) { const sel = c.selected; c.selected = true; const jobs = buildJobs().filter((j) => j.spec.clip.start === c.start && j.spec.clip.end === c.end); c.selected = sel; return jobs[0]; }

// ---------- events ----------
function bind() {
  $("tcRefresh").onclick = refreshLibrary;
  $("tcLibrary").onclick = (e) => { const b = e.target.closest("[data-recording]"); if (b) openRecording(b.dataset.recording); };
  $("tcFile").onchange = (e) => { const f = e.target.files[0]; if (f) setSource({ id: `upload-${f.name}-${f.size}`, name: f.name, blob: f }); };
  const drop = $("tcDrop");
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("is-over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("is-over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer?.files?.[0]; if (f && /video|\.(mp4|mov|webm|m4v)$/i.test(f.type + f.name)) setSource({ id: `upload-${f.name}-${f.size}`, name: f.name, blob: f }); });
  $("tcFind").onclick = findClips;
  $("tcAnalyzeCancel").onclick = () => state.analyzeAbort?.abort();
  $("tcExportTimeline").onclick = exportTimeline;
  $("tcUseModels").onchange = savePrefs; $("tcUseVisual").onchange = savePrefs;
  $("tcTranscriptFile").onchange = (e) => e.target.files[0] && importTranscript(e.target.files[0]);
  $("tcAddHere").onclick = () => { const v = $("tcVideo"), t = v.currentTime || 0; state.clips.push({ id: `manual-${Date.now()}`, start: Math.max(0, t - 5), end: Math.min(state.source.duration || t + 25, t + 25), title: "My clip", category: "clip-that", score: 100, reason: "Added by you", source: "manual", selected: true, spec: defaultSpec() }); state.clips.sort((a, b) => a.start - b.start); selectClip(state.clips.findIndex((c) => c.source === "manual" && Math.abs(c.start - Math.max(0, t - 5)) < 0.01)); persist(); };
  $("tcClips").onclick = (e) => {
    const li = e.target.closest("[data-i]"); if (!li) return; const i = Number(li.dataset.i), c = state.clips[i], act = e.target.dataset.act;
    if (act === "select") { c.selected = e.target.checked; renderClips(); persist(); }
    else if (act === "edit") selectClip(i);
    else if (act === "remove") { state.clips.splice(i, 1); state.active = -1; $("tcEdit").hidden = true; renderClips(); persist(); }
    else if (act === "play") { const v = $("tcVideo"); v.currentTime = c.start; v.play(); const stop = () => { if (v.currentTime >= c.end) { v.pause(); v.removeEventListener("timeupdate", stop); } }; v.addEventListener("timeupdate", stop); }
  };
  $("tcClips").oninput = (e) => { if (e.target.dataset.act === "title") { const li = e.target.closest("[data-i]"); state.clips[li.dataset.i].title = e.target.value; persist(); } };
  $("tcStart").onchange = () => { const v = parseTime($("tcStart").value), c = activeClip(); if (v != null && c) setRange(v, c.end); };
  $("tcEnd").onchange = () => { const v = parseTime($("tcEnd").value), c = activeClip(); if (v != null && c) setRange(c.start, v); };
  document.querySelectorAll("[data-nudge]").forEach((b) => b.onclick = () => { const c = activeClip(); if (!c) return; const [which, d] = b.dataset.nudge.split(":"); which === "start" ? setRange(c.start + Number(d), c.end) : setRange(c.start, c.end + Number(d)); });
  $("tcSetStart").onclick = () => { const c = activeClip(); if (c) setRange($("tcVideo").currentTime, c.end); };
  $("tcSetEnd").onclick = () => { const c = activeClip(); if (c) setRange(c.start, $("tcVideo").currentTime); };
  $("tcApply").onclick = applyInstruction;
  $("tcTemplates").onclick = (e) => { const b = e.target.closest("[data-tpl]"); const c = activeClip(); if (!b || !c) return; c.spec.templateId = b.dataset.tpl; c.spec.overrides = {}; c.spec.musicStyle = "template"; c.spec.musicGainDb = null; syncTemplateControls(); $("tcMusic").value = "template"; redraw(); persist(); };
  const ov = (path, value) => { const c = activeClip(); if (!c) return; let cur = c.spec.overrides; const k = path.split("."); k.slice(0, -1).forEach((p) => { cur = cur[p] ??= {}; }); cur[k[k.length - 1]] = value; redraw(); persist(); };
  $("tcCaptions").onchange = (e) => ov("captions.style", e.target.value);
  $("tcIntro").onchange = (e) => { const c = activeClip(), base = resolvedTemplate(c); ov("intro.kind", e.target.checked ? (base.intro.kind === "none" ? "title-card" : base.intro.kind) : "none"); };
  $("tcOutro").onchange = (e) => ov("outro.kind", e.target.checked ? "brand-end" : "none");
  const bindText = (id, set) => { $(id).oninput = (e) => { const c = activeClip(); if (c) { set(c, e.target.value); redraw(); persist(); } }; };
  bindText("tcTitle", (c, v) => { c.spec.title = v; }); bindText("tcSubtitle", (c, v) => { c.spec.subtitle = v; });
  bindText("tcLtName", (c, v) => { c.spec.lt.name = v; }); bindText("tcLtRole", (c, v) => { c.spec.lt.role = v; });
  const custom = () => { const c = activeClip(); if (!c) return; const text = $("tcCustomText").value.trim(); c.spec.custom = text ? [{ text, at: Number($("tcCustomAt").value) || 0, dur: 3, position: "center" }] : []; redraw(); persist(); };
  $("tcCustomText").oninput = custom; $("tcCustomAt").oninput = custom;
  $("tcLogoDefault").onchange = (e) => { const c = activeClip(); if (c) { c.spec.logoDefault = e.target.checked; redraw(); persist(); } };
  $("tcImage").onchange = async (e) => { const f = e.target.files[0], c = activeClip(); if (!f || !c) return; const img = await loadImage(f); c.spec.images = [{ img, kind: "logo", position: $("tcImagePos").value, size: Number($("tcImageSize").value), at: 0, dur: 1e9, name: f.name }]; $("tcImageNote").textContent = `${f.name} added (kept in this tab only).`; redraw(); };
  $("tcImagePos").onchange = (e) => { const c = activeClip(); if (c?.spec.images[0]) { c.spec.images[0].position = e.target.value; redraw(); } };
  $("tcImageSize").oninput = (e) => { const c = activeClip(); if (c?.spec.images[0]) { c.spec.images[0].size = Number(e.target.value); redraw(); } };
  $("tcMusic").onchange = (e) => { const c = activeClip(); if (!c) return; c.spec.musicStyle = e.target.value; $("tcMusicFileWrap").hidden = e.target.value !== "file"; redraw(); persist(); };
  $("tcMusicFile").onchange = async (e) => { const f = e.target.files[0], c = activeClip(); if (!f || !c) return; try { const ctx = new AudioContext({ sampleRate: 48000 }); const buf = await ctx.decodeAudioData(await f.arrayBuffer()); await ctx.close(); state.musicBuffers.set(f.name, buf); c.spec.musicFile = { name: f.name }; $("tcMusicFileWrap").firstChild.textContent = `Music: ${f.name}`; } catch (_) { $("tcMusicFileWrap").firstChild.textContent = "That file could not be read as audio."; } };
  $("tcMusicGain").oninput = (e) => { const c = activeClip(); if (c) { c.spec.musicGainDb = Number(e.target.value); $("tcMusicGainLabel").textContent = `${e.target.value} dB`; persist(); } };
  $("tcEnhance").onchange = (e) => { const c = activeClip(); if (c) { c.spec.enhance = e.target.checked; persist(); } };
  $("tcFocus").oninput = (e) => { const c = activeClip(); if (c) { c.spec.focusX = Number(e.target.value); redraw(); persist(); } };
  document.querySelectorAll("[data-aspect]").forEach((cb) => cb.onchange = () => { const c = activeClip(); if (!c) return; c.spec.aspects = [...document.querySelectorAll("[data-aspect]")].filter((x) => x.checked).map((x) => x.dataset.aspect); if (!c.spec.aspects.length) { c.spec.aspects = ["16:9"]; cb.checked = cb.dataset.aspect === "16:9"; } redraw(); persist(); });
  $("tcScrub").oninput = (e) => { const c = activeClip(); if (c) drawPreview(Number(e.target.value) * planFor(c).total); };
  $("tcRenderPreview").onclick = renderPreviewVideo;
  $("tcRender").onclick = renderSelected;
  $("tcCancel").onclick = () => state.abort?.abort();
  $("tcDownloadAll").onclick = () => { state.results.filter((r) => r.ok).forEach((r, i) => setTimeout(() => { const a = document.createElement("a"); a.href = r.url; a.download = r.filename; document.body.appendChild(a); a.click(); a.remove(); }, i * 600)); };
}
const redraw = () => drawPreview(Number($("tcScrub").value) * (activeClip() ? planFor(activeClip()).total : 0));

function applyInstruction() {
  const c = activeClip(); if (!c) return;
  const r = interpretInstruction($("tcInstruction").value, { clip: { start: c.start, end: c.end } });
  const sp = c.spec;
  if (r.template) { sp.templateId = r.template; sp.overrides = {}; sp.musicStyle = "template"; sp.musicGainDb = null; }
  const merge = (a, b) => { for (const k of Object.keys(b)) a[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) ? merge(a[k] && typeof a[k] === "object" ? a[k] : {}, b[k]) : b[k]; return a; };
  merge(sp.overrides, r.overrides);
  if (r.overrides.music?.style) sp.musicStyle = r.overrides.music.style;
  if (r.overrides.music?.gainDb != null) sp.musicGainDb = r.overrides.music.gainDb;
  if (r.overrides.audio?.enhance != null) sp.enhance = r.overrides.audio.enhance;
  if (r.aspect) { sp.aspects = [r.aspect]; }
  if (r.spec.title) sp.title = r.spec.title; if (r.spec.subtitle) sp.subtitle = r.spec.subtitle;
  if (r.spec.lowerThird) sp.lt = r.spec.lowerThird;
  if (r.spec.custom.length) sp.custom = r.spec.custom;
  if (r.spec.trim) { c.start = Math.max(0, r.spec.trim.start); c.end = Math.min(state.source.duration || Infinity, r.spec.trim.end); }
  $("tcUnderstood").innerHTML = [...r.understood.map((u) => `<li>${esc(u)}</li>`), ...r.ignored.map((u) => `<li class="is-ignored">Could not do: ${esc(u)}</li>`)].join("") || "<li>Nothing to change.</li>";
  const keepUnderstood = $("tcUnderstood").innerHTML; selectClip(state.active); $("tcUnderstood").innerHTML = keepUnderstood;
  persist();
}

// ---------- persistence (settings only; never the video) ----------
const KEY = (id) => `toasty.clips.${id}`;
function persist() {
  const s = state.source; if (!s) return;
  try { localStorage.setItem(KEY(s.id), JSON.stringify(state.clips.map((c) => ({ ...c, spec: { ...c.spec, images: [], musicFile: null } })))); } catch (_) {}
}
function restore() {
  const s = state.source; if (!s) return;
  try { const saved = JSON.parse(localStorage.getItem(KEY(s.id)) || "null"); if (Array.isArray(saved)) { state.clips = saved.map((c) => ({ ...c, spec: { ...defaultSpec(), ...c.spec } })); if (state.clips.length) { $("tcFindStatus").textContent = `Restored ${state.clips.length} clips from your last visit.`; selectClip(0); try { const a = JSON.parse(localStorage.getItem(ANALYSIS_KEY(s.id)) || "null"); if (a) showSignals(a); } catch (_) {} } } } catch (_) {}
}

init();
