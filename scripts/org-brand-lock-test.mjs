#!/usr/bin/env node
// Organization-owned dynamic brand lock — server-authoritative, same pattern/conventions as
// scripts/brand-lock-policy-test.mjs (which covers the LEGACY per-brand-id lock). Covers the
// "org:<organizationId>" brand-id convention: a locked account can never create/resume a session in any
// other organization, /api/organizations never lists any org but its own, the public brand-profile
// endpoint resolves a real BrandProfile, and the whole thing is idempotent across repeated `migrate()`
// runs (see toasty-auth-db.py's bootstrap_stablecorp_brand_lock, the concrete production case this
// mechanism exists for).
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4212;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-org-brand-lock-test-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function db(action, values = {}) {
  const result = spawnSync("python3", [helper], { input: JSON.stringify({ dbPath, action, ...values }), encoding: "utf8" });
  if (result.status !== 0 && !result.stdout) throw new Error(`db ${action} failed: ${result.stderr || result.status}`);
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
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "org-brand-lock-test-secret", RESEND_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function main() {
  await waitForHealth();
  db("migrate");

  console.log("Setup — a member account, plus a second, unrelated organization to prove isolation");
  const member = await jsonFetch("/auth/register", { method: "POST", body: { name: "Acme Member", email: "acme@example.com", password: "password10chars" } });
  assert(member.status === 201, "member registers");
  const acmeOrgId = member.data.user ? (await jsonFetch("/api/organizations", { cookie: member.cookie })).data.organizations[0].id : null;
  assert(Boolean(acmeOrgId), "member's own organization exists");

  const other = await jsonFetch("/auth/register", { method: "POST", body: { name: "Other Org Owner", email: "other@example.com", password: "password10chars" } });
  const otherOrgId = (await jsonFetch("/api/organizations", { cookie: other.cookie })).data.organizations[0].id;

  console.log("\nGive Acme's organization a real, customized active BrandProfile");
  const profileCreate = await jsonFetch(`/api/organizations/${acmeOrgId}/brand-profiles`, {
    method: "POST", cookie: member.cookie,
    body: { name: "Acme", baseThemeId: "toasty", overrides: { logoSrc: "https://acme.example/logo.svg", vars: { "--brand-primary": "#123456" } } }
  });
  assert(profileCreate.status === 201, "brand profile is created with overrides");
  const profileId = profileCreate.data.brandProfile.id;
  const activate = await jsonFetch(`/api/organizations/${acmeOrgId}/update`, { method: "POST", cookie: member.cookie, body: { activeBrandProfileId: profileId } });
  assert(activate.status === 200 && activate.data.organization.activeBrandProfileId === profileId, "profile is set as the organization's active brand");

  console.log("\nPublic/guest-safe brand-profile lookup — no account, no cookie");
  const publicLookup = await fetch(`${BASE}/api/organizations/${acmeOrgId}/brand-profile`);
  const publicData = await publicLookup.json();
  assert(publicLookup.status === 200, "public brand-profile endpoint responds without auth");
  assert(publicData.brandProfile.overrides.logoSrc === "https://acme.example/logo.svg", "public endpoint returns the real overrides");
  assert(!("plan" in (publicData.organization || {})), "public endpoint never leaks plan/billing/owner data");

  console.log("\nLock the member's account to Acme's organization (operator-only action, same as legacy user_set_branding)");
  const lockResult = db("user_set_branding", { id: member.data.user.id, mode: "locked", brandId: `org:${acmeOrgId}` });
  assert(lockResult.user.branding.mode === "locked" && lockResult.user.branding.brandId === `org:${acmeOrgId}`, "account is locked with the org: convention");

  const sessionAfterLock = await jsonFetch("/auth/session", { cookie: member.cookie });
  assert(sessionAfterLock.data.user.branding.organizationId === acmeOrgId, "/auth/session inlines the resolved organizationId");
  assert(sessionAfterLock.data.user.branding.brandProfile.overrides.logoSrc === "https://acme.example/logo.svg", "/auth/session inlines the resolved BrandProfile — no extra round trip needed");

  console.log("\nSession creation is forced into the locked organization, regardless of what's requested");
  const created = await jsonFetch("/api/sessions", {
    method: "POST", cookie: member.cookie,
    body: { roomId: "tmorglock1", title: "Should be Acme", organizationId: otherOrgId, brandId: "8alta" }
  });
  assert(created.status === 200, "locked create succeeds");
  assert(created.data.session.organizationId === acmeOrgId, "server forced organizationId to the locked org, ignoring the requested otherOrgId");
  assert(created.data.session.brandId === `org:${acmeOrgId}`, "server forced brandId to the locked org's own dynamic brand, ignoring the requested 8alta");

  console.log("\n/api/organizations never lists any organization but the locked one");
  const orgList = await jsonFetch("/api/organizations", { cookie: member.cookie });
  assert(orgList.data.organizations.length === 1 && orgList.data.organizations[0].id === acmeOrgId, "locked account's organization list contains exactly their own org");

  console.log("\nOrganization isolation still holds for a locked account (cannot read the other org's data)");
  const stolenGet = await jsonFetch(`/api/organizations/${otherOrgId}`, { cookie: member.cookie });
  assert(stolenGet.status === 404, "a locked account cannot read another organization it happens to still be listed against");

  console.log("\nIdempotent production bootstrap — migrate() re-run does not create a second profile or clobber a real customization");
  db("migrate");
  db("migrate");
  const profilesAfter = await jsonFetch(`/api/organizations/${acmeOrgId}/brand-profiles`, { cookie: member.cookie });
  assert(profilesAfter.data.brandProfiles.length === 1, "re-running migrate() does not create duplicate brand profiles");
  assert(profilesAfter.data.brandProfiles[0].id === profileId, "the same profile id survives repeated migrate() runs");

  console.log("\nALL PASSED — organization-owned dynamic brand lock is server-authoritative.");
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
