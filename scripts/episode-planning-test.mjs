#!/usr/bin/env node
// Episode planning in the Session Planner: the pure model (statuses, normalisation, show/season ordering, Moxie context)
// and the real server (shows, plan.episode, append-only production record, ownership and privacy).
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EPISODE_STATUSES, normalizeEpisode, normalizeProduction, normalizeShow, readinessGaps, orderSeasonEpisodes, moveInOrder,
  seasonProgress, buildEpisodeSummary, episodeContextForMoxie, applyShowDefaults, EPISODE_MOXIE_PROMPTS
} from "../js/episode-model.js";
import { buildGuestBriefing, buildPrepSummary, prepContextForMoxie, SESSION_TEMPLATES } from "../js/session-plan-model.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };

console.log("Model");
assert(EPISODE_STATUSES.map((s) => s.id).join() === "draft,planned,ready_to_record,recorded,editing,ready_to_publish,published", "the seven production statuses exist in order");
const e = normalizeEpisode({ workingTitle: "Panama", number: "1", plannedMinutes: "60", status: "bogus", format: "nope", storyBeats: "- Trip\n\nHospital", privateNotes: "PRIVATE", showId: "bad id!" });
assert(e.number === 1 && e.status === "draft" && e.format === "interview" && e.showId === "" && e.storyBeats.join("|") === "Trip|Hospital", "episodes are normalised; unknown values fall back and bullets are tidied");
assert(readinessGaps(e).length >= 3 && readinessGaps({ ...e, format: "solo", description: "x" }).length === 0, "readiness lists what is missing and never invents content; a solo episode needs no guest");
const show = normalizeShow({ id: "show_1", title: "Toasty Stories", defaultMinutes: 60, cadence: "biweekly", brand: { accent: "#ff7a29", skin: "x" }, seasons: [{ id: "s1", title: "Season 1", bufferTarget: 3, episodeOrder: ["b", "a"] }] });
assert(show.seasons[0].bufferTarget === 3 && show.brand.accent === "#ff7a29" && normalizeShow({ brand: { accent: "javascript:1" } }).brand.accent === "", "shows keep branding and seasons; invalid colours are dropped");
const sessions = [
  { id: "a", title: "A", plan: { episode: { seasonId: "s1", number: 1, status: "recorded" } } },
  { id: "b", title: "B", plan: { episode: { seasonId: "s1", number: 2, status: "planned" } } },
  { id: "c", title: "C", plan: { episode: { seasonId: "s1", number: 3, status: "published" } } },
  { id: "x", title: "X", plan: { episode: { seasonId: "other", number: 1, status: "draft" } } }
];
assert(orderSeasonEpisodes(show.seasons[0], sessions).map((s) => s.id).join() === "b,a,c", "stored order wins, then episode number");
assert(moveInOrder(["b", "a", "c"], "c", "up").join() === "b,c,a" && moveInOrder(["b", "a"], "b", "up").join() === "b,a", "episodes can be reordered and the ends are safe");
const prog = seasonProgress(show.seasons[0], sessions);
assert(prog.total === 3 && prog.completed === 2 && prog.bufferMet === false && prog.counts.planned === 1, "season progress counts recorded-or-later episodes against the buffer target");
assert(applyShowDefaults(normalizeEpisode({}), { ...show, defaultMinutes: 45, defaultFormat: "co_host" }).plannedMinutes === 45, "new episodes inherit the show's defaults");

console.log("\nMoxie and Studio context");
const plan = { episode: { workingTitle: "Panama", storyBeats: ["Costa Rica", "Panama hospital"], factsToVerify: ["Exact diagnosis"], privateNotes: "PRIVATE NOTE", questions: ["What did your father see?"] }, episodeProduction: { moments: [{ id: "m", kind: "clip", atSeconds: 90 }] } };
const summary = buildPrepSummary(plan, []);
const ctx = prepContextForMoxie(summary);
assert(summary.episode.production.moments.length === 1 && ctx.includes("Panama hospital") && ctx.includes("Not yet verified (do not state as fact): Exact diagnosis") && ctx.includes("PRIVATE NOTE"), "the host's plan, unverified facts and private notes reach Moxie");
assert(/Never invent events/.test(ctx), "the no-invention rule travels with the context");
assert(prepContextForMoxie(buildPrepSummary({ description: "plain" }, [])).indexOf("Rule:") === -1, "a normal session adds no episode context");
assert(EPISODE_MOXIE_PROMPTS.length >= 6, "Moxie offers questions, gaps, chronology, structure, hooks and clip ideas");
assert(SESSION_TEMPLATES.some((t) => t.id === "story"), "the planner offers a storytelling episode template");
const briefing = JSON.stringify(buildGuestBriefing({ ...plan, template: "story", description: "d", topics: ["t"] }, { title: "T" }));
assert(!/PRIVATE NOTE|Exact diagnosis|Panama hospital/.test(briefing), "the guest briefing never includes story beats, unverified facts or private notes");
assert(normalizeProduction({ moments: new Array(900).fill({ kind: "clip" }) }).moments.length === 500, "production lists are bounded");

console.log("\nServer");
const PORT = 4291, BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(join(tmpdir(), "toasty-episode-"));
const dbPath = join(scratch, "t.sqlite");
let out = "", ip = 40;
async function api(path, { method = "GET", cookie, body } = {}) {
  const h = { "x-toasty-csrf": "1", "x-forwarded-for": `10.9.9.${ip++}` };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] || cookie };
}
const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "episode-secret", RESEND_API_KEY: "", DEEPSEEK_API_KEY: "", TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", APP_BASE_URL: BASE },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (c) => (out += c)); server.stderr.on("data", (c) => (out += c));

async function main() {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
  const user = await api("/auth/register", { method: "POST", body: { name: "Host", email: "host-ep@example.com", password: "password10chars" } });
  const cookie = user.cookie;
  const other = await api("/auth/register", { method: "POST", body: { name: "Other", email: "other-ep@example.com", password: "password10chars" } });

  console.log("Shows and seasons");
  assert((await api("/api/shows")).status === 401, "shows need a sign-in");
  const made = await api("/api/shows", { method: "POST", cookie, body: { show: { title: "Toasty Stories", description: "Real conversations", defaultMinutes: 60, cadence: "biweekly", brand: { tagline: "Story first", accent: "#ff7a29" }, seasons: [{ title: "Season 1", bufferTarget: 3 }] } } });
  const showId = made.data.show?.id;
  assert(made.status === 200 && showId && made.data.show.seasons[0].id && made.data.show.seasons[0].bufferTarget === 3, "a show with a season is created");
  assert((await api("/api/shows", { method: "POST", cookie, body: { show: { title: "" } } })).status === 400, "a show needs a title");
  const seasonId = made.data.show.seasons[0].id;
  const upd = await api("/api/shows", { method: "POST", cookie, body: { show: { ...made.data.show, title: "Toasty Stories 2", seasons: [...made.data.show.seasons, { title: "Season 2" }] } } });
  assert(upd.data.show.id === showId && upd.data.show.title === "Toasty Stories 2" && upd.data.show.seasons.length === 2, "editing a show keeps its id and adds a season");
  assert((await api("/api/shows", { cookie })).data.shows.length === 1 && (await api("/api/shows", { cookie: other.cookie })).data.shows.length === 0, "another account never sees these shows");

  console.log("\nEpisode on a planned session");
  const created = await api("/api/sessions", { method: "POST", cookie, body: { roomId: "ep1", title: "Panama", brandId: "toasty" } });
  const sid = created.data.session.id;
  const sp = await api(`/api/sessions/${sid}/episode`, { method: "POST", cookie, body: { episode: { showId, seasonId, number: 1, workingTitle: "Panama", description: "d", storyBeats: "Trip\nHospital", questions: "Q1", privateNotes: "PRIVATE NOTE", factsToVerify: "diagnosis", status: "planned", evil: "x" } } });
  assert(sp.status === 200 && sp.data.session.plan.episode.storyBeats.length === 2 && sp.data.session.plan.episode.evil === undefined && sp.data.session.plan.episode.status === "planned", "the episode is saved on the session and unknown fields are dropped");
  assert((await api(`/api/sessions/${sid}/episode`, { method: "POST", cookie: other.cookie, body: { episode: {} } })).status === 404, "another account cannot edit it");
  assert((await api(`/api/sessions/${sid}/episode`, { method: "POST", body: { episode: {} } })).status === 401, "saving needs a sign-in");

  console.log("\nProduction record");
  const mark = (item) => api(`/api/sessions/${sid}/episode-production`, { method: "POST", cookie, body: { op: "moments", item } });
  const m1 = await mark({ kind: "clip", label: "Clip moment", atSeconds: 125, recordingId: "rec1" });
  assert(m1.status === 200 && m1.data.session.plan.episodeProduction.moments.length === 1 && m1.data.session.plan.episodeProduction.moments[0].atSeconds === 125, "a moment marked during recording is stored");
  await api(`/api/sessions/${sid}/episode-production`, { method: "POST", cookie, body: { op: "recordings", item: { recordingId: "rec1", durationSeconds: 3600 } } });
  await api(`/api/sessions/${sid}/episode-production`, { method: "POST", cookie, body: { op: "recordings", item: { recordingId: "rec1", durationSeconds: 3601 } } });
  await api(`/api/sessions/${sid}/episode-production`, { method: "POST", cookie, body: { op: "transcript", item: { recordingId: "rec1", lineCount: 420, speakers: ["Ricardo", "Friend"] } } });
  const clip = await api(`/api/sessions/${sid}/episode-production`, { method: "POST", cookie, body: { op: "clips", item: { id: "clip1", label: "The kettle", startSeconds: 10, endSeconds: 55, source: "moxie" } } });
  await api(`/api/sessions/${sid}/episode-production`, { method: "POST", cookie, body: { op: "clip_select", item: { id: "clip1", selected: true } } });
  await api(`/api/sessions/${sid}/episode-production`, { method: "POST", cookie, body: { op: "exports", item: { id: "x1", kind: "vertical", label: "Clip 1 vertical" } } });
  const st = await api(`/api/sessions/${sid}/episode-production`, { method: "POST", cookie, body: { op: "status", item: { status: "recorded" } } });
  const prod = st.data.session.plan.episodeProduction;
  assert(prod.recordings.length === 1 && prod.recordings[0].durationSeconds === 3601, "the recording is associated once with the episode (re-saves update, not duplicate)");
  assert(prod.transcript.lineCount === 420 && prod.transcript.speakers.length === 2, "the transcript summary is stored with the episode");
  assert(clip.status === 200 && prod.clips[0].selected === true && prod.clips[0].source === "moxie" && prod.exports[0].label === "Clip 1 vertical", "Moxie clip suggestions can be selected and completed exports are tracked");
  assert(st.data.session.plan.episode.status === "recorded" && prod.statusHistory.at(-1).status === "recorded", "status changes are recorded with history");
  assert((await api(`/api/sessions/${sid}/episode-production`, { method: "POST", cookie, body: { op: "status", item: { status: "weird" } } })).status === 400, "unknown statuses are refused");
  assert((await api(`/api/sessions/${sid}/episode-production`, { method: "POST", cookie, body: { op: "bogus", item: {} } })).status === 400, "unknown operations are refused");

  console.log("\nA planner save cannot wipe production data");
  const stale = (await api(`/api/sessions/${sid}`, { cookie })).data.session.plan;
  delete stale.episodeProduction;
  const saved = await api(`/api/sessions/${sid}/plan`, { method: "POST", cookie, body: { plan: { ...stale, description: "edited in planner" } } });
  assert(saved.data.session.plan.episodeProduction.moments.length === 1 && saved.data.session.plan.description === "edited in planner", "marked moments and recordings survive a planner save from a stale tab");
  const forged = await api(`/api/sessions/${sid}/plan`, { method: "POST", cookie, body: { plan: { ...stale, episodeProduction: { moments: [] } } } });
  assert(forged.data.session.plan.episodeProduction.moments.length === 1, "a planner save cannot overwrite the production record");

  console.log("\nPrivacy: guests never see episode planning");
  const spk = (await api(`/api/sessions/${sid}/speakers`, { method: "POST", cookie, body: { email: "friend@example.com", displayName: "Friend", sessionRole: "Guest" } })).data.speaker;
  const invite = await api(`/api/speakers/${spk.id}/invite`, { method: "POST", cookie, body: {} });
  const token = decodeURIComponent(invite.data.inviteUrl.split("token=")[1]);
  const view = JSON.stringify((await api(`/api/speaker-invites/${encodeURIComponent(token)}`)).data);
  assert(view.includes("Friend") && !/PRIVATE NOTE|Hospital|diagnosis|episode|storyBeats/i.test(view), "the guest invitation page carries no story beats, unverified facts, private notes or episode data");
  assert(!/PRIVATE NOTE|Hospital/.test(out), "the invitation email and server log never contain private notes or beats");

  console.log("\nMoxie episode assist");
  assert((await api(`/api/sessions/${sid}/moxie/episode-assist`, { method: "POST", cookie, body: { task: "nope" } })).status === 400, "an unknown Moxie task is refused");
  const empty = (await api("/api/sessions", { method: "POST", cookie, body: { roomId: "ep2", title: "Empty", brandId: "toasty" } })).data.session.id;
  assert((await api(`/api/sessions/${empty}/moxie/episode-assist`, { method: "POST", cookie, body: { task: "questions" } })).status === 400, "Moxie asks for something to work from instead of inventing it");
  const noKey = await api(`/api/sessions/${sid}/moxie/episode-assist`, { method: "POST", cookie, body: { task: "questions" } });
  assert(noKey.status === 402 || (console.log("   status", noKey.status, JSON.stringify(noKey.data)), false), "without the creator's own AI key Moxie does not run (existing BYOK rule)");
  assert((await api(`/api/sessions/${sid}/moxie/episode-assist`, { method: "POST", cookie: other.cookie, body: { task: "questions" } })).status === 404, "another account cannot use Moxie on this episode");

  console.log("\nDeleting a show keeps its episodes");
  assert((await api(`/api/shows/${showId}/delete`, { method: "POST", cookie: other.cookie, body: {} })).status === 200 && (await api("/api/shows", { cookie })).data.shows.length === 1, "another account cannot delete the show");
  await api(`/api/shows/${showId}/delete`, { method: "POST", cookie, body: {} });
  const still = (await api(`/api/sessions/${sid}`, { cookie })).data.session;
  assert((await api("/api/shows", { cookie })).data.shows.length === 0 && still.plan.episode.workingTitle === "Panama" && still.plan.episodeProduction.recordings.length === 1, "the episode and its recording stay after the show is removed");

  console.log("\nALL PASSED: episode planning is stored per session, production data is append-only, and guests never see it.");
}
main().catch((err) => { console.error(err.message); console.error(out.split("\n").slice(-12).join("\n")); try { server.kill("SIGKILL"); } catch (_) {} process.exit(1); }).finally(() => { try { server.kill("SIGKILL"); } catch (_) {} });
