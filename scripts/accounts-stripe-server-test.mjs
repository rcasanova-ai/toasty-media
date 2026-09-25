#!/usr/bin/env node
// HTTP-level integration test for Stripe billing (Phase 7). No real Stripe account is needed or used:
// webhook signature verification is pure crypto this test controls both sides of (it signs a fake payload
// with a fake shared secret, exactly as Stripe's documented scheme works, and the server verifies it with
// the SAME secret) — this is genuinely how Stripe's algorithm works, not a stub of it. Checkout/portal
// route creation itself (which needs a real STRIPE_SECRET_KEY to call api.stripe.com) is intentionally
// NOT exercised here — those are tested only for what's checkable without real credentials: they correctly
// 503 when unconfigured, and enforce owner-only + tenancy authorization before ever reaching Stripe.
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4214;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-stripe-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const WEBHOOK_SECRET = "whsec_test_fake_shared_secret_for_this_test_only";

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

function stripeSign(payload, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function sendWebhook(eventPayload, { signature } = {}) {
  const body = JSON.stringify(eventPayload);
  const headers = { "content-type": "application/json" };
  if (signature !== null) headers["stripe-signature"] = signature ?? stripeSign(body, WEBHOOK_SECRET);
  const response = await fetch(`${BASE}/webhooks/stripe`, { method: "POST", headers, body });
  let data = {};
  try { data = await response.json(); } catch (_) {}
  return { status: response.status, data };
}

async function waitForHealth() {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server never came up");
}

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "stripe-test-secret", RESEND_API_KEY: "", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET, STRIPE_SECRET_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

async function main() {
  await waitForHealth();

  const owner = await jsonFetch("/auth/register", { method: "POST", body: { name: "Stripe Owner", email: "stripe@example.com", password: "password10chars" } });
  const orgs = await jsonFetch("/api/organizations", { cookie: owner.cookie });
  const orgId = orgs.data.organizations[0].id;

  console.log("Checkout/portal are unconfigured (no STRIPE_SECRET_KEY) -> clean 503, never a stack trace");
  const checkoutUnconfigured = await jsonFetch(`/api/organizations/${orgId}/billing/checkout`, { method: "POST", cookie: owner.cookie, body: { plan: "creator" } });
  assert(checkoutUnconfigured.status === 503, "checkout returns 503 when card billing isn't configured");
  const portalUnconfigured = await jsonFetch(`/api/organizations/${orgId}/billing/portal`, { method: "POST", cookie: owner.cookie, body: {} });
  assert(portalUnconfigured.status === 503, "portal returns 503 when card billing isn't configured");

  console.log("\nCheckout/portal are owner-only, even before reaching Stripe at all");
  const member = await jsonFetch("/auth/register", { method: "POST", body: { name: "Regular Member", email: "member-stripe@example.com", password: "password10chars" } });
  await jsonFetch(`/api/organizations/${orgId}/members/invite`, { method: "POST", cookie: owner.cookie, body: { email: "member-stripe@example.com", role: "admin" } });
  const inviteMatch = serverOutput.match(/accept-invite\.html\?token=([A-Za-z0-9_-]+)/g);
  const inviteToken = inviteMatch[inviteMatch.length - 1].split("token=")[1];
  await jsonFetch("/api/invites/accept", { method: "POST", cookie: member.cookie, body: { token: inviteToken } });
  const adminCheckout = await jsonFetch(`/api/organizations/${orgId}/billing/checkout`, { method: "POST", cookie: member.cookie, body: { plan: "creator" } });
  assert(adminCheckout.status === 403, "an admin (not owner) cannot start checkout for the organization — billing is owner-only");

  console.log("\nWebhook signature verification — this is the actual trust boundary, fully testable without a real Stripe account");
  const fakeEvent = { id: "evt_test_1", type: "checkout.session.completed", data: { object: { client_reference_id: orgId, customer: "cus_fake123", subscription: "sub_fake456", metadata: { organizationId: orgId, plan: "creator" } } } };

  const noSig = await sendWebhook(fakeEvent, { signature: null });
  assert(noSig.status === 400, "a webhook with no signature header at all is rejected");

  const wrongSecret = await sendWebhook(fakeEvent, { signature: stripeSign(JSON.stringify(fakeEvent), "wrong-secret-entirely") });
  assert(wrongSecret.status === 400, "a webhook signed with the WRONG secret is rejected");

  const tamperedPayload = { ...fakeEvent, data: { object: { ...fakeEvent.data.object, metadata: { organizationId: orgId, plan: "enterprise" } } } };
  const tamperedSig = stripeSign(JSON.stringify(fakeEvent), WEBHOOK_SECRET);
  const tamperedResponse = await fetch(`${BASE}/webhooks/stripe`, { method: "POST", headers: { "content-type": "application/json", "stripe-signature": tamperedSig }, body: JSON.stringify(tamperedPayload) });
  assert(tamperedResponse.status === 400, "a payload signed for ONE body but sent with a DIFFERENT body (tampered in transit) is rejected — the signature covers the exact bytes");

  const staleSig = stripeSign(JSON.stringify(fakeEvent), WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 600);
  const stale = await sendWebhook(fakeEvent, { signature: staleSig });
  assert(stale.status === 400, "a correctly-signed but 10-minutes-old webhook is rejected (replay protection)");

  console.log("\nA correctly-signed, fresh webhook actually activates the plan — this is the only thing that ever should");
  const orgBeforeWebhook = await jsonFetch(`/api/organizations/${orgId}`, { cookie: owner.cookie });
  assert(orgBeforeWebhook.data.organization.plan === "demo", "the organization is still on the demo plan before any webhook arrives");

  const goodWebhook = await sendWebhook(fakeEvent);
  assert(goodWebhook.status === 200 && goodWebhook.data.received === true, "a correctly-signed, fresh webhook is accepted");

  const orgAfterWebhook = await jsonFetch(`/api/organizations/${orgId}`, { cookie: owner.cookie });
  assert(orgAfterWebhook.data.organization.plan === "creator", "the plan is now 'creator' — activated ONLY by the server-verified webhook, never by anything the browser claimed");
  assert(orgAfterWebhook.data.organization.subscriptionStatus === "active", "subscriptionStatus reflects the activated subscription");

  console.log("\nSubscription cancellation downgrades the plan back to demo");
  const cancelEvent = { id: "evt_test_2", type: "customer.subscription.deleted", data: { object: { id: "sub_fake456", metadata: { organizationId: orgId }, cancel_at_period_end: false } } };
  const cancelWebhook = await sendWebhook(cancelEvent);
  assert(cancelWebhook.status === 200, "the cancellation webhook is accepted");
  const orgAfterCancel = await jsonFetch(`/api/organizations/${orgId}`, { cookie: owner.cookie });
  assert(orgAfterCancel.data.organization.plan === "demo", "the organization is downgraded back to demo once its subscription is cancelled");
  assert(orgAfterCancel.data.organization.subscriptionStatus === "canceled", "subscriptionStatus reflects cancellation");

  console.log("\nA failed invoice payment marks the org past_due without immediately downgrading the plan (a grace period, not an instant cutoff)");
  const reactivateEvent = { id: "evt_test_3", type: "checkout.session.completed", data: { object: { client_reference_id: orgId, customer: "cus_fake123", subscription: "sub_fake789", metadata: { organizationId: orgId, plan: "pro" } } } };
  await sendWebhook(reactivateEvent);
  const failedInvoiceEvent = { id: "evt_test_4", type: "invoice.payment_failed", data: { object: { metadata: { organizationId: orgId } } } };
  const failedWebhook = await sendWebhook(failedInvoiceEvent);
  assert(failedWebhook.status === 200, "the payment-failed webhook is accepted");
  const orgAfterFailedPayment = await jsonFetch(`/api/organizations/${orgId}`, { cookie: owner.cookie });
  assert(orgAfterFailedPayment.data.organization.subscriptionStatus === "past_due", "subscriptionStatus becomes past_due");
  assert(orgAfterFailedPayment.data.organization.plan === "pro", "the plan itself is NOT immediately revoked on a failed payment — that's Stripe's own dunning/retry process, not this webhook's job");

  console.log("\nAll accounts Stripe billing server tests passed.");
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
