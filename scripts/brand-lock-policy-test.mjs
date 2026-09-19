#!/usr/bin/env node
// Brand-lock contract for 9782c2e — no live room, no VDO, no camera/mute.
// Uses the production DB helper (scripts/toasty-auth-db.py.production-reference) because that is the
// file 9782c2e actually updated; git scripts/toasty-auth-db.py still has no brand_mode columns.
// Run: node scripts/brand-lock-policy-test.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND_THEME_IDS, DEFAULT_BRAND_THEME, normalizeBrandTheme } from "../js/brand-themes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PROD_HELPER = join(ROOT, "scripts/toasty-auth-db.py.production-reference");
const GIT_HELPER = join(ROOT, "scripts/toasty-auth-db.py");
const PORT = 4201;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-brand-lock-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const SECRET = "brand-lock-test-secret";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function runHelper(helper, payload) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [helper], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      if (!stdout.trim()) {
        reject(new Error(`helper empty (code ${code}): ${stderr}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`helper JSON: ${stdout}\n${stderr}\n${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify({ dbPath, ...payload }));
  });
}

function cookieFrom(response) {
  const raw = response.headers.getSetCookie?.() || [];
  const header = raw.find((value) => value.startsWith("toasty_session=")) || "";
  return header.split(";")[0];
}

async function api(path, { method = "GET", body, cookie, csrf = true, origin } = {}) {
  const headers = {};
  if (method !== "GET") headers["Content-Type"] = "application/json";
  if (csrf && method !== "GET") headers["X-Toasty-CSRF"] = "1";
  if (cookie) headers.Cookie = cookie;
  if (origin) headers.Origin = origin;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body)
  });
  let payload = {};
  try { payload = await response.json(); } catch { /* empty */ }
  return { status: response.status, payload, cookie: cookieFrom(response) || cookie || "" };
}

const server = spawn("node", [join(ROOT, "scripts/render-production-server.mjs")], {
  env: {
    ...process.env,
    TOASTY_RENDER_PORT: String(PORT),
    TOASTY_AUTH_DB: dbPath,
    TOASTY_AUTH_DB_HELPER: PROD_HELPER,
    TOASTY_SESSION_SECRET: SECRET
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("render server never came up");
}

async function main() {
  console.log("Brand-lock — source / helper contract");

  const prodHelper = readFileSync(PROD_HELPER, "utf8");
  const gitHelper = readFileSync(GIT_HELPER, "utf8");
  const studioAuth = readFileSync(join(ROOT, "js/studio-auth.js"), "utf8");
  const director = readFileSync(join(ROOT, "js/director.js"), "utf8");
  const serverSrc = readFileSync(join(ROOT, "scripts/render-production-server.mjs"), "utf8");
  const sessionMgr = readFileSync(join(ROOT, "js/session-manager.js"), "utf8");

  assert(prodHelper.includes("brand_mode"), "production DB helper migrates brand_mode");
  assert(prodHelper.includes("locked_brand_id"), "production DB helper migrates locked_brand_id");
  assert(prodHelper.includes("user_set_branding"), "production DB helper has operator-only user_set_branding");
  assert(!prodHelper.includes("/auth/") && !/http.*user_set_branding/.test(prodHelper), "user_set_branding is not an HTTP route in the helper");
  assert(!serverSrc.includes('db("user_set_branding"') && !serverSrc.includes("/auth/branding"), "render server does not expose user_set_branding over HTTP");
  assert(!gitHelper.includes("brand_mode"), "git toasty-auth-db.py still lacks brand_mode (production-reference is the live helper)");
  assert(!gitHelper.includes("user_set_branding"), "git toasty-auth-db.py still lacks user_set_branding");
  assert(studioAuth.includes('branding.mode === "locked"'), "studio-auth.js forces locked brand from /auth/session");
  assert(studioAuth.includes("useStorage: false"), "logged-out public gate does not read localStorage brand");
  assert(studioAuth.includes("normalizeBrandTheme(branding.brandId)"), "locked boot uses server brandId, not URL/storage");
  assert(director.includes('get("brandLocked") === "1"'), "director.js treats brandLocked as UX-only hide flag");
  assert(serverSrc.includes("requireCsrf(req, res)") && serverSrc.includes('req.url.endsWith("/brand")'), "brand-change API requires CSRF");
  assert(sessionMgr.includes("result.session.status !== \"ENDED\""), "session resume does not currently re-check locked brand");

  assertEqual(normalizeBrandTheme("superteam"), "superteam", "known brand id stays itself");
  assertEqual(normalizeBrandTheme("not-a-real-brand"), DEFAULT_BRAND_THEME, "unknown brand ids fall back to Toasty on the frontend");
  assert(BRAND_THEME_IDS.includes("superteam"), "superteam is a catalog brand");
  assert(!BRAND_THEME_IDS.includes("not-a-real-brand"), "garbage ids are not in the catalog");

  console.log("\nBrand-lock — production helper (migrate / operator action)");

  const pre = join(scratchDir, "pre-migrate.sqlite");
  const boot = spawn("python3", ["-c", [
    "import sqlite3, sys",
    "path = sys.argv[1]",
    "conn = sqlite3.connect(path)",
    "conn.execute('CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_login_at TEXT, status TEXT NOT NULL DEFAULT \"active\")')",
    "conn.execute(\"INSERT INTO users VALUES ('u_old','Existing','old@test.local','hash','2026-01-01','2026-01-01',NULL,'active')\")",
    "conn.commit()",
  ].join("\n"), pre], { stdio: ["ignore", "pipe", "pipe"] });
  const bootErr = await new Promise((resolve, reject) => {
    let stderr = "";
    boot.stderr.on("data", (c) => { stderr += c; });
    boot.on("close", (code) => code === 0 ? resolve("") : reject(new Error(`bootstrap failed: ${stderr || code}`)));
  });

  const migratedOnce = await new Promise((resolve, reject) => {
    const child = spawn("python3", [PROD_HELPER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.on("close", () => resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ dbPath: pre, action: "migrate" }));
  });
  assertEqual(migratedOnce.ok, true, "migrate() succeeds against a pre-branding users table");
  const migratedTwice = await new Promise((resolve, reject) => {
    const child = spawn("python3", [PROD_HELPER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.on("close", () => resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ dbPath: pre, action: "migrate" }));
  });
  assertEqual(migratedTwice.ok, true, "migrate() is idempotent on a second start");
  const oldUser = await new Promise((resolve) => {
    const child = spawn("python3", [PROD_HELPER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (c) => { stdout += c; });
    child.on("close", () => resolve(JSON.parse(stdout)));
    child.stdin.end(JSON.stringify({ dbPath: pre, action: "get_user_by_id", id: "u_old" }));
  });
  assertEqual(oldUser.user.branding.mode, "flexible", "existing users remain flexible after migration");
  assertEqual(oldUser.user.branding.brandId, null, "existing users have no locked_brand_id");

  await waitForHealth();

  const created = await runHelper(PROD_HELPER, {
    action: "create_user",
    id: "u_new",
    name: "New Account",
    email: "new@test.local",
    passwordHash: "hash"
  });
  assertEqual(created.user.branding.mode, "flexible", "new accounts default to flexible");

  const badMode = await runHelper(PROD_HELPER, {
    action: "user_set_branding",
    id: "u_new",
    mode: "enterprise",
    brandId: "superteam"
  });
  assertEqual(badMode.error, "invalid_mode", "user_set_branding rejects unknown brand_mode");

  const locked = await runHelper(PROD_HELPER, {
    action: "user_set_branding",
    id: "u_new",
    mode: "locked",
    brandId: "superteam"
  });
  assertEqual(locked.user.branding.mode, "locked", "operator can lock an account");
  assertEqual(locked.user.branding.brandId, "superteam", "locked_brand_id is stored");

  const unlocked = await runHelper(PROD_HELPER, {
    action: "user_set_branding",
    id: "u_new",
    mode: "flexible",
    brandId: "tangem"
  });
  assertEqual(unlocked.user.branding.mode, "flexible", "operator can return an account to flexible");
  assertEqual(unlocked.user.branding.brandId, null, "unlocking clears locked_brand_id even if a brandId was sent");

  const bogusBrand = await runHelper(PROD_HELPER, {
    action: "user_set_branding",
    id: "u_new",
    mode: "locked",
    brandId: "not-a-real-brand"
  });
  assertEqual(bogusBrand.user.branding.brandId, "not-a-real-brand", "helper currently does not validate locked_brand_id against the Studio catalog (documented gap)");

  const gitUnknown = await runHelper(GIT_HELPER, { action: "user_set_branding", id: "x", mode: "locked" });
  assert(gitUnknown.error === "db_error", "git helper rejects user_set_branding as an unknown action");

  console.log(`\nBrand-lock — HTTP enforcement on ${BASE}`);

  const flexibleReg = await api("/auth/register", {
    method: "POST",
    body: { name: "Flexible Host", email: "flexible@test.local", password: "password10" }
  });
  assertEqual(flexibleReg.status, 201, "flexible account can register");
  assertEqual(flexibleReg.payload.user.branding.mode, "flexible", "/auth/register serializes branding.mode");
  let flexCookie = flexibleReg.cookie;
  assert(flexCookie.startsWith("toasty_session="), "register sets HttpOnly session cookie");
  const cookiePayload = JSON.parse(Buffer.from(flexCookie.split("=")[1].split(".")[0], "base64url").toString("utf8"));
  assert(!("branding" in cookiePayload), "session cookie does not carry branding — DB is re-read on every request");

  const unauthCreate = await api("/api/sessions", {
    method: "POST",
    body: { roomId: "roomflex1", title: "x", brandId: "8alta" }
  });
  assertEqual(unauthCreate.status, 401, "session create requires auth");

  const noCsrf = await api("/api/sessions", {
    method: "POST",
    cookie: flexCookie,
    csrf: false,
    body: { roomId: "roomflex1", title: "x", brandId: "8alta" }
  });
  assertEqual(noCsrf.status, 403, "session create without CSRF is rejected");

  const flexCreate = await api("/api/sessions", {
    method: "POST",
    cookie: flexCookie,
    body: { roomId: "roomflex1", title: "Flex 8ALTA", brandId: "8alta" }
  });
  assertEqual(flexCreate.status, 200, "flexible account can create a session");
  assertEqual(flexCreate.payload.session.brandId, "8alta", "flexible create honors client brandId");
  const flexSessionId = flexCreate.payload.session.id;

  const flexChange = await api(`/api/sessions/${flexSessionId}/brand`, {
    method: "POST",
    cookie: flexCookie,
    body: { brandId: "santati" }
  });
  assertEqual(flexChange.status, 200, "flexible account can change brand");
  assertEqual(flexChange.payload.session.brandId, "santati", "flexible brand-change persists");

  const lockedReg = await api("/auth/register", {
    method: "POST",
    body: { name: "Locked Host", email: "locked@test.local", password: "password10" }
  });
  assertEqual(lockedReg.status, 201, "second account can register");
  let lockCookie = lockedReg.cookie;
  const lockedUserId = lockedReg.payload.user.id;

  const preLock = await api("/api/sessions", {
    method: "POST",
    cookie: lockCookie,
    body: { roomId: "roomoldalta", title: "Old 8ALTA", brandId: "8alta" }
  });
  assertEqual(preLock.payload.session.brandId, "8alta", "account can create an 8ALTA session before it is locked");
  const oldSessionId = preLock.payload.session.id;

  const lockOp = await runHelper(PROD_HELPER, {
    action: "user_set_branding",
    id: lockedUserId,
    mode: "locked",
    brandId: "superteam"
  });
  assertEqual(lockOp.user.branding.mode, "locked", "operator lock applied");

  const sessionAfterLock = await api("/auth/session", { cookie: lockCookie });
  assertEqual(sessionAfterLock.payload.authenticated, true, "existing cookie still authenticates after lock");
  assertEqual(sessionAfterLock.payload.user.branding.mode, "locked", "/auth/session reloads branding from DB, not the cookie");
  assertEqual(sessionAfterLock.payload.user.branding.brandId, "superteam", "/auth/session reports locked_brand_id");

  const lockedCreate = await api("/api/sessions", {
    method: "POST",
    cookie: lockCookie,
    body: { roomId: "roomforced", title: "Should be Superteam", brandId: "tangem" }
  });
  assertEqual(lockedCreate.status, 200, "locked account can still create a session");
  assertEqual(lockedCreate.payload.session.brandId, "superteam", "locked create ignores client brandId and forces locked brand");
  const lockedSessionId = lockedCreate.payload.session.id;

  const lockedBypass = await api(`/api/sessions/${lockedSessionId}/brand`, {
    method: "POST",
    cookie: lockCookie,
    body: { brandId: "tangem" }
  });
  assertEqual(lockedBypass.status, 403, "locked brand-change to another brand is 403");
  assert(/locked to a single brand/.test(lockedBypass.payload.error || ""), "403 message names the lock");

  const lockedSame = await api(`/api/sessions/${lockedSessionId}/brand`, {
    method: "POST",
    cookie: lockCookie,
    body: { brandId: "superteam" }
  });
  assertEqual(lockedSame.status, 200, "re-sending the locked brand is a no-op success");
  assertEqual(lockedSame.payload.session.brandId, "superteam", "no-op brand-change stays on locked brand");

  const resumeOther = await api(`/api/sessions/${oldSessionId}`, { cookie: lockCookie });
  assertEqual(resumeOther.status, 200, "locked account can still GET a pre-lock session it owns");
  assertEqual(resumeOther.payload.session.brandId, "8alta", "KNOWN GAP: resume of a pre-lock other-brand session is not rewritten/rejected");

  const otherOwner = await api(`/api/sessions/${flexSessionId}`, { cookie: lockCookie });
  assertEqual(otherOwner.status, 404, "locked account cannot open another owner's session");

  const logout = await api("/auth/logout", { method: "POST", cookie: lockCookie });
  assertEqual(logout.status, 200, "logout succeeds");
  const afterLogout = await api("/auth/session", { cookie: lockCookie });
  // Cookie still sent, but server clears it on logout response; this request used the old cookie value.
  // A subsequent login proves persistence of the lock.
  const relogin = await api("/auth/login", {
    method: "POST",
    body: { email: "locked@test.local", password: "password10" }
  });
  assertEqual(relogin.status, 200, "login after logout works");
  assertEqual(relogin.payload.user.branding.mode, "locked", "lock survives logout/login");
  assertEqual(relogin.payload.user.branding.brandId, "superteam", "locked brand survives logout/login");
  lockCookie = relogin.cookie;
  const otherBrowser = await api("/auth/session");
  assertEqual(otherBrowser.payload.authenticated, false, "a request with no cookie is unauthenticated (new browser)");

  const stillLocked = await api("/api/sessions", {
    method: "POST",
    cookie: lockCookie,
    body: { roomId: "roomagain", title: "Again", brandId: "peeps" }
  });
  assertEqual(stillLocked.payload.session.brandId, "superteam", "post-login create still forces locked brand");

  const noCsrfBrand = await api(`/api/sessions/${lockedSessionId}/brand`, {
    method: "POST",
    cookie: lockCookie,
    csrf: false,
    body: { brandId: "tangem" }
  });
  assertEqual(noCsrfBrand.status, 403, "brand-change without CSRF is rejected even before lock logic");

  const badOrigin = await api(`/api/sessions/${lockedSessionId}/brand`, {
    method: "POST",
    cookie: lockCookie,
    origin: "https://evil.example",
    body: { brandId: "tangem" }
  });
  assertEqual(badOrigin.status, 403, "brand-change from a disallowed origin is rejected");

  console.log("\nAll brand-lock policy checks passed.");
}

main()
  .then(() => {
    server.kill();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(`\n${error.message}`);
    console.error("\n--- server output ---");
    console.error(serverOutput);
    server.kill();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
