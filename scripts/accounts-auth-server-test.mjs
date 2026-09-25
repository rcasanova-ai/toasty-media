#!/usr/bin/env node
// HTTP-level integration test for Phase 2 of accounts/organizations/billing: registration auto-creates an
// organization, email verification, forgot/reset password (neutral response, hash-only tokens, single
// use), change password, and session invalidation on password change — against the REAL
// render-production-server.mjs + toasty-auth-db.py, same pattern as scripts/session-management-server-test.mjs.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4209;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-accounts-auth-"));
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
row = conn.execute(sys.argv[1]).fetchone()
print(row[0] if row else "")
`, sql], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || "sqlite query failed");
  return result.stdout.trim();
}

// The dev email transport (sendEmail() in render-production-server.mjs when RESEND_API_KEY is unset)
// console.logs the verification/reset URL — pull the most recent token for a given path out of captured
// server stdout instead of needing a real inbox.
function latestTokenFor(pathFragment) {
  const pattern = new RegExp(`${pathFragment}\\?token=([A-Za-z0-9_-]+)`, "g");
  let match;
  let last = null;
  while ((match = pattern.exec(serverOutput))) last = match[1];
  if (!last) throw new Error(`No token found in server output for ${pathFragment}`);
  return last;
}

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "accounts-auth-test-secret", RESEND_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function main() {
  await waitForHealth();

  console.log("Registration auto-creates exactly one organization (owner role) and sends a verification email");
  const signup = await jsonFetch("/auth/register", { method: "POST", body: { name: "Ada Lovelace", email: "ada@example.com", password: "password10chars" } });
  assert(signup.status === 201, "registration succeeds");
  assert(signup.data.user.emailVerifiedAt === null, "a fresh account starts unverified");
  const orgCount = sqliteScalar("SELECT COUNT(*) FROM organizations");
  assert(orgCount === "1", "exactly one organization exists after one signup");
  const membershipRole = sqliteScalar(`SELECT role FROM memberships WHERE user_id='${signup.data.user.id}'`);
  assert(membershipRole === "owner", "the new user is the owner of their auto-created organization");

  console.log("\nEmail verification — real token works once, garbage/reused tokens are rejected");
  const verifyToken = latestTokenFor("verify-email.html");
  const badVerify = await jsonFetch("/auth/verify-email", { method: "POST", body: { token: "not-a-real-token" } });
  assert(badVerify.status === 400, "a token that was never issued is rejected");
  const goodVerify = await jsonFetch("/auth/verify-email", { method: "POST", body: { token: verifyToken } });
  assert(goodVerify.status === 200 && goodVerify.data.user.emailVerifiedAt, "the real token verifies the email");
  const reusedVerify = await jsonFetch("/auth/verify-email", { method: "POST", body: { token: verifyToken } });
  assert(reusedVerify.status === 400, "the same verification token cannot be used twice");

  console.log("\nLogin / logout");
  const login = await jsonFetch("/auth/login", { method: "POST", body: { email: "ada@example.com", password: "password10chars" } });
  assert(login.status === 200, "login succeeds with the right password");
  const wrongLogin = await jsonFetch("/auth/login", { method: "POST", body: { email: "ada@example.com", password: "wrong-password" } });
  assert(wrongLogin.status === 401, "login fails with the wrong password");
  const session = await jsonFetch("/auth/session", { cookie: login.cookie });
  assert(session.data.authenticated === true, "the session cookie authenticates a follow-up request");

  console.log("\nForgot password — always a neutral response, real or fake email");
  const forgotReal = await jsonFetch("/auth/forgot-password", { method: "POST", body: { email: "ada@example.com" } });
  const forgotFake = await jsonFetch("/auth/forgot-password", { method: "POST", body: { email: "nobody-here@example.com" } });
  assert(forgotReal.status === 200 && forgotFake.status === 200, "both requests return 200");
  assert(JSON.stringify(forgotReal.data) === JSON.stringify(forgotFake.data), "the response body is identical whether or not the email exists (no enumeration)");

  console.log("\nReset password — real token works once, changes the password, and invalidates the prior session everywhere");
  const resetToken = latestTokenFor("reset-password.html");
  const badReset = await jsonFetch("/auth/reset-password", { method: "POST", body: { token: "garbage", newPassword: "brandNewPassword1" } });
  assert(badReset.status === 400, "a bogus reset token is rejected");
  const goodReset = await jsonFetch("/auth/reset-password", { method: "POST", body: { token: resetToken, newPassword: "brandNewPassword1" } });
  assert(goodReset.status === 200, "the real reset token succeeds");
  const reusedReset = await jsonFetch("/auth/reset-password", { method: "POST", body: { token: resetToken, newPassword: "anotherPassword2" } });
  assert(reusedReset.status === 400, "the same reset token cannot be used twice");

  const oldSessionStillWorks = await jsonFetch("/auth/session", { cookie: login.cookie });
  assert(oldSessionStillWorks.data.authenticated === false, "the session cookie issued BEFORE the reset no longer authenticates");

  const loginOldPassword = await jsonFetch("/auth/login", { method: "POST", body: { email: "ada@example.com", password: "password10chars" } });
  assert(loginOldPassword.status === 401, "the old password no longer works");
  const loginNewPassword = await jsonFetch("/auth/login", { method: "POST", body: { email: "ada@example.com", password: "brandNewPassword1" } });
  assert(loginNewPassword.status === 200, "the new password works");

  console.log("\nChange password (authenticated) — requires the current password, invalidates OTHER sessions, keeps this one working");
  const secondDeviceLogin = await jsonFetch("/auth/login", { method: "POST", body: { email: "ada@example.com", password: "brandNewPassword1" } });
  assert(secondDeviceLogin.status === 200, "a second login (simulating a second device) succeeds");

  const wrongCurrent = await jsonFetch("/auth/change-password", { method: "POST", cookie: loginNewPassword.cookie, body: { currentPassword: "not-the-password", newPassword: "yetAnotherPassword3" } });
  assert(wrongCurrent.status === 401, "change-password requires the correct current password");

  const changed = await jsonFetch("/auth/change-password", { method: "POST", cookie: loginNewPassword.cookie, body: { currentPassword: "brandNewPassword1", newPassword: "yetAnotherPassword3" } });
  assert(changed.status === 200, "change-password succeeds with the correct current password");

  const thisSessionStillWorks = await jsonFetch("/auth/session", { cookie: changed.cookie });
  assert(thisSessionStillWorks.data.authenticated === true, "the session that just changed its own password keeps working (re-issued cookie)");

  const otherDeviceNowLoggedOut = await jsonFetch("/auth/session", { cookie: secondDeviceLogin.cookie });
  assert(otherDeviceNowLoggedOut.data.authenticated === false, "a DIFFERENT session active before the change is invalidated");

  console.log("\nSame-second regression: a fresh login right after a password change must NOT be invalidated");
  {
    // This is the exact bug a first (timestamp-comparison) implementation of session invalidation had: a
    // password change and an immediately-following legitimate login can land in the same wall-clock
    // second, and a second-precision timestamp comparison can't tell "before" from "at" apart. The fix is
    // an incrementing passwordVersion instead of a timestamp — this loop hammers the race window to make
    // sure it can't regress back to the timestamp approach without this failing.
    // Kept well under both the login (12/15min) and change-password (10/15min) rate-limit buckets,
    // several of which were already spent earlier in this test file.
    for (let i = 0; i < 5; i += 1) {
      const changeResp = await jsonFetch("/auth/change-password", { method: "POST", cookie: changed.cookie, body: { currentPassword: "yetAnotherPassword3", newPassword: "yetAnotherPassword3" } });
      assert(changeResp.status === 200, `change-password iteration ${i} succeeds (no-op password change, just to bump the version)`);
      const freshLogin = await jsonFetch("/auth/login", { method: "POST", body: { email: "ada@example.com", password: "yetAnotherPassword3" } });
      assert(freshLogin.status === 200, `iteration ${i}: login immediately after a password change succeeds`);
      const freshSession = await jsonFetch("/auth/session", { cookie: freshLogin.cookie });
      assert(freshSession.data.authenticated === true, `iteration ${i}: the fresh login's session is NOT incorrectly invalidated by the change that just happened`);
      changed.cookie = changeResp.cookie;
    }
  }

  console.log("\nRate limiting — forgot-password is throttled per the configured window");
  let sawRateLimit = false;
  for (let i = 0; i < 8; i += 1) {
    const attempt = await jsonFetch("/auth/forgot-password", { method: "POST", body: { email: `throttle-check-${i}@example.com` } });
    if (attempt.status === 429) sawRateLimit = true;
  }
  assert(sawRateLimit, "repeated forgot-password requests eventually get rate-limited");

  console.log("\nAll accounts auth server tests passed.");
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
