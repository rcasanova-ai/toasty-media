#!/usr/bin/env node
// Verifies the Peeps journey against a REAL deployment using a real, authorized account. It injects nothing: no synthetic
// attendance, no fabricated payment, no fake transcript. It creates a real request, reads the real evaluation, authorizes with
// the account's own Dough (or a Solana signature you supply), then reports which stages have REAL evidence yet.
//
//   export PEEPS_EMAIL=...  PEEPS_PASSWORD=...            # an invited, active account (never committed, never printed)
//   node scripts/production-journey-check.mjs start [--guest-email you+guest@example.com] [--pay dough|solana --signature <sig>]
//   (without --guest-email it uses a Toasty-run demo participant: no email involved; attendance and End Session need a human in Studio)
//   node scripts/production-journey-check.mjs status           # re-run any time; PASS only where real evidence exists
//
// Defaults to production (API https://render.toasty.media, origin https://toasty.media). For a local sandbox:
//   PEEPS_API=http://127.0.0.1:4174 PEEPS_ORIGIN=http://127.0.0.1:4173 node scripts/production-journey-check.mjs start ...
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = (process.env.PEEPS_API || "https://render.toasty.media").replace(/\/$/, "");
const ORIGIN = process.env.PEEPS_ORIGIN || "https://toasty.media";
const STATE = ".prod-journey.json";
const [cmd = "status", ...rest] = process.argv.slice(2);
const arg = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };
let cookie = "";

async function call(path, { method = "GET", body, headers = {} } = {}) {
  const r = await fetch(`${API}${path}`, { method, headers: { origin: ORIGIN, "x-toasty-csrf": "1", ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc && !cookie) cookie = sc.split(";")[0];
  let data = {}; try { data = await r.json(); } catch (_) {}
  return { status: r.status, data };
}
const line = (state, name, detail = "") => console.log(`${state.padEnd(8)} ${name}${detail ? `: ${detail}` : ""}`);

async function login() {
  const email = process.env.PEEPS_EMAIL, password = process.env.PEEPS_PASSWORD;
  if (!email || !password) { console.error("Set PEEPS_EMAIL and PEEPS_PASSWORD (an invited, active account)."); process.exit(2); }
  const r = await call("/auth/login", { method: "POST", body: { email, password } });
  if (r.status !== 200) { console.error(`Login failed (HTTP ${r.status}). Is the account invited and active?`); process.exit(2); }
  const s = await call("/auth/session");
  if (s.data.peepsAccess === "blocked") { console.error("This account is signed in but NOT cleared for the Peeps beta (waitlist state is not ACTIVE)."); process.exit(2); }
  line("PASS", "Sign in", `peepsAccess=${s.data.peepsAccess || "n/a"}`);
  const dough = await call("/api/peeps/dough");
  if (dough.status === 200 && Number(dough.data.account?.spendBalance) < 0.25 && dough.data.demoCredit?.available) {
    const claimed = await call("/api/peeps/dough/demo-credit", { method: "POST", body: {} });
    line(claimed.status === 200 ? "PASS" : "FAIL", "Beta demo credit claimed (test money, labelled demo_credit)", claimed.data.amount ? `$${claimed.data.amount}` : "");
  }
}

// Acts only through the demo participant's own private link and the requester's own account. Attendance and ending the
// Jam need a human in the Studio, so this stops there: nothing is simulated.
function zoned(ms, tz) { const parts = {}; for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) parts[p.type] = p.value; return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; }
const dayUtc = (d, h) => { const t = new Date(Date.now() + d * 86400000); return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h, 0); };
async function runDemoParticipantSteps(requestId, introId, jamId) {
  const detail = await call(`/api/peeps/introductions/${introId}`);
  const url = detail.data.contact?.demoGuestUrl;
  line(url ? "PASS" : "FAIL", "Demo participant link (no email sent)", url ? "present" : "missing");
  if (!url) process.exit(1);
  const token = new URL(url).searchParams.get("token");
  const guestCall = (path, body) => fetch(`${API}${path}`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", "x-toasty-csrf": "1" }, body: JSON.stringify(body || {}) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
  line((await guestCall(`/api/peeps/respond/${token}/interested`)).status === 200 ? "PASS" : "FAIL", "Participant accepts (their private link)");
  const ans = await guestCall(`/api/peeps/respond/${token}/answers`, { recordingPreference: "ok", durationMinutes: 45, timezone: "Asia/Bangkok", windows: [{ start: zoned(dayUtc(9, 2), "Asia/Bangkok"), end: zoned(dayUtc(9, 5), "Asia/Bangkok") }] });
  line(ans.status === 200 ? "PASS" : "FAIL", "Participant shares recording preference and availability");
  const av = await call(`/api/peeps/requests/${requestId}/availability`, { method: "POST", body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(8, 20), "America/New_York"), end: zoned(dayUtc(9, 8), "America/New_York") }] } });
  line(av.status === 200 ? "PASS" : "FAIL", "Requester availability recorded");
  const booked = await call(`/api/peeps/introductions/${introId}/book`, { method: "POST", body: {} });
  line(booked.status === 201 || booked.data.idempotent ? "PASS" : "FAIL", "Booked: Jam + Studio session", booked.data.booking?.studioSessionId || `HTTP ${booked.status}`);
  const consent = await guestCall(`/api/peeps/respond/${token}/consent`, { acceptances: ["terms_of_service", "recording"] });
  line(consent.status === 200 ? "PASS" : "FAIL", "Participant consent captured (their own link)");
  const join = await guestCall(`/api/peeps/respond/${token}/join`);
  console.log(`\nNOW A HUMAN MUST (nothing below is simulated by this script):\n  1. Open the Studio as host: ${ORIGIN}/studio/director.html?session=${booked.data.booking?.studioSessionId || ""}\n  2. Open the participant's join link in another browser/device, allow camera and microphone, join: ${join.data.joinUrl || "(see participant link)"}\n  3. In Studio choose End Session (in the ••• menu).\nThen run: node scripts/production-journey-check.mjs status`);
}

async function start() {
  await login();
  const guest = arg("guest-email");
  const demoMode = !guest; // no email: use a Toasty-run demo participant (private demo link, no email involved)
  const created = await call("/api/peeps/requests", { method: "POST", body: { whoText: "Fintech/payment executives in Southeast Asia who understand offline payments", outcomeText: "I want 1 person for a recorded podcast about offline payments and digital wallets." } });
  if (created.status !== 201) { line("FAIL", "Create request", `HTTP ${created.status} ${created.data.error || ""}`); process.exit(1); }
  const request = created.data.request, cands = created.data.candidates;
  line("PASS", "Request created", request.id);
  const evaluated = cands.filter((c) => c.evaluation);
  line(evaluated.length === cands.length ? "PASS" : "FAIL", "Evidence-based evaluation", `${evaluated.length}/${cands.length} candidates evaluated; ${cands.filter((c) => c.evaluation?.verdict === "qualified").length} qualified, ${cands.filter((c) => c.evaluation?.verdict === "excluded").length} excluded`);
  const pick = (demoMode ? [...cands].filter((c) => c.reachability === "demo_participant") : [...cands]).filter((c) => !demoMode || true).sort((a, b) => (a.evaluation?.evaluationRank ?? 99) - (b.evaluation?.evaluationRank ?? 99))[0] || cands[0];
  if (demoMode && pick.reachability !== "demo_participant") { line("FAIL", "Demo participant", "no demo participant among the candidates; pass --guest-email instead"); process.exit(1); }
  line("INFO", "Selected", `${pick.displayName} (#${pick.evaluation?.evaluationRank}, ${pick.evaluation?.verdict}, ${Math.round((pick.evaluation?.score || 0) * 100)}% evidence)`);
  const headers = {};
  if (arg("pay") === "solana") {
    const sig = arg("signature"); if (!sig) { console.error("--signature <Solana tx signature> is required for --pay solana (see peeps/README.md)"); process.exit(2); }
    Object.assign(headers, { "x-payment-signature": sig, "x-solana-transaction-signature": sig, "x-payment-asset": "USDC", "x-payment-amount": "0.25" });
  }
  const auth = await call(`/api/peeps/requests/${request.id}/authorize`, { method: "POST", headers, body: { candidates: [{ candidateId: pick.id, outreachEmail: guest }], compensationAmount: 25 } });
  if (auth.status !== 200) { line("FAIL", "Authorize introduction", `HTTP ${auth.status}: ${auth.data.message || auth.data.error || ""}`); if (auth.status === 402) console.error("Not enough Dough, or the Solana proof was rejected. Fund Dough at /peeps/app/dough.html or use --pay solana."); process.exit(1); }
  line("PASS", "Authorize introduction", auth.data.payment ? `${auth.data.payment.label}${auth.data.payment.explorerUrl ? ` ${auth.data.payment.explorerUrl}` : ""}` : "");
  writeFileSync(STATE, JSON.stringify({ requestId: request.id, jamId: auth.data.jamId }));
  if (demoMode) await runDemoParticipantSteps(request.id, auth.data.introductions[0].id, auth.data.jamId);
  if (!demoMode) console.log(`\nNext (a real person must do these): open the email sent to ${guest}, click the link, accept, share availability and consent. Then run:  node scripts/production-journey-check.mjs status`);
}

async function status() {
  if (!existsSync(STATE)) { console.error("Run 'start' first (no .prod-journey.json)."); process.exit(2); }
  const { requestId } = JSON.parse(readFileSync(STATE, "utf8"));
  await login();
  const [req, rc, life] = await Promise.all([call(`/api/peeps/requests/${requestId}`), call(`/api/peeps/requests/${requestId}/receipt`), call(`/api/peeps/requests/${requestId}/lifecycle`)]);
  if (rc.status !== 200) { line("FAIL", "Read receipt", `HTTP ${rc.status}`); process.exit(1); }
  const r = rc.data, intro = req.data.introductions?.[0];
  const checks = Object.fromEntries(r.checks.map((c) => [c.key, c]));
  const st = (ok) => (ok ? "PASS" : "PENDING");
  line("PASS", "Request + discovery + evaluation", `${req.data.candidates.length} candidates, persisted`);
  const ev = r.solana.events[0];
  line(st(Boolean(ev || checks.payment?.state === "done")), "Introduction payment", ev ? `${ev.status} ${ev.explorerUrl || "(no chain signature: ledger/simulated)"}` : checks.payment?.detail);
  line(st(["accepted", "scheduling", "booked"].includes(intro?.status)), "Candidate responded", intro?.status);
  line(st(Boolean(r.jam?.studioSessionId)), "Booked: Jam + Studio session", r.jam ? `${r.jam.id} / ${r.jam.studioSessionId}` : "not yet");
  if (r.jam?.studioUrl) console.log(`         Open the Studio room (host): https://toasty.media${r.jam.studioUrl}`);
  line(st(checks.consent?.state === "done"), "Consent captured (by the participant)", checks.consent?.detail);
  line(st(checks.attendance?.state === "done"), "Attendance (emitted by the room)", checks.attendance?.detail);
  line(st(r.evidence.recordingPresent), "Recording registered (Studio finalization)", r.evidence.recordingPresent ? "present" : "none yet");
  line(st(r.evidence.transcripts.length > 0), "Transcript", r.evidence.transcripts.map((t) => t.source).join(", ") || "none yet (upload with named speakers, or automatic when whisper is configured)");
  line(st(r.breadcrumbs.total > 0), "Breadcrumbs from attributed speech", `${r.breadcrumbs.total}`);
  line(st(checks.outcome?.state === "done"), "Outcome verified", checks.outcome?.detail);
  line(st(r.dough.status === "settled"), "Compensation settled", `${r.dough.status}; rail: ${r.dough.items[0]?.rail || "n/a"}`);
  line(st(r.zcash?.settlements?.some((z) => z.verified)), "Optional Zcash confidential settlement", r.zcash ? r.zcash.settlements.map((z) => `${z.label} [${z.networkLabel}]`).join("; ") || "enabled, not used" : "not enabled on this deployment");
  console.log(`\nLifecycle state: ${life.data.state}. Receipt: ${ORIGIN}/peeps/app/outcome.html?request=${requestId}`);
}

if (cmd === "start") await start(); else if (cmd === "status") await status(); else { console.error("usage: production-journey-check.mjs start --guest-email <addr> | status"); process.exit(2); }
