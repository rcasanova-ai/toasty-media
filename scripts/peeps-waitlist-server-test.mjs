#!/usr/bin/env node
// End-to-end test for the Peeps public waitlist against the real production server and a throwaway SQLite DB:
//   join -> record saved -> confirmation email triggered -> visitor stays waitlisted (cannot log in, no account)
//   -> admin sees it -> admin invites -> invitee accepts -> account ACTIVE -> can log in and use Peeps
// plus duplicates, bad/expired/used invitations, rate limits, bot traps, suspension, unsubscribe, closed-beta
// mode and unauthorized access. Email transport here is the server's DEV transport (RESEND_API_KEY unset): it
// logs instead of delivering, and the server records that honestly as "simulated" — never "sent". REAL
// delivery cannot be proven by a test; it is verified separately against production with a real inbox.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const scratch = mkdtempSync(join(tmpdir(), "toasty-waitlist-"));
const servers = [];
const outputs = new Map();

function assert(ok, message) { if (!ok) throw new Error(`FAILED: ${message}`); console.log(`  ok — ${message}`); }

function startServer(port, extraEnv = {}) {
  const dbPath = join(scratch, `db-${port}.sqlite`);
  const child = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: { ...process.env, TOASTY_RENDER_PORT: String(port), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "waitlist-test-secret", RESEND_API_KEY: "",
      TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", PEEPS_BETA_REQUIRE_INVITE: "", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "", SVM_KEYPAIR_PATH: "", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"]
  });
  outputs.set(port, "");
  child.stdout.on("data", (c) => outputs.set(port, outputs.get(port) + c));
  child.stderr.on("data", (c) => outputs.set(port, outputs.get(port) + c));
  servers.push(child);
  return { port, dbPath, base: `http://127.0.0.1:${port}` };
}
async function waitFor(base) {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server never came up");
}
function client(srv) {
  const api = async (path, { method = "GET", cookie, body, headers = {}, csrf = true, ip = "10.0.0.1" } = {}) => {
    const h = { "x-forwarded-for": ip, ...headers };
    if (csrf) h["x-toasty-csrf"] = "1";
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h["Content-Type"] = "application/json";
    const r = await fetch(`${srv.base}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let data = {}; try { data = JSON.parse(text); } catch (_) { data = { text }; }
    return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] || cookie };
  };
  const sql = (statement, params = []) => {
    const script = `import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\ncur=c.execute(sys.argv[2], json.loads(sys.argv[3]))\nc.commit()\nprint(json.dumps(cur.fetchall()))`;
    const r = spawnSync("python3", ["-c", script, srv.dbPath, statement, JSON.stringify(params)], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
    return JSON.parse(r.stdout.trim());
  };
  return { api, sql, out: () => outputs.get(srv.port) };
}

const good = (over = {}) => ({ name: "Wanda Waitlist", email: "wanda@example.com", country: "Thailand", city: "Bangkok", interest: "community_services", description: "Local volunteer groups", consent: true, website: "", elapsedMs: 5000, ...over });

async function main() {
  const srv = startServer(4234);
  await waitFor(srv.base);
  const { api, sql, out } = client(srv);
  const waitlist = "/api/peeps/waitlist";
  const adminList = "/api/organizations/platform-admin/peeps-waitlist";

  // The very first account on a fresh DB is the platform admin (existing platform behaviour).
  const admin = await api("/auth/register", { method: "POST", body: { name: "Platform Admin", email: "admin-wl@example.com", password: "password10chars" } });
  assert(admin.status === 201, "an administrator account exists");
  const adminCookie = admin.cookie;
  const ordinary = await api("/auth/register", { method: "POST", body: { name: "Ordinary User", email: "ordinary-wl@example.com", password: "password10chars" } });
  assert((await api("/auth/session", { cookie: ordinary.cookie })).data.user.isPlatformAdmin === false, "a second account is an ordinary user");

  console.log("\nVisitor joins");
  const join = await api(waitlist, { method: "POST", body: good(), ip: "10.0.1.1" });
  assert(join.status === 200 && join.data.ok === true, "valid registration succeeds");
  const row = sql("SELECT email, name, country, city, interest, status, consent_version, consent_at, confirmation_email_status FROM peeps_waitlist");
  assert(row.length === 1 && row[0][0] === "wanda@example.com" && row[0][5] === "WAITLISTED" && row[0][4] === "community_services", "record persisted as WAITLISTED with the chosen interest");
  assert(row[0][6] === "peeps-waitlist-2026-10-v1" && Boolean(row[0][7]), "consent timestamp and consent-text version are recorded");
  assert(row[0][8] === "simulated" && /\[Toasty Email:DEV\] to=wanda@example.com subject="You're on the Toasty Peeps waitlist"/.test(out()), "a confirmation email was triggered and is recorded as SIMULATED (dev transport), not sent");
  assert(/not have access yet|don't have access yet/i.test(out()) && /unsubscribe/i.test(out()), "the email says they don't have access yet and has an unsubscribe link");
  assert(sql("SELECT COUNT(*) FROM users WHERE email = 'wanda@example.com'")[0][0] === 0, "joining created NO account");
  const loginTry = await api("/auth/login", { method: "POST", body: { email: "wanda@example.com", password: "anything-at-all" }, ip: "10.0.1.2" });
  assert(loginTry.status === 401, "the waitlisted visitor cannot log in");

  console.log("\nValidation, duplicates and bot protection");
  const before = out();
  const dup = await api(waitlist, { method: "POST", body: good({ email: "  WANDA@Example.COM ", name: "Someone Else" }), ip: "10.0.1.3" });
  assert(dup.status === 200 && JSON.stringify(dup.data) === JSON.stringify(join.data), "a duplicate (different case/whitespace) gets the identical response — no enumeration");
  assert(sql("SELECT COUNT(*) FROM peeps_waitlist")[0][0] === 1 && sql("SELECT name FROM peeps_waitlist")[0][0] === "Wanda Waitlist", "no second row; the original record is untouched");
  assert(out().length === before.length || !/to=wanda@example.com/.test(out().slice(before.length)), "a duplicate does not send another email");
  let ipn = 0;
  for (const [label, body] of [["missing name", good({ name: "" })], ["bad email", good({ email: "not-an-email" })], ["email with injected recipient", good({ email: "a@b.com,c@d.com" })], ["missing interest", good({ interest: "" })], ["unknown interest", good({ interest: "hacking" })], ["no consent", good({ consent: false })], ["consent as string", good({ consent: "true" })]]) {
    const r = await api(waitlist, { method: "POST", body: { ...body, email: body.email === good().email ? "valid1@example.com" : body.email }, ip: `10.0.2.${++ipn}` });
    assert(r.status === 400, `${label} is rejected (400)`);
  }
  assert(sql("SELECT COUNT(*) FROM peeps_waitlist")[0][0] === 1, "no rejected submission was stored");
  const trap = await api(waitlist, { method: "POST", body: good({ email: "bot1@example.com", website: "http://spam.example" }), ip: "10.0.3.1" });
  const fast = await api(waitlist, { method: "POST", body: good({ email: "bot2@example.com", elapsedMs: 100 }), ip: "10.0.3.2" });
  assert(trap.status === 200 && fast.status === 200 && sql("SELECT COUNT(*) FROM peeps_waitlist WHERE email LIKE 'bot%'")[0][0] === 0, "honeypot and impossibly-fast submissions look successful but store nothing");
  assert((await api(waitlist, { method: "POST", body: good({ email: "nocsrf@example.com" }), csrf: false, ip: "10.0.3.3" })).status === 403, "a request without the CSRF header is refused");
  assert((await api(waitlist, { method: "POST", body: good({ email: "origin@example.com" }), headers: { origin: "https://evil.example" }, ip: "10.0.3.4" })).status === 403, "a request from a disallowed origin is refused");
  const long = await api(waitlist, { method: "POST", body: good({ email: "long@example.com", description: "x".repeat(5000), city: "y".repeat(500) }), ip: "10.0.3.5" });
  assert(long.status === 200 && sql("SELECT length(description), length(city) FROM peeps_waitlist WHERE email='long@example.com'")[0].join() === "1000,80", "over-long free text is truncated server-side");
  await api(waitlist, { method: "POST", body: good({ email: "html@example.com", name: "<script>alert(1)</script>" }), ip: "10.0.3.6" });
  const sec = await api("/auth/session", { cookie: adminCookie });
  assert(sec.data.peepsAccess === "active", "platform admins always have Peeps access");
  assert(sql("SELECT COUNT(*) FROM peeps_waitlist")[0][0] === 3, "three legitimate registrations exist");

  console.log("\nRate limiting");
  let limited = 0;
  for (let i = 0; i < 30; i++) { if ((await api(waitlist, { method: "POST", body: good({ email: `rl${i}@example.com` }), ip: "10.0.9.9" })).status === 429) limited++; }
  assert(limited > 0, `one IP is rate limited (${limited} of 30 refused with 429)`);
  assert(sql("SELECT COUNT(*) FROM peeps_waitlist WHERE email LIKE 'rl%'")[0][0] <= 6, "the limiter stopped the flood from filling the list");

  console.log("\nPrivacy: nothing public, nothing for ordinary users");
  assert((await api(waitlist, { ip: "10.0.4.1" })).status !== 200, "there is no public listing endpoint");
  assert((await api(adminList, { csrf: false })).status === 401, "the admin list requires a session");
  assert((await api(adminList, { cookie: ordinary.cookie })).status === 403, "an ordinary signed-in user cannot read the waitlist");
  const wl0 = sql("SELECT id FROM peeps_waitlist WHERE email='wanda@example.com'")[0][0];
  assert((await api(`${adminList}/${wl0}/invite`, { method: "POST", cookie: ordinary.cookie, body: {} })).status === 403, "an ordinary user cannot invite");
  assert((await api(`${adminList}/${wl0}/invite`, { method: "POST", cookie: adminCookie, body: {}, csrf: false })).status === 403, "admin writes still require CSRF");

  console.log("\nAdmin sees the registration");
  const total = sql("SELECT COUNT(*) FROM peeps_waitlist")[0][0];
  const list = (await api(adminList, { cookie: adminCookie })).data;
  const entry = list.entries.find((e) => e.email === "wanda@example.com");
  assert(list.total === total && entry && entry.status === "WAITLISTED" && entry.interestLabel === "Community Services" && entry.country === "Thailand" && entry.invite === null, "the admin sees the entry with interest, country, status and no invitation");
  assert(list.byInterest.community_services === total && list.byCountry.thailand === total && list.byStatus.WAITLISTED === total, "totals by interest, country and status are right");
  assert(list.emailTransport === "dev_not_delivered" && entry.confirmationEmailStatus === "simulated", "the admin is told email isn't really being delivered");

  console.log("\nAdmin invites; invitee accepts; account becomes ACTIVE");
  const invited = await api(`${adminList}/${wl0}/invite`, { method: "POST", cookie: adminCookie, body: {} });
  assert(invited.status === 200 && invited.data.entry.status === "INVITED" && invited.data.emailDelivery === "simulated" && /\/peeps\/join\/\?token=/.test(invited.data.inviteUrl), "invite creates an INVITED entry; delivery honestly 'simulated' and the link is handed to the admin");
  const token = invited.data.inviteUrl.split("token=")[1];
  assert(token.length >= 40 && sql("SELECT COUNT(*) FROM peeps_waitlist_invites WHERE token_hash = ?", [token])[0][0] === 0, "the token is long and only its hash is stored");
  assert(sql("SELECT COUNT(*) FROM users WHERE email='wanda@example.com'")[0][0] === 0, "still no account — an invitation alone grants nothing");
  const info = await api(`${waitlist}/invite/${token}`, { ip: "10.0.5.1" });
  assert(info.status === 200 && info.data.state === "valid" && info.data.email === "w****@example.com" && !JSON.stringify(info.data).includes("wanda@"), "the invitation page sees only a masked email");
  assert((await api(`${waitlist}/invite/${"A".repeat(43)}`, { ip: "10.0.5.2" })).status === 404, "an invalid token is 404");
  assert((await api(`${waitlist}/invite/${"A".repeat(43)}/accept`, { method: "POST", body: { password: "password10chars" }, ip: "10.0.5.3" })).status === 404, "accepting an invalid token is 404");
  assert((await api(`${waitlist}/invite/${token}/accept`, { method: "POST", body: { password: "short" }, ip: "10.0.5.4" })).status === 400, "a short password is refused");
  assert((await api(`${waitlist}/invite/${token}`, { ip: "10.0.5.5" })).data.state === "valid", "…and a refused attempt did not consume the invitation");
  const [a1, a2] = await Promise.all([1, 2].map((i) => api(`${waitlist}/invite/${token}/accept`, { method: "POST", body: { password: "password10chars" }, ip: `10.0.6.${i}` })));
  assert([a1.status, a2.status].sort().join() === "201,410", "two simultaneous accepts: exactly one wins, the other gets 410 (single use)");
  const win = a1.status === 201 ? a1 : a2;
  assert(win.data.authenticated === true && win.cookie, "the winner is signed in");
  assert(sql("SELECT status, user_id IS NOT NULL, activated_at IS NOT NULL FROM peeps_waitlist WHERE id=?", [wl0])[0].join() === "ACTIVE,1,1", "the entry is ACTIVE and linked to the new account");
  assert(sql("SELECT COUNT(*) FROM users WHERE email='wanda@example.com'")[0][0] === 1 && sql("SELECT COUNT(*) FROM organizations o JOIN memberships m ON m.organization_id=o.id JOIN users u ON u.id=m.user_id WHERE u.email='wanda@example.com'")[0][0] === 1, "exactly one account and one organization were created");
  assert((await api(`${waitlist}/invite/${token}/accept`, { method: "POST", body: { password: "password10chars" }, ip: "10.0.6.9" })).status === 410, "reusing the token later is refused");
  const login = await api("/auth/login", { method: "POST", body: { email: "wanda@example.com", password: "password10chars" }, ip: "10.0.7.1" });
  assert(login.status === 200 && login.data.authenticated, "the invited user can now log in with their password");
  assert((await api("/auth/session", { cookie: login.cookie })).data.peepsAccess === "active" && (await api("/api/peeps/dough", { cookie: login.cookie })).status === 200, "and can use Peeps");

  console.log("\nWaitlisted/invited accounts are blocked from the private beta");
  const eve = await api("/auth/register", { method: "POST", body: { name: "Eve Early", email: "eve-early@example.com", password: "password10chars" }, ip: "10.0.8.1" });
  assert((await api("/auth/session", { cookie: eve.cookie })).data.peepsAccess === "active", "an account that never joined the waitlist keeps existing access (closed-beta mode is off)");
  await api(waitlist, { method: "POST", body: good({ email: "eve-early@example.com", name: "Eve Early" }), ip: "10.0.8.2" });
  const gated = await api("/api/peeps/dough", { cookie: eve.cookie });
  assert(gated.status === 403 && gated.data.code === "peeps_beta_inactive", "an existing account whose email is WAITLISTED is refused by the Peeps API (403)");
  assert((await api("/api/peeps/requests", { cookie: eve.cookie })).status === 403 && (await api("/auth/session", { cookie: eve.cookie })).data.peepsAccess === "blocked", "…on every Peeps route, and /auth/session reports blocked so the app gate redirects");
  const eveId = sql("SELECT id FROM peeps_waitlist WHERE email='eve-early@example.com'")[0][0];
  assert((await api(`${adminList}/${eveId}/activate`, { method: "POST", cookie: adminCookie, body: {} })).status === 409, "admin can't 'activate' someone with no linked account");
  const eveInv = await api(`${adminList}/${eveId}/invite`, { method: "POST", cookie: adminCookie, body: {} });
  assert((await api("/api/peeps/dough", { cookie: eve.cookie })).status === 403, "INVITED is still blocked");
  const eveAccept = await api(`${waitlist}/invite/${eveInv.data.inviteUrl.split("token=")[1]}/accept`, { method: "POST", body: {}, ip: "10.0.8.3" });
  assert(eveAccept.status === 200 && eveAccept.data.existingAccount === true && eveAccept.data.authenticated === false, "accepting with an existing account links it (no duplicate, no password bypass, not signed in by the token)");
  assert(sql("SELECT COUNT(*) FROM users WHERE email='eve-early@example.com'")[0][0] === 1, "no duplicate account");
  assert((await api("/api/peeps/dough", { cookie: eve.cookie })).status === 200, "after acceptance the existing account has access");

  console.log("\nSuspend / reinstate");
  assert((await api(`${adminList}/${wl0}/suspend`, { method: "POST", cookie: adminCookie, body: {} })).data.entry.status === "SUSPENDED", "admin suspends an active user");
  assert((await api("/api/peeps/dough", { cookie: login.cookie })).status === 403, "the suspended user is immediately locked out of Peeps");
  assert((await api(`${adminList}/${wl0}/invite`, { method: "POST", cookie: adminCookie, body: {} })).status === 409, "a suspended user can't simply be re-invited");
  assert((await api(`${adminList}/${wl0}/activate`, { method: "POST", cookie: adminCookie, body: {} })).data.entry.status === "ACTIVE" && (await api("/api/peeps/dough", { cookie: login.cookie })).status === 200, "admin reinstates them and access returns");

  console.log("\nExpired and revoked invitations");
  await api(waitlist, { method: "POST", body: good({ email: "late@example.com", name: "Lena Late" }), ip: "10.0.10.1" });
  const lateId = sql("SELECT id FROM peeps_waitlist WHERE email='late@example.com'")[0][0];
  const lateInv = await api(`${adminList}/${lateId}/invite`, { method: "POST", cookie: adminCookie, body: {} });
  const lateToken = lateInv.data.inviteUrl.split("token=")[1];
  sql("UPDATE peeps_waitlist_invites SET expires_at = '2020-01-01T00:00:00.000Z' WHERE waitlist_id = ?", [lateId]);
  const exp = await api(`${waitlist}/invite/${lateToken}`, { ip: "10.0.10.2" });
  assert(exp.status === 410 && exp.data.state === "expired", "an expired invitation is refused (410, expired)");
  assert((await api(`${waitlist}/invite/${lateToken}/accept`, { method: "POST", body: { password: "password10chars" }, ip: "10.0.10.3" })).status === 410 && sql("SELECT COUNT(*) FROM users WHERE email='late@example.com'")[0][0] === 0, "accepting an expired invitation creates nothing");
  const reinv = await api(`${adminList}/${lateId}/invite`, { method: "POST", cookie: adminCookie, body: {} });
  assert(reinv.status === 200 && (await api(`${waitlist}/invite/${reinv.data.inviteUrl.split("token=")[1]}`, { ip: "10.0.10.4" })).data.state === "valid", "admin can issue a fresh invitation");
  assert((await api(`${adminList}/${lateId}/suspend`, { method: "POST", cookie: adminCookie, body: {} })).status === 200 && (await api(`${waitlist}/invite/${reinv.data.inviteUrl.split("token=")[1]}/accept`, { method: "POST", body: { password: "password10chars" }, ip: "10.0.10.5" })).status === 410, "suspending revokes the open invitation");

  console.log("\nConsent withdrawal (no unsolicited email)");
  await api(waitlist, { method: "POST", body: good({ email: "unsub@example.com", name: "Una Sub" }), ip: "10.0.11.1" });
  const unsubId = sql("SELECT id FROM peeps_waitlist WHERE email='unsub@example.com'")[0][0];
  const mail = out().split("to=unsub@example.com")[1] || "";
  const unsubUrl = (mail.match(/unsubscribe\?t=([^"]+)"/) || [])[1];
  assert(Boolean(unsubUrl), "the confirmation email carries a personal unsubscribe link");
  assert((await api(`${waitlist}/unsubscribe?t=${unsubId}.forged`, { ip: "10.0.11.2" })).status === 400, "a forged unsubscribe link is refused");
  const un = await api(`${waitlist}/unsubscribe?t=${decodeURIComponent(unsubUrl)}`, { ip: "10.0.11.3" });
  assert(un.status === 200 && sql("SELECT consent_withdrawn_at IS NOT NULL FROM peeps_waitlist WHERE id=?", [unsubId])[0][0] === 1, "unsubscribing records the withdrawal");
  assert((await api(`${adminList}/${unsubId}/invite`, { method: "POST", cookie: adminCookie, body: {} })).status === 409, "an admin can't invite someone who withdrew consent");

  console.log("\nClosed-beta mode (PEEPS_BETA_REQUIRE_INVITE=1)");
  const closed = startServer(4235, { PEEPS_BETA_REQUIRE_INVITE: "1" });
  await waitFor(closed.base);
  const c2 = client(closed);
  const a2c = await c2.api("/auth/register", { method: "POST", body: { name: "Admin Two", email: "admin2@example.com", password: "password10chars" } });
  const rando = await c2.api("/auth/register", { method: "POST", body: { name: "Random Person", email: "random@example.com", password: "password10chars" } });
  assert((await c2.api("/api/peeps/dough", { cookie: a2c.cookie })).status === 200, "the admin still has access");
  assert((await c2.api("/api/peeps/dough", { cookie: rando.cookie })).status === 403 && (await c2.api("/auth/session", { cookie: rando.cookie })).data.peepsAccess === "blocked", "an account that was never invited is refused");

  console.log("\nAll Peeps waitlist tests passed.");
}

main()
  .then(() => { servers.forEach((s) => s.kill()); rmSync(scratch, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => { console.error(error.message || error); for (const [p, o] of outputs) console.error(`--- server ${p} ---\n${o.slice(-1500)}`); servers.forEach((s) => s.kill()); rmSync(scratch, { recursive: true, force: true }); process.exit(1); });
