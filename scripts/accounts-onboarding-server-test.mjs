#!/usr/bin/env node
// HTTP-level integration test for the onboarding wizard's website-analysis step (Phase 3). This route
// fetches a URL the caller supplies from the SERVER, which is a textbook SSRF vector, so most of this file
// is about proving the SSRF guard actually blocks the classic targets (localhost, RFC1918 ranges, the AWS
// metadata address) BEFORE any request is attempted. The happy-path parsing is tested against a local mock
// "website" server, reached only because TOASTY_ONBOARDING_ANALYSIS_ALLOW_PRIVATE=1 is set for THIS test
// process alone (see the flag's comment in render-production-server.mjs) — every real deployment leaves it
// unset, so production keeps the full private-IP block.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4217;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-onboarding-"));
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

const mockSite = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(`<!doctype html><html><head>
    <title>Fallback Title</title>
    <meta property="og:site_name" content="Acme Rockets">
    <meta name="description" content="We build rockets for hobbyists.">
    <meta name="theme-color" content="#ff7a29">
    <meta property="og:image" content="/social-card.png">
    <link rel="icon" href="/favicon.ico">
    <style>.hero{color:#ff7a29}.hero{color:#ff7a29}.badge{color:#111827}</style>
  </head><body>Acme Rockets</body></html>`);
});

async function main() {
  await new Promise((resolve) => mockSite.listen(0, "127.0.0.1", resolve));
  const mockPort = mockSite.address().port;

  const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: {
      ...process.env,
      TOASTY_RENDER_PORT: String(PORT),
      TOASTY_AUTH_DB: dbPath,
      TOASTY_AUTH_DB_HELPER: helper,
      TOASTY_SESSION_SECRET: "onboarding-test-secret",
      RESEND_API_KEY: "",
      TOASTY_ONBOARDING_ANALYSIS_ALLOW_PRIVATE: "1"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  server.stdout.on("data", (c) => (serverOutput += c));
  server.stderr.on("data", (c) => (serverOutput += c));

  try {
    await waitForHealth();

    const owner = await jsonFetch("/auth/register", { method: "POST", body: { name: "Onboarding Owner", email: "onboarding@example.com", password: "password10chars" } });
    const orgs = await jsonFetch("/api/organizations", { cookie: owner.cookie });
    const orgId = orgs.data.organizations[0].id;

    console.log("Analyzing a website is admin-only, even with the SSRF guard relaxed for this test");
    const member = await jsonFetch("/auth/register", { method: "POST", body: { name: "Regular Member", email: "member-onboarding@example.com", password: "password10chars" } });
    await jsonFetch(`/api/organizations/${orgId}/members/invite`, { method: "POST", cookie: owner.cookie, body: { email: "member-onboarding@example.com", role: "member" } });
    const inviteMatch = serverOutput.match(/accept-invite\.html\?token=([A-Za-z0-9_-]+)/g);
    const inviteToken = inviteMatch[inviteMatch.length - 1].split("token=")[1];
    await jsonFetch("/api/invites/accept", { method: "POST", cookie: member.cookie, body: { token: inviteToken } });
    const memberAttempt = await jsonFetch(`/api/organizations/${orgId}/onboarding/analyze-website`, { method: "POST", cookie: member.cookie, body: { url: `http://127.0.0.1:${mockPort}/` } });
    assert(memberAttempt.status === 403, "a plain member (not admin/owner) cannot run the website analysis");

    console.log("\nMalformed input is rejected before any fetch");
    const missing = await jsonFetch(`/api/organizations/${orgId}/onboarding/analyze-website`, { method: "POST", cookie: owner.cookie, body: {} });
    assert(missing.status === 400, "a missing URL is rejected");
    const malformed = await jsonFetch(`/api/organizations/${orgId}/onboarding/analyze-website`, { method: "POST", cookie: owner.cookie, body: { url: "not a url at all !!" } });
    assert(malformed.status === 400, "an unparseable URL is rejected");

    console.log("\nA real website is fetched and parsed correctly (against a local mock, SSRF guard relaxed only for this test process)");
    const analyzed = await jsonFetch(`/api/organizations/${orgId}/onboarding/analyze-website`, { method: "POST", cookie: owner.cookie, body: { url: `http://127.0.0.1:${mockPort}/` } });
    assert(analyzed.status === 200, "the analysis succeeds");
    assert(analyzed.data.analysis.title === "Acme Rockets", "title prefers og:site_name over <title>");
    assert(analyzed.data.analysis.description === "We build rockets for hobbyists.", "description is extracted from meta description");
    assert(analyzed.data.analysis.themeColor === "#ff7a29", "theme-color meta tag is extracted");
    assert(analyzed.data.analysis.logoUrl === `http://127.0.0.1:${mockPort}/favicon.ico`, "favicon href is resolved to an absolute URL");
    assert(analyzed.data.analysis.ogImage === `http://127.0.0.1:${mockPort}/social-card.png`, "og:image is resolved to an absolute URL");
    assert(analyzed.data.analysis.dominantColors[0] === "#ff7a29", "the most-repeated hex color in the page is ranked first");

    console.log("\nThe analyzed URL is saved onto organization settings as a side effect");
    const settings = await jsonFetch(`/api/organizations/${orgId}/settings`, { cookie: owner.cookie });
    assert(settings.data.settings.websiteUrl === `http://127.0.0.1:${mockPort}/`, "organization_settings.websiteUrl is updated after a successful analysis");

    console.log("\nAll accounts onboarding (website analysis) server tests passed.");
  } finally {
    server.kill();
  }

  console.log("\n--- SSRF guard, running WITHOUT the test-only allow-private flag (real production behavior) ---");
  const guardedPort = 4218;
  const guardedBase = `http://127.0.0.1:${guardedPort}`;
  const guardedDbPath = join(scratchDir, "toasty-guarded.sqlite");
  const guardedServer = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: { ...process.env, TOASTY_RENDER_PORT: String(guardedPort), TOASTY_AUTH_DB: guardedDbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "onboarding-guarded-secret", RESEND_API_KEY: "", TOASTY_ONBOARDING_ANALYSIS_ALLOW_PRIVATE: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`${guardedBase}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
    const guardedOwnerRes = await fetch(`${guardedBase}/auth/register`, { method: "POST", headers: { "content-type": "application/json", "x-toasty-csrf": "1" }, body: JSON.stringify({ name: "Guarded Owner", email: "guarded@example.com", password: "password10chars" }) });
    const guardedCookie = cookieFrom(guardedOwnerRes);
    const guardedOrgs = await (await fetch(`${guardedBase}/api/organizations`, { headers: { cookie: guardedCookie } })).json();
    const guardedOrgId = guardedOrgs.organizations[0].id;

    const targets = [
      ["http://127.0.0.1:9/", "loopback (127.0.0.1)"],
      ["http://localhost:9/", "loopback hostname (localhost)"],
      ["http://10.0.0.1/", "RFC1918 10.0.0.0/8"],
      ["http://172.16.0.1/", "RFC1918 172.16.0.0/12"],
      ["http://192.168.1.1/", "RFC1918 192.168.0.0/16"],
      ["http://169.254.169.254/", "link-local / cloud metadata address"],
      ["http://[::1]/", "IPv6 loopback"]
    ];
    for (const [url, label] of targets) {
      const attempt = await fetch(`${guardedBase}/api/organizations/${guardedOrgId}/onboarding/analyze-website`, { method: "POST", headers: { cookie: guardedCookie, "content-type": "application/json", "x-toasty-csrf": "1" }, body: JSON.stringify({ url }) });
      assert(attempt.status === 400, `${label} is blocked by the SSRF guard by default`);
    }
    console.log("\nAll SSRF guard assertions passed.");
  } finally {
    guardedServer.kill();
  }
}

main()
  .then(() => { mockSite.close(); rmSync(scratchDir, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => {
    console.error(error);
    mockSite.close();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
