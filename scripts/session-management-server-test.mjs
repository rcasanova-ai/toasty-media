#!/usr/bin/env node
// Session rename / delete / reusable-setup duplicate against the real render-production-server.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4208;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-session-mgmt-"));
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

function sqliteScalar(sql) {
  const result = spawnSync("python3", ["-c", `
import sqlite3, sys
conn = sqlite3.connect(${JSON.stringify(dbPath)})
print(conn.execute(sys.argv[1]).fetchone()[0])
`, sql], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "sqlite query failed");
  return result.stdout.trim();
}

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "session-mgmt-test-secret" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function main() {
  await waitForHealth();

  const user = await jsonFetch("/auth/register", { method: "POST", body: { name: "Ricardo", email: "ricardo-mgmt@example.com", password: "password10chars" } });
  assert(user.status === 201, "user registers");

  const created = await jsonFetch("/api/sessions", { method: "POST", cookie: user.cookie, body: { roomId: "tmmgmt1", title: "Thursday recap", brandId: "peeps" } });
  assert(created.status === 200, "session creates");
  const sessionId = created.data.session.id;

  const renamed = await jsonFetch(`/api/sessions/${sessionId}/title`, {
    method: "POST",
    cookie: user.cookie,
    body: { title: "Thursday recap (final)" }
  });
  assert(renamed.status === 200, "rename persists");
  assert(renamed.data.session.title === "Thursday recap (final)", "rename title round-trips");
  const reread = await jsonFetch(`/api/sessions/${sessionId}`, { cookie: user.cookie });
  assert(reread.data.session.title === "Thursday recap (final)", "rename survives GET");

  const setupSave = await jsonFetch(`/api/sessions/${sessionId}/setup`, {
    method: "POST",
    cookie: user.cookie,
    body: {
      setup: {
        brandId: "peeps",
        sessionType: "jam",
        policy: { sessionType: "jam", privacy: "confidential", capturePolicy: "none", access: "invited_only" },
        layouts: { compositionMode: "active-speaker", layout: "active-speaker", shareLayout: "screen-speaker", assetLayout: "asset-speaker" },
        ticker: { speed: 28, text: "LIVE COPY SHOULD DROP" },
        scene: "live",
        timeline: [{ type: "layout" }],
        runOfShow: [
          { title: "Open", notes: "welcome", estimatedMinutes: 4, status: "completed", startedAt: 11, completedAt: 22 },
          { title: "Interview", preparedQuestions: ["Why now?"], estimatedMinutes: 10, status: "current" }
        ]
      }
    }
  });
  assert(setupSave.status === 200, "setup persists");
  assert(setupSave.data.session.setup.sessionType === "jam", "setup copies session type");
  assert(setupSave.data.session.setup.layouts.layout === "active-speaker", "setup copies layout");
  assert(setupSave.data.session.setup.ticker.speed === 28, "setup copies ticker speed");
  assert(setupSave.data.session.setup.runOfShow[0].title === "Open", "setup copies ROS");
  assert(!("status" in setupSave.data.session.setup.runOfShow[0]), "setup strips ROS status");
  assert(!("tickerText" in setupSave.data.session.setup) && !setupSave.data.session.setup.ticker.text, "setup strips live ticker text");
  assert(!("scene" in setupSave.data.session.setup), "setup strips live scene");
  assert(!("timeline" in setupSave.data.session.setup), "setup strips timeline history");

  spawnSync("python3", ["-c", `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.execute("INSERT INTO session_program (room_id, state_json, revision, updated_at) VALUES ('tmmgmt1', '{\\"scene\\":\\"live\\",\\"history\\":true}', 3, '2026-09-21T00:00:00Z')")
conn.commit()
`], { encoding: "utf8" });
  assert(sqliteScalar("SELECT COUNT(*) FROM session_program WHERE room_id='tmmgmt1'") === "1", "source room has live program history");

  const duplicated = await jsonFetch(`/api/sessions/${sessionId}/duplicate`, {
    method: "POST",
    cookie: user.cookie,
    body: { roomId: "tmmgmt2", title: "Copy of Thursday recap (final)" }
  });
  assert(duplicated.status === 200, "duplicate creates");
  assert(duplicated.data.session.id !== sessionId, "duplicate is a new session id");
  assert(duplicated.data.session.roomId === "tmmgmt2", "duplicate uses a new room");
  assert(duplicated.data.session.status === "OPEN", "duplicate starts OPEN");
  assert(!duplicated.data.session.startedAt, "duplicate does not copy startedAt");
  assert(!duplicated.data.session.endedAt, "duplicate does not copy endedAt");
  assert(duplicated.data.session.brandId === "peeps", "duplicate copies brand");
  assert(duplicated.data.session.setup.sessionType === "jam", "duplicate copies session type");
  assert(duplicated.data.session.setup.layouts.shareLayout === "screen-speaker", "duplicate copies layouts");
  assert(duplicated.data.session.setup.runOfShow[1].preparedQuestions[0] === "Why now?", "duplicate copies ROS template");
  assert(sqliteScalar("SELECT COUNT(*) FROM session_program WHERE room_id='tmmgmt2'") === "0", "duplicate does not copy session_program history");

  const other = await jsonFetch("/auth/register", { method: "POST", body: { name: "Other", email: "other-mgmt@example.com", password: "password10chars" } });
  assert(other.status === 201, "second user registers");
  const stolenRename = await jsonFetch(`/api/sessions/${sessionId}/title`, { method: "POST", cookie: other.cookie, body: { title: "hijacked" } });
  assert(stolenRename.status === 404, "another account cannot rename");
  const stolenDelete = await jsonFetch(`/api/sessions/${sessionId}/delete`, { method: "POST", cookie: other.cookie, body: {} });
  assert(stolenDelete.status === 404, "another account cannot delete");
  const stolenDup = await jsonFetch(`/api/sessions/${sessionId}/duplicate`, { method: "POST", cookie: other.cookie, body: { roomId: "tmmgmtx" } });
  assert(stolenDup.status === 404, "another account cannot duplicate");

  const deleted = await jsonFetch(`/api/sessions/${sessionId}/delete`, { method: "POST", cookie: user.cookie, body: {} });
  assert(deleted.status === 200 && deleted.data.ok === true, "owner can delete");
  const missing = await jsonFetch(`/api/sessions/${sessionId}`, { cookie: user.cookie });
  assert(missing.status === 404, "deleted session is gone");
  assert(sqliteScalar("SELECT COUNT(*) FROM session_program WHERE room_id='tmmgmt1'") === "0", "delete removes live program row");
  const copyStillThere = await jsonFetch(`/api/sessions/${duplicated.data.session.id}`, { cookie: user.cookie });
  assert(copyStillThere.status === 200, "deleting source does not delete the duplicate");

  console.log("\nAll session-management server tests passed.");
}

main()
  .then(() => { server.kill(); rmSync(scratchDir, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => {
    console.error(error);
    console.error("\n--- server output ---\n" + serverOutput);
    server.kill();
    rmSync(scratchDir, { recursive: true, force: true }); process.exit(1);
  });
