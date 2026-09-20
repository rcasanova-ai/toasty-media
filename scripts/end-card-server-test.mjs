#!/usr/bin/env node
// End card backend routes, against the real render-production-server.mjs + a scratch SQLite DB (same
// pattern as brand-lock-policy-test.mjs) — not just the client-side resolution unit tests. Proves the
// profile-default and session-override persistence actually round-trips through real HTTP + SQLite, and
// that ownership/auth boundaries hold (one account cannot read/write another account's session end card).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4207;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-end-card-test-"));
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

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "end-card-test-secret" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function main() {
  await waitForHealth();

  console.log("Profile default end card persists across requests for the same account");
  const user = await jsonFetch("/auth/register", { method: "POST", body: { name: "Ricardo", email: "ricardo@example.com", password: "password10chars" } });
  assert(user.status === 201, "user registers");
  assert(JSON.stringify(user.data.user.endCard) === "{}", "new account starts with no end card default");

  const profileSave = await jsonFetch("/api/profile/end-card", {
    method: "POST",
    cookie: user.cookie,
    body: { endCard: { headline: "Follow Ricardo / Toasty Peeps", website: "toasty.media/peeps", socials: { x: "https://x.com/toastymedia", notreal: "https://dropped.example" } } }
  });
  assert(profileSave.status === 200, "profile end card saves");
  assert(profileSave.data.user.endCard.headline === "Follow Ricardo / Toasty Peeps", "saved headline round-trips");
  assert(profileSave.data.user.endCard.socials.x === "https://x.com/toastymedia", "saved social URL round-trips");
  assert(!("notreal" in profileSave.data.user.endCard.socials), "server strips unknown social platform keys");

  const reread = await jsonFetch("/auth/session", { cookie: user.cookie });
  assert(reread.data.user.endCard.headline === "Follow Ricardo / Toasty Peeps", "profile default persists and is readable via /auth/session on a later request");

  console.log("\nSession override end card persists on the durable session row, independent of profile default");
  const created = await jsonFetch("/api/sessions", { method: "POST", cookie: user.cookie, body: { roomId: "tmendcard1", title: "Weekly Update", brandId: "peeps" } });
  assert(created.status === 200, "session creates");
  assert(JSON.stringify(created.data.session.endCard) === "{}", "new session starts with no end card override");

  const sessionSave = await jsonFetch(`/api/sessions/${created.data.session.id}/end-card`, {
    method: "POST",
    cookie: user.cookie,
    body: { endCard: { headline: "Session-specific headline", showQr: true, qrImage: "data:image/png;base64,AAA" } }
  });
  assert(sessionSave.status === 200, "session end card saves");
  assert(sessionSave.data.session.endCard.headline === "Session-specific headline", "session override headline round-trips");
  assert(sessionSave.data.session.endCard.qrImage === "data:image/png;base64,AAA", "session override QR image round-trips");

  const resumedSession = await jsonFetch(`/api/sessions/${created.data.session.id}`, { cookie: user.cookie });
  assert(resumedSession.data.session.endCard.headline === "Session-specific headline", "session override persists across a later GET");

  const profileAfterSessionSave = await jsonFetch("/auth/session", { cookie: user.cookie });
  assert(profileAfterSessionSave.data.user.endCard.headline === "Follow Ricardo / Toasty Peeps", "saving a session override does not mutate the profile default");

  console.log("\nOwnership boundary: another account cannot read or write this session's end card");
  const other = await jsonFetch("/auth/register", { method: "POST", body: { name: "Someone Else", email: "someone@example.com", password: "password10chars" } });
  assert(other.status === 201, "second user registers");
  const stolenRead = await jsonFetch(`/api/sessions/${created.data.session.id}`, { cookie: other.cookie });
  assert(stolenRead.status === 404, "another account cannot GET a session it does not own");
  const stolenWrite = await jsonFetch(`/api/sessions/${created.data.session.id}/end-card`, { method: "POST", cookie: other.cookie, body: { endCard: { headline: "hijacked" } } });
  assert(stolenWrite.status === 404, "another account cannot write another account's session end card");
  const untouchedAfterHijackAttempt = await jsonFetch(`/api/sessions/${created.data.session.id}`, { cookie: user.cookie });
  assert(untouchedAfterHijackAttempt.data.session.endCard.headline === "Session-specific headline", "the hijack attempt left the real owner's session end card unchanged");

  console.log("\nAuth required");
  const noAuth = await jsonFetch("/api/profile/end-card", { method: "POST", body: { endCard: { headline: "nope" } } });
  assert(noAuth.status === 401, "unauthenticated profile end-card write is rejected");

  console.log("\nAll end-card server tests passed.");
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
