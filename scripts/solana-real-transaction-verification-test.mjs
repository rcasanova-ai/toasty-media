#!/usr/bin/env node
// Verifies the server's Solana USDC verification against GENUINE mainnet transaction structure, not a
// hand-built fixture. scripts/fixtures/mainnet-usdc-transfer-{0,1}.json are real `getTransaction`
// (jsonParsed, confirmed) responses captured from Solana mainnet for ordinary USDC `transferChecked`
// transfers. In both, the recipient WALLET is not an account key (funds move between token accounts), the
// zero/new balances carry `uiAmount: null`, and amounts come as decimal strings — exactly the things a
// synthetic fixture tends to get wrong. A fake RPC replays them; the server code under test is the real one.
//   fixture 0: 114.022 USDC -> HFJp8Yv9HkVibKMFX8zeVHRNbQsh93gfo6qrrd8fJFJq
//   fixture 1:  15.000 USDC -> 9njDd3bFLpNCCYUQvKz2RV9a7WbigM8S3xGmihwVia4L
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4233;
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(join(tmpdir(), "toasty-realtx-"));
const dbPath = join(scratch, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const load = (n) => JSON.parse(readFileSync(join(ROOT, "scripts", "fixtures", `mainnet-usdc-transfer-${n}.json`), "utf8"));
const F0 = load(0), F1 = load(1);
const RECIPIENT = "9njDd3bFLpNCCYUQvKz2RV9a7WbigM8S3xGmihwVia4L"; // owner of fixture 1's destination

function assert(c, m) { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); }
async function api(path, { method = "GET", cookie, body, headers = {} } = {}) {
  const h = { "x-toasty-csrf": "1", ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] || cookie };
}

const txs = new Map();
const rpc = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    const { method, params } = JSON.parse(b || "{}");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "getTransaction" && txs.has(params[0]) ? txs.get(params[0]) : null }));
  });
});
let server, out = "";

async function main() {
  // Sanity: the fixtures really have the structure this test claims.
  for (const F of [F0, F1]) {
    const keys = F.result.transaction.message.accountKeys.map((k) => k.pubkey);
    const post = F.result.meta.postTokenBalances.find((e) => e.mint === USDC && keys.indexOf(e.owner) === -1);
    assert(Boolean(post) && F.result.meta.err === null, `fixture ${F.signature.slice(0, 8)}… is a successful USDC transfer whose recipient wallet is NOT an account key`);
  }
  txs.set(F0.signature, F0.result); txs.set(F1.signature, F1.result);
  await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
  server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "real-tx-test-secret", RESEND_API_KEY: "", PEEPS_TEST_ADAPTERS: "1",
      SVM_PAY_TO: RECIPIENT, TOASTY_EXPERTS_X402_RECIPIENT: "", TOASTY_BILLING_SOLANA_RECIPIENT: RECIPIENT, TOASTY_USDC_MINT: USDC, TOASTY_USDT_MINT: "", TOASTY_SOLANA_NETWORK: "solana-devnet",
      TOASTY_SOLANA_RPC_URL: `http://127.0.0.1:${rpc.address().port}`, TOASTY_SOLANA_PAYER_KEYPAIR: "", SVM_KEYPAIR_PATH: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (c) => (out += c)); server.stderr.on("data", (c) => (out += c));
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }

  const user = await api("/auth/register", { method: "POST", body: { name: "Real Tx", email: "realtx@example.com", password: "password10chars" } });
  const cookie = user.cookie;
  const fund = async (amount, sig) => {
    const intent = await api("/api/peeps/dough/funding-intents", { method: "POST", cookie, body: { amount, method: "crypto" } });
    return api(`/api/peeps/dough/funding-intents/${intent.data.intent.id}/confirm`, { method: "POST", cookie, body: { transactionSignature: sig } });
  };

  console.log("\nDough funding against genuine transfers");
  assert((await fund(15, F0.signature)).status === 400, "a real transfer to a DIFFERENT recipient is refused");
  assert((await fund(16, F1.signature)).status === 400, "a real 15 USDC transfer does not satisfy a 16 USDC claim");
  const ok = await fund(15, F1.signature);
  assert(ok.status === 200 && ok.data.confirmed === true, "a real 15 USDC transfer to the recipient (wallet absent from account keys) verifies");

  console.log("\nPeeps introduction payment against the same genuine structure");
  const orgs = await api("/api/organizations", { cookie });
  const created = await api("/api/peeps/requests", { method: "POST", cookie, body: { organizationId: orgs.data.organizations[0].id, whoText: "Fintech payment executives in Southeast Asia", outcomeText: "I want 1 guest for a podcast about offline payments." } });
  const requestId = created.data.request.id;
  const candidate = created.data.candidates.find((c) => c.source === "demo_directory_provider");
  const reference = (await api(`/api/peeps/requests/${requestId}/payment-requirement`, { cookie })).data.requirement.accepts[0].reference;
  const authorize = (sig) => api(`/api/peeps/requests/${requestId}/authorize`, { method: "POST", cookie, headers: { "x-payment-signature": sig, "x-payment-asset": "USDC", "x-payment-amount": "0.25", "x-payer-wallet": "Ignored1111111111111111111111111111111111" }, body: { candidates: [{ candidateId: candidate.id, outreachEmail: "realtx.guest@example.com" }] } });
  // Fixture 0 pays another wallet; fixture 1 pays the recipient but carries no reference for this request.
  assert((await authorize(F0.signature)).status === 402, "genuine transfer to another recipient can't authorize");
  const noRef = await authorize(F1.signature);
  assert(noRef.status === 402 && /reference/i.test(noRef.data.message), "a genuine, sufficient, public transfer WITHOUT this request's reference can't authorize (no hijacking of public transactions)");
  // Same real transaction with the Solana Pay reference appended as a read-only account key.
  const withRef = JSON.parse(JSON.stringify(F1.result));
  withRef.transaction.message.accountKeys.push({ pubkey: reference, signer: false, source: "transaction", writable: false });
  const sig2 = "5".repeat(88); txs.set(sig2, withRef);
  const paid = await authorize(sig2);
  assert(paid.status === 200 && paid.data.payment.status === "onchain_verified" && paid.data.payment.signature === sig2, "the same genuine structure plus the request's reference verifies on-chain");
  const sender = F1.result.meta.preTokenBalances.find((e) => e.mint === USDC && e.owner !== RECIPIENT && Number(e.uiTokenAmount.uiAmountString) > Number(F1.result.meta.postTokenBalances.find((p) => p.accountIndex === e.accountIndex).uiTokenAmount.uiAmountString)).owner;
  assert(paid.data.payment.payerWallet === sender && paid.data.payment.payerWallet !== "Ignored1111111111111111111111111111111111", "payer is the token owner whose balance fell on-chain, not the header");
  console.log("\nAll real-structure Solana verification tests passed.");
}
main().then(() => { server.kill(); rpc.close(); rmSync(scratch, { recursive: true, force: true }); process.exit(0); })
  .catch((e) => { console.error(e.message || e); console.error(out.slice(-2000)); server?.kill(); rpc.close(); rmSync(scratch, { recursive: true, force: true }); process.exit(1); });
