#!/usr/bin/env node
// Paid access to a Dub over x402 (Solana USDC): the owner chooses the price and which entries are paid; an agent gets
// a 402 with a one-use quote and can read the permitted entries only after the server verifies the on-chain payment.
// A fake Solana RPC stands in for the chain; the server code under test is the real one.
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4281;
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(join(tmpdir(), "toasty-dub-access-"));
const dbPath = join(scratch, "t.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const RECIPIENT = "9njDd3bFLpNCCYUQvKz2RV9a7WbigM8S3xGmihwVia4L";
const PAYER = "HFJp8Yv9HkVibKMFX8zeVHRNbQsh93gfo6qrrd8fJFJq";
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeSig = (n) => { let s = ""; for (let i = 0; i < 88; i++) s += ALPHABET[(n * 7 + i * 13) % ALPHABET.length]; return s; };

const txs = new Map();
const rpc = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c));
  req.on("end", () => {
    const { method, params } = JSON.parse(b || "{}");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "getTransaction" && txs.has(params[0]) ? txs.get(params[0]) : null }));
  });
});
// A confirmed USDC transfer from PAYER to RECIPIENT of `amount`, whose account list carries `reference`.
function transfer(signature, { amount, reference, recipient = RECIPIENT, mint = USDC }) {
  txs.set(signature, {
    slot: 123, blockTime: Math.floor(Date.now() / 1000),
    transaction: { message: { accountKeys: [{ pubkey: PAYER }, ...(reference ? [{ pubkey: reference }] : [])] } },
    meta: {
      err: null,
      preTokenBalances: [{ owner: PAYER, mint, uiTokenAmount: { uiAmountString: "50" } }, { owner: recipient, mint, uiTokenAmount: { uiAmountString: "0" } }],
      postTokenBalances: [{ owner: PAYER, mint, uiTokenAmount: { uiAmountString: String(50 - amount) } }, { owner: recipient, mint, uiTokenAmount: { uiAmountString: String(amount) } }]
    }
  });
}

async function api(path, { method = "GET", cookie, body, headers = {}, ip = "10.9.9.1" } = {}) {
  const h = { "x-toasty-csrf": "1", "x-forwarded-for": ip, ...headers };
  if (cookie) h.cookie = cookie;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = {}; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data, headers: r.headers, cookie: (r.headers.get("set-cookie") || "").split(";")[0] || cookie };
}
const run = (action, values) => {
  const r = spawnSync("python3", [helper], { input: JSON.stringify({ action, dbPath, ...values }), encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || r.stdout);
  return JSON.parse(r.stdout || "{}");
};
let server, out = "";
let ipN = 20;

async function main() {
  await new Promise((r) => rpc.listen(0, "127.0.0.1", r));
  server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: { ...process.env, TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "dub-access-secret",
      SVM_PAY_TO: RECIPIENT, TOASTY_EXPERTS_X402_RECIPIENT: "", TOASTY_BILLING_SOLANA_RECIPIENT: RECIPIENT, TOASTY_USDC_MINT: USDC, TOASTY_USDT_MINT: "", TOASTY_SOLANA_NETWORK: "solana-devnet",
      TOASTY_SOLANA_RPC_URL: `http://127.0.0.1:${rpc.address().port}`, TOASTY_SOLANA_PAYER_KEYPAIR: "", SVM_KEYPAIR_PATH: "", STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", RESEND_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  server.stdout.on("data", (c) => (out += c)); server.stderr.on("data", (c) => (out += c));
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }

  const reg = await api("/auth/register", { method: "POST", body: { name: "Sally Owner", email: "sally@example.com", password: "password10chars" }, ip: "10.9.0.1" });
  const cookie = reg.cookie;
  const me = await api("/auth/session", { cookie });
  const userId = me.data?.user?.id || me.data?.session?.id || me.data?.id;
  assert(Boolean(userId), "the owner is signed in");
  run("dub_find_or_create", { id: "dub_sally", email: "sally@example.com", displayName: "Sally" });
  spawnSync("python3", ["-c", "import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('UPDATE dubs SET user_id=? WHERE id=?',(sys.argv[2],'dub_sally'));c.commit()", dbPath, userId]);
  const entry = (id, statement, visibility) => run("dub_entry_upsert", { id: `dpe_${id}`, dubId: "dub_sally", breadcrumbId: `bc_${id}`, kind: "experience", statement, evidenceClass: "verified", topics: [], visibility });
  entry("pub", "Coordinates schedules for a family of five.", "public");
  entry("paid", "Negotiated a 22 percent saving on a group purchase.", "paid");
  entry("priv", "Private: home address is 12 Example Lane.", "private");

  console.log("\nOwner controls");
  const g0 = await api("/api/peeps/me/dub-access", { cookie });
  assert(g0.status === 200 && g0.data.settings.enabled === false && g0.data.entries.length === 3 && g0.data.limits.minUsd === 0.01, "the owner sees paid access off, their entries and the price limits");
  assert((await api("/api/peeps/me/dub-access", { method: "POST", cookie, body: { enabled: true, priceUsd: 0 } })).status === 400, "a zero price is refused");
  assert((await api("/api/peeps/me/dub-access", { method: "POST", cookie, body: { enabled: true, priceUsd: 0.005 } })).status === 400, "a price that is not a whole cent is refused");
  assert((await api("/api/peeps/me/dub-access", { method: "POST", cookie, body: { enabled: true, priceUsd: 500 } })).status === 400, "a price above the maximum is refused");
  assert((await api("/api/peeps/me/dub-access", { method: "POST", cookie: "", body: { enabled: true, priceUsd: 0.01 } })).status === 401, "signing in is required to set a price");
  assert((await api("/api/peeps/me/dub-access/entries/dpe_paid", { method: "POST", cookie, body: { visibility: "bogus" } })).status === 400, "an unknown visibility is refused");

  console.log("\nGateway is closed until the owner turns it on");
  assert((await api("/api/peeps/dubs/dub_sally/access", { ip: `10.9.1.${ipN++}` })).status === 404, "a Dub with paid access off returns 404, not its data");

  const on = await api("/api/peeps/me/dub-access", { method: "POST", cookie, body: { enabled: true, priceUsd: 0.01 } });
  assert(on.status === 200 && on.data.settings.priceUsd === 0.01, "the owner sets a price of $0.01 per access");

  console.log("\nThe 402 challenge");
  const c1 = await api("/api/peeps/dubs/dub_sally/access", { ip: `10.9.1.${ipN++}` });
  assert(c1.status === 402 && c1.headers.get("x402-payment-required") === "true" && Boolean(c1.headers.get("payment-required")), "an unpaid request gets an HTTP 402 with the payment requirement");
  const req1 = c1.data.accepts[0];
  assert(req1.amount === "0.01" && req1.asset === "USDC" && req1.payTo === RECIPIENT && req1.tokenMint === USDC && Boolean(req1.reference) && Boolean(c1.data.quoteId), "it quotes the owner's price, the recipient, the USDC mint, a unique reference and a quote id");
  assert(!JSON.stringify(c1.data).includes("Negotiated") && !JSON.stringify(c1.data).includes("Coordinates"), "the 402 reveals none of the protected information");

  console.log("\nClaimed or unverifiable payments unlock nothing");
  const claim = await api("/api/peeps/dubs/dub_sally/access", { headers: { "x-payment-signature": fakeSig(1), "x-toasty-quote": c1.data.quoteId }, ip: `10.9.1.${ipN++}` });
  assert(claim.status === 402 && !JSON.stringify(claim.data).includes("Negotiated"), "a claimed signature the chain does not know is refused with a 402");
  assert((await api("/api/peeps/dubs/dub_sally/access", { headers: { "x-payment-signature": fakeSig(2) }, ip: `10.9.1.${ipN++}` })).status === 402, "a signature with no quote just gets a new quote");
  transfer(fakeSig(3), { amount: 0.01, reference: "" });
  const noRef = await api("/api/peeps/dubs/dub_sally/access", { headers: { "x-payment-signature": fakeSig(3), "x-toasty-quote": c1.data.quoteId }, ip: `10.9.1.${ipN++}` });
  assert(noRef.status === 402 && !JSON.stringify(noRef.data).includes("Negotiated"), "a real transfer without this quote's reference is refused");
  transfer(fakeSig(4), { amount: 0.005, reference: req1.reference });
  const under = await api("/api/peeps/dubs/dub_sally/access", { headers: { "x-payment-signature": fakeSig(4), "x-toasty-quote": c1.data.quoteId }, ip: `10.9.1.${ipN++}` });
  assert(under.status === 402, "an underpayment is refused");
  transfer(fakeSig(5), { amount: 0.01, reference: req1.reference, recipient: PAYER });
  assert((await api("/api/peeps/dubs/dub_sally/access", { headers: { "x-payment-signature": fakeSig(5), "x-toasty-quote": c1.data.quoteId }, ip: `10.9.1.${ipN++}` })).status === 402, "a payment to the wrong recipient is refused");

  console.log("\nA verified payment releases only the permitted entries");
  transfer(fakeSig(6), { amount: 0.01, reference: req1.reference });
  const paid = await api("/api/peeps/dubs/dub_sally/access", { headers: { "x-payment-signature": fakeSig(6), "x-toasty-quote": c1.data.quoteId }, ip: `10.9.1.${ipN++}` });
  assert(paid.status === 200 && paid.data.ok === true, "a verified on-chain payment with the right reference unlocks access");
  const statements = paid.data.access.entries.map((e) => e.statement);
  assert(statements.some((t) => t.includes("Negotiated")) && statements.some((t) => t.includes("Coordinates")), "paid and public entries are returned");
  assert(!JSON.stringify(paid.data).includes("12 Example Lane"), "private entries are never returned");
  assert(paid.data.payment.transactionSignature === fakeSig(6) && /explorer\.solana\.com/.test(paid.data.payment.explorerUrl), "the response names the verified transaction");

  console.log("\nRetries and replays");
  const again = await api("/api/peeps/dubs/dub_sally/access", { headers: { "x-payment-signature": fakeSig(6), "x-toasty-quote": c1.data.quoteId }, ip: `10.9.1.${ipN++}` });
  assert(again.status === 200 && again.data.payment.idempotent === true, "repeating the same paid request succeeds without charging twice");
  const c2 = await api("/api/peeps/dubs/dub_sally/access", { ip: `10.9.1.${ipN++}` });
  const replay = await api("/api/peeps/dubs/dub_sally/access", { headers: { "x-payment-signature": fakeSig(6), "x-toasty-quote": c2.data.quoteId }, ip: `10.9.1.${ipN++}` });
  assert(replay.status === 402 && !JSON.stringify(replay.data).includes("Negotiated"), "reusing the paid transaction against a new quote is refused");
  const other = await api("/api/peeps/dubs/dub_sally/access", { headers: { "x-payment-signature": fakeSig(7), "x-toasty-quote": c1.data.quoteId }, ip: `10.9.1.${ipN++}` });
  assert(other.status === 409 || other.status === 402, "a different signature cannot take over an already paid quote");

  console.log("\nOwner earnings and visibility");
  const dough = await api("/api/peeps/dough", { cookie });
  const owner = await api("/api/peeps/me/dub-access", { cookie });
  assert(owner.data.paidAccesses.count === 1 && owner.data.paidAccesses.totalUsd === 0.01, "the owner sees one paid access worth $0.01");
  const earned = run("dough_get", { subjectType: "user", subjectId: userId }).account;
  assert(earned.earnedBalance === 0.01, "the owner's Dough is credited $0.01 once, from the verified payment");
  assert((await api("/api/peeps/me/dub-access/entries/dpe_paid", { method: "POST", cookie, body: { visibility: "private" } })).status === 200, "the owner can make an entry private again");
  transfer(fakeSig(8), { amount: 0.01, reference: dubRef(c2.data.accepts[0].reference) });
  const c3 = await api("/api/peeps/dubs/dub_sally/access", { headers: { "x-payment-signature": fakeSig(8), "x-toasty-quote": c2.data.quoteId }, ip: `10.9.1.${ipN++}` });
  assert(c3.status === 200 && !JSON.stringify(c3.data).includes("Negotiated"), "an entry made private is no longer released, even with a valid payment");
  void dough;

  console.log("\nOwner can switch it off");
  assert((await api("/api/peeps/me/dub-access", { method: "POST", cookie, body: { enabled: false, priceUsd: 0.01 } })).status === 200, "the owner turns paid access off");
  assert((await api("/api/peeps/dubs/dub_sally/access", { ip: `10.9.1.${ipN++}` })).status === 404, "access is closed again");

  console.log("\nALL PASSED: paid Dub access verifies payment on-chain, honors the owner's price and visibility, and never leaks private entries.");
}
const dubRef = (r) => r;

main().catch((e) => { console.error(e.message); console.error(out.split("\n").slice(-12).join("\n")); process.exit(1); }).finally(() => { try { server?.kill("SIGKILL"); } catch (_) {} rpc.close(); });
