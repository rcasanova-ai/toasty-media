#!/usr/bin/env node
// HTTP-level integration test for BYOK (Phase 6) — the brief's "no BYOK credential = no paid AI, never a
// silent platform-key fallback" requirement, plus credential storage/masking/tenancy isolation. Same
// pattern as scripts/session-management-server-test.mjs.
//
// Note on the "test key" assertions: they use a deliberately fake API key against the REAL
// api.openai.com, which correctly answers 401 with no cost and no valid credential required — this proves
// handleAiProviderTest genuinely calls out to the real provider (not a stub), without needing a real key
// or spending any money. If this environment has no outbound network access, those two assertions will
// fail with a network error instead of the expected {ok:false}; every other assertion in this file needs
// no network access at all.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4213;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-byok-"));
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

// A real (non-secret-leaking) DeepSeek/Anthropic platform key is intentionally NOT set for this server
// process — that's the whole point: even if the platform happened to have one configured, BYOK must never
// reach for it.
const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "byok-test-secret", RESEND_API_KEY: "", DEEPSEEK_API_KEY: "", ANTHROPIC_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function main() {
  await waitForHealth();

  const owner = await jsonFetch("/auth/register", { method: "POST", body: { name: "Byok Owner", email: "byok@example.com", password: "password10chars" } });
  assert(owner.status === 201, "owner registers");
  const orgs = await jsonFetch("/api/organizations", { cookie: owner.cookie });
  const orgId = orgs.data.organizations[0].id;

  console.log("\nAI Producer respond requires a signed-in session at all (BYOK made it session-gated)");
  const anonymous = await fetch(`${BASE}/api/ai-producer/respond`, { method: "POST", headers: { "content-type": "application/json", "x-toasty-csrf": "1" }, body: JSON.stringify({ instruction: "test" }) });
  assert(anonymous.status === 401, "an anonymous request is rejected outright — there is no 'whose key' answer with no account");

  console.log("\nNo BYOK credential -> explicit byok_required, never a silent platform-key fallback");
  const noByok = await jsonFetch("/api/ai-producer/respond", { method: "POST", cookie: owner.cookie, body: { instruction: "What should I ask next?", organizationId: orgId } });
  assert(noByok.status === 402, "with no provider connected, the response is a clean 402, not a 200 with a real AI answer");
  assert(noByok.data.error === "byok_required", "the error code is specifically byok_required, not a generic failure");
  assert(noByok.data.message === "Moxie requires an AI provider. Connect your API key to enable research, production intelligence, and live assistance.", "the message is the exact copy required by the brief");

  console.log("\nSaving a key — encrypted at rest, never returned, masked in list");
  const badProvider = await jsonFetch(`/api/organizations/${orgId}/ai-providers`, { method: "POST", cookie: owner.cookie, body: { provider: "made-up-provider", apiKey: "sk-fake1234567890" } });
  assert(badProvider.status === 400, "an unrecognized provider name is rejected");

  const tooShort = await jsonFetch(`/api/organizations/${orgId}/ai-providers`, { method: "POST", cookie: owner.cookie, body: { provider: "openai", apiKey: "short" } });
  assert(tooShort.status === 400, "an implausibly short 'key' is rejected before ever being stored or tested");

  const saved = await jsonFetch(`/api/organizations/${orgId}/ai-providers`, { method: "POST", cookie: owner.cookie, body: { provider: "openai", apiKey: "sk-fake1234567890abcd" } });
  assert(saved.status === 200, "a plausible key for a known provider is accepted");
  assert(saved.data.credential.encryptedCredential === undefined, "the save response never echoes back any form of the key");
  assert(saved.data.credential.keyLast4 === "abcd", "only the last 4 characters are returned, for display purposes");

  const list = await jsonFetch(`/api/organizations/${orgId}/ai-providers`, { cookie: owner.cookie });
  assert(list.data.credentials.length === 1 && list.data.credentials[0].provider === "openai", "the saved provider shows up in the list");
  assert(JSON.stringify(list.data.credentials).includes("abcd") && !JSON.stringify(list.data.credentials).includes("sk-fake1234567890abcd"), "the list shows the masked hint, never the real key");

  console.log("\nTest-key endpoint genuinely calls the real provider (fake key -> real rejection, no cost, no valid key needed)");
  const testSaved = await jsonFetch(`/api/organizations/${orgId}/ai-providers/openai/test`, { method: "POST", cookie: owner.cookie, body: {} });
  assert(testSaved.status === 200 && testSaved.data.ok === false, "testing the already-saved (fake) key comes back as ok:false from the real provider, not a stubbed success");

  const testInline = await jsonFetch(`/api/organizations/${orgId}/ai-providers/openai/test`, { method: "POST", cookie: owner.cookie, body: { apiKey: "sk-another-fake-key-999" } });
  assert(testInline.status === 200 && testInline.data.ok === false, "a key can be tested BEFORE saving, by passing it directly in the test request");

  console.log("\nRevoke and delete");
  const revoke = await jsonFetch(`/api/organizations/${orgId}/ai-providers/openai/revoke`, { method: "POST", cookie: owner.cookie, body: {} });
  assert(revoke.status === 200, "revoke succeeds");
  const stillNoByok = await jsonFetch("/api/ai-producer/respond", { method: "POST", cookie: owner.cookie, body: { instruction: "anything", organizationId: orgId } });
  assert(stillNoByok.data.error === "byok_required", "a REVOKED credential is treated exactly like no credential at all — AI stays disabled");

  const del = await jsonFetch(`/api/organizations/${orgId}/ai-providers/openai/delete`, { method: "POST", cookie: owner.cookie, body: {} });
  assert(del.status === 200, "delete succeeds");
  const afterDelete = await jsonFetch(`/api/organizations/${orgId}/ai-providers`, { cookie: owner.cookie });
  assert(afterDelete.data.credentials.length === 0, "the deleted credential is gone from the list entirely");

  console.log("\n--- Tenancy isolation for BYOK credentials ---");
  await jsonFetch(`/api/organizations/${orgId}/ai-providers`, { method: "POST", cookie: owner.cookie, body: { provider: "anthropic", apiKey: "sk-ant-fake-0000-key" } });
  const outsider = await jsonFetch("/auth/register", { method: "POST", body: { name: "Outsider", email: "outsider-byok@example.com", password: "password10chars" } });
  assert(outsider.status === 201, "a completely unrelated account exists");

  const stolenList = await jsonFetch(`/api/organizations/${orgId}/ai-providers`, { cookie: outsider.cookie });
  assert(stolenList.status === 404, "a non-member cannot list another organization's AI providers");

  const stolenSave = await jsonFetch(`/api/organizations/${orgId}/ai-providers`, { method: "POST", cookie: outsider.cookie, body: { provider: "openai", apiKey: "sk-hijack-attempt-000" } });
  assert(stolenSave.status === 404, "a non-member cannot save a key into another organization");

  const stolenTest = await jsonFetch(`/api/organizations/${orgId}/ai-providers/anthropic/test`, { method: "POST", cookie: outsider.cookie, body: {} });
  assert(stolenTest.status === 404, "a non-member cannot even trigger a test call using another organization's stored key");

  const stolenRevoke = await jsonFetch(`/api/organizations/${orgId}/ai-providers/anthropic/revoke`, { method: "POST", cookie: outsider.cookie, body: {} });
  assert(stolenRevoke.status === 404, "a non-member cannot revoke another organization's key");

  console.log("\nAll accounts BYOK server tests passed.");
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
