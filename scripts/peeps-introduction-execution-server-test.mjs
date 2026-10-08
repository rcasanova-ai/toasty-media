#!/usr/bin/env node
// HTTP-level integration test for the Peeps INTRODUCTION EXECUTION slice: authorized introduction ->
// contact resolution -> outreach (adapter) -> unauthenticated response page -> interested -> availability
// -> deterministic scheduling -> idempotent booking -> Jam + Studio link -> Session Planner auto-population
// -> prep -> organizer edits -> notifications -> READY FOR SESSION, plus cancel/reschedule/replacement and
// the security + failure cases from the brief. Same harness as peeps-agent-lifecycle-server-test.mjs: the
// real server against a throwaway SQLite DB, driven with fetch. PEEPS_TEST_ADAPTERS=1 with no
// RESEND_API_KEY selects the clearly-labelled TEST/DEMO outreach provider (status "simulated").
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4217;
const BASE = `http://127.0.0.1:${PORT}`;
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-peeps-exec-"));
const dbPath = join(scratchDir, "toasty.sqlite");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function cookieFrom(response) {
  return (response.headers.get("set-cookie") || "").split(";")[0];
}

async function api(path, { method = "GET", cookie, body, headers = {}, raw = false } = {}) {
  const requestHeaders = { "x-toasty-csrf": "1", ...headers };
  if (cookie) requestHeaders.cookie = cookie;
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  const response = await fetch(`${BASE}${path}`, { method, headers: requestHeaders, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (raw) return { status: response.status, text: await response.text(), type: response.headers.get("content-type") || "" };
  let data = {};
  try { data = await response.json(); } catch (_) {}
  return { status: response.status, data, cookie: cookieFrom(response) || cookie };
}

function db(action, values = {}) {
  const result = spawnSync("python3", [helper], { input: JSON.stringify({ action, dbPath, ...values }), encoding: "utf8" });
  if (result.status !== 0) throw new Error(`db helper failed: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function sql(statement, params = []) {
  const script = `import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\nc.execute(sys.argv[2], json.loads(sys.argv[3]))\nc.commit()`;
  const result = spawnSync("python3", ["-c", script, dbPath, statement, JSON.stringify(params)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sql failed: ${result.stderr}`);
}

async function waitForHealth() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) return; } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("server never came up");
}

const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "peeps-exec-test-secret", RESEND_API_KEY: "", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "", PEEPS_TEST_ADAPTERS: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
let serverOutput = "";
server.stdout.on("data", (c) => (serverOutput += c));
server.stderr.on("data", (c) => (serverOutput += c));

// ---- time helpers (independent of the server's implementation) ----
function zoned(ms, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
const iso = (ms) => new Date(ms).toISOString();
function dayUtc(daysFromNow, hour, minute = 0) {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour, minute);
}
const HOUR = 3600000;

async function payAndAuthorize(requestId, cookie, candidates, extra = {}) {
  const demoPay = await api("/api/peeps/demo-payments/authorize", { method: "POST", cookie, body: { requestId } });
  return api(`/api/peeps/requests/${requestId}/authorize`, {
    method: "POST", cookie,
    headers: { "x-payment-signature": demoPay.data.paymentSignature, "x-solana-transaction-signature": demoPay.data.transactionSignature, "x-payment-asset": "USDC", "x-payment-amount": "0.25", "x-payer-wallet": demoPay.data.payerWallet, "x-approval-source": demoPay.data.approvalSource },
    body: { candidates, ...extra }
  });
}

async function outbox(requestId, cookie) {
  return (await api(`/api/peeps/test-outbox?requestId=${requestId}`, { cookie })).data.messages || [];
}

function tokenFromOutreach(messages, introId, purposes = ["outreach", "opening", "reminder"]) {
  const message = [...messages].reverse().find((m) => m.introductionId === introId && purposes.includes(m.purpose) && m.audience === "candidate" && m.status === "simulated");
  const url = message?.testPayload?.url || "";
  return { token: url.split("token=")[1] || "", message };
}

async function main() {
  await waitForHealth();

  console.log("Setup — organizer + golden-demo request + candidates");
  const organizer = await api("/auth/register", { method: "POST", body: { name: "Priya Organizer", email: "priya-exec@example.com", password: "password10chars" } });
  assert(organizer.status === 201, "organizer registers");
  const cookie = organizer.cookie;
  const create = await api("/api/peeps/requests", { method: "POST", cookie, body: {
    whoText: "Fintech/payment executives in Southeast Asia who understand offline payments.",
    outcomeText: "I want three interesting people for a recorded podcast about where digital payments are going."
  } });
  assert(create.status === 201, "golden-demo request is created");
  const request = create.data.request;
  const cands = create.data.candidates;
  assert(cands.length >= 5, "at least five candidates exist to exercise every branch");

  console.log("\nPhase 1 — authorize: contact resolution + outreach adapters, honest about what's real");
  const emailA = "guest-a@example.com";
  const auth = await payAndAuthorize(request.id, cookie, [
    { candidateId: cands[0].id, outreachEmail: emailA },
    { candidateId: cands[1].id, outreachEmail: "bounce-b@example.com" },
    { candidateId: cands[2].id, outreachEmail: "latefail-c@example.com" },
    { candidateId: cands[3].id, outreachEmail: emailA },
    { candidateId: cands[4].id }
  ], { compensationAmount: 25 });
  assert(auth.status === 200, "authorize succeeds");
  const byCandidate = new Map(auth.data.introductions.map((i) => [i.candidateId, i]));
  const introA = byCandidate.get(cands[0].id);
  const introB = byCandidate.get(cands[1].id);
  const introC = byCandidate.get(cands[2].id);
  assert(introA.status === "outreach_sent" && introA.outreachSentAt, "an introduction with a working channel reaches outreach_sent");
  assert(introB.status === "unreachable", "a hard delivery failure marks the introduction unreachable instead of spinning");
  assert(!byCandidate.has(cands[3].id) && auth.data.skipped.some((s) => s.candidateId === cands[3].id && s.reason === "duplicate_identity"), "a second candidate resolving to the SAME identity is refused (participant identity collision)");
  assert(auth.data.skipped.some((s) => s.candidateId === cands[4].id && s.reason === "no_verified_contact_path"), "a candidate with no legitimate path is skipped honestly; no email is ever guessed");

  const viewA = await api(`/api/peeps/introductions/${introA.id}`, { cookie });
  assert(viewA.status === 200, "organizer can open the introduction");
  const chA = viewA.data.contact.channels[0];
  assert(chA.channel === "requester_supplied_email" && chA.source === "requester_supplied" && chA.verification === "unverified_supplied_by_requester", "contact provenance is stored: channel, source, verification");
  assert(chA.destination.includes("•") && !JSON.stringify(viewA.data).includes(emailA), "the organizer only ever sees a MASKED destination — the raw address never leaves the server");
  assert(chA.lastCheckedAt && chA.authorizationContext.purpose === "introduction_outreach", "last-checked and authorization context are recorded");
  const msgA = viewA.data.messages.find((m) => m.purpose === "outreach");
  assert(msgA.providerKind === "test_demo" && msgA.status === "simulated" && /Simulated by the test provider/.test(msgA.delivery), "simulated delivery is labelled test_demo/simulated and never described as real delivery");
  assert(viewA.data.adapters.find((a) => a.id === "peeps_a2a").automatable === false, "unsupported channels are reported as adapter-only, not pretended");
  const viewB = await api(`/api/peeps/introductions/${introB.id}`, { cookie });
  assert(viewB.data.contact.reason === "delivery_failed" && viewB.data.nextActions.includes("find_replacement"), "the requester is told the truth and offered a replacement");
  const requestGet = await api(`/api/peeps/requests/${request.id}`, { cookie });
  assert(!JSON.stringify(requestGet.data).includes(emailA), "the request endpoint doesn't leak the contact address either");

  console.log("\nPhase 2 — the external response page: no account, unguessable token");
  const msgs1 = await outbox(request.id, cookie);
  const { token: tokenA, message: outreachA } = tokenFromOutreach(msgs1, introA.id);
  assert(/^[A-Za-z0-9_-]{43}$/.test(tokenA), "the response token is 256 bits of base64url entropy");
  assert(/would like to speak with you/.test(outreachA.testPayload.text) && /introduction request facilitated by Toasty Peeps/.test(outreachA.testPayload.text) && /has not been in touch with you before/.test(outreachA.testPayload.text), "outreach says who, that it's Peeps-facilitated, and claims no prior relationship");
  assert(/recorded/i.test(outreachA.testPayload.text) && /\$25\.00/.test(outreachA.testPayload.text) && /45 minutes/.test(outreachA.testPayload.text) && !/Payments product lead|evidence/i.test(outreachA.testPayload.text), "outreach states purpose, format, recording, compensation and time without dumping research about them");
  const publicView = await api(`/api/peeps/respond/${tokenA}`, { headers: { "x-toasty-csrf": "" } });
  assert(publicView.status === 200 && publicView.data.state === "awaiting_decision", "the response page loads with NO cookie/session");
  const publicJson = JSON.stringify(publicView.data);
  assert(publicView.data.requester.name === "Priya Organizer" && publicView.data.purpose.includes("podcast") && publicView.data.compensation.amount === 25 && publicView.data.recording === "planned", "it shows who, why, purpose, recording and compensation");
  assert(!publicJson.includes(emailA) && !/organizationId|evidence|jamId|contactEmail/.test(publicJson), "no contact info, evidence or internal ids on the public view");
  assert((await api(`/api/peeps/respond/${"a".repeat(43)}`)).status === 404 && (await api("/api/peeps/respond/short")).status === 404, "guessed/malformed tokens are 404");
  const unauth = await api(`/api/peeps/introductions/${introA.id}`, { headers: { "x-toasty-csrf": "" } });
  assert(unauth.status === 401, "the organizer API needs a session — holding a response token grants no organization access");
  const tokenAsCookie = await api(`/api/peeps/requests/${request.id}`, { cookie: `toasty_session=${tokenA}` });
  assert(tokenAsCookie.status === 401, "a response token can't be used as a session");

  console.log("\nPhase 3 — Interested: only ask what is still missing");
  const interested = await api(`/api/peeps/respond/${tokenA}/interested`, { method: "POST", body: {} });
  assert(interested.status === 200 && interested.data.state === "collecting_details", "Interested moves them into detail collection");
  assert(interested.data.needs.includes("availability") && interested.data.needs.includes("recording") && interested.data.needs.includes("duration") && !interested.data.needs.includes("compensation"), "needs list skips what's known (compensation is already offered)");
  assert((await api(`/api/peeps/respond/${tokenA}/interested`, { method: "POST", body: {} })).status === 200, "Interested is idempotent");
  const partial = await api(`/api/peeps/respond/${tokenA}/answers`, { method: "POST", body: { recordingPreference: "ok", durationMinutes: 45 } });
  assert(partial.status === 200 && partial.data.needs.length === 1 && partial.data.needs[0] === "availability", "answers persist and only availability remains");
  assert((await api(`/api/peeps/respond/${tokenA}/answers`, { method: "POST", body: { timezone: "Not/AZone", windows: [] } })).status === 400, "an invalid timezone is rejected");
  assert((await api(`/api/peeps/respond/${tokenA}/answers`, { method: "POST", body: { timezone: "Asia/Bangkok", windows: [{ start: "2026-13-40T09:00", end: "2026-13-40T10:00" }] } })).status === 400, "an impossible date is rejected");
  assert((await api(`/api/peeps/respond/${tokenA}/answers`, { method: "POST", body: { timezone: "Asia/Bangkok", windows: [{ start: zoned(dayUtc(9, 5), "Asia/Bangkok"), end: zoned(dayUtc(9, 5), "Asia/Bangkok") }] } })).status === 400, "a zero-length window is rejected");
  assert((await api(`/api/peeps/respond/${tokenA}/answers`, { method: "POST", body: { timezone: "Asia/Bangkok", windows: [{ start: "2020-01-01T09:00", end: "2020-01-01T10:00" }] } })).status === 400, "windows entirely in the past are rejected");

  // Bangkok 09:00-12:00 local on D = 02:00-05:00 UTC on D.
  const D = 9;
  const answers = await api(`/api/peeps/respond/${tokenA}/answers`, { method: "POST", body: { timezone: "Asia/Bangkok", minNoticeHours: 12, windows: [{ start: zoned(dayUtc(D, 2), "Asia/Bangkok"), end: zoned(dayUtc(D, 5), "Asia/Bangkok") }] } });
  assert(answers.status === 200 && answers.data.state === "waiting_for_booking", "once everything is known the introduction moves to scheduling");
  const scheduling = await api(`/api/peeps/introductions/${introA.id}`, { cookie });
  assert(scheduling.data.introduction.status === "scheduling" && scheduling.data.availability.timezone === "Asia/Bangkok", "availability is persisted against the introduction");
  assert((await outbox(request.id, cookie)).some((m) => m.introductionId === introA.id && m.purpose === "organizer_interest") && (await outbox(request.id, cookie)).some((m) => m.introductionId === introA.id && m.purpose === "organizer_ready_to_schedule"), "the requester is notified of interest and of readiness to schedule");

  console.log("\nPhase 4 — scheduling: deterministic slot intersection, never a time nobody offered");
  const noReq = await api(`/api/peeps/introductions/${introA.id}/slots`, { cookie });
  assert(noReq.data.reason === "requester_availability_required" && noReq.data.slots.length === 0, "with no requester availability there are no slots");
  const noReqBook = await api(`/api/peeps/introductions/${introA.id}/book`, { method: "POST", cookie, body: {} });
  assert(noReqBook.status === 409, "booking without the requester's own availability is refused");
  const setNone = await api(`/api/peeps/requests/${request.id}/availability`, { method: "POST", cookie, body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(D + 3, 14), "America/New_York"), end: zoned(dayUtc(D + 3, 16), "America/New_York") }] } });
  assert(setNone.status === 200, "requester saves availability");
  const noOverlap = await api(`/api/peeps/introductions/${introA.id}/slots`, { cookie });
  assert(noOverlap.data.reason === "no_overlapping_availability", "no overlap is reported plainly (not an empty spinner)");
  assert((await api(`/api/peeps/introductions/${introA.id}/book`, { method: "POST", cookie, body: {} })).status === 409, "no overlap -> booking refused");
  // Generous NY window that covers 02:00-05:00Z on D regardless of DST.
  const setReq = await api(`/api/peeps/requests/${request.id}/availability`, { method: "POST", cookie, body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(D - 1, 20), "America/New_York"), end: zoned(dayUtc(D, 8), "America/New_York") }] } });
  assert(setReq.status === 200, "requester changes availability");
  const slots = await api(`/api/peeps/introductions/${introA.id}/slots`, { cookie });
  assert(slots.data.slots.length >= 1 && slots.data.durationMinutes === 45, "compatible slots are produced");
  assert(slots.data.slots.every((s) => Date.parse(s.startsAt) >= dayUtc(D, 2) && Date.parse(s.endsAt) <= dayUtc(D, 5)), "every slot sits inside BOTH parties' windows across the Bangkok/New York boundary");
  assert(/ICT|GMT\+7/.test(slots.data.slots[0].candidateLocal) && /E[SD]T|GMT-[45]/.test(slots.data.slots[0].requesterLocal), "each slot renders correctly in each party's own timezone");
  const outside = await api(`/api/peeps/introductions/${introA.id}/book`, { method: "POST", cookie, body: { slotStart: iso(dayUtc(D, 9)) } });
  assert(outside.status === 409, "booking a time the guest never offered is refused");
  const chosen = slots.data.slots[0].startsAt;

  console.log("\nPhase 5 — booking: idempotent; Jam + Studio + Planner + prep created and linked");
  const book1 = await api(`/api/peeps/introductions/${introA.id}/book`, { method: "POST", cookie, body: { slotStart: chosen, cancellationPolicy: { lateCancellationHours: 24 } }, headers: {} });
  assert(book1.status === 201 && book1.data.created === true, "booking is created");
  const booking = book1.data.booking;
  assert(booking.jamId && booking.studioSessionId && booking.jamParticipantId && booking.requestId === request.id && booking.introductionId === introA.id && booking.organizationId && booking.candidateDubId, "booking links request, introduction, org, Jam, Studio session, participant and Dub IDs");
  assert(book1.data.booking.setup.jam.ok && book1.data.booking.setup.studio.ok && book1.data.booking.setup.speaker.ok && book1.data.booking.setup.planner.ok, "every setup step reports ok");
  assert(booking.cancellationPolicy.lateCancellationHours === 24 && booking.cancellationPolicy.monetaryPenalty === "none_automatic", "the cancellation policy is stored with the booking and imposes no automatic money penalty");
  assert(book1.data.state === "READY_FOR_SESSION" && book1.data.readiness.items.every((i) => i.ok), "the session reaches READY_FOR_SESSION with every readiness item satisfied");

  const [dup1, dup2] = await Promise.all([1, 2].map(() => api(`/api/peeps/introductions/${introA.id}/book`, { method: "POST", cookie, body: { slotStart: chosen } })));
  assert(dup1.data.booking.id === booking.id && dup2.data.booking.id === booking.id && !dup1.data.created && !dup2.data.created, "retrying / double-clicking never creates a second booking");
  const jamAfter = await api(`/api/jams/${booking.jamId}`, { cookie });
  assert(jamAfter.data.jam.studioSessionId === booking.studioSessionId && jamAfter.data.jam.scheduledAt === zoned(Date.parse(chosen), "America/New_York") && jamAfter.data.jam.timezone === "America/New_York", "the existing Jam carries the booked time; one Studio session");
  assert(jamAfter.data.participants.every((p) => !p.email || p.email.includes("•")) && !JSON.stringify(jamAfter.data).includes(emailA), "the Jam participant list masks the guest's address too — no side door to the contact details");
  const rerun = await api(`/api/jams/${booking.jamId}/run-session`, { method: "POST", cookie, body: {} });
  assert(rerun.status === 200 && rerun.data.created === false && rerun.data.session.id === booking.studioSessionId, "Studio session creation retry reuses the same session");
  const rebuild = await api(`/api/peeps/bookings/${booking.id}/rebuild`, { method: "POST", cookie, body: {} });
  assert(rebuild.status === 200 && rebuild.data.booking.studioSessionId === booking.studioSessionId, "rebuild is idempotent");
  const studioSession = await api(`/api/sessions/${booking.studioSessionId}`, { cookie });
  const plan = studioSession.data.session.plan;
  assert(plan.sessionType === "podcast" && plan.description.includes("podcast") && plan.expectedDurationMinutes === 45 && plan.timezone === "America/New_York" && plan.scheduledAt === zoned(Date.parse(chosen), "America/New_York"), "the real Session Planner is populated: type, objective, time, timezone, duration");
  assert(plan.peeps.questions.length >= 5 && plan.runOfShow.length >= plan.peeps.questions.length, "questions exist before the meeting and are mirrored into the planner's run of show");
  assert(!plan.peeps.questions.some((q) => /tell us about yourself/i.test(q.text)), "no generic 'tell us about yourself' question");
  const guest = cands[0];
  assert(plan.peeps.questions.some((q) => new RegExp(guest.headline.split(/\s+/).slice(0, 2).join("\\s+"), "i").test(q.text)) && plan.peeps.questions.some((q) => /digital payments/i.test(q.text)), "questions reflect the guest's background and the requested subject");
  assert(plan.peeps.recording.state === "recorded" && plan.peeps.compensation.amount === 25, "recording and compensation are carried into the planner");
  const speakers = await api(`/api/sessions/${booking.studioSessionId}/speakers`, { cookie });
  assert(speakers.data.speakers.length === 1 && speakers.data.speakers[0].displayName === guest.displayName && speakers.data.speakers[0].email === "" && speakers.data.speakers[0].selectionReason, "the guest is a planner Speaker with a selection reason and NO contact email (rebuilds didn't duplicate)");

  console.log("\nPhase 6 — prep: organizer vs attendee, no private leakage");
  const organizerPrep = await api(`/api/peeps/bookings/${booking.id}/prep?role=organizer`, { cookie });
  assert(organizerPrep.status === 200 && organizerPrep.data.evidence.length && organizerPrep.data.whySelected && organizerPrep.data.talkingPoints.length && organizerPrep.data.questions.length, "organizer prep: who, why selected, evidence, talking points, questions");
  assert(/demo candidate directory/i.test(organizerPrep.data.who.source), "organizer prep is honest that the candidate came from the demo directory");
  await api(`/api/peeps/bookings/${booking.id}/plan`, { method: "POST", cookie, body: { privateNotes: "SECRET-ORGANIZER-NOTE do not share" } });
  const attendeePrep = await api(`/api/peeps/respond/${tokenA}/prep`);
  assert(attendeePrep.status === 200 && attendeePrep.data.requester.name === "Priya Organizer" && attendeePrep.data.schedule.display && attendeePrep.data.questions.length >= 5 && attendeePrep.data.recording.state === "recorded" && attendeePrep.data.joinPath.available, "attendee prep: who, why, purpose, time, recording, compensation, questions, join");
  const attendeeJson = JSON.stringify(attendeePrep.data);
  assert(!/SECRET-ORGANIZER-NOTE/.test(attendeeJson) && !/evidence|whySelected|privateNotes|talkingPoints|organizationId/.test(attendeeJson) && !attendeeJson.includes(emailA) && !attendeeJson.includes(cands[1].displayName), "attendee prep never contains private notes, research, contact info or other candidates");

  console.log("\nPhase 7 — organizer edits persist, version, and notify attendees only for participant-facing changes");
  const before = await outbox(request.id, cookie);
  const planNow = (await api(`/api/peeps/bookings/${booking.id}`, { cookie })).data;
  const versionBefore = planNow.plan.version;
  const edited = planNow.plan.questions.map((q, i) => ({ id: q.id, text: i === 0 ? "EDITED: what does offline payment failure actually cost a merchant?" : q.text }));
  const edit = await api(`/api/peeps/bookings/${booking.id}/plan`, { method: "POST", cookie, body: { questions: edited, baseVersion: versionBefore } });
  assert(edit.status === 200 && edit.data.edit.participantFacingChanged && edit.data.edit.version === versionBefore + 1, "editing a question bumps the version");
  const staleEdit = await api(`/api/peeps/bookings/${booking.id}/plan`, { method: "POST", cookie, body: { objective: "stale", baseVersion: versionBefore } });
  assert(staleEdit.status === 409, "a stale edit is rejected instead of overwriting newer work");
  const after = await outbox(request.id, cookie);
  assert(after.filter((m) => m.purpose === "prep_update" && m.introductionId === introA.id).length === 1, "exactly one prep-update notification went to the attendee");
  assert((await api(`/api/peeps/respond/${tokenA}/prep`)).data.questions[0].startsWith("EDITED:"), "the guest-facing prep reflects the edit");
  const privateOnly = await api(`/api/peeps/bookings/${booking.id}/plan`, { method: "POST", cookie, body: { privateNotes: "another private thought" } });
  assert(privateOnly.data.edit.participantFacingChanged === false && (await outbox(request.id, cookie)).filter((m) => m.purpose === "prep_update").length === 1, "a private-notes edit notifies no one");
  const reloaded = await api(`/api/peeps/bookings/${booking.id}`, { cookie });
  assert(reloaded.data.plan.questions[0].text.startsWith("EDITED:") && reloaded.data.plan.privateNotes === "another private thought" && reloaded.data.versions.length >= 2, "edits and history survive a refresh");
  // Classic planner saves the whole plan from a stale copy: Peeps content and the booked time must survive.
  const stalePlan = { ...plan, scheduledAt: "2030-01-01T00:00", timezone: "UTC", peeps: { questions: [], objective: "clobber" }, runOfShow: [] };
  const plannerSave = await api(`/api/sessions/${booking.studioSessionId}/plan`, { method: "POST", cookie, body: { plan: stalePlan } });
  assert(plannerSave.status === 200 && plannerSave.data.session.plan.peeps.questions.length >= 5 && plannerSave.data.session.plan.scheduledAt === plan.scheduledAt && plannerSave.data.session.plan.peeps.objective !== "clobber", "a stale classic-planner save can't clobber Peeps content or the booked time");
  const ros = plannerSave.data.session.plan.runOfShow.map((item) => (String(item.id).startsWith("ros_q_") && item === plannerSave.data.session.plan.runOfShow[1] ? { ...item, label: "PLANNER EDIT question" } : item));
  const rosSave = await api(`/api/sessions/${booking.studioSessionId}/plan`, { method: "POST", cookie, body: { plan: { ...plannerSave.data.session.plan, runOfShow: ros } } });
  assert(rosSave.data.session.plan.peeps.questions[1].text === "PLANNER EDIT question", "editing a question in the classic planner updates the canonical question");

  console.log("\nPhase 8 — consent, join path, calendar file");
  const consent = await api(`/api/peeps/respond/${tokenA}/consent`, { method: "POST", body: { acceptances: ["terms_of_service", "recording"], displayName: "Anong S." } });
  assert(consent.status === 200 && consent.data.consentSatisfied === true, "the guest records consent from the response page");
  const join = await api(`/api/peeps/respond/${tokenA}/join`, { method: "POST", body: {} });
  const inviteToken = join.data.joinUrl.split("token=")[1];
  const lobby = await api(`/api/jam-invites/${inviteToken}`);
  assert(lobby.status === 200, "the join link opens the existing Jam lobby");
  const access = await api(`/api/jams/${booking.jamId}/access`, { method: "POST", body: { invite: inviteToken } });
  assert(access.status === 200 && access.data.media.roomId, "and reaches the Studio room for THIS session");
  const ics = await api(`/api/peeps/respond/${tokenA}/calendar.ics`, { raw: true });
  assert(ics.status === 200 && /text\/calendar/.test(ics.type) && ics.text.includes("BEGIN:VEVENT") && ics.text.includes(`UID:${booking.id}@toasty.media`) && ics.text.includes(`DTSTART:${chosen.replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`), "a calendar-compatible .ics is generated (no external calendar is faked)");

  console.log("\nPhase 9 — reschedule and cancel");
  const reqResched = await api(`/api/peeps/respond/${tokenA}/reschedule`, { method: "POST", body: { reason: "conflict", timezone: "Asia/Bangkok", windows: [{ start: zoned(dayUtc(D + 1, 2), "Asia/Bangkok"), end: zoned(dayUtc(D + 1, 5), "Asia/Bangkok") }] } });
  assert(reqResched.status === 200 && reqResched.data.state === "reschedule_requested", "the guest can request a reschedule with new availability");
  await api(`/api/peeps/requests/${request.id}/availability`, { method: "POST", cookie, body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(D - 1, 20), "America/New_York"), end: zoned(dayUtc(D + 1, 8), "America/New_York") }] } });
  const slots2 = await api(`/api/peeps/introductions/${introA.id}/slots`, { cookie });
  const newSlot = slots2.data.slots.find((s) => Date.parse(s.startsAt) >= dayUtc(D + 1, 2));
  const rebooked = await api(`/api/peeps/introductions/${introA.id}/book`, { method: "POST", cookie, body: { slotStart: newSlot.startsAt } });
  assert(rebooked.status === 200 && rebooked.data.rescheduled === true && rebooked.data.booking.id === booking.id && rebooked.data.booking.sequence === 1, "the organizer rebooks the SAME booking at a new time (no duplicate)");
  assert((await api(`/api/sessions/${booking.studioSessionId}`, { cookie })).data.session.plan.scheduledAt === zoned(Date.parse(newSlot.startsAt), "America/New_York"), "the planner time follows the reschedule");
  assert((await outbox(request.id, cookie)).some((m) => m.purpose === "reschedule" && m.introductionId === introA.id), "the guest is notified of the new time");

  const cancel = await api(`/api/peeps/respond/${tokenA}/cancel`, { method: "POST", body: { reason: "travelling" } });
  assert(cancel.status === 200 && cancel.data.state === "cancelled", "the guest can cancel after booking");
  const afterCancel = await api(`/api/peeps/introductions/${introA.id}`, { cookie });
  assert(afterCancel.data.introduction.status === "cancelled" && afterCancel.data.nextActions.includes("find_replacement"), "the requester sees the cancellation and a replacement option (podcast format)");
  assert((await outbox(request.id, cookie)).some((m) => m.purpose === "organizer_candidate_cancelled"), "the requester is notified of the guest cancelling");
  const cancelBooking = await api(`/api/peeps/bookings/${booking.id}`, { cookie });
  assert(cancelBooking.data.booking.status === "cancelled" && cancelBooking.data.booking.lateCancellation === false, "early cancellation isn't flagged late");

  console.log("\nPhase 10 — podcast replacement: opening context, organizer approval, no new fee");
  const finding = await api(`/api/peeps/introductions/${introA.id}/find-replacement`, { method: "POST", cookie, body: {} });
  assert(finding.status === 200 && finding.data.opening.status === "open" && finding.data.opening.context.purpose.includes("podcast") && finding.data.opening.context.startsAt && finding.data.opening.context.recording === "recorded" && finding.data.opening.context.compensation.amount === 25 && finding.data.opening.context.durationMinutes === 45, "the last-minute opening carries purpose, time, duration, format, recording, compensation");
  assert(finding.data.candidates.length >= 1, "replacement candidates come from prior qualification or fresh discovery");
  const finding2 = await api(`/api/peeps/introductions/${introA.id}/find-replacement`, { method: "POST", cookie, body: {} });
  assert(finding2.data.opening.id === finding.data.opening.id, "opening creation is idempotent");
  const replacement = finding.data.candidates[0];
  const approve = await api(`/api/peeps/openings/${finding.data.opening.id}/approve`, { method: "POST", cookie, body: { candidateId: replacement.id, outreachEmail: "replacement@example.com" } });
  assert(approve.status === 201 && approve.data.introduction.replacesIntroductionId === introA.id && approve.data.paymentRelationship === "preserved_no_new_charge", "the organizer approves a replacement; the original payment relationship is preserved");
  assert((await api(`/api/peeps/openings/${finding.data.opening.id}/approve`, { method: "POST", cookie, body: { candidateId: replacement.id } })).status === 409, "an opening can only be filled once");
  const withOpening = await outbox(request.id, cookie);
  assert(withOpening.some((m) => m.purpose === "opening" && m.introductionId === approve.data.introduction.id && /last-minute opening/i.test(m.testPayload.text)), "the replacement receives opening-specific outreach");

  console.log("\nPhase 11 — decline, no-reply expiry, unreachable, delivery/notification failure");
  // C: latefail => outreach ok, later notifications fail. Decline it.
  const { token: tokenC } = tokenFromOutreach(await outbox(request.id, cookie), introC.id);
  assert(tokenC, "candidate C received outreach");
  const declined = await api(`/api/peeps/respond/${tokenC}/decline`, { method: "POST", body: { reason: "bad_timing", note: "Maybe next quarter" } });
  assert(declined.status === 200 && declined.data.state === "declined", "declining works without an account");
  assert((await api(`/api/peeps/respond/${tokenC}/decline`, { method: "POST", body: {} })).status === 200, "declining twice is idempotent");
  assert((await api(`/api/peeps/respond/${tokenC}/interested`, { method: "POST", body: {} })).status === 409, "a declined introduction can't silently flip back");
  const declinedView = await api(`/api/peeps/introductions/${introC.id}`, { cookie });
  assert(declinedView.data.introduction.status === "declined" && declinedView.data.introduction.declineReason === "bad_timing" && declinedView.data.nextActions.includes("find_replacement"), "the requester sees the decline and can look for a replacement");
  const declineMsg = (await outbox(request.id, cookie)).find((m) => m.purpose === "organizer_decline" && m.introductionId === introC.id);
  assert(declineMsg && /not held against/.test(declineMsg.testPayload.text) && /not been charged again/.test(declineMsg.testPayload.text), "the requester is told the decline is not a negative mark and isn't charged again");
  const declinedDub = db("dub_get", { id: (await db("peeps_intro_get", { id: introC.id })).introduction.dubId });
  assert(declinedDub.dub && !("reputation" in declinedDub.dub), "a decline records evidence about THIS interaction, not a reputation on the Dub");

  const retry = await api(`/api/peeps/introductions/${introB.id}/retry-outreach`, { method: "POST", cookie, body: {} });
  assert(retry.status === 200 && retry.data.introduction.status === "unreachable", "retrying a hard-failing channel stays unreachable");
  await api(`/api/peeps/introductions/${introB.id}/retry-outreach`, { method: "POST", cookie, body: {} });
  assert((await api(`/api/peeps/introductions/${introB.id}/retry-outreach`, { method: "POST", cookie, body: {} })).status === 409, "outreach retries are capped");

  // No-reply expiry: backdate the outreach expiry on the replacement introduction.
  sql("UPDATE peeps_introductions SET outreach_expires_at = ? WHERE id = ?", ["2020-01-01T00:00:00+00:00", approve.data.introduction.id]);
  const expired = await api(`/api/peeps/introductions/${approve.data.introduction.id}`, { cookie });
  assert(expired.data.introduction.status === "expired" && expired.data.nextActions.includes("find_replacement") && expired.data.nextActions.includes("retry_outreach"), "a candidate who never responds becomes 'expired' — the request never spins forever");

  console.log("\nPhase 12 — booking failure modes: planner/Studio failures, notification failure, late cancellation, group time");
  // Fresh request for a clean set of candidates.
  const create2 = await api("/api/peeps/requests", { method: "POST", cookie, body: { whoText: "Fintech payments executives in Southeast Asia", outcomeText: "I want to interview two people for a recorded podcast about offline payments." } });
  const req2 = create2.data.request;
  const c2 = create2.data.candidates;
  // Two in-history dubs now exist (A and C); prefer to authorize brand-new external candidates by name.
  const external = c2.filter((c) => c.source === "demo_directory_provider");
  const auth2 = await payAndAuthorize(req2.id, cookie, [
    { candidateId: external[0].id, outreachEmail: "late-guest@example.com" },
    { candidateId: external[1].id, outreachEmail: "latefail-guest@example.com" }
  ]);
  const [i1, i2] = auth2.data.introductions;
  assert(i1 && i2 && i1.status === "outreach_sent", "second request introductions are authorized and contacted");
  const msgs2 = await outbox(req2.id, cookie);
  const t1 = tokenFromOutreach(msgs2, i1.id).token;
  const t2 = tokenFromOutreach(msgs2, i2.id).token;
  // Session-time helpers: windows starting ~ +2h from now (all UTC) so the booking falls inside 24h.
  const soon = Math.ceil((Date.now() + 2 * HOUR) / (30 * 60000)) * 30 * 60000;
  for (const [token, tz] of [[t1, "Pacific/Kiritimati"], [t2, "Pacific/Kiritimati"]]) {
    await api(`/api/peeps/respond/${token}/interested`, { method: "POST", body: {} });
    const ans = await api(`/api/peeps/respond/${token}/answers`, { method: "POST", body: { recordingPreference: "ok", durationMinutes: 30, compensation: { requirement: "none" }, timezone: tz, windows: [{ start: zoned(soon, tz), end: zoned(soon + 3 * HOUR, tz) }] } });
    assert(ans.status === 200 && ans.data.state === "waiting_for_booking", `guest availability in ${tz} (UTC+14, across the date line) is accepted`);
  }
  await api(`/api/peeps/requests/${req2.id}/availability`, { method: "POST", cookie, body: { timezone: "UTC", windows: [{ start: zoned(soon - HOUR, "UTC"), end: zoned(soon + 4 * HOUR, "UTC") }] } });
  const s1 = await api(`/api/peeps/introductions/${i1.id}/slots`, { cookie });
  assert(s1.data.slots.length >= 1 && s1.data.slots.every((s) => Date.parse(s.startsAt) >= soon && Date.parse(s.endsAt) <= soon + 3 * HOUR), "the intersection is right across a UTC+14 / UTC boundary");
  const failPlanner = await api(`/api/peeps/introductions/${i1.id}/book`, { method: "POST", cookie, body: { slotStart: s1.data.slots[0].startsAt }, headers: { "x-peeps-test-fail": "planner" } });
  assert(failPlanner.status === 201 && failPlanner.data.booking.setup.planner.ok === false && failPlanner.data.readiness.ready === false && failPlanner.data.state === "PREPARING", "a planner failure leaves a visible, non-ready booking — not a hang and not a lost booking");
  const healed = await api(`/api/peeps/bookings/${failPlanner.data.booking.id}`, { cookie });
  assert(healed.data.readiness.ready && healed.data.state === "READY_FOR_SESSION" && healed.data.plan.questions.length >= 3, "the next read heals the planner idempotently and reaches READY_FOR_SESSION");
  const speakers2 = await api(`/api/sessions/${healed.data.booking.studioSessionId}/speakers`, { cookie });
  assert(speakers2.data.speakers.length === 1, "healing didn't duplicate the speaker");
  const groupSlots = await api(`/api/peeps/introductions/${i2.id}/slots`, { cookie });
  assert(groupSlots.data.fixedSessionTime === s1.data.slots[0].startsAt && groupSlots.data.slots.length === 1, "a second guest can only join the Session's already-booked time");
  const b2 = await api(`/api/peeps/introductions/${i2.id}/book`, { method: "POST", cookie, body: {} });
  assert(b2.status === 201 && b2.data.booking.jamId === failPlanner.data.booking.jamId && b2.data.booking.studioSessionId === failPlanner.data.booking.studioSessionId, "the second guest shares ONE Jam and ONE Studio session");
  const planTwo = (await api(`/api/sessions/${b2.data.booking.studioSessionId}`, { cookie })).data.session.plan;
  assert(planTwo.peeps.participants.length === 2 && planTwo.peeps.questions.some((q) => q.forDubId === b2.data.booking.candidateDubId) && planTwo.peeps.questions.some((q) => q.forDubId === healed.data.booking.candidateDubId), "each guest gets their own guest-specific questions in the shared planner");
  const versionBefore2 = (await api(`/api/peeps/bookings/${b2.data.booking.id}`, { cookie })).data.plan.version;
  await Promise.all([healed.data.booking.id, b2.data.booking.id, healed.data.booking.id, b2.data.booking.id].map((bid) => api(`/api/peeps/bookings/${bid}/rebuild`, { method: "POST", cookie, body: {} })));
  const afterRebuilds = await api(`/api/peeps/bookings/${b2.data.booking.id}`, { cookie });
  assert(afterRebuilds.data.plan.version === versionBefore2 && (await api(`/api/sessions/${b2.data.booking.studioSessionId}/speakers`, { cookie })).data.speakers.length === 2, "concurrent rebuilds are true no-ops: no duplicate speakers, no version churn, no second Studio session");
  const confirmFail = (await api(`/api/peeps/bookings/${b2.data.booking.id}`, { cookie }));
  const failedMsg = (await api(`/api/peeps/introductions/${i2.id}`, { cookie })).data.messages.find((m) => m.purpose === "booking_confirmation");
  assert(failedMsg.status === "failed" && confirmFail.data.readiness.ready, "a failed notification is recorded but never blocks the booking");
  const retryMsg = await api(`/api/peeps/messages/${failedMsg.id}/retry`, { method: "POST", cookie, body: {} });
  assert(retryMsg.status === 200 && retryMsg.data.message.attempt >= 2, "the failed notification can be retried");
  const lateCancel = await api(`/api/peeps/bookings/${failPlanner.data.booking.id}/cancel`, { method: "POST", cookie, body: { reason: "schedule change" } });
  assert(lateCancel.status === 200 && lateCancel.data.lateCancellation === true && lateCancel.data.monetaryPenalty === "none_automatic", "cancelling inside the 24h window is flagged late with NO automatic penalty");
  assert(lateCancel.data.next === "find_replacement_or_reschedule", "podcast cancellations offer replacement or reschedule");

  console.log("\nPhase 13 — claimed and unclaimed Dubs, remembered preferences");
  // Claim A's Dub, then a new request should surface A as a claimed member and a decliner as unclaimed.
  const dubA = db("peeps_intro_get", { id: introA.id }).introduction.dubId;
  const claimIssue = await api(`/api/dubs/${dubA}/claim-invite`, { method: "POST", cookie, body: {} });
  const memberUser = await api("/auth/register", { method: "POST", body: { name: "Anong Member", email: "anong-member@example.com", password: "password10chars" } });
  const claimed = await api(`/api/dub-claims/${claimIssue.data.token}/claim`, { method: "POST", cookie: memberUser.cookie });
  assert(claimed.status === 200, "a guest claims their Dub");
  const create3 = await api("/api/peeps/requests", { method: "POST", cookie, body: { whoText: "Fintech payments executives in Southeast Asia offline payments", outcomeText: "I want a recorded podcast guest about offline payments." } });
  const c3 = create3.data.candidates;
  const claimedCand = c3.find((c) => c.source === "internal_claimed_dub");
  const unclaimedCand = c3.find((c) => c.source === "internal_unclaimed_dub");
  assert(claimedCand && claimedCand.reachability === "claimed_member" && unclaimedCand && unclaimedCand.reachability === "unclaimed_dub", "history yields a claimed-member and an unclaimed-Dub candidate");
  const auth3 = await payAndAuthorize(create3.data.request.id, cookie, [{ candidateId: claimedCand.id }, { candidateId: unclaimedCand.id }]);
  assert(unclaimedCand.contactEmail && unclaimedCand.contactEmail.includes("•") && !JSON.stringify(create3.data).includes("latefail-c@example.com") && !JSON.stringify(create3.data).includes("guest-a@example.com"), "candidate lists carry only a masked address, never the raw one");
  assert(auth3.data.introductions.length === 2 && auth3.data.introductions.every((i) => i.status === "outreach_sent"), "both are contacted without the organizer supplying any address");
  const claimedIntro = auth3.data.introductions.find((i) => i.candidateId === claimedCand.id);
  const unclaimedIntro = auth3.data.introductions.find((i) => i.candidateId === unclaimedCand.id);
  const claimedView = await api(`/api/peeps/introductions/${claimedIntro.id}`, { cookie });
  assert(claimedView.data.contact.channels[0].channel === "peeps_member" && claimedView.data.contact.channels[0].source === "peeps_member_account", "a claimed Dub is reached through their Peeps member account");
  const unclaimedView = await api(`/api/peeps/introductions/${unclaimedIntro.id}`, { cookie });
  assert(unclaimedView.data.contact.channels[0].channel === "prior_participation_email" && unclaimedView.data.contact.channels[0].source === "prior_jam_participation", "an unclaimed Dub is reached through their prior-participation address, with that provenance");
  const out3 = await outbox(create3.data.request.id, cookie);
  assert(out3.find((m) => m.introductionId === claimedIntro.id && m.purpose === "outreach").testPayload.to === "anong-member@example.com", "the claimed member's outreach goes to their account address");
  const t3 = tokenFromOutreach(out3, claimedIntro.id).token;
  const remembered = await api(`/api/peeps/respond/${t3}`);
  assert(remembered.data.known.timezone === "Asia/Bangkok" && remembered.data.known.durationMinutes === 45, "what Peeps already learned (timezone, length) is remembered and not asked again");
  const t3i = await api(`/api/peeps/respond/${t3}/interested`, { method: "POST", body: {} });
  assert(!t3i.data.needs.includes("duration"), "the known meeting length isn't re-asked");

  console.log("\nPhase 14 — manual-only public paths are never claimed as automated");
  const manualOrg = await api("/auth/register", { method: "POST", body: { name: "Manual Org", email: "manual-org@example.com", password: "password10chars" } });
  const create4 = await api("/api/peeps/requests", { method: "POST", cookie: manualOrg.cookie, body: { whoText: "Cybersecurity incident response leads", outcomeText: "I want a research interview about incident response." } });
  assert(create4.status === 201, "a request about a different topic is created");
  const c4 = create4.data.candidates.find((c) => c.source === "demo_directory_provider" && c.status === "proposed");
  assert(c4, "the demo directory yields a proposed candidate for the new topic");
  db("peeps_candidate_set_contact_paths", { id: c4.id, contactPaths: [{ type: "linkedin", url: "https://www.linkedin.com/in/example-person", source: "public_profile", confidence: "Medium" }] });
  const auth4 = await payAndAuthorize(create4.data.request.id, manualOrg.cookie, [{ candidateId: c4.id }]);
  const manualIntro = auth4.data.introductions[0];
  assert(manualIntro && manualIntro.status === "unreachable", "a candidate with only a public profile path is unreachable by automation");
  const manualView = await api(`/api/peeps/introductions/${manualIntro.id}`, { cookie: manualOrg.cookie });
  assert(manualView.data.contact.reason === "manual_only" && manualView.data.contact.manualOptions[0].channel === "public_social_profile" && manualView.data.contact.channels[0].automatable === false && manualView.data.messages.filter((m) => m.audience === "candidate").length === 0, "it's exposed as manual-only, and NO message was pretended to be sent");

  console.log("\nSecurity — cross-organization isolation and authorization");
  const outsider = await api("/auth/register", { method: "POST", body: { name: "Eve Outsider", email: "eve-exec@example.com", password: "password10chars" } });
  const eve = outsider.cookie;
  const evilChecks = [
    ["GET", `/api/peeps/introductions/${introA.id}`], ["GET", `/api/peeps/introductions/${introA.id}/slots`], ["POST", `/api/peeps/introductions/${introA.id}/book`],
    ["POST", `/api/peeps/introductions/${introA.id}/retry-outreach`], ["POST", `/api/peeps/introductions/${introA.id}/find-replacement`],
    ["GET", `/api/peeps/bookings/${booking.id}`], ["GET", `/api/peeps/bookings/${booking.id}/prep?role=organizer`], ["POST", `/api/peeps/bookings/${booking.id}/plan`],
    ["POST", `/api/peeps/bookings/${booking.id}/cancel`], ["POST", `/api/peeps/bookings/${booking.id}/rebuild`], ["POST", `/api/peeps/openings/${finding.data.opening.id}/approve`],
    ["POST", `/api/peeps/messages/${failedMsg.id}/retry`], ["POST", `/api/peeps/requests/${request.id}/availability`], ["GET", `/api/peeps/test-outbox?requestId=${request.id}`]
  ];
  for (const [method, path] of evilChecks) {
    const res = await api(path, { method, cookie: eve, body: method === "POST" ? { candidateId: replacement.id } : undefined });
    assert(res.status === 404 || res.status === 403, `a non-member is refused: ${method} ${path.split("?")[0].replace(/\/(pintro|pbk|pop|pmsg|preq)_[a-z0-9]+/gi, "/:id")}`);
  }
  const ownTokenView = await api(`/api/peeps/respond/${t1}`);
  assert(ownTokenView.data.candidateName === external[0].displayName && !JSON.stringify(ownTokenView.data).includes(external[1].displayName), "one token only ever shows ITS OWN introduction");
  const otherBooking = await api(`/api/peeps/respond/${tokenC}/prep`);
  assert(otherBooking.status === 409, "a declined guest's token has no booking/prep to read");

  console.log("\nSecurity — token expiry and revocation");
  sql("UPDATE peeps_response_tokens SET expires_at = ? WHERE token_hash = (SELECT token_hash FROM peeps_response_tokens WHERE introduction_id = ? ORDER BY created_at DESC LIMIT 1)", ["2020-01-01T00:00:00+00:00", claimedIntro.id]);
  const oldTokens = db("peeps_token_get", { tokenHash: "x" });
  void oldTokens;
  const stillValid = await api(`/api/peeps/respond/${t3}`);
  assert(stillValid.status === 410, "an expired response token is 410 Gone");
  const distinct = new Set([tokenA, tokenC, t1, t2, t3]);
  assert(distinct.size === 5, "every introduction gets a distinct token");

  await productionLikeCheck();
  console.log("\nAll Peeps introduction-execution tests passed.");
}

// A deployment with NO real email provider and the test provider OFF (i.e. production before Resend is
// configured) must say so plainly: nothing is sent, nothing is simulated, no test endpoints exist.
async function productionLikeCheck() {
  console.log("\nProduction-like — no provider configured, test adapters off");
  const port = 4218;
  const dir = mkdtempSync(join(tmpdir(), "toasty-peeps-exec-prod-"));
  const path2 = join(dir, "toasty.sqlite");
  const proc = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: { ...process.env, TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", TOASTY_RENDER_PORT: String(port), TOASTY_AUTH_DB: path2, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "peeps-exec-prod-secret", RESEND_API_KEY: "", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "", PEEPS_TEST_ADAPTERS: "" },
    stdio: ["ignore", "ignore", "ignore"]
  });
  const call = async (p, { method = "GET", cookie: ck, body, headers = {} } = {}) => {
    const h = { "x-toasty-csrf": "1", ...headers };
    if (ck) h.cookie = ck;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    let d = {};
    try { d = await r.json(); } catch (_) {}
    return { status: r.status, data: d, cookie: (r.headers.get("set-cookie") || "").split(";")[0] || ck };
  };
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
    const user = await call("/auth/register", { method: "POST", body: { name: "Prod Like", email: "prodlike@example.com", password: "password10chars" } });
    const created = await call("/api/peeps/requests", { method: "POST", cookie: user.cookie, body: { whoText: "Fintech payments executives in Southeast Asia", outcomeText: "I want a recorded podcast guest about offline payments." } });
    const pay = await call("/api/peeps/demo-payments/authorize", { method: "POST", cookie: user.cookie, body: { requestId: created.data.request.id } });
    const authorized = await call(`/api/peeps/requests/${created.data.request.id}/authorize`, {
      method: "POST", cookie: user.cookie,
      headers: { "x-payment-signature": pay.data.paymentSignature, "x-solana-transaction-signature": pay.data.transactionSignature, "x-payment-asset": "USDC", "x-payment-amount": "0.25", "x-payer-wallet": pay.data.payerWallet, "x-approval-source": pay.data.approvalSource },
      body: { candidates: [{ candidateId: created.data.candidates[0].id, outreachEmail: "someone@example.com" }] }
    });
    const intro = authorized.data.introductions[0];
    assert(intro.status === "ready_for_outreach" && !intro.outreachSentAt, "with no provider the introduction waits at ready_for_outreach — nothing is claimed as sent");
    const view = await call(`/api/peeps/introductions/${intro.id}`, { cookie: user.cookie });
    assert(view.data.contact.blocked === "provider_unavailable" && view.data.messages.length === 0 && view.data.adapters.find((a) => a.id === "selected").available === false, "the requester is told outreach isn't going out because no provider is configured");
    assert((await call(`/api/peeps/test-outbox?requestId=${created.data.request.id}`, { cookie: user.cookie })).status === 404, "the test outbox does not exist outside test mode");
  } finally {
    proc.kill();
    rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .then(() => { server.kill(); rmSync(scratchDir, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => {
    console.error(error);
    console.error("\n--- server output ---\n" + serverOutput.slice(-4000));
    server.kill();
    rmSync(scratchDir, { recursive: true, force: true });
    process.exit(1);
  });
