// Episode steps for the existing Session Planner wizard (studio/plan.html). A session becomes an episode when the host
// turns on "This is an episode of a show"; the steps below then appear in the same guided path. Nothing is scripted:
// every story field is optional free text and Moxie only organises or questions what the host wrote.
import { studioRequest } from "./studio-api.js";
import {
  EPISODE_STATUSES, EPISODE_FORMATS, PUBLISHING_CADENCES, EPISODE_MOXIE_PROMPTS,
  emptyEpisode, normalizeEpisode, emptyShow, normalizeShow, applyShowDefaults, readinessGaps
} from "./episode-model.js";

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const opts = (list, current) => list.map((o) => `<option value="${esc(o.id)}" ${o.id === current ? "selected" : ""}>${esc(o.label)}</option>`).join("");
const joinLines = (list) => (list || []).join("\n");
const field = (label, html, hint = "") => `<div class="plan-field"><label>${label}</label>${html}${hint ? `<small style="color:#8f857b">${hint}</small>` : ""}</div>`;

let shows = [];

export function isEpisodeMode(plan) {
  return Boolean(plan.episode && typeof plan.episode === "object");
}

export function enableEpisodeMode(plan) {
  if (!isEpisodeMode(plan)) plan.episode = { ...emptyEpisode(), plannedMinutes: plan.expectedDurationMinutes || 60 };
}

export async function loadShows() {
  try { shows = (await studioRequest("/api/shows")).shows || []; } catch { shows = []; }
  return shows;
}

async function saveEpisode(ctx) {
  const result = await studioRequest(`/api/sessions/${ctx.session.id}/episode`, { method: "POST", body: JSON.stringify({ episode: ctx.plan.episode }) });
  ctx.plan.episode = normalizeEpisode(result.session.plan.episode);
  ctx.plan.episodeProduction = result.session.plan.episodeProduction;
}

// ---------- Step: episode and show ----------
export function renderEpisodeStep(ctx) {
  const { main, plan, session } = ctx;
  enableEpisodeMode(plan);
  const e = plan.episode;
  const show = shows.find((s) => s.id === e.showId);
  const seasons = show?.seasons || [];
  main.innerHTML = `
    <h1>Episode and show</h1>
    <p style="color:#8f857b">Choose the show this episode belongs to, or create one. A show remembers your defaults so the next episode starts faster. <a href="./shows.html" style="color:#f5a67b">Manage shows and seasons</a></p>
    <div class="plan-grid-2">
      ${field("Show", `<select id="epShow"><option value="">No show (standalone episode)</option>${shows.map((s) => `<option value="${esc(s.id)}" ${s.id === e.showId ? "selected" : ""}>${esc(s.title)}</option>`).join("")}<option value="__new">Create a new show…</option></select>`)}
      ${field("Season", `<select id="epSeason"><option value="">No season</option>${seasons.map((s) => `<option value="${esc(s.id)}" ${s.id === e.seasonId ? "selected" : ""}>${esc(s.title)}</option>`).join("")}${show ? `<option value="__new">Add a season…</option>` : ""}</select>`)}
    </div>
    <div id="epShowForm" hidden></div>
    <div class="plan-grid-3">
      ${field("Episode number", `<input id="epNumber" type="number" min="1" value="${e.number || ""}">`)}
      ${field("Format", `<select id="epFormat">${opts(EPISODE_FORMATS, e.format)}</select>`)}
      ${field("Planned length (min)", `<input id="epMinutes" type="number" min="1" value="${e.plannedMinutes}">`)}
    </div>
    ${field("Working title", `<input id="epTitle" value="${esc(e.workingTitle || (session.title !== "Untitled event" ? session.title : ""))}" placeholder="You can change this any time">`)}
    ${field("Description", `<textarea id="epDescription" placeholder="What is this episode about, in your own words?">${esc(e.description)}</textarea>`)}
    <div class="plan-grid-2">
      ${field("Guest or interviewer", `<input id="epInterviewer" value="${esc(e.interviewer)}" placeholder="Add their details in the Guests step">`)}
      ${field("Target release date", `<input id="epRelease" type="date" value="${esc(e.releaseDate)}">`)}
    </div>
    ${field("Status", `<select id="epStatus">${opts(EPISODE_STATUSES, e.status)}</select>`, "Moves to Recorded automatically after you record in Studio.")}
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="epBack">Back</button><button class="xp-btn" id="epNext">Save & continue</button></div>
    <p class="plan-status" id="epStatusMsg"></p>`;
  const $ = (id) => document.getElementById(id);
  const read = () => {
    const keep = plan.episode;
    plan.episode = normalizeEpisode({
      ...keep, showId: $("epShow").value === "__new" ? keep.showId : $("epShow").value,
      seasonId: $("epSeason").value === "__new" ? keep.seasonId : $("epSeason").value,
      number: $("epNumber").value, format: $("epFormat").value, plannedMinutes: $("epMinutes").value,
      workingTitle: $("epTitle").value, description: $("epDescription").value, interviewer: $("epInterviewer").value,
      releaseDate: $("epRelease").value, status: $("epStatus").value
    });
  };
  $("epShow").addEventListener("change", () => {
    read();
    const picked = shows.find((s) => s.id === plan.episode.showId);
    if ($("epShow").value === "__new") return showForm(ctx, null);
    plan.episode.seasonId = "";
    if (picked) plan.episode = applyShowDefaults(plan.episode, picked);
    renderEpisodeStep(ctx);
  });
  $("epSeason").addEventListener("change", () => {
    read();
    if ($("epSeason").value === "__new") return showForm(ctx, shows.find((s) => s.id === plan.episode.showId), true);
  });
  $("epBack").addEventListener("click", () => ctx.goToStep("basics"));
  $("epNext").addEventListener("click", async () => {
    read();
    const msg = $("epStatusMsg");
    msg.textContent = "Saving…";
    try {
      if (plan.episode.workingTitle.trim()) await ctx.saveTitle(plan.episode.workingTitle.trim());
      plan.expectedDurationMinutes = plan.episode.plannedMinutes;
      await ctx.savePlan();
      await saveEpisode(ctx);
      ctx.goToStep("story");
    } catch (error) { msg.textContent = error.message; msg.classList.add("err"); }
  });
}

function showForm(ctx, show, seasonOnly = false) {
  const box = document.getElementById("epShowForm");
  const s = show ? normalizeShow(show) : emptyShow();
  box.hidden = false;
  box.innerHTML = `<div class="plan-brief-section">
    ${seasonOnly ? `<strong>New season of ${esc(s.title)}</strong>
      <div class="plan-grid-3">${field("Season title", `<input id="nsTitle" placeholder="Season ${s.seasons.length + 1}">`)}${field("Release cadence", `<select id="nsCadence">${opts(PUBLISHING_CADENCES, s.cadence)}</select>`)}${field("Launch date", `<input id="nsLaunch" type="date">`)}</div>
      ${field("Episodes to finish before launch", `<input id="nsBuffer" type="number" min="0" max="50" value="3">`)}`
    : `<strong>New show</strong>
      ${field("Show title", `<input id="nsShowTitle">`)}${field("Description", `<textarea id="nsShowDesc"></textarea>`)}
      <div class="plan-grid-3">${field("Default length (min)", `<input id="nsMinutes" type="number" min="1" value="60">`)}${field("Default format", `<select id="nsFormat">${opts(EPISODE_FORMATS, "interview")}</select>`)}${field("Publishing cadence", `<select id="nsCadence">${opts(PUBLISHING_CADENCES, "")}</select>`)}</div>
      <div class="plan-grid-2">${field("Tagline", `<input id="nsTagline">`)}${field("Accent colour", `<input id="nsAccent" placeholder="#ff7a29" maxlength="7">`)}</div>`}
    <button class="xp-btn plan-btn-small" id="nsSave">${seasonOnly ? "Add season" : "Create show"}</button> <span class="plan-status" id="nsMsg"></span></div>`;
  const $ = (id) => document.getElementById(id);
  $("nsSave").addEventListener("click", async () => {
    try {
      let saved;
      if (seasonOnly) {
        s.seasons.push({ id: "", title: $("nsTitle").value || `Season ${s.seasons.length + 1}`, releaseCadence: $("nsCadence").value, launchDate: $("nsLaunch").value, bufferTarget: Number($("nsBuffer").value) || 0, episodeOrder: [] });
        saved = (await studioRequest("/api/shows", { method: "POST", body: JSON.stringify({ show: { ...s, id: show.id } }) })).show;
        ctx.plan.episode.seasonId = saved.seasons[saved.seasons.length - 1].id;
      } else {
        if (!$("nsShowTitle").value.trim()) throw new Error("Give the show a title.");
        saved = (await studioRequest("/api/shows", { method: "POST", body: JSON.stringify({ organizationId: ctx.organizationId, show: { title: $("nsShowTitle").value, description: $("nsShowDesc").value, defaultMinutes: $("nsMinutes").value, defaultFormat: $("nsFormat").value, cadence: $("nsCadence").value, brand: { tagline: $("nsTagline").value, accent: $("nsAccent").value }, seasons: [] } }) })).show;
        ctx.plan.episode = applyShowDefaults({ ...ctx.plan.episode, seasonId: "" }, saved);
      }
      await loadShows();
      ctx.plan.episode.showId = saved.id;
      renderEpisodeStep(ctx);
    } catch (error) { const m = $("nsMsg"); m.textContent = error.message; m.classList.add("err"); }
  });
}

// ---------- Step: story map ----------
export function renderStoryStep(ctx) {
  const { main, plan } = ctx;
  enableEpisodeMode(plan);
  const e = plan.episode;
  main.innerHTML = `
    <h1>Story map</h1>
    <p style="color:#8f857b">Everything here is optional and in your own words. It is a private memory aid for you and your producer, never a script, and guests never see it.</p>
    ${field("Opening hook (optional)", `<textarea id="stHook" placeholder="A moment, line or question you might start with">${esc(e.openingHook)}</textarea>`)}
    ${field("Story beats, in order", `<textarea id="stBeats" rows="8" placeholder="One beat per line, in the order it happened">${esc(joinLines(e.storyBeats))}</textarea>`, "Reorder by moving lines. Nothing is added for you.")}
    ${field("Key discussion topics", `<textarea id="stTopics" rows="4" placeholder="One per line">${esc(joinLines(e.topics))}</textarea>`)}
    ${field("Interview questions", `<textarea id="stQuestions" rows="5" placeholder="One per line">${esc(joinLines(e.questions))}</textarea>`)}
    ${field("Important details to remember", `<textarea id="stDetails" rows="4" placeholder="Names, dates, places">${esc(joinLines(e.importantDetails))}</textarea>`)}
    <div class="plan-grid-2">
      ${field("Facts to verify before publishing", `<textarea id="stVerify" rows="4" placeholder="One per line">${esc(joinLines(e.factsToVerify))}</textarea>`)}
      ${field("Sensitive details", `<textarea id="stSensitive" rows="4" placeholder="Things to handle with care or leave out">${esc(joinLines(e.sensitiveDetails))}</textarea>`)}
    </div>
    ${field("Private production notes", `<textarea id="stNotes" rows="4">${esc(e.privateNotes)}</textarea>`, "Visible only to you and your producer.")}
    <div class="plan-brief-section"><strong>Ask Moxie to help you prepare</strong>
      <p style="color:#8f857b;margin:6px 0 10px">Moxie works only from what you wrote above. It will not invent events or details, and its ideas are suggestions, not facts.</p>
      <div id="stMoxie" style="display:flex;flex-wrap:wrap;gap:8px">${EPISODE_MOXIE_PROMPTS.map((p) => `<button type="button" class="xp-btn xp-btn-ghost plan-btn-small" data-task="${esc(p.id)}">${esc(p.label)}</button>`).join("")}</div>
      <pre id="stMoxieOut" style="white-space:pre-wrap;margin-top:12px;font:inherit;color:#e8ded4" aria-live="polite"></pre></div>
    <div class="plan-actions"><button class="xp-btn xp-btn-ghost plan-btn-small" id="stBack">Back</button><button class="xp-btn" id="stNext">Save & continue</button></div>
    <p class="plan-status" id="stMsg"></p>`;
  const $ = (id) => document.getElementById(id);
  const read = () => {
    plan.episode = normalizeEpisode({ ...plan.episode, openingHook: $("stHook").value, storyBeats: $("stBeats").value, topics: $("stTopics").value, questions: $("stQuestions").value, importantDetails: $("stDetails").value, factsToVerify: $("stVerify").value, sensitiveDetails: $("stSensitive").value, privateNotes: $("stNotes").value });
  };
  const save = async () => { read(); await ctx.savePlan(); await saveEpisode(ctx); };
  $("stBack").addEventListener("click", () => { read(); ctx.goToStep("episode"); });
  $("stNext").addEventListener("click", async () => {
    const msg = $("stMsg"); msg.textContent = "Saving…";
    try { await save(); ctx.goToStep("speakers"); } catch (error) { msg.textContent = error.message; msg.classList.add("err"); }
  });
  $("stMoxie").querySelectorAll("[data-task]").forEach((btn) => btn.addEventListener("click", async () => {
    const out = $("stMoxieOut"); out.textContent = "Moxie is reading your plan…";
    try {
      await save();
      const reply = await studioRequest(`/api/sessions/${ctx.session.id}/moxie/episode-assist`, { method: "POST", body: JSON.stringify({ task: btn.dataset.task }) });
      out.textContent = reply.result || "Moxie had nothing to add.";
    } catch (error) { out.textContent = error.message; }
  }));
}

// Compact block for the review step.
export function episodeReviewHtml(plan) {
  if (!isEpisodeMode(plan)) return "";
  const e = normalizeEpisode(plan.episode);
  const show = shows.find((s) => s.id === e.showId);
  const season = show?.seasons.find((s) => s.id === e.seasonId);
  const gaps = readinessGaps(e, { guestCount: 1 });
  const list = (items) => items.length ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>` : `<p style="color:#8f857b">None yet.</p>`;
  return `<section><div class="plan-review-head"><h3>Episode${e.number ? ` ${e.number}` : ""}${show ? ` of ${esc(show.title)}${season ? `, ${esc(season.title)}` : ""}` : ""}</h3><button type="button" class="xp-btn xp-btn-ghost plan-btn-small" data-edit-step="episode">Edit</button><button type="button" class="xp-btn xp-btn-ghost plan-btn-small" data-edit-step="story">Story map</button></div>
    <p><span class="plan-pill ${e.status === "ready_to_record" ? "good" : ""}">${esc(EPISODE_STATUSES.find((s) => s.id === e.status).label)}</span> ${esc(e.format.replace(/_/g, " "))} · about ${e.plannedMinutes} min</p>
    ${e.openingHook ? `<h4>Opening hook</h4><p>${esc(e.openingHook)}</p>` : ""}<h4>Story beats</h4>${list(e.storyBeats)}<h4>Interview questions</h4>${list(e.questions)}
    ${gaps.length ? `<h4>Still to do before recording</h4>${list(gaps)}` : `<p><span class="plan-pill good">Nothing missing. Set the status to Ready to Record when you are set.</span></p>`}</section>`;
}
