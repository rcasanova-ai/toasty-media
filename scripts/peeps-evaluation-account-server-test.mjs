#!/usr/bin/env node
// Colosseum evaluation accounts: provisioned by a platform admin only, ordinary and isolated users (backend-enforced),
// reusable demo credit, and the complete journey (request -> demo participant -> booking -> Jam -> End Session ->
// settlement -> receipt) works under an evaluation login. Nothing is fabricated: attendance/consent come from the
// guest's own link, exactly as in the other journey tests.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const scratch = mkdtempSync(join(tmpdir(), "toasty-eval-"));
const dbPath = join(scratch, "db.sqlite");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
function zoned(ms, tz) { const parts = {}; for (const p of new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).formatToParts(new Date(ms))) parts[p.type] = p.value; return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`; }
function dayUtc(d, h) { const t = new Date(Date.now() + d * 86400000); return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), h, 0); }
const child = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], { env: { ...process.env, TOASTY_RENDER_PORT: "4761", TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "eval-secret", RESEND_API_KEY: "", PEEPS_TEST_ADAPTERS: "", TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "" }, stdio: "ignore" });
const base = "http://127.0.0.1:4761";
const call = async (path, { method = "GET", cookie, body } = {}) => { const r = await fetch(base + path, { method, headers: { "x-toasty-csrf": "1", ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); let data = {}; try { data = await r.json(); } catch (_) {} return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
const sql = (statement, params = []) => { const r = spawnSync("python3", ["-c", "import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\ncur=c.execute(sys.argv[2], json.loads(sys.argv[3]))\nc.commit()\nprint(json.dumps(cur.fetchall()))", dbPath, statement, JSON.stringify(params)], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return JSON.parse(r.stdout); };
const login = async (email, password) => { const r = await call("/auth/login", { method: "POST", body: { email, password } }); return r; };
try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
  const admin = await call("/auth/register", { method: "POST", body: { name: "Admin", email: "admin-ev@example.com", password: "password10chars" } });
  sql("UPDATE users SET platform_role = 'platform_admin' WHERE email = ?", ["admin-ev@example.com"]);
  const adminCookie = (await login("admin-ev@example.com", "password10chars")).cookie;
  const regular = await call("/auth/register", { method: "POST", body: { name: "Regular", email: "regular-ev@example.com", password: "password10chars" } });

  console.log("Provisioning is admin-only");
  assert((await call("/api/organizations/platform-admin/peeps-evaluation-accounts", { method: "POST", cookie: regular.cookie, body: { count: 1 } })).status === 403, "a regular user cannot create evaluation accounts");
  assert((await call("/api/organizations/platform-admin/peeps-evaluation-accounts", { method: "POST", body: { count: 1 } })).status === 401, "an anonymous caller cannot either");
  const made = await call("/api/organizations/platform-admin/peeps-evaluation-accounts", { method: "POST", cookie: adminCookie, body: { count: 2 } });
  assert(made.status === 200 && made.data.accounts.length === 2 && made.data.accounts[0].email === "colosseum@toasty.media" && made.data.accounts[1].email === "colosseum2@toasty.media", "an admin creates colosseum@ and colosseum2@toasty.media");
  const [one, two] = made.data.accounts;
  assert(one.status === "created" && one.password.length >= 20 && two.password.length >= 20 && one.password !== two.password, "each gets its own generated password (returned once)");
  const list = await call("/api/organizations/platform-admin/peeps-evaluation-accounts", { cookie: adminCookie });
  assert(list.data.accounts.length === 2 && !JSON.stringify(list.data).includes(one.password), "listing never contains passwords");
  assert(!sql("SELECT password_hash FROM users WHERE email = ?", [one.email])[0][0].includes(one.password), "the password is stored only as a hash");
  const again = await call("/api/organizations/platform-admin/peeps-evaluation-accounts", { method: "POST", cookie: adminCookie, body: { count: 2 } });
  assert(again.data.accounts.every((a) => a.status === "exists" && a.password === null), "re-running does not touch existing accounts or reveal anything");

  console.log("\nAn ordinary, isolated user (permissions enforced by the backend)");
  const e1 = await login(one.email, one.password); const e2 = await login(two.email, two.password);
  assert(e1.status === 200 && e2.status === 200, "both evaluation accounts sign in through normal authentication");
  const sess = (await call("/auth/session", { cookie: e1.cookie })).data;
  assert(sess.peepsAccess === "active" && sess.peepsEvaluation === true && !sess.user.isPlatformAdmin, "Peeps access is active, flagged as evaluation, and NOT a platform admin");
  assert((await call("/auth/session", { cookie: regular.cookie })).data.peepsEvaluation === false, "regular users are not flagged (no competition onboarding for them)");
  for (const path of ["/api/organizations/platform-admin/peeps-waitlist", "/api/organizations/platform-admin/organizations", "/api/organizations/platform-admin/peeps-evaluation-accounts"]) assert((await call(path, { cookie: e1.cookie })).status === 403, `admin endpoint ${path.split("/").pop()} is 403`);
  assert((await call("/api/peeps/josip-roast", { method: "POST", cookie: e1.cookie, body: { pitch: "x".repeat(60) } })).status === 403, "the private pitch roast is admin-only on the server");
  const regReq = await call("/api/peeps/requests", { method: "POST", cookie: regular.cookie, body: { whoText: "Fintech payment executives", outcomeText: "I want a recorded podcast guest about offline payments." } });
  assert([403, 404].includes((await call(`/api/peeps/requests/${regReq.data.request?.id || "x"}`, { cookie: e1.cookie })).status), "another user's request is not readable");

  console.log("\nReusable demo credit");
  let d = (await call("/api/peeps/dough", { cookie: e1.cookie })).data;
  assert(d.account.spendBalance === 5 && d.entries.some((e) => e.kind === "demo_credit"), "the evaluation account already holds the $5 demo credit at first login, labelled demo_credit");
  assert(d.demoCredit.available === false, "no claim needed while the balance is healthy");
  assert((await call("/api/peeps/dough/demo-credit", { method: "POST", cookie: e1.cookie, body: {} })).data.alreadyClaimed === true, "no top-up while the balance is healthy");
  const uid = sql("SELECT id FROM users WHERE email = ?", [one.email])[0][0];
  sql("UPDATE dough_accounts SET spend_balance = 0.5 WHERE subject_type = 'user' AND subject_id = ?", [uid]);
  d = (await call("/api/peeps/dough", { cookie: e1.cookie })).data;
  assert(d.demoCredit.available === true && d.demoCredit.amount === 4.5, "when the balance runs low the account can top back up");
  const c = await call("/api/peeps/dough/demo-credit", { method: "POST", cookie: e1.cookie, body: {} });
  assert(c.data.account.spendBalance === 5, "top-up restores the demo amount, never more");

  console.log("\nThe full journey under the evaluation login");
  const cookie = e1.cookie;
  const created = await call("/api/peeps/requests", { method: "POST", cookie, body: { whoText: "Fintech/payment executives in Southeast Asia who understand offline payments", outcomeText: "I want 1 person for a recorded podcast about offline payments." } });
  const rid = created.data.request.id;
  const demo = created.data.candidates.filter((x) => x.reachability === "demo_participant");
  const auth = await call(`/api/peeps/requests/${rid}/authorize`, { method: "POST", cookie, body: { candidates: [{ candidateId: demo[0].id }], compensationAmount: 2 } });
  assert(auth.status === 200 && auth.data.introductions.length === 1, "introduction authorized for a demo participant");
  const intro = auth.data.introductions[0];
  const url = (await call(`/api/peeps/introductions/${intro.id}`, { cookie })).data.contact.demoGuestUrl;
  const token = new URL(url).searchParams.get("token");
  await call(`/api/peeps/respond/${token}/interested`, { method: "POST", body: {} });
  await call(`/api/peeps/respond/${token}/answers`, { method: "POST", body: { recordingPreference: "ok", durationMinutes: 45, timezone: "Asia/Bangkok", windows: [{ start: zoned(dayUtc(9, 2), "Asia/Bangkok"), end: zoned(dayUtc(9, 5), "Asia/Bangkok") }] } });
  await call(`/api/peeps/requests/${rid}/availability`, { method: "POST", cookie, body: { timezone: "America/New_York", windows: [{ start: zoned(dayUtc(8, 20), "America/New_York"), end: zoned(dayUtc(9, 8), "America/New_York") }] } });
  const booked = await call(`/api/peeps/introductions/${intro.id}/book`, { method: "POST", cookie, body: {} });
  assert(booked.status === 201, "booked: Jam + Studio session");
  assert((await call(`/api/peeps/respond/${token}/consent`, { method: "POST", body: { acceptances: ["terms_of_service", "recording"] } })).status === 200, "the guest gives consent through their own link");
  const joinRes = await call(`/api/peeps/respond/${token}/join`, { method: "POST", body: {} });
  assert((await call(`/api/jams/${auth.data.jamId}/events`, { method: "POST", body: { invite: joinRes.data.joinUrl.split("token=")[1], type: "participant.joined" } })).status === 201, "the participant's own join event records attendance");
  const ended = await call(`/api/sessions/${booked.data.booking.studioSessionId}/end`, { method: "POST", cookie, body: {} });
  assert(ended.data.session.peepsRequestId === rid && ended.data.session.postJam?.completed === true, "End Session runs the post-Jam workflow");
  assert((await call(`/api/peeps/requests/${rid}/settle`, { method: "POST", cookie, body: {} })).data.settlements[0].status === "settled_to_dough", "Dough settlement completes");
  const receipt = (await call(`/api/peeps/requests/${rid}/receipt`, { cookie })).data;
  const checks = Object.fromEntries(receipt.checks.map((x) => [x.key, x.state]));
  assert(checks.interaction === "done" && checks.consent === "done" && checks.attendance === "done" && checks.payment === "done" && checks.settlement === "done", "the receipt shows interaction, consent, attendance, payment and settlement from real events");
  assert(receipt.dough.fundingSources.demoFunded && receipt.dough.onchain === false && receipt.solana.events[0].signature === null && !JSON.stringify(receipt).includes("onchain_verified"), "demo credit and off-chain Dough are labelled; nothing claims an on-chain verification");

  console.log("\nIsolation between evaluation accounts");
  assert([403, 404].includes((await call(`/api/peeps/requests/${rid}`, { cookie: e2.cookie })).status), "colosseum2 cannot read colosseum's request");
  assert((await call(`/api/peeps/requests/${rid}/receipt`, { cookie: e2.cookie })).status !== 200, "…or its receipt");

  console.log("\nPassword reset");
  const reset = await call("/api/organizations/platform-admin/peeps-evaluation-accounts", { method: "POST", cookie: adminCookie, body: { count: 1, reset: true } });
  assert(reset.data.accounts[0].status === "password_reset" && reset.data.accounts[0].password !== one.password, "an admin can reset an evaluation password");
  assert((await login(one.email, one.password)).status === 401 && (await login(one.email, reset.data.accounts[0].password)).status === 200, "the old password stops working, the new one works");
  sql("INSERT INTO users (id, name, email, password_hash, created_at, updated_at, status) VALUES ('squat', 'Real Person', 'colosseum3@toasty.media', 'x', datetime('now'), datetime('now'), 'active')");
  const clash = await call("/api/organizations/platform-admin/peeps-evaluation-accounts", { method: "POST", cookie: adminCookie, body: { count: 3, reset: true } });
  assert(clash.data.accounts[2].status === "refused", "a real account that happens to use an evaluation address is never converted or reset");

  console.log("\nIntroduction banner (client)");
  const gate = readFileSync(resolve(ROOT, "js/peeps-app-gate.js"), "utf8");
  for (const text of ["Welcome to Toasty Peeps", "connects people through AI agents that discover expertise", "Your Dub helps you find the right people", "How it works", "Dismiss"]) assert(gate.includes(text), `banner contains "${text}"`);
  assert(/result\.evaluation\) renderEvaluationIntro/.test(gate) && gate.includes("peepsEvaluation === true"), "the banner is rendered only when the server flags an evaluation session");
  const idx = readFileSync(resolve(ROOT, "peeps/app/index.html"), "utf8");
  assert(!/Judges? Golden Path|Judge path|golden-path/i.test(idx) && !/golden-path|Judge path/i.test(readFileSync(resolve(ROOT, "peeps/app/roast.html"), "utf8")), "no judge-specific navigation in the app");
  assert(!existsSync(resolve(ROOT, "peeps/app/golden-path.html")), "the separate walkthrough screen is gone");
  assert(!existsSync(resolve(ROOT, "js/peeps-golden-path-page.js")), "its controller is removed");
  const outcome = readFileSync(resolve(ROOT, "js/peeps-outcome-page.js"), "utf8");
  assert(outcome.includes("receiptCard(receipt)") && outcome.includes("zecCard"), "the receipt (rails labelled) lives in the regular request outcome page");
  assert(readFileSync(resolve(ROOT, "js/peeps-introduction-page.js"), "utf8").includes("Open the demo guest link"), "the regular introduction page offers the demo guest link");
  console.log("\nPASS");
} finally { child.kill(); }
