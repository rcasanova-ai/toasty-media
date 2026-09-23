#!/usr/bin/env node
// Brand-lock policy — server-authoritative. Covers the defects a previous pass found against
// production: Git's auth helper missing the lock, resume of a pre-lock foreign-brand session,
// invalid locked_brand_id storage, and mode=locked with no brandId.
//
// Run: node scripts/brand-lock-policy-test.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BRAND_THEME_IDS } from "../js/brand-themes.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4201;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-brand-lock-test-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const renderSrc = readFileSync(join(ROOT, "scripts", "render-production-server.mjs"), "utf8");
if (/from\s+["']\.\.\/js\//.test(renderSrc)) {
  throw new Error("render-production-server.mjs must stay self-contained (no ../js/ imports)");
}

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function db(action, values = {}) {
  const result = spawnSync("python3", [helper], {
    input: JSON.stringify({ dbPath, action, ...values }),
    encoding: "utf8"
  });
  if (result.status !== 0 && !result.stdout) {
    throw new Error(`db ${action} failed: ${result.stderr || result.status}`);
  }
  return JSON.parse(result.stdout);
}

function cookieFrom(response) {
  const raw = response.headers.get("set-cookie") || "";
  return raw.split(";")[0];
}

async function jsonFetch(path, { method = "GET", cookie, body } = {}) {
  const headers = { "x-toasty-csrf": "1" };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  return { status: response.status, data, cookie: cookieFrom(response) || cookie };
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server never came up");
}

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: {
    ...process.env,
    TOASTY_RENDER_PORT: String(PORT),
    TOASTY_AUTH_DB: dbPath,
    TOASTY_AUTH_DB_HELPER: helper,
    TOASTY_SESSION_SECRET: "brand-lock-test-secret"
  },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (chunk) => (serverOutput += chunk));
server.stderr.on("data", (chunk) => (serverOutput += chunk));

async function main() {
  await waitForHealth();
  db("migrate");

  console.log("0. catalog — Python helper and JS BRAND_THEMES stay identical");
  const pyCatalog = db("user_set_branding", { id: "nobody", mode: "locked", brandId: "not-a-real-brand" });
  assert(pyCatalog.error === "invalid_brand", "Python rejects a brand that is not in the catalog");
  const listed = [...BRAND_THEME_IDS].sort().join(",");
  assert(listed === "8alta,optimai,peeps,santati,superteam,tangem,toasty,zenify", "JS catalog is the canonical Studio brand set");
  const knownMatch = renderSrc.match(/KNOWN_BRAND_IDS = new Set\(\[([^\]]+)\]\)/);
  assert(Boolean(knownMatch), "render server inlines KNOWN_BRAND_IDS");
  const renderListed = knownMatch[1].split(",").map((entry) => entry.trim().replace(/['"]/g, "")).filter(Boolean).sort().join(",");
  assert(renderListed === listed, "inlined render catalog matches js/brand-themes.js");

  console.log("\n1. new users default flexible; mode=locked requires a valid brandId");
  const flexible = await jsonFetch("/auth/register", {
    method: "POST",
    body: { name: "Flexible User", email: "flex@example.com", password: "password10chars" }
  });
  assert(flexible.status === 201, "flexible user registers");
  assert(flexible.data.user.branding.mode === "flexible", "existing/new users default flexible");
  assert(flexible.data.user.branding.brandId === null, "flexible accounts have no locked brand");

  const lockedNoBrand = db("user_set_branding", { id: flexible.data.user.id, mode: "locked" });
  assert(lockedNoBrand.error === "invalid_brand", "mode=locked with no brandId is rejected");
  const stillFlexible = db("get_user_by_id", { id: flexible.data.user.id });
  assert(stillFlexible.user.branding.mode === "flexible", "rejected lock does not change the account");

  console.log("\n2. flexible user can create and resume an 8ALTA session");
  const created = await jsonFetch("/api/sessions", {
    method: "POST",
    cookie: flexible.cookie,
    body: { roomId: "tmbrandlock1", title: "8ALTA show", brandId: "8alta" }
  });
  assert(created.status === 200, "flexible create 8alta session");
  assert(created.data.session.brandId === "8alta", "flexible session stores the requested brand");
  const resumed = await jsonFetch(`/api/sessions/${created.data.session.id}`, { cookie: flexible.cookie });
  assert(resumed.status === 200 && resumed.data.session.brandId === "8alta", "flexible user can GET/resume their 8alta session");

  console.log("\n3. invalid brand on create is rejected (frontend cannot store a Toasty fallback)");
  const bogus = await jsonFetch("/api/sessions", {
    method: "POST",
    cookie: flexible.cookie,
    body: { roomId: "tmbrandlock2", title: "bogus", brandId: "notabrand" }
  });
  assert(bogus.status === 400, "unknown brandId is 400");

  console.log("\n4. locking the same user to Superteam closes the resume hole");
  const locked = db("user_set_branding", { id: flexible.data.user.id, mode: "locked", brandId: "superteam" });
  assert(locked.user.branding.mode === "locked" && locked.user.branding.brandId === "superteam", "account is now locked to superteam");

  const blockedGet = await jsonFetch(`/api/sessions/${created.data.session.id}`, { cookie: flexible.cookie });
  assert(blockedGet.status === 403, "locked account cannot GET/resume the old 8ALTA session");

  const listedActive = await jsonFetch("/api/sessions?status=active", { cookie: flexible.cookie });
  assert(listedActive.status === 200, "session list still works for locked user");
  assert(
    !(listedActive.data.sessions || []).some((session) => session.id === created.data.session.id),
    "old 8ALTA session is not offered as resumable"
  );

  console.log("\n5. locked create ignores client brandId; localStorage/cookies cannot override");
  const forced = await jsonFetch("/api/sessions", {
    method: "POST",
    cookie: flexible.cookie,
    body: { roomId: "tmbrandlock3", title: "should be superteam", brandId: "8alta" }
  });
  assert(forced.status === 200, "locked create succeeds");
  assert(forced.data.session.brandId === "superteam", "server stored Superteam, not the 8ALTA body.brandId");

  const brandChange = await jsonFetch(`/api/sessions/${forced.data.session.id}/brand`, {
    method: "POST",
    cookie: flexible.cookie,
    body: { brandId: "8alta" }
  });
  assert(brandChange.status === 403, "locked account cannot switch a live session off its brand");

  console.log("\n6. a different flexible user is unchanged");
  const other = await jsonFetch("/auth/register", {
    method: "POST",
    body: { name: "Other Flex", email: "otherflex@example.com", password: "password10chars" }
  });
  const otherSession = await jsonFetch("/api/sessions", {
    method: "POST",
    cookie: other.cookie,
    body: { roomId: "tmbrandlock4", title: "other 8alta", brandId: "8alta" }
  });
  assert(otherSession.status === 200 && otherSession.data.session.brandId === "8alta", "flexible users still pick any catalog brand");

  console.log("\nALL PASSED — brand lock is server-authoritative in the canonical Git helper.");
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
