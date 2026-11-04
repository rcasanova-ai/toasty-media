// Controller for studio/shows.html: shows, seasons, episode order and production status. Episodes are ordinary sessions
// (plan.episode); this page only organises them. Status changes go through the same production endpoint Studio uses.
import { studioRequest } from "./studio-api.js";
import { createSession } from "./session-manager.js";
import { normalizeProduction, EPISODE_STATUSES, EPISODE_FORMATS, PUBLISHING_CADENCES, emptyEpisode, normalizeShow, orderSeasonEpisodes, moveInOrder, seasonProgress, readinessGaps } from "./episode-model.js";

const main = document.getElementById("shMain");
const params = new URLSearchParams(location.search);
let orgId = params.get("org") || "";
let shows = [];
let sessions = [];

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const opts = (list, cur) => list.map((o) => `<option value="${esc(o.id)}" ${o.id === cur ? "selected" : ""}>${esc(o.label)}</option>`).join("");
const post = (path, body) => studioRequest(path, { method: "POST", body: JSON.stringify(body) });

async function load() {
  try {
    [shows, sessions] = await Promise.all([
      studioRequest("/api/shows").then((r) => r.shows || []),
      studioRequest("/api/sessions").then((r) => (r.sessions || []).filter((s) => s.plan?.episode))
    ]);
    render();
  } catch (error) { main.innerHTML = `<p class="sh-err">${esc(error.message || "Could not load shows.")}</p>`; }
}

function saveShow(show) { return post("/api/shows", { organizationId: show.organizationId || orgId, show }).then(load); }

function episodeRow(s, season, index, total) {
  const e = s.plan.episode;
  const gaps = readinessGaps(e, { guestCount: 1 });
  const pill = e.status === "published" || e.status === "ready_to_publish" ? "good" : (e.status === "ready_to_record" ? "good" : "");
  return `<div class="sh-row" data-sid="${esc(s.id)}">
    <div class="grow"><strong>${e.number ? `${e.number}. ` : ""}${esc(e.workingTitle || s.title)}</strong>
      <div class="sh-muted">${esc(e.format.replace(/_/g, " "))} · ${e.plannedMinutes} min${e.releaseDate ? ` · release ${esc(e.releaseDate)}` : ""}${gaps.length && ["draft", "planned"].includes(e.status) ? ` · needs: ${esc(gaps[0].toLowerCase())}` : ""}</div></div>
    <select class="sh-sel" data-status aria-label="Status">${opts(EPISODE_STATUSES, e.status)}</select>
    <span class="sh-pill ${pill}">${esc(EPISODE_STATUSES.find((x) => x.id === e.status)?.label || "Draft")}</span>
    ${season ? `<button class="sh-btn ghost" data-move="up" ${index === 0 ? "disabled" : ""} aria-label="Move up">&uarr;</button><button class="sh-btn ghost" data-move="down" ${index === total - 1 ? "disabled" : ""} aria-label="Move down">&darr;</button>` : ""}
    <a class="sh-btn ghost" href="./plan.html?session=${encodeURIComponent(s.id)}&org=${encodeURIComponent(s.organizationId || orgId)}">Plan</a>
    <a class="sh-btn" href="./director.html?session=${encodeURIComponent(s.id)}">Record</a>
    ${productionHtml(s)}</div>`;
}

const clock = (sec) => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, "0")}`;
// After recording: the episode's own recordings, transcript, marked moments, clip candidates and finished exports.
function productionHtml(s) {
  const p = normalizeProduction(s.plan.episodeProduction);
  if (!p.recordings.length && !p.moments.length && !p.clips.length && !p.exports.length) return "";
  return `<details style="flex-basis:100%"><summary class="sh-muted">Recording and clips (${p.recordings.length} recording, ${p.moments.length} marked, ${p.clips.filter((c) => c.selected).length} clips selected)</summary>
    ${p.recordings.map((r) => `<p class="sh-muted">Recording ${esc(r.recordingId)} · ${clock(r.durationSeconds)}${p.transcript?.recordingId === r.recordingId ? ` · transcript ${p.transcript.lineCount} lines, speakers: ${esc(p.transcript.speakers.join(", ") || "unlabelled")}` : " · no transcript saved"}</p>`).join("")}
    ${p.moments.map((m) => `<div class="sh-row"><span class="grow">${esc(m.label)} at ${clock(m.atSeconds)}</span><button class="sh-btn ghost" data-make-clip="${esc(m.id)}">Make clip candidate</button><button class="sh-btn ghost" data-drop="moments:${esc(m.id)}">Remove</button></div>`).join("")}
    ${p.clips.map((c) => `<div class="sh-row"><label class="grow"><input type="checkbox" data-clip-select="${esc(c.id)}" ${c.selected ? "checked" : ""}> ${esc(c.label)} (${clock(c.startSeconds)} to ${clock(c.endSeconds)}, ${esc(c.source)})</label><button class="sh-btn ghost" data-drop="clips:${esc(c.id)}">Remove</button></div>`).join("")}
    ${p.exports.map((x) => `<p class="sh-muted">Exported: ${esc(x.label)} (${esc(x.kind)})</p>`).join("")}
    <div class="sh-row"><input class="sh-sel grow" data-export-label placeholder="Name an export you finished, e.g. Clip 1 vertical"><button class="sh-btn ghost" data-export-add>Record export</button></div></details>`;
}

function render() {
  const assigned = new Set();
  main.innerHTML = `
    ${shows.map((show) => {
      const body = (show.seasons || []).map((season) => {
        const eps = orderSeasonEpisodes(season, sessions);
        eps.forEach((x) => assigned.add(x.id));
        const p = seasonProgress(season, sessions);
        return `<div class="sh-card" data-season="${esc(season.id)}" data-show="${esc(show.id)}">
          <div class="sh-row"><div class="grow"><strong>${esc(season.title)}</strong>
            <div class="sh-muted">${p.total} episodes · ${p.completed} recorded or further${season.launchDate ? ` · launch ${esc(season.launchDate)}` : ""}${season.releaseCadence ? ` · ${esc(season.releaseCadence)}` : ""}</div></div>
            ${season.bufferTarget ? `<span class="sh-pill ${p.bufferMet ? "good" : "warn"}">${p.completed} of ${season.bufferTarget} ready before launch</span>` : ""}
            <button class="sh-btn ghost" data-edit-season>Season settings</button>
            <button class="sh-btn" data-new-episode>New episode</button></div>
          ${eps.length ? eps.map((x, i) => episodeRow(x, season, i, eps.length)).join("") : `<p class="sh-muted">No episodes yet.</p>`}
          <div data-season-form></div></div>`;
      }).join("");
      return `<section data-show-card="${esc(show.id)}"><div class="sh-card"><div class="sh-row"><div class="grow"><strong style="font-size:18px">${esc(show.title)}</strong>
        <div class="sh-muted">${esc(show.description || "")}</div><div class="sh-muted">Default ${show.defaultMinutes} min · ${esc((show.defaultFormat || "").replace(/_/g, " "))}${show.cadence ? ` · ${esc(show.cadence)}` : ""}</div></div>
        <button class="sh-btn ghost" data-edit-show>Show settings</button><button class="sh-btn" data-add-season>Add season</button></div><div data-show-form></div></div>${body}</section>`;
    }).join("")}
    ${(() => { const loose = sessions.filter((x) => !assigned.has(x.id)); return loose.length ? `<div class="sh-card"><strong>Episodes not in a season</strong>${loose.map((x) => episodeRow(x, null, 0, 0)).join("")}</div>` : ""; })()}
    <div class="sh-card"><strong>Create a show</strong><div id="newShowForm"></div><button class="sh-btn" id="newShowBtn">New show</button></div>`;
  wire();
}

function showFormHtml(s) {
  return `<div class="sh-grid">
    <div class="sh-field"><label>Title</label><input data-f="title" value="${esc(s.title)}"></div>
    <div class="sh-field"><label>Default length (min)</label><input data-f="defaultMinutes" type="number" min="1" value="${s.defaultMinutes}"></div>
    <div class="sh-field"><label>Default format</label><select data-f="defaultFormat">${opts(EPISODE_FORMATS, s.defaultFormat)}</select></div></div>
    <div class="sh-field"><label>Description</label><textarea data-f="description">${esc(s.description)}</textarea></div>
    <div class="sh-grid">
    <div class="sh-field"><label>Publishing cadence</label><select data-f="cadence">${opts(PUBLISHING_CADENCES, s.cadence)}</select></div>
    <div class="sh-field"><label>Tagline</label><input data-f="tagline" value="${esc(s.brand.tagline)}"></div>
    <div class="sh-field"><label>Accent colour</label><input data-f="accent" maxlength="7" placeholder="#ff7a29" value="${esc(s.brand.accent)}"></div></div>
    <button class="sh-btn" data-save-show>Save show</button> <span class="sh-muted" data-msg></span>`;
}

function readShowForm(box, base) {
  const v = (k) => box.querySelector(`[data-f="${k}"]`).value;
  return normalizeShow({ ...base, title: v("title"), description: v("description"), defaultMinutes: v("defaultMinutes"), defaultFormat: v("defaultFormat"), cadence: v("cadence"), brand: { ...base.brand, tagline: v("tagline"), accent: v("accent") } });
}

function seasonFormHtml(season) {
  return `<div class="sh-grid">
    <div class="sh-field"><label>Season title</label><input data-f="title" value="${esc(season.title)}"></div>
    <div class="sh-field"><label>Release cadence</label><select data-f="releaseCadence">${opts(PUBLISHING_CADENCES, season.releaseCadence)}</select></div>
    <div class="sh-field"><label>Launch date</label><input data-f="launchDate" type="date" value="${esc(season.launchDate)}"></div></div>
    <div class="sh-field"><label>Episodes to finish before launch</label><input data-f="bufferTarget" type="number" min="0" max="50" value="${season.bufferTarget}"></div>
    <button class="sh-btn" data-save-season>Save season</button> <span class="sh-muted" data-msg></span>`;
}

function wire() {
  document.getElementById("newShowBtn").addEventListener("click", () => {
    const box = document.getElementById("newShowForm");
    const blank = normalizeShow({ title: "", defaultMinutes: 60 });
    box.innerHTML = showFormHtml(blank);
    box.querySelector("[data-save-show]").addEventListener("click", () => {
      const show = readShowForm(box, blank);
      if (!show.title) { box.querySelector("[data-msg]").textContent = "Give the show a title."; return; }
      saveShow(show).catch((e) => { box.querySelector("[data-msg]").textContent = e.message; });
    });
  });
  main.querySelectorAll("[data-show-card]").forEach((card) => {
    const show = shows.find((s) => s.id === card.dataset.showCard);
    card.querySelector("[data-edit-show]").addEventListener("click", () => {
      const box = card.querySelector("[data-show-form]");
      box.innerHTML = showFormHtml(normalizeShow(show));
      box.querySelector("[data-save-show]").addEventListener("click", () => saveShow({ ...readShowForm(box, normalizeShow(show)), id: show.id, organizationId: show.organizationId }).catch((e) => { box.querySelector("[data-msg]").textContent = e.message; }));
    });
    card.querySelector("[data-add-season]").addEventListener("click", () => {
      const next = normalizeShow(show);
      next.seasons.push({ id: "", title: `Season ${next.seasons.length + 1}`, releaseCadence: next.cadence, launchDate: "", bufferTarget: 3, episodeOrder: [] });
      saveShow({ ...next, id: show.id, organizationId: show.organizationId });
    });
  });
  main.querySelectorAll("[data-season]").forEach((card) => {
    const show = shows.find((s) => s.id === card.dataset.show);
    const season = show.seasons.find((s) => s.id === card.dataset.season);
    const persist = (nextSeason) => saveShow({ ...normalizeShow({ ...show, seasons: show.seasons.map((x) => (x.id === season.id ? nextSeason : x)) }), id: show.id, organizationId: show.organizationId });
    card.querySelector("[data-edit-season]").addEventListener("click", () => {
      const box = card.querySelector("[data-season-form]");
      box.innerHTML = seasonFormHtml(season);
      box.querySelector("[data-save-season]").addEventListener("click", () => {
        const v = (k) => box.querySelector(`[data-f="${k}"]`).value;
        persist({ ...season, title: v("title"), releaseCadence: v("releaseCadence"), launchDate: v("launchDate"), bufferTarget: Number(v("bufferTarget")) || 0 }).catch((e) => { box.querySelector("[data-msg]").textContent = e.message; });
      });
    });
    card.querySelector("[data-new-episode]").addEventListener("click", async () => {
      const org = show.organizationId || orgId;
      if (!org) { alert("Open Shows and seasons from your dashboard so we know which organization to use."); return; }
      const count = sessions.filter((x) => x.plan.episode.seasonId === season.id).length;
      const created = await createSession({ title: "Untitled episode", organizationId: org });
      const episode = { ...emptyEpisode(), showId: show.id, seasonId: season.id, number: count + 1, plannedMinutes: show.defaultMinutes, format: show.defaultFormat };
      await post(`/api/sessions/${created.id}/plan`, { plan: { sessionType: "podcast", template: "story", expectedDurationMinutes: show.defaultMinutes, episode } });
      await post(`/api/sessions/${created.id}/episode`, { episode });
      location.href = `./plan.html?session=${encodeURIComponent(created.id)}&org=${encodeURIComponent(org)}&step=episode`;
    });
    card.querySelectorAll("[data-move]").forEach((btn) => btn.addEventListener("click", () => {
      const sid = btn.closest("[data-sid]").dataset.sid;
      const current = orderSeasonEpisodes(season, sessions).map((x) => x.id);
      persist({ ...season, episodeOrder: moveInOrder(current, sid, btn.dataset.move) });
    }));
  });
  const produce = (sid, op, item) => post(`/api/sessions/${sid}/episode-production`, { op, item }).then(load).catch((e) => alert(e.message));
  const rowSid = (node) => node.closest("[data-sid]").dataset.sid;
  main.querySelectorAll("[data-make-clip]").forEach((b) => b.addEventListener("click", () => {
    const sess = sessions.find((x) => x.id === rowSid(b)); const m = normalizeProduction(sess.plan.episodeProduction).moments.find((x) => x.id === b.dataset.makeClip);
    produce(sess.id, "clips", { id: `clip_${m.id}`, label: m.label, startSeconds: Math.max(0, m.atSeconds - 30), endSeconds: m.atSeconds + 30, source: "marker", selected: false, recordingId: m.recordingId });
  }));
  main.querySelectorAll("[data-clip-select]").forEach((b) => b.addEventListener("change", () => produce(rowSid(b), "clip_select", { id: b.dataset.clipSelect, selected: b.checked })));
  main.querySelectorAll("[data-drop]").forEach((b) => b.addEventListener("click", () => { const [kind, id] = b.dataset.drop.split(":"); produce(rowSid(b), "remove", { kind, id }); }));
  main.querySelectorAll("[data-export-add]").forEach((b) => b.addEventListener("click", () => { const input = b.closest(".sh-row").querySelector("[data-export-label]"); if (input.value.trim()) produce(rowSid(b), "exports", { id: `x_${Date.now()}`, kind: "export", label: input.value.trim() }); }));
  main.querySelectorAll("[data-status]").forEach((sel) => sel.addEventListener("change", async () => {
    sel.disabled = true;
    try { await post(`/api/sessions/${sel.closest("[data-sid]").dataset.sid}/episode-production`, { op: "status", item: { status: sel.value } }); await load(); } catch (e) { alert(e.message); sel.disabled = false; }
  }));
}

load();
