#!/usr/bin/env node
// Post-Jam journey (End Session -> completion -> settlement -> receipt) for a demo participant. Companion: peeps-demo-participants-server-test. Demo participants: Toasty-run personas with a legitimate, honestly-labelled contact path (a private guest link, no email).
// Production-like server: NO email provider, NO test adapters. Nothing may be claimed delivered.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "toasty-dp-"));
function zoned(ms, tz) { const parts = {}; for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) parts[p.type] = p.value; return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; }
function dayUtc(d, h) { const t = new Date(Date.now() + d * 86400000); return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h, 0); }
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const child = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], { env: { ...process.env, TOASTY_RENDER_PORT: "4741", TOASTY_AUTH_DB: join(scratch, "db.sqlite"), TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "dp-secret", RESEND_API_KEY: "", PEEPS_TEST_ADAPTERS: "", TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "" }, stdio: "ignore" });
const base = "http://127.0.0.1:4741";
const call = async (path, { method = "GET", cookie, body } = {}) => { const r = await fetch(base + path, { method, headers: { "x-toasty-csrf": "1", ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); let data = {}; try { data = await r.json(); } catch (_) {} return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
  const reg = await call("/auth/register", { method: "POST", body: { name: "Judge", email: "judge-pj@example.com", password: "password10chars" } });
  const cookie = reg.cookie;
  await call("/api/peeps/dough/demo-credit", { method: "POST", cookie, body: {} });
  const created = await call("/api/peeps/requests", { method: "POST", cookie, body: { whoText: "Fintech/payment executives in Southeast Asia who understand offline payments", outcomeText: "I want 1 person for a recorded podcast about offline payments." } });
  const rid = created.data.request.id;
  const demo = created.data.candidates.filter((c) => c.reachability === "demo_participant");
  const auth = await call(`/api/peeps/requests/${rid}/authorize`, { method: "POST", cookie, body: { candidates: [{ candidateId: demo[0].id }], compensationAmount: 2 } });
  const intro = auth.data.introductions[0];
  const url = (await call(`/api/peeps/introductions/${intro.id}`, { cookie })).data.contact.demoGuestUrl;
  const token = new URL(url).searchParams.get("token");
  await call(`/api/peeps/respond/${token}/interested`, { method: "POST", body: {} });
  await call(`/api/peeps/respond/${token}/answers`, { method: "POST", body: { recordingPreference: "ok", durationMinutes: 45, timezone: "Asia/Bangkok", windows: [{ start: zoned(dayUtc(9, 2), "Asia/Bangkok"), end: zoned(dayUtc(9, 5), "Asia/Bangkok") }] } });
  await call(`/api/peeps/requests/${rid}/availability`, { method: "POST", cookie, body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(8, 20), "America/New_York"), end: zoned(dayUtc(9, 8), "America/New_York") }] } });
  const booked = await call(`/api/peeps/introductions/${intro.id}/book`, { method: "POST", cookie, body: {} });
  assert(booked.status === 201, "booked");
  const jamId = auth.data.jamId, sessionId = booked.data.booking.studioSessionId;
  const consent = await call(`/api/peeps/respond/${token}/consent`, { method: "POST", body: { acceptances: ["terms_of_service", "recording"] } });
  assert(consent.status === 200, "guest consent");
  const join = await call(`/api/peeps/respond/${token}/join`, { method: "POST", body: {} });
  const invite = join.data.joinUrl.split("token=")[1];
  assert((await call(`/api/jams/${jamId}/events`, { method: "POST", body: { invite, type: "participant.joined" } })).status === 201, "attendance");
  // The host ENDS the Studio session, with no recording and no transcript.
  const ended = await call(`/api/sessions/${sessionId}/end`, { method: "POST", cookie, body: {} });
  assert(ended.status === 200 && ended.data.session.status === "ENDED", "End Session answers 200 and the session is ENDED");
  assert(ended.data.session.peepsRequestId === rid && ended.data.session.postJam?.completed === true, "the response names the Peeps request (receipt target) and confirms the post-Jam workflow ran");
  let life = (await call(`/api/peeps/requests/${rid}/lifecycle`, { cookie })).data;
  assert(life.completion?.trigger === "studio_session_ended" && life.completion.participants[0].status === "attended", "completion was recorded by ending the session, with real attendance");
  assert(life.outcome.state === "outcome_pending" && life.outcome.criteria.some((c) => c.key === "recording_present" && !c.met), "with no recording the outcome stays PENDING and says why (nothing invented)");
  const again = await call(`/api/sessions/${sessionId}/end`, { method: "POST", cookie, body: {} });
  assert(again.status === 200, "ending twice is harmless");
  const settle = await call(`/api/peeps/requests/${rid}/settle`, { method: "POST", cookie, body: {} });
  assert(settle.status === 200 && settle.data.settlements[0].status === "settled_to_dough", "Dough settlement works from the ended session");
  const receipt = (await call(`/api/peeps/requests/${rid}/receipt`, { cookie })).data;
  const checks = Object.fromEntries(receipt.checks.map((c) => [c.key, c.state]));
  assert(checks.interaction === "done" && checks.consent === "done" && checks.attendance === "done" && checks.payment === "done" && checks.settlement === "done" && checks.outcome === "pending", "receipt: interaction, consent, attendance, payment, settlement done; outcome honestly pending");
  assert(receipt.dough.fundingSources.demoFunded === true && /simulated/i.test(receipt.dough.fundingSources.label), "receipt says the Dough was a simulated beta demo credit");
  assert(receipt.dough.onchain === false && receipt.dough.items[0].rail === "dough_ledger" && /off-chain/i.test(receipt.dough.items[0].railLabel) && /demo credit/i.test(receipt.dough.items[0].railLabel), "settlement is labelled off-chain Dough ledger, funded by demo credit");
  assert(receipt.solana.events.length === 1 && receipt.solana.events[0].status === "ledger_posted" && receipt.solana.events[0].signature === null && receipt.solana.events[0].explorerUrl === null && /demo credit/i.test(receipt.solana.events[0].label), "the introduction fee is labelled off-chain/demo and carries NO signature or Explorer link");
  assert(receipt.solana.doughFunding.length === 0 && !JSON.stringify(receipt).includes("onchain_verified"), "nothing on the receipt claims an on-chain verification that did not happen");
  console.log("\nPASS");
} finally { child.kill(); }
