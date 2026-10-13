#!/usr/bin/env node
// Demo participants: Toasty-run personas with a legitimate, honestly-labelled contact path (a private guest link, no email).
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
const child = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], { env: { ...process.env, TOASTY_RENDER_PORT: "4731", TOASTY_AUTH_DB: join(scratch, "db.sqlite"), TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "dp-secret", RESEND_API_KEY: "", PEEPS_TEST_ADAPTERS: "", TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "" }, stdio: "ignore" });
const base = "http://127.0.0.1:4731";
const call = async (path, { method = "GET", cookie, body } = {}) => { const r = await fetch(base + path, { method, headers: { "x-toasty-csrf": "1", ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); let data = {}; try { data = await r.json(); } catch (_) {} return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
  const reg = await call("/auth/register", { method: "POST", body: { name: "Judge", email: "judge-dp@example.com", password: "password10chars" } });
  const cookie = reg.cookie;
  await call("/api/peeps/dough/demo-credit", { method: "POST", cookie, body: {} });
  const created = await call("/api/peeps/requests", { method: "POST", cookie, body: { whoText: "Fintech/payment executives in Southeast Asia who understand offline payments", outcomeText: "I want 2 people for a recorded podcast about offline payments." } });
  const cands = created.data.candidates;
  const demo = cands.filter((c) => c.reachability === "demo_participant");
  assert(demo.length >= 2, `at least two candidates have a demo contact path (${demo.map((c) => c.displayName).join(", ")})`);
  const indirect = cands.filter((c) => c.reachability === "external_indirect");
  assert(indirect.length >= 1, "other directory entries still have NO contact path (the real skip behaviour is preserved)");

  const before = (await call("/api/peeps/dough", { cookie })).data.account.spendBalance;
  const refused = await call(`/api/peeps/requests/${created.data.request.id}/authorize`, { method: "POST", cookie, body: { candidates: [{ candidateId: indirect[0].id }] } });
  assert(refused.status === 409 && refused.data.error === "no_contactable_candidates" && refused.data.skipped[0].reason === "no_verified_contact_path", "selecting only uncontactable people is refused with the reason");
  const after = (await call("/api/peeps/dough", { cookie })).data.account.spendBalance;
  const reqState = (await call(`/api/peeps/requests/${created.data.request.id}`, { cookie })).data;
  assert(after === before && reqState.request.status !== "introductions_authorized" && !reqState.introductions.length, "refusal charged nothing, created no introduction, did not mark the request authorized");

  const auth = await call(`/api/peeps/requests/${created.data.request.id}/authorize`, { method: "POST", cookie, body: { candidates: demo.slice(0, 2).map((c) => ({ candidateId: c.id })), compensationAmount: 25 } });
  assert(auth.status === 200 && auth.data.introductions.length === 2 && auth.data.skipped.length === 0, "two demo participants authorized, none skipped");
  const detail = await call(`/api/peeps/introductions/${auth.data.introductions[0].id}`, { cookie });
  assert(detail.data.introduction?.status === "outreach_sent" || detail.data.status === "outreach_sent" || JSON.stringify(detail.data).includes("outreach_sent"), "introduction is waiting for the participant");
  const url = detail.data.contact?.demoGuestUrl;
  assert(/\/peeps\/respond\.html\?token=/.test(url || ""), "requester gets the private demo guest link");
  const msg = (detail.data.messages || []).find((m) => m.audience === "candidate");
  assert(msg && msg.providerKind === "demo_link" && msg.status === "simulated" && /no email was sent/i.test(msg.statusLabel || msg.label || JSON.stringify(msg)), "message is recorded as a demo link, never as sent email");
  assert(!(detail.data.messages || []).some((m) => m.status === "sent"), "nothing is claimed delivered");
  assert(detail.data.contact.channels.some((c) => c.channel === "demo_link" && c.verification === "toasty_run_demo_participant"), "the contact channel is labelled as a Toasty-run demo participant");
  const token = new URL(url).searchParams.get("token");
  const interested = await call(`/api/peeps/respond/${token}/interested`, { method: "POST", body: {} });
  assert(interested.status === 200, "the demo participant can accept through the private link (consent flow intact)");
  const answers = await call(`/api/peeps/respond/${token}/answers`, { method: "POST", body: { recordingPreference: "ok", durationMinutes: 45, timezone: "Asia/Bangkok", windows: [{ start: zoned(dayUtc(9, 2), "Asia/Bangkok"), end: zoned(dayUtc(9, 5), "Asia/Bangkok") }] } });
  assert(answers.status === 200, "the participant gives recording consent preference and availability");
  const rid = created.data.request.id;
  await call(`/api/peeps/requests/${rid}/availability`, { method: "POST", cookie, body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(8, 20), "America/New_York"), end: zoned(dayUtc(9, 8), "America/New_York") }] } });
  const booked = await call(`/api/peeps/introductions/${auth.data.introductions[0].id}/book`, { method: "POST", cookie, body: {} });
  assert(booked.status === 201 && booked.data.booking.jamId === auth.data.jamId && booked.data.booking.studioSessionId, "booking creates the Studio session on the same Jam: the requester can proceed to the Jam");
  const jam = await call(`/api/jams/${auth.data.jamId}`, { cookie });
  assert(jam.data.jam.studioSessionId === booked.data.booking.studioSessionId, "Jam is linked to its Studio session");
  const cons = await call(`/api/peeps/respond/${token}/consent`, { method: "POST", body: { acceptances: ["terms_of_service", "recording"] } });
  const early = (await call(`/api/peeps/requests/${rid}/receipt`, { cookie })).data.checks.find((c) => c.key === "consent");
  assert(cons.status === 200 && early.state === "pending" && /1 of 2 consented \(before anyone has attended\)/.test(early.detail), "before attendance the receipt reports the consent that exists (1 of 2) instead of a misleading '0 of N'");
  console.log("\nPASS");
} finally { child.kill(); }
