#!/usr/bin/env node
// HTTP-level integration test for Solana crypto billing (Phase 8) — SOL/USDC/USDT prepaid terms, verified
// against the Solana RPC's getTransaction. No real devnet transaction is needed: this test runs its OWN
// tiny JSON-RPC server standing in for Solana (TOASTY_SOLANA_RPC_URL points at it) that returns canned
// getTransaction responses shaped exactly like the real RPC — the server under test has no idea it isn't
// talking to real Solana. This makes every anti-fraud path genuinely exercisable: wrong recipient, wrong
// mint, underpayment, a failed on-chain transaction, an unconfirmed/missing transaction, a reused
// signature, and an expired intent. Same pattern as scripts/session-management-server-test.mjs.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4215;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-solana-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");

const RECIPIENT = "ToastyBiLLingWaLLetRecipient11111111111111";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const PAYER = "SomeCustomerWaLLetAddress1111111111111111";
const FAKE_SIGNATURE_A = "5".repeat(88);
const FAKE_SIGNATURE_B = "6".repeat(88);

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

// ---- Fake Solana RPC ----
// A map of signature -> canned getTransaction "result" body, settable per-test. Any signature not in the
// map answers `result: null`, exactly like real Solana for an unknown/unconfirmed signature.
const fakeTransactions = new Map();
function solTx({ ok = true, recipientDeltaLamports = 0 } = {}) {
  return {
    meta: { err: ok ? null : { InstructionError: [0, "Custom"] }, preBalances: [1_000_000_000, 5_000_000_000], postBalances: [1_000_000_000 - recipientDeltaLamports, 5_000_000_000 + recipientDeltaLamports] },
    transaction: { message: { accountKeys: [PAYER, RECIPIENT] } }
  };
}
function tokenTx({ ok = true, mint = USDC_MINT, owner = RECIPIENT, preAmount = 0, postAmount = 0 } = {}) {
  return {
    meta: {
      err: ok ? null : { InstructionError: [0, "Custom"] },
      preTokenBalances: [{ owner, mint, uiTokenAmount: { uiAmount: preAmount } }],
      postTokenBalances: [{ owner, mint, uiTokenAmount: { uiAmount: postAmount } }]
    },
    transaction: { message: { accountKeys: [PAYER, RECIPIENT] } }
  };
}

const fakeRpc = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const { method, params } = JSON.parse(body || "{}");
    if (method !== "getTransaction") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: null }));
      return;
    }
    const [signature] = params;
    const result = fakeTransactions.has(signature) ? fakeTransactions.get(signature) : null;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
  });
});

async function main() {
  await new Promise((resolve) => fakeRpc.listen(0, "127.0.0.1", resolve));
  const rpcPort = fakeRpc.address().port;

  const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: {
      ...process.env,
      TOASTY_RENDER_PORT: String(PORT),
      TOASTY_AUTH_DB: dbPath,
      TOASTY_AUTH_DB_HELPER: helper,
      TOASTY_SESSION_SECRET: "solana-test-secret",
      RESEND_API_KEY: "",
      TOASTY_BILLING_SOLANA_RECIPIENT: RECIPIENT,
      TOASTY_SOLANA_RPC_URL: `http://127.0.0.1:${rpcPort}`,
      TOASTY_USDC_MINT: USDC_MINT,
      TOASTY_USDT_MINT: "",
      TOASTY_PAYMENT_INTENT_TTL_MS: "300000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let serverOutput = "";
  server.stdout.on("data", (c) => (serverOutput += c));
  server.stderr.on("data", (c) => (serverOutput += c));

  try {
    await waitForHealth();

    const owner = await jsonFetch("/auth/register", { method: "POST", body: { name: "Solana Owner", email: "solana@example.com", password: "password10chars" } });
    const orgs = await jsonFetch("/api/organizations", { cookie: owner.cookie });
    const orgId = orgs.data.organizations[0].id;

    console.log("Creating a Solana payment intent is owner-only, even before touching Solana at all");
    const member = await jsonFetch("/auth/register", { method: "POST", body: { name: "Regular Member", email: "member-solana@example.com", password: "password10chars" } });
    await jsonFetch(`/api/organizations/${orgId}/members/invite`, { method: "POST", cookie: owner.cookie, body: { email: "member-solana@example.com", role: "admin" } });
    const inviteMatch = serverOutput.match(/accept-invite\.html\?token=([A-Za-z0-9_-]+)/g);
    const inviteToken = inviteMatch[inviteMatch.length - 1].split("token=")[1];
    await jsonFetch("/api/invites/accept", { method: "POST", cookie: member.cookie, body: { token: inviteToken } });
    const memberIntent = await jsonFetch(`/api/organizations/${orgId}/billing/solana/intent`, { method: "POST", cookie: member.cookie, body: { plan: "creator", termDays: 30, asset: "USDC" } });
    assert(memberIntent.status === 403, "an admin (not owner) cannot start a Solana checkout for the organization");

    console.log("\nBad requests are rejected before any RPC call is made");
    const badPlan = await jsonFetch(`/api/organizations/${orgId}/billing/solana/intent`, { method: "POST", cookie: owner.cookie, body: { plan: "nonexistent", termDays: 30, asset: "USDC" } });
    assert(badPlan.status === 400, "an unpriced plan is rejected");
    const badTerm = await jsonFetch(`/api/organizations/${orgId}/billing/solana/intent`, { method: "POST", cookie: owner.cookie, body: { plan: "creator", termDays: 45, asset: "USDC" } });
    assert(badTerm.status === 400, "a termDays outside 30/90/365 is rejected");
    const badAsset = await jsonFetch(`/api/organizations/${orgId}/billing/solana/intent`, { method: "POST", cookie: owner.cookie, body: { plan: "creator", termDays: 30, asset: "DOGE" } });
    assert(badAsset.status === 400, "an unsupported asset is rejected");
    const unconfiguredUsdt = await jsonFetch(`/api/organizations/${orgId}/billing/solana/intent`, { method: "POST", cookie: owner.cookie, body: { plan: "creator", termDays: 30, asset: "USDT" } });
    assert(unconfiguredUsdt.status === 400, "USDT is rejected cleanly when no mint is configured on this server");

    console.log("\nCreating a real USDC intent — 1:1 with USD, no price quote needed");
    const created = await jsonFetch(`/api/organizations/${orgId}/billing/solana/intent`, { method: "POST", cookie: owner.cookie, body: { plan: "creator", termDays: 30, asset: "USDC" } });
    assert(created.status === 200, "the intent is created");
    const intent = created.data.paymentIntent;
    assert(intent.cryptoAmount === intent.fiatReferenceAmount, "USDC amount is 1:1 with the USD reference price");
    assert(intent.status === "pending", "a fresh intent starts pending");
    assert(intent.recipientWallet === RECIPIENT, "the intent quotes the configured recipient wallet");

    console.log("\nA non-member cannot even read the intent");
    const outsider = await jsonFetch("/auth/register", { method: "POST", body: { name: "Outsider", email: "outsider-solana@example.com", password: "password10chars" } });
    const stolenGet = await jsonFetch(`/api/billing/solana/intents/${intent.id}`, { cookie: outsider.cookie });
    assert(stolenGet.status === 404, "a non-member gets 404, not the intent's payment details");

    console.log("\nAnti-fraud: wrong recipient wallet is rejected");
    fakeTransactions.set(FAKE_SIGNATURE_A, { meta: { err: null, preTokenBalances: [], postTokenBalances: [] }, transaction: { message: { accountKeys: [PAYER, "SomeOtherWalletEntirely1111111111111111111"] } } });
    const wrongRecipient = await jsonFetch(`/api/billing/solana/intents/${intent.id}/confirm`, { method: "POST", cookie: owner.cookie, body: { transactionSignature: FAKE_SIGNATURE_A } });
    assert(wrongRecipient.status === 400, "a transaction that doesn't pay the Toasty billing wallet is rejected");

    console.log("\nAnti-fraud: wrong mint is rejected");
    fakeTransactions.set(FAKE_SIGNATURE_A, tokenTx({ mint: "SomeRandomOtherMint1111111111111111111111", postAmount: intent.cryptoAmount }));
    const wrongMint = await jsonFetch(`/api/billing/solana/intents/${intent.id}/confirm`, { method: "POST", cookie: owner.cookie, body: { transactionSignature: FAKE_SIGNATURE_A } });
    assert(wrongMint.status === 400, "a transaction paying the right wallet but the WRONG token mint is rejected");

    console.log("\nAnti-fraud: underpayment is rejected");
    fakeTransactions.set(FAKE_SIGNATURE_A, tokenTx({ postAmount: intent.cryptoAmount - 10 }));
    const underpaid = await jsonFetch(`/api/billing/solana/intents/${intent.id}/confirm`, { method: "POST", cookie: owner.cookie, body: { transactionSignature: FAKE_SIGNATURE_A } });
    assert(underpaid.status === 400, "a transaction that pays LESS than the quoted amount is rejected");

    console.log("\nAnti-fraud: a failed on-chain transaction is rejected");
    fakeTransactions.set(FAKE_SIGNATURE_A, tokenTx({ ok: false, postAmount: intent.cryptoAmount }));
    const failedTx = await jsonFetch(`/api/billing/solana/intents/${intent.id}/confirm`, { method: "POST", cookie: owner.cookie, body: { transactionSignature: FAKE_SIGNATURE_A } });
    assert(failedTx.status === 400, "a transaction that failed on-chain (meta.err set) cannot be credited");

    console.log("\nAn unconfirmed/unknown signature is rejected (not found in the RPC at all)");
    const unknownSig = await jsonFetch(`/api/billing/solana/intents/${intent.id}/confirm`, { method: "POST", cookie: owner.cookie, body: { transactionSignature: FAKE_SIGNATURE_B } });
    assert(unknownSig.status === 400, "a signature the RPC has never heard of is rejected, not silently accepted");

    console.log("\nAn admin (not owner) cannot confirm payment either");
    fakeTransactions.set(FAKE_SIGNATURE_A, tokenTx({ postAmount: intent.cryptoAmount }));
    const adminConfirm = await jsonFetch(`/api/billing/solana/intents/${intent.id}/confirm`, { method: "POST", cookie: member.cookie, body: { transactionSignature: FAKE_SIGNATURE_A } });
    assert(adminConfirm.status === 403, "confirming payment is owner-only, same as Stripe checkout");

    console.log("\nA correct, exact-amount USDC payment activates the plan");
    const orgBefore = await jsonFetch(`/api/organizations/${orgId}`, { cookie: owner.cookie });
    assert(orgBefore.data.organization.plan === "demo", "the organization is still on demo before payment is confirmed");
    const confirmed = await jsonFetch(`/api/billing/solana/intents/${intent.id}/confirm`, { method: "POST", cookie: owner.cookie, body: { transactionSignature: FAKE_SIGNATURE_A } });
    assert(confirmed.status === 200, "the correct payment is accepted");
    assert(confirmed.data.paymentIntent.status === "paid", "the intent is marked paid");
    const orgAfter = await jsonFetch(`/api/organizations/${orgId}`, { cookie: owner.cookie });
    assert(orgAfter.data.organization.plan === "creator", "the plan is activated — ONLY by real, server-verified on-chain confirmation");
    assert(orgAfter.data.organization.subscriptionStatus === "active", "subscriptionStatus reflects the activated subscription");

    console.log("\nAnti-fraud: the exact same signature cannot be reused on a second intent (same price, so it passes amount verification but is still blocked by signature uniqueness)");
    const secondIntent = await jsonFetch(`/api/organizations/${orgId}/billing/solana/intent`, { method: "POST", cookie: owner.cookie, body: { plan: "creator", termDays: 30, asset: "USDC" } });
    const reuse = await jsonFetch(`/api/billing/solana/intents/${secondIntent.data.paymentIntent.id}/confirm`, { method: "POST", cookie: owner.cookie, body: { transactionSignature: FAKE_SIGNATURE_A } });
    assert(reuse.status === 409, "reusing a signature already credited to a different intent is rejected outright");

    console.log("\nConfirming an already-paid intent again is a harmless no-op, not a double-charge");
    const reconfirm = await jsonFetch(`/api/billing/solana/intents/${intent.id}/confirm`, { method: "POST", cookie: owner.cookie, body: { transactionSignature: FAKE_SIGNATURE_A } });
    assert(reconfirm.status === 200 && reconfirm.data.paymentIntent.status === "paid", "re-confirming a paid intent just returns its already-paid state");

    console.log("\nAn expired intent cannot be confirmed even with a genuinely valid payment");
    const shortLivedServer = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
      env: { ...process.env, TOASTY_RENDER_PORT: "4216", TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "solana-test-secret", RESEND_API_KEY: "", TOASTY_BILLING_SOLANA_RECIPIENT: RECIPIENT, TOASTY_SOLANA_RPC_URL: `http://127.0.0.1:${rpcPort}`, TOASTY_USDC_MINT: USDC_MINT, TOASTY_PAYMENT_INTENT_TTL_MS: "1" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    try {
      const shortBase = "http://127.0.0.1:4216";
      for (let i = 0; i < 50; i++) { try { if ((await fetch(`${shortBase}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
      const cookie2 = cookieFrom(await fetch(`${shortBase}/auth/register`, { method: "POST", headers: { "content-type": "application/json", "x-toasty-csrf": "1" }, body: JSON.stringify({ name: "Expiry Owner", email: "expiry@example.com", password: "password10chars" }) }));
      const orgs2 = await (await fetch(`${shortBase}/api/organizations`, { headers: { cookie: cookie2 } })).json();
      const orgId2 = orgs2.organizations[0].id;
      await new Promise((r) => setTimeout(r, 50));
      const expIntentRes = await fetch(`${shortBase}/api/organizations/${orgId2}/billing/solana/intent`, { method: "POST", headers: { cookie: cookie2, "content-type": "application/json", "x-toasty-csrf": "1" }, body: JSON.stringify({ plan: "creator", termDays: 30, asset: "USDC" }) });
      const expIntent = (await expIntentRes.json()).paymentIntent;
      fakeTransactions.set(FAKE_SIGNATURE_B, tokenTx({ postAmount: expIntent.cryptoAmount }));
      const expiredConfirm = await fetch(`${shortBase}/api/billing/solana/intents/${expIntent.id}/confirm`, { method: "POST", headers: { cookie: cookie2, "content-type": "application/json", "x-toasty-csrf": "1" }, body: JSON.stringify({ transactionSignature: FAKE_SIGNATURE_B }) });
      assert(expiredConfirm.status === 410, "an expired payment reference cannot be confirmed even with a genuinely valid on-chain payment");
    } finally {
      shortLivedServer.kill();
    }

    console.log("\nAll accounts Solana billing server tests passed.");
  } finally {
    server.kill();
  }
}

main()
  .then(() => { fakeRpc.close(); rmSync(scratchDir, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => {
    console.error(error);
    fakeRpc.close();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
