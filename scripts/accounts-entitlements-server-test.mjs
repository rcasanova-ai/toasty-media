#!/usr/bin/env node
// HTTP-level integration test for entitlement enforcement (Phase 5) — the brief's explicit requirement
// that a demo account cannot exceed its session quota or participant cap, enforced server-side (not just
// hidden in UI), against the real render-production-server.mjs + toasty-auth-db.py.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4212;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-entitlements-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

async function jsonFetch(path, { method = "GET", cookie, body } = {}) {
  const headers = { "x-toasty-csrf": "1" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  return { status: response.status, data, cookie: cookieFrom(response) || cookie };
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server never came up");
}

function sqliteRun(sql) {
  const result = spawnSync("python3", ["-c", `
import sqlite3, sys
conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.execute(sys.argv[1])
conn.commit()
`, sql], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "sqlite run failed");
}

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "entitlements-test-secret", RESEND_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function createSession(cookie, roomId) {
  return jsonFetch("/api/sessions", { method: "POST", cookie, body: { roomId, title: roomId } });
}

async function main() {
  await waitForHealth();

  const user = await jsonFetch("/auth/register", { method: "POST", body: { name: "Demo User", email: "demo@example.com", password: "password10chars" } });
  assert(user.status === 201, "user registers (their auto-created organization defaults to the demo plan)");

  console.log("\nConcurrent session cap (demo plan: maxConcurrentSessions = 1)");
  const first = await createSession(user.cookie, "tment0001");
  assert(first.status === 200 && first.data.session, "the first session is created");

  const secondWhileFirstOpen = await createSession(user.cookie, "tment0002");
  assert(secondWhileFirstOpen.status === 402, "a second CONCURRENT session is rejected with a clean 402, not a generic 500");
  assert(/active session/.test(secondWhileFirstOpen.data.error), "the rejection message explains the actual limit, not a stack trace");

  const ended = await jsonFetch(`/api/sessions/${first.data.session.id}/end`, { method: "POST", cookie: user.cookie, body: {} });
  assert(ended.status === 200, "ending the first session succeeds");

  const secondAfterEnd = await createSession(user.cookie, "tment0002");
  assert(secondAfterEnd.status === 200, "a new session succeeds once the concurrent slot is freed");
  await jsonFetch(`/api/sessions/${secondAfterEnd.data.session.id}/end`, { method: "POST", cookie: user.cookie, body: {} });

  console.log("\nDaily session cap (demo plan: maxSessionsPerDay = 3) — 2 sessions already created above count toward it");
  const third = await createSession(user.cookie, "tment0003");
  assert(third.status === 200, "third session of the day succeeds (day count now 3)");
  await jsonFetch(`/api/sessions/${third.data.session.id}/end`, { method: "POST", cookie: user.cookie, body: {} });

  const fourth = await createSession(user.cookie, "tment0004");
  assert(fourth.status === 402, "a 4th session THE SAME DAY is rejected even though no session is concurrently open");
  assert(/per day/.test(fourth.data.error), "the daily-cap rejection message is specific, not generic");

  console.log("\nEntitlements are enforced server-side even against a directly-forged request (no UI involved at all)");
  const forged = await jsonFetch("/api/sessions", { method: "POST", cookie: user.cookie, body: { roomId: "tmentforge", title: "forged", organizationId: undefined } });
  assert(forged.status === 402, "a raw API call with no UI in the loop is rejected exactly the same way — the limit is not a client-side illusion");

  console.log("\nUpgrading the plan immediately raises the limit (the check reads the LIVE plan, not a cached value)");
  const orgs = await jsonFetch("/api/organizations", { cookie: user.cookie });
  const orgId = orgs.data.organizations[0].id;
  sqliteRun(`UPDATE organizations SET plan = 'creator' WHERE id = '${orgId}'`);
  const afterUpgrade = await createSession(user.cookie, "tment0005");
  assert(afterUpgrade.status === 200, "session creation succeeds immediately after the plan is upgraded, with no other change");
  await jsonFetch(`/api/sessions/${afterUpgrade.data.session.id}/end`, { method: "POST", cookie: user.cookie, body: {} });

  console.log("\nParticipant cap (demo plan: maxParticipants = 4, i.e. host + 3 guests) — a fresh account, since the first one's daily session quota is now spent for today regardless of plan (usage tracking is plan-independent by design)");
  const capUser = await jsonFetch("/auth/register", { method: "POST", body: { name: "Cap User", email: "cap@example.com", password: "password10chars" } });
  assert(capUser.status === 201, "a second, independent account registers for this check");
  const capSession = await createSession(capUser.cookie, "tment0006");
  assert(capSession.status === 200, "a fresh session is created for the participant-cap check");
  const roomId = capSession.data.session.roomId;

  const hostAnnounce = await jsonFetch("/api/presence/announce", { method: "POST", body: { roomId, participantId: "host", role: "host", displayName: "Host" } });
  assert(hostAnnounce.status === 200, "the host announces presence");

  let full = false;
  for (let i = 1; i <= 4; i += 1) {
    const guest = await jsonFetch("/api/presence/announce", { method: "POST", body: { roomId, participantId: `guest-${i}`, role: "guest", displayName: `Guest ${i}` } });
    if (guest.status === 409) { full = true; assert(i === 4, `the room fills at guest #${i} — expected the 4th guest (3 max on the demo plan) to be the one rejected`); break; }
  }
  assert(full, "a 4th guest is rejected once the demo plan's 3-guest cap (4 total participants) is reached");

  console.log("\nAll accounts entitlements server tests passed.");
}

main()
  .then(() => { server.kill(); rmSync(scratchDir, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => {
    console.error(error);
    console.error("\n--- server output ---\n" + serverOutput);
    server.kill();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
