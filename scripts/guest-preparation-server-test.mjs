#!/usr/bin/env node
// Guest invitation and preparation against the real server: the host approves a briefing, each guest gets a private
// emailed link (no account), submits preparation, and the host sees it. Guests never see each other's data or the
// host's notes, an unapproved briefing is never exposed, and expired or unknown tokens open nothing.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4287;
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(join(tmpdir(), "toasty-guest-prep-"));
const dbPath = join(scratch, "t.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
let out = "";
let ip = 30;

async function api(path, { method = "GET", cookie, body } = {}) {
  const h = { "x-toasty-csrf": "1", "x-forwarded-for": `10.8.8.${ip++}` };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] || cookie };
}
const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "guest-prep-secret", RESEND_API_KEY: "", TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", APP_BASE_URL: BASE },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (c) => (out += c)); server.stderr.on("data", (c) => (out += c));
const tokenFrom = (invitePath) => decodeURIComponent(invitePath.split("token=")[1]);

async function main() {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
  const user = await api("/auth/register", { method: "POST", body: { name: "Host", email: "host-prep@example.com", password: "password10chars" } });
  const cookie = user.cookie;
  const created = await api("/api/sessions", { method: "POST", cookie, body: { roomId: "prep1", title: "Lit: Example Novel", brandId: "toasty" } });
  const sessionId = created.data.session.id;

  console.log("\nHost plan with a briefing");
  const plan = {
    sessionType: "book_club", template: "lit", hostName: "Sam", scheduledAt: "2026-11-02T19:00",
    hostPrep: { openingQuestions: "Why this book?", talkingPoints: "Structure", specialInstructions: "HOST SECRET: guest is nervous" },
    guestBriefing: { intro: "Thanks for joining Sam.", sections: [{ title: "The premise", body: "A short premise." }], approved: false },
    runOfShow: [{ id: "r1", label: "Intro", startOffset: 0, notes: "" }]
  };
  assert((await api(`/api/sessions/${sessionId}/plan`, { method: "POST", cookie, body: { plan } })).status === 200, "the host saves the plan");
  const sA = (await api(`/api/sessions/${sessionId}/speakers`, { method: "POST", cookie, body: { email: "maya@example.com", displayName: "Maya", sessionRole: "Guest" } })).data.speaker;
  const sB = (await api(`/api/sessions/${sessionId}/speakers`, { method: "POST", cookie, body: { email: "ben@example.com", displayName: "Ben", sessionRole: "Guest" } })).data.speaker;
  const note = await api(`/api/speakers/${sA.id}/update`, { method: "POST", cookie, body: { fields: { hostBackground: "HOST NOTE: debut author" } } });
  assert(note.status === 200 && note.data.speaker.hostBackground === "HOST NOTE: debut author", "the host records their own background note about a guest");

  console.log("\nInvitation");
  const inviteA = await api(`/api/speakers/${sA.id}/invite`, { method: "POST", cookie, body: {} });
  const inviteB = await api(`/api/speakers/${sB.id}/invite`, { method: "POST", cookie, body: {} });
  assert(inviteA.status === 201 && inviteA.data.inviteUrl.includes("token=") && inviteA.data.inviteUrl !== inviteB.data.inviteUrl, "each guest gets their own private link");
  assert(inviteA.data.emailed === true && /maya@example\.com/.test(out) && /Prepare for Lit: Example Novel/.test(out), "an email is sent to the guest with a preparation subject");
  const tokenA = tokenFrom(inviteA.data.inviteUrl), tokenB = tokenFrom(inviteB.data.inviteUrl);
  assert(!/HOST SECRET|HOST NOTE/.test(out), "the email never contains the host's private notes");

  console.log("\nWhat a guest can open without an account");
  const viewA = await api(`/api/speaker-invites/${encodeURIComponent(tokenA)}`);
  assert(viewA.status === 200 && viewA.data.speaker.email === "maya@example.com", "the guest opens their own preparation page without signing in");
  assert(viewA.data.briefing === null, "a briefing the host has not approved is not exposed");
  assert(!JSON.stringify(viewA.data).includes("HOST NOTE") && !JSON.stringify(viewA.data).includes("HOST SECRET") && viewA.data.speaker.hostBackground === undefined, "the host's notes about the guest and session never reach the guest");
  assert(viewA.data.event.hostName === "Sam" && viewA.data.event.sessionType === "book_club", "the guest sees the host's name and session type");

  console.log("\nApproved briefing");
  plan.guestBriefing.approved = true;
  await api(`/api/sessions/${sessionId}/plan`, { method: "POST", cookie, body: { plan } });
  const viewA2 = await api(`/api/speaker-invites/${encodeURIComponent(tokenA)}`);
  assert(viewA2.data.briefing?.intro === "Thanks for joining Sam." && viewA2.data.briefing.sections[0].title === "The premise", "once the host approves it, the briefing is shown to the guest");
  assert(!JSON.stringify(viewA2.data.briefing).includes("HOST SECRET"), "the briefing contains only the approved text");

  console.log("\nGuest submits preparation");
  const prep = { preferredIntro: "Maya, author of Maps", expertise: "Cartography", topicsToDiscuss: "Writing process", topicsToAvoid: "My divorce", supportingLinks: "https://example.com/maya", additionalNotes: "Please start late", ignoredField: "x" };
  const sub = await api(`/api/speaker-invites/${encodeURIComponent(tokenA)}/profile`, { method: "POST", body: { fields: { displayName: "Maya Chen", bioShort: "Writes about maps.", pronunciationNotes: "MY-uh", hostBackground: "guest tries to set this", prep } } });
  assert(sub.status === 200 && sub.data.speaker.prep.topicsToAvoid === "My divorce" && sub.data.speaker.prep.ignoredField === undefined, "the guest saves preparation and unknown fields are dropped");
  const list = await api(`/api/sessions/${sessionId}/speakers`, { cookie });
  const maya = list.data.speakers.find((s) => s.id === sA.id);
  assert(maya.prep.preferredIntro === "Maya, author of Maps" && maya.pronunciationNotes === "MY-uh" && Boolean(maya.profileSubmittedAt), "the host sees what the guest submitted");
  assert(maya.hostBackground === "HOST NOTE: debut author", "a guest cannot overwrite the host's private note");

  console.log("\nGuests are isolated from one another");
  const viewB = await api(`/api/speaker-invites/${encodeURIComponent(tokenB)}`);
  assert(viewB.data.speaker.email === "ben@example.com" && !JSON.stringify(viewB.data).includes("Maya") && !JSON.stringify(viewB.data).includes("My divorce"), "another guest's page shows none of Maya's preparation");
  assert((await api(`/api/speaker-invites/${encodeURIComponent(tokenB)}/profile`, { method: "POST", body: { fields: { prep: { additionalNotes: "Ben's notes" } } } })).status === 200, "each guest can only edit their own");
  const after = (await api(`/api/sessions/${sessionId}/speakers`, { cookie })).data.speakers;
  assert(after.find((s) => s.id === sA.id).prep.additionalNotes === "Please start late" && after.find((s) => s.id === sB.id).prep.additionalNotes === "Ben's notes", "Maya's and Ben's preparation stay separate");

  console.log("\nTokens");
  assert((await api(`/api/speaker-invites/not-a-real-token`)).status === 404, "an unknown token opens nothing");
  spawnSync("python3", ["-c", "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute(\"UPDATE speaker_invites SET expires_at='2020-01-01T00:00:00.000Z' WHERE speaker_id=?\",(sys.argv[2],));c.commit()", dbPath, sB.id]);
  assert((await api(`/api/speaker-invites/${encodeURIComponent(tokenB)}`)).status === 410, "an expired invitation link no longer opens");
  assert((await api(`/api/speaker-invites/${encodeURIComponent(tokenB)}/profile`, { method: "POST", body: { fields: { prep: { additionalNotes: "late edit" } } } })).status === 410, "an expired link cannot submit either");
  assert((await api(`/api/sessions/${sessionId}/speakers`, { cookie: "" })).status === 401, "the speaker list needs the host's sign-in");
  const other = await api("/auth/register", { method: "POST", body: { name: "Other", email: "other-prep@example.com", password: "password10chars" } });
  assert([403, 404].includes((await api(`/api/sessions/${sessionId}/speakers`, { cookie: other.cookie })).status), "another account cannot read this session's guest preparation");

  console.log("\nALL PASSED: guest preparation is private, token based and visible only to the host and producer.");
}

main().catch((e) => { console.error(e.message); console.error(out.split("\n").slice(-12).join("\n")); process.exit(1); }).finally(() => { try { server.kill("SIGKILL"); } catch (_) {} });
