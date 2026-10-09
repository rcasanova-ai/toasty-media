#!/usr/bin/env node
// GENUINE end-to-end confidential settlement on a local Zcash REGTEST chain (no value; see scripts/zcash/README.md).
//
// Real: a real Peeps server + SQLite, a real Peeps request -> candidate -> booking -> Jam -> consent -> attendance -> transcript
// -> completion lifecycle, a real Zebra regtest chain, and two real zingo-cli wallets. The payment is a REAL shielded
// Orchard transaction broadcast from the requester wallet to the recipient wallet's shielded address, confirmed on-chain.
// The recipient's confirmation is read FROM THE RECIPIENT'S OWN WALLET (never from the requester) and submitted with the
// recipient's private response token. Seeded/simulated here: the Dough funding credit for the $0.25 introduction fee (a ledger
// seed, labelled), the outreach email (recorded, not sent), and the Jam attendance event (Studio's camera room can't run headless).
//
//   node scripts/zcash/regtest.mjs start && node scripts/zcash-regtest-e2e.mjs
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { height, walletJson, wallet, DIR } from "./zcash/regtest.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const PORT = 4246, BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(join(tmpdir(), "toasty-zec-e2e-"));
const dbPath = join(scratch, "toasty.sqlite");
const AMOUNT_ZAT = 2_500_000; // 0.025 regtest ZEC, no value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let out = "";
const say = (m) => console.log(m);
function assert(c, m) { if (!c) throw new Error(`FAILED: ${m}`); say(`  ok - ${m}`); }

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "zec-e2e", RESEND_API_KEY: "", PEEPS_TEST_ADAPTERS: "1",
    TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "", SVM_KEYPAIR_PATH: "",
    ZCASH_SETTLEMENT_ENABLED: "1", ZCASH_NETWORK: "regtest" }, stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (c) => (out += c)); server.stderr.on("data", (c) => (out += c));
let cookie = "";
async function api(path, { method = "GET", body, headers = {}, session = true } = {}) {
  const h = { "x-toasty-csrf": "1", ...headers };
  if (session && cookie) h.cookie = cookie;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc && session && !cookie) cookie = sc.split(";")[0];
  let data = {}; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
const db = (action, values = {}) => { const r = spawnSync("python3", [helper], { input: JSON.stringify({ action, dbPath, ...values }), encoding: "utf8" }); return r.stdout.trim() ? JSON.parse(r.stdout) : {}; };
function zoned(ms, tz) { const p = {}; for (const x of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) p[x.type] = x.value; return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`; }
const dayUtc = (d, h) => { const t = new Date(Date.now() + d * 86400000); return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h, 0); };
const orchard = (name) => { const o = wallet(name, ["--waitsync", "balance"]).out; return Number((o.match(/total_orchard_balance:\s*([\d_]+)/) || [])[1]?.replace(/_/g, "") || 0); };

async function main() {
  if ((await height()) === null) throw new Error("No regtest chain. Run: node scripts/zcash/regtest.mjs start");
  const addresses = JSON.parse(readFileSync(join(DIR, "addresses.json"), "utf8"));
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {} await sleep(100); }

  say("1. REAL Peeps lifecycle up to a completed Jam (request -> booking -> consent -> attendance -> transcript -> completion)");
  const reg = await api("/auth/register", { method: "POST", body: { name: "Zec Requester", email: "zec-e2e-req@example.com", password: "password10chars" } });
  db("dough_post", { id: "dle_e2e_seed", subjectType: "user", subjectId: reg.data.user.id, bucket: "spend", direction: "credit", amount: 5, kind: "funding", referenceId: "e2e-seed" });
  const created = await api("/api/peeps/requests", { method: "POST", body: { whoText: "Fintech payment executives in Southeast Asia offline payments", outcomeText: "I want 1 person for a recorded podcast about offline payments." } });
  const request = created.data.request;
  const cand = created.data.candidates.find((c) => c.source === "demo_directory_provider");
  const auth = await api(`/api/peeps/requests/${request.id}/authorize`, { method: "POST", body: { candidates: [{ candidateId: cand.id, outreachEmail: "zec-e2e-guest@example.com" }], compensationAmount: 25 } });
  const intro = auth.data.introductions[0];
  const msgs = (await api(`/api/peeps/test-outbox?requestId=${request.id}`)).data.messages;
  const token = msgs.find((m) => m.introductionId === intro.id && m.purpose === "outreach").testPayload.url.split("token=")[1];
  await api(`/api/peeps/respond/${token}/interested`, { method: "POST", body: {}, session: false });
  await api(`/api/peeps/respond/${token}/answers`, { method: "POST", session: false, body: { recordingPreference: "ok", durationMinutes: 45, timezone: "Asia/Bangkok", windows: [{ start: zoned(dayUtc(9, 2), "Asia/Bangkok"), end: zoned(dayUtc(9, 5), "Asia/Bangkok") }] } });
  await api(`/api/peeps/requests/${request.id}/availability`, { method: "POST", body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(8, 20), "America/New_York"), end: zoned(dayUtc(9, 8), "America/New_York") }] } });
  const book = await api(`/api/peeps/introductions/${intro.id}/book`, { method: "POST", body: {} });
  const jamId = book.data.booking.jamId;
  await api(`/api/peeps/respond/${token}/consent`, { method: "POST", session: false, body: { acceptances: ["terms_of_service", "recording"] } });
  const joinRes = await api(`/api/peeps/respond/${token}/join`, { method: "POST", session: false, body: {} });
  const invite = joinRes.data.joinUrl.split("token=")[1];
  await api(`/api/jams/${jamId}/events`, { method: "POST", session: false, body: { invite, type: "participant.joined" } });
  await api(`/api/jams/${jamId}/transcript`, { method: "POST", body: { segments: [{ speaker: "Zec Requester", text: "Welcome. Tell me about offline payments." }, { speaker: cand.displayName, text: "I have spent twelve years building offline payment systems across Southeast Asia." }] } });
  await api(`/api/jams/${jamId}/artifacts`, { method: "POST", body: { artifactType: "recording", storageReference: "s3://e2e/rec.mp4", status: "ready" } });
  await api(`/api/jams/${jamId}/complete`, { method: "POST", body: {} });
  const participantId = (await api(`/api/jams/${jamId}`)).data.participants[0].id;
  assert((await api(`/api/peeps/requests/${request.id}/lifecycle`)).data.state === "payment_pending", "Jam completed; compensation ($25 Dough obligation) is pending");

  say("2. Recipient opts in with their SHIELDED regtest address (consent); requester creates the obligation and explicitly approves");
  assert((await api(`/api/peeps/respond/${token}/zec-address`, { method: "POST", session: false, body: { consent: true, address: addresses.recipient } })).status === 200, "recipient opted in (shielded unified address, regtest)");
  const z = `/api/peeps/requests/${request.id}/zec-settlements`;
  const obligation = await api(z, { method: "POST", body: { participantId, amountZat: AMOUNT_ZAT } });
  const ref = obligation.data.settlement.ref;
  assert(obligation.data.settlement.state === "AWAITING_APPROVAL", "obligation created, AWAITING_APPROVAL");
  const approved = await api(`${z}/${ref}/approve`, { method: "POST", body: { approve: true } });
  const ins = approved.data.instructions;
  assert(approved.status === 200 && ins.address === addresses.recipient && ins.network === "regtest", "requester explicitly approved; payment instructions released to the requester only");

  say("3. REAL shielded transfer from the requester wallet (Orchard -> Orchard, memo carries the opaque settlement reference)");
  const before = { requester: orchard("req"), recipient: orchard("rec") };
  const send = wallet("req", ["--waitsync", "quicksend", ins.address, String(ins.amountZat), ins.memo]);
  const txid = (send.out.match(/"([0-9a-f]{64})"/) || [])[1];
  assert(Boolean(txid), "the requester wallet broadcast a shielded transaction");
  const submitted = await api(`${z}/${ref}/submit`, { method: "POST", body: { txid } });
  assert(submitted.data.settlement.state === "SUBMITTED", "Peeps recorded SUBMITTED (a claim, not settlement)");
  assert((await api(`/api/peeps/requests/${request.id}/lifecycle`)).data.state !== "paid", "not paid on the sender's say-so");

  say("4. Chain confirmation, then the RECIPIENT'S WALLET confirms receipt");
  const h0 = await height();
  for (let i = 0; i < 60 && (await height()) < h0 + 2; i++) await sleep(1000);
  let received;
  for (let i = 0; i < 20 && !received; i++) {
    // `notes` lists the wallet's own shielded outputs: value, memo, txid and confirmation status come from the RECIPIENT's wallet.
    const notes = (walletJson("rec", ["--waitsync", "notes"]).orchard_notes?.note_summaries) || [];
    const n = notes.find((x) => x.memo === ins.memo && String(x.status).startsWith("confirmed") && x.scope === "external");
    if (n) received = { value: n.value, memos: [n.memo], txid: n.txid, pool_received: "Orchard", blockheight: Number((String(n.status).match(/(\d+)/) || [])[1]) };
    else await sleep(3000);
  }
  assert(Boolean(received), "the recipient wallet shows a CONFIRMED incoming shielded note with the settlement memo");
  assert(received.value === AMOUNT_ZAT && received.pool_received === "Orchard" && received.txid === txid, `received exactly ${AMOUNT_ZAT} zatoshis in the Orchard (shielded) pool, same txid as the payer reported`);
  const view = (await api(`/api/peeps/respond/${token}/zec`, { session: false })).data.settlement;
  assert(view.state === "AWAITING_RECIPIENT_CONFIRMATION", "Peeps shows AWAITING_RECIPIENT_CONFIRMATION");
  const confirm = await api(`/api/peeps/respond/${token}/zec-confirm`, { method: "POST", session: false, body: { ref, code: view.confirmationCode, memo: received.memos[0], amountZat: received.value, txid: received.txid } });
  assert(confirm.status === 200 && confirm.data.settlement.state === "VERIFIED", "recipient-authenticated confirmation accepted: VERIFIED");
  assert((await api(`/api/peeps/respond/${token}/zec-confirm`, { method: "POST", session: false, body: { ref, code: view.confirmationCode, memo: received.memos[0], amountZat: received.value, txid: received.txid } })).data.idempotent === true, "replaying the confirmation is a no-op");

  say("5. Funds actually moved; Peeps records settlement; receipt privacy");
  const after = { requester: orchard("req"), recipient: orchard("rec") };
  assert(after.recipient - before.recipient === AMOUNT_ZAT, `recipient wallet +${AMOUNT_ZAT} zatoshis (shielded)`);
  // The requester wallet keeps receiving mined regtest coinbase, so its raw balance can't show the spend. Its own transfer record does.
  const sentBlock = wallet("req", ["--nosync", "value_transfers"]).out.match(/\{[^{}]*\}/g).find((b) => b.includes(`txid: ${txid}`) && /kind:\s*sent/.test(b)) || "";
  const sent = { kind: (sentBlock.match(/kind:\s*(\w+)/) || [])[1], value: Number((sentBlock.match(/value:\s*(\d+)/) || [])[1]), fee: Number((sentBlock.match(/transaction fee:\s*(\d+)/) || [])[1]), status: (sentBlock.match(/status:\s*(\w+)/) || [])[1] };
  assert(sent.kind === "sent" && sent.value === AMOUNT_ZAT && sent.status === "confirmed", `requester wallet's own record: SENT ${sent.value} zatoshis (+${sent.fee} fee), confirmed`);
  const life = (await api(`/api/peeps/requests/${request.id}/lifecycle`)).data;
  assert(life.state === "paid", "Peeps lifecycle reached 'paid'");
  const receipt = (await api(`/api/peeps/requests/${request.id}/receipt`)).data;
  const rz = receipt.zcash.settlements[0];
  assert(rz.state === "VERIFIED" && rz.label === "VERIFIED CONFIDENTIAL SETTLEMENT" && /REGTEST/.test(rz.networkLabel), "receipt: VERIFIED CONFIDENTIAL SETTLEMENT on REGTEST (labelled as a no-value test network)");
  assert(receipt.dough.items[0].rail === "zcash_confidential" && db("dough_get", { subjectType: "dub", subjectId: book.data.booking.candidateDubId }).account?.earnedBalance !== 25, "the payout is NOT presented as, or recorded in, the Dough ledger");
  const json = JSON.stringify(receipt);
  for (const secret of [addresses.recipient, addresses.requester, txid, ins.memo, String(AMOUNT_ZAT), "uregtest1"]) assert(!json.includes(secret), `public receipt omits ${secret.slice(0, 18)}...`);
  const stored = JSON.stringify(spawnSync("python3", ["-c", `import sqlite3,sys,json;print(json.dumps(sqlite3.connect(sys.argv[1]).execute("select confirmed_txid_hash from peeps_zec_settlements").fetchall()))`, dbPath], { encoding: "utf8" }).stdout);
  assert(stored.includes(createHash("sha256").update(txid).digest("hex")) && !stored.includes(txid), "Peeps stored only a hash of the transaction id as evidence");

  say(`\nEVIDENCE (regtest, no value)\n  network:            regtest (Zebra + Zaino + zingo-cli, all local)\n  settlement ref:     ${ref}\n  shielded txid:      ${txid}\n  confirmed at:       block ${received.blockheight}\n  amount:             ${AMOUNT_ZAT} zatoshis, Orchard->Orchard, memo = settlement ref\n  requester wallet:   sent ${sent.value} + ${sent.fee} fee (confirmed)\n  recipient wallet:   ${before.recipient} -> ${after.recipient} zatoshis\n  Peeps state:        ${rz.state}  (${rz.label})\n  Peeps lifecycle:    ${life.state}\n(The txid is shown here only because this is a regtest transcript; Peeps itself never exposes it.)`);
}

main().then(() => { server.kill(); rmSync(scratch, { recursive: true, force: true }); process.exit(0); })
  .catch((e) => { console.error(e.message || e); console.error(out.slice(-1500)); server.kill(); rmSync(scratch, { recursive: true, force: true }); process.exit(1); });
