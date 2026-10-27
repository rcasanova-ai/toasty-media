// Pure model for episode planning inside the Session Planner: shows, seasons, episode story maps, production
// status, and the host-only context Studio and Moxie use. No DOM, no network. The planner page, the Studio prep
// panel, the shows page and the tests all share these.
//
// An episode IS a planned session: its data lives in plan.episode on the session's existing plan_json, so every
// existing session, recording and guest flow keeps working. Shows and seasons live in the episode_shows table.
// Nothing here ever invents story content: every field is something the creator typed.

export const EPISODE_STATUSES = Object.freeze([
  { id: "draft", label: "Draft" },
  { id: "planned", label: "Planned" },
  { id: "ready_to_record", label: "Ready to Record" },
  { id: "recorded", label: "Recorded" },
  { id: "editing", label: "Editing" },
  { id: "ready_to_publish", label: "Ready to Publish" },
  { id: "published", label: "Published" }
]);

export const EPISODE_FORMATS = Object.freeze([
  { id: "solo", label: "Solo" },
  { id: "interview", label: "Interview" },
  { id: "co_host", label: "Co-host conversation" },
  { id: "panel", label: "Panel" }
]);

export const PUBLISHING_CADENCES = Object.freeze([
  { id: "", label: "Not set" }, { id: "weekly", label: "Weekly" }, { id: "biweekly", label: "Every two weeks" },
  { id: "monthly", label: "Monthly" }, { id: "irregular", label: "Irregular" }
]);

export const MOMENT_KINDS = Object.freeze(["clip", "important", "fact_check"]);

const STATUS_IDS = new Set(EPISODE_STATUSES.map((s) => s.id));
const FORMAT_IDS = new Set(EPISODE_FORMATS.map((f) => f.id));
const CADENCE_IDS = new Set(PUBLISHING_CADENCES.map((c) => c.id));

const text = (value, max) => String(value ?? "").slice(0, max);
const lineList = (value, maxItems, maxLen) => {
  const raw = Array.isArray(value) ? value : String(value ?? "").split(/\r?\n/);
  return raw.map((l) => String(l ?? "").replace(/^[-*•]\s*/, "").trim().slice(0, maxLen)).filter(Boolean).slice(0, maxItems);
};
const isoOrEmpty = (value) => (/^\d{4}-\d{2}-\d{2}/.test(String(value || "")) ? String(value).slice(0, 10) : "");
const safeId = (value) => (/^[A-Za-z0-9_-]{1,80}$/.test(String(value || "")) ? String(value) : "");

export function emptyEpisode() {
  return {
    showId: "", seasonId: "", number: null,
    workingTitle: "", description: "", format: "interview", plannedMinutes: 60,
    status: "draft", releaseDate: "",
    interviewer: "",
    openingHook: "",
    topics: [], storyBeats: [], questions: [], importantDetails: [], factsToVerify: [], sensitiveDetails: [],
    privateNotes: ""
  };
}

// Normalises whatever the client sent. Server-owned production data (moments, clips, recordings) is never taken
// from here; see normalizeProduction.
export function normalizeEpisode(input = {}) {
  const base = emptyEpisode();
  const e = input && typeof input === "object" ? input : {};
  const number = Number(e.number);
  const minutes = Number(e.plannedMinutes);
  return {
    showId: safeId(e.showId), seasonId: safeId(e.seasonId),
    number: Number.isInteger(number) && number > 0 && number < 10000 ? number : null,
    workingTitle: text(e.workingTitle, 160), description: text(e.description, 4000),
    format: FORMAT_IDS.has(e.format) ? e.format : base.format,
    plannedMinutes: Number.isFinite(minutes) && minutes >= 1 && minutes <= 600 ? Math.round(minutes) : base.plannedMinutes,
    status: STATUS_IDS.has(e.status) ? e.status : base.status,
    releaseDate: isoOrEmpty(e.releaseDate),
    interviewer: text(e.interviewer, 160),
    openingHook: text(e.openingHook, 2000),
    topics: lineList(e.topics, 40, 300), storyBeats: lineList(e.storyBeats, 80, 600), questions: lineList(e.questions, 80, 500),
    importantDetails: lineList(e.importantDetails, 60, 500), factsToVerify: lineList(e.factsToVerify, 60, 500), sensitiveDetails: lineList(e.sensitiveDetails, 60, 500),
    privateNotes: text(e.privateNotes, 8000)
  };
}

export function emptyProduction() {
  return { moments: [], clips: [], recordings: [], transcript: null, exports: [], statusHistory: [] };
}

// Server-owned production record: append-only lists with hard bounds. A planner save can never overwrite them.
export function normalizeProduction(input = {}) {
  const p = input && typeof input === "object" ? input : {};
  const arr = (v, n) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object").slice(0, n) : []);
  return {
    moments: arr(p.moments, 500).map((m) => ({ id: text(m.id, 60), kind: MOMENT_KINDS.includes(m.kind) ? m.kind : "clip", label: text(m.label, 240), atSeconds: Math.max(0, Number(m.atSeconds) || 0), recordingId: text(m.recordingId, 80), createdAt: text(m.createdAt, 40) })),
    clips: arr(p.clips, 200).map((c) => ({ id: text(c.id, 60), label: text(c.label, 240), startSeconds: Math.max(0, Number(c.startSeconds) || 0), endSeconds: Math.max(0, Number(c.endSeconds) || 0), source: ["moxie", "marker", "manual"].includes(c.source) ? c.source : "manual", selected: Boolean(c.selected), recordingId: text(c.recordingId, 80) })),
    recordings: arr(p.recordings, 50).map((r) => ({ recordingId: text(r.recordingId, 80), durationSeconds: Math.max(0, Number(r.durationSeconds) || 0), recordedAt: text(r.recordedAt, 40) })),
    transcript: p.transcript && typeof p.transcript === "object" ? { recordingId: text(p.transcript.recordingId, 80), lineCount: Math.max(0, Number(p.transcript.lineCount) || 0), speakers: lineList(p.transcript.speakers, 12, 80), savedAt: text(p.transcript.savedAt, 40) } : null,
    exports: arr(p.exports, 100).map((x) => ({ id: text(x.id, 60), kind: text(x.kind, 40), label: text(x.label, 160), completedAt: text(x.completedAt, 40) })),
    statusHistory: arr(p.statusHistory, 60).map((s) => ({ status: STATUS_IDS.has(s.status) ? s.status : "draft", at: text(s.at, 40) }))
  };
}

export function statusLabel(id) {
  return (EPISODE_STATUSES.find((s) => s.id === id) || EPISODE_STATUSES[0]).label;
}

// What still needs doing before the episode can be recorded. Informational only: it never blocks anything.
export function readinessGaps(episode = {}, { guestCount = 0 } = {}) {
  const e = { ...emptyEpisode(), ...episode };
  const gaps = [];
  if (!e.workingTitle.trim()) gaps.push("Add a working title");
  if (!e.description.trim()) gaps.push("Add a short description");
  if (!e.storyBeats.length && !e.topics.length) gaps.push("Add story beats or key topics");
  if (e.format !== "solo" && !guestCount && !e.interviewer.trim()) gaps.push("Add a guest or interviewer");
  if (e.format !== "solo" && !e.questions.length) gaps.push("Add a few interview questions");
  return gaps;
}

export function isReadyToRecord(episode, opts) {
  return readinessGaps(episode, opts).length === 0;
}

// ---------- Shows and seasons ----------

export function emptyShow() {
  return { id: "", title: "", description: "", brand: { skin: "", accent: "", tagline: "" }, defaultMinutes: 60, defaultFormat: "interview", cadence: "", seasons: [] };
}

export function normalizeShow(input = {}) {
  const s = input && typeof input === "object" ? input : {};
  const minutes = Number(s.defaultMinutes);
  const seasons = (Array.isArray(s.seasons) ? s.seasons : []).slice(0, 50).map((x, i) => {
    const bufferTarget = Number(x?.bufferTarget);
    return {
      id: safeId(x?.id) || `season_${i + 1}`, title: text(x?.title, 120) || `Season ${i + 1}`,
      releaseCadence: CADENCE_IDS.has(x?.releaseCadence) ? x.releaseCadence : "",
      launchDate: isoOrEmpty(x?.launchDate),
      bufferTarget: Number.isInteger(bufferTarget) && bufferTarget >= 0 && bufferTarget <= 50 ? bufferTarget : 0,
      episodeOrder: (Array.isArray(x?.episodeOrder) ? x.episodeOrder : []).map(safeId).filter(Boolean).slice(0, 500)
    };
  });
  const brand = s.brand && typeof s.brand === "object" ? s.brand : {};
  return {
    id: safeId(s.id), title: text(s.title, 160), description: text(s.description, 2000),
    brand: { skin: text(brand.skin, 60), accent: /^#[0-9a-fA-F]{6}$/.test(brand.accent || "") ? brand.accent : "", tagline: text(brand.tagline, 160) },
    defaultMinutes: Number.isFinite(minutes) && minutes >= 1 && minutes <= 600 ? Math.round(minutes) : 60,
    defaultFormat: FORMAT_IDS.has(s.defaultFormat) ? s.defaultFormat : "interview",
    cadence: CADENCE_IDS.has(s.cadence) ? s.cadence : "",
    seasons
  };
}

// Applies a show's defaults to an episode that has not set its own yet.
export function applyShowDefaults(episode, show) {
  if (!show) return episode;
  const next = { ...episode, showId: show.id };
  if (!episode.workingTitle && !episode.description) { next.plannedMinutes = show.defaultMinutes; next.format = show.defaultFormat; }
  return next;
}

// Orders a season's episodes: stored order first, then anything unlisted by episode number then title.
export function orderSeasonEpisodes(season, sessions = []) {
  const inSeason = sessions.filter((s) => s.plan?.episode?.seasonId === season.id);
  const rank = new Map((season.episodeOrder || []).map((id, i) => [id, i]));
  return inSeason.slice().sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Infinity, rb = rank.has(b.id) ? rank.get(b.id) : Infinity;
    if (ra !== rb) return ra - rb;
    const na = a.plan.episode.number ?? Infinity, nb = b.plan.episode.number ?? Infinity;
    return na !== nb ? na - nb : String(a.title).localeCompare(String(b.title));
  });
}

export function moveInOrder(order, id, direction) {
  const next = order.slice();
  const i = next.indexOf(id);
  const j = i + (direction === "up" ? -1 : 1);
  if (i < 0 || j < 0 || j >= next.length) return next;
  [next[i], next[j]] = [next[j], next[i]];
  return next;
}

// Episode counts per status, and how many are finished enough to count toward the pre-launch buffer.
export function seasonProgress(season, sessions = []) {
  const eps = orderSeasonEpisodes(season, sessions);
  const counts = Object.fromEntries(EPISODE_STATUSES.map((s) => [s.id, 0]));
  for (const s of eps) counts[STATUS_IDS.has(s.plan.episode.status) ? s.plan.episode.status : "draft"]++;
  const completed = eps.filter((s) => ["recorded", "editing", "ready_to_publish", "published"].includes(s.plan.episode.status)).length;
  return { total: eps.length, counts, completed, bufferTarget: season.bufferTarget || 0, bufferMet: season.bufferTarget ? completed >= season.bufferTarget : null };
}

// ---------- Studio and Moxie context (host and producer only) ----------

export function buildEpisodeSummary(plan = {}, production = {}) {
  const e = plan.episode ? normalizeEpisode(plan.episode) : null;
  if (!e) return null;
  const p = normalizeProduction(production);
  return { ...e, statusLabel: statusLabel(e.status), production: p };
}

// Plain-text context for Moxie. Everything is the host's own words, labelled as such. The closing line is part of the
// contract: Moxie may organise and question, but never supplies events, quotes, diagnoses or motives of its own.
export function episodeContextForMoxie(summary) {
  if (!summary) return "";
  const out = [];
  out.push(`Episode${summary.number ? ` ${summary.number}` : ""}: ${summary.workingTitle || "untitled"} (${summary.format.replace(/_/g, " ")}, about ${summary.plannedMinutes} min, status ${summary.statusLabel})`);
  if (summary.description) out.push(`Premise (host's words): ${summary.description}`);
  if (summary.openingHook) out.push(`Opening hook (host's words): ${summary.openingHook}`);
  if (summary.storyBeats.length) out.push(`Story beats in the host's order: ${summary.storyBeats.map((b, i) => `${i + 1}. ${b}`).join(" | ")}`);
  if (summary.topics.length) out.push(`Key topics: ${summary.topics.join("; ")}`);
  if (summary.questions.length) out.push(`Prepared questions: ${summary.questions.join("; ")}`);
  if (summary.importantDetails.length) out.push(`Details the host wants remembered: ${summary.importantDetails.join("; ")}`);
  if (summary.factsToVerify.length) out.push(`Not yet verified (do not state as fact): ${summary.factsToVerify.join("; ")}`);
  if (summary.sensitiveDetails.length) out.push(`Sensitive, handle with care: ${summary.sensitiveDetails.join("; ")}`);
  if (summary.privateNotes) out.push(`Private production notes: ${summary.privateNotes}`);
  out.push("Rule: use only what the host wrote above. Never invent events, quotes or details of the host's life, and label any suggestion as a suggestion, not a fact.");
  return out.join("\n").slice(0, 5000);
}

// Moxie prompts that organise the host's own material. They are requests to Moxie, never generated story content.
export const EPISODE_MOXIE_PROMPTS = Object.freeze([
  { id: "questions", label: "Suggest questions", prompt: "Using only my episode plan, suggest discussion questions I have not already prepared. Mark each one as a suggestion." },
  { id: "gaps", label: "What context is missing?", prompt: "Looking only at my episode plan, what context would a listener need that I have not written down yet? Ask me, do not fill it in." },
  { id: "chronology", label: "Check the order of events", prompt: "Read my story beats in order and point out anything that looks out of sequence or unclear. Do not add events." },
  { id: "structure", label: "Suggest a structure", prompt: "Suggest how to structure this episode using only the beats and topics I listed. Do not add any beats." },
  { id: "hook", label: "Possible opening hooks", prompt: "From my own beats and details, point to moments that could work as an opening hook. Quote my wording, do not invent any." },
  { id: "clips", label: "Possible clip moments", prompt: "Based on my plan, which beats are most likely to make strong short clips? Say why, and note that this is a guess before we hear the recording." }
]);
