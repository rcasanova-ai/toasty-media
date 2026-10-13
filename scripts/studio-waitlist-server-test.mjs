#!/usr/bin/env node
// Toasty Studio public waitlist, tested end to end against the real server and a throwaway SQLite DB:
// persistent storage, duplicate prevention, explicit consent (recorded with its text version), bot traps,
// rate limits, one-click unsubscribe + re-consent, admin-only visibility, status management and CSV export.
// Email transport is the server's DEV transport (RESEND_API_KEY unset): recorded honestly as "simulated", never "sent".
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4277;
const BASE = `http://127.0.0.1:${PORT}`;
const scratch = mkdtempSync(join(tmpdir(), "toasty-studio-waitlist-"));
const dbPath = join(scratch, "t.sqlite");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
let out = "";
const server = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
  env: { ...process.env, TOASTY_RENDER_PORT: String(PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "studio-waitlist-secret", RESEND_API_KEY: "", TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1" },
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", (c) => (out += c)); server.stderr.on("data", (c) => (out += c));
process.on("exit", () => { try { server.kill("SIGKILL"); } catch (_) {} });

let ipCounter = 10;
async function api(path, { method = "GET", cookie, body, csrf = true, ip = `10.1.1.${ipCounter++}`, origin } = {}) {
  const h = { "x-forwarded-for": ip };
  if (csrf) h["x-toasty-csrf"] = "1";
  if (cookie) h.cookie = cookie;
  if (origin) h.origin = origin;
  if (body !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch (_) { data = { text }; }
  return { status: r.status, data, text, cookie: (r.headers.get("set-cookie") || "").split(";")[0] || cookie, headers: r.headers };
}
const sql = (statement, params = []) => {
  const script = `import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\ncur=c.execute(sys.argv[2], json.loads(sys.argv[3]))\nc.commit()\nprint(json.dumps(cur.fetchall()))`;
  const r = spawnSync("python3", ["-c", script, dbPath, statement, JSON.stringify(params)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim());
};
const good = (over = {}) => ({ name: "Sam Studio", email: "sam@example.com", company: "Sam's Show", interest: "podcast", notes: "Weekly interview show", consent: true, website: "", elapsedMs: 6000, ...over });
const JOIN = "/api/organizations/studio-waitlist";
const ADMIN = "/api/organizations/platform-admin/studio-waitlist";

async function main() {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${BASE}/health`)).ok) break; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); }
  const admin = await api("/auth/register", { method: "POST", body: { name: "Admin", email: "admin-sw@example.com", password: "password10chars" } });
  const ordinary = await api("/auth/register", { method: "POST", body: { name: "Ordinary", email: "ord-sw@example.com", password: "password10chars" } });
  assert((await api("/auth/session", { cookie: admin.cookie })).data.user.isPlatformAdmin === true && (await api("/auth/session", { cookie: ordinary.cookie })).data.user.isPlatformAdmin === false, "an administrator and an ordinary user exist");

  console.log("\nJoining");
  const first = await api(JOIN, { method: "POST", body: good() });
  assert(first.status === 200 && first.data.ok === true, "a valid registration succeeds");
  let rows = sql("SELECT email,name,company,interest,status,consent_version,consent_at,confirmation_email_status FROM studio_waitlist");
  assert(rows.length === 1 && rows[0][0] === "sam@example.com" && rows[0][3] === "podcast" && rows[0][4] === "WAITLISTED", "it is persisted in the database as WAITLISTED");
  assert(rows[0][5] === "studio-waitlist-2026-10-v1" && rows[0][6], "the consent text version and timestamp are recorded");
  assert(rows[0][7] === "simulated", "the confirmation email is recorded honestly as 'simulated' (no email provider configured), not 'sent'");

  console.log("\nDuplicate prevention");
  const dup = await api(JOIN, { method: "POST", body: good({ name: "Sam Again", email: "  SAM@Example.COM " }) });
  assert(dup.status === 200 && sql("SELECT COUNT(*) FROM studio_waitlist")[0][0] === 1, "the same email (any case/spacing) never creates a second row");
  assert(dup.text === first.text, "the response is identical to a first-time signup (does not reveal who is on the list)");

  console.log("\nValidation and consent");
  assert((await api(JOIN, { method: "POST", body: good({ email: "a2@example.com", consent: false }) })).status === 400, "consent is required");
  assert((await api(JOIN, { method: "POST", body: good({ email: "a3@example.com", consent: "yes" }) })).status === 400, "consent must be an explicit true");
  assert((await api(JOIN, { method: "POST", body: good({ email: "not-an-email" }) })).status === 400, "an invalid email is refused");
  assert((await api(JOIN, { method: "POST", body: good({ email: "b@example.com", name: "" }) })).status === 400, "a name is required");
  assert((await api(JOIN, { method: "POST", body: good({ email: "c@example.com", interest: "crypto" }) })).status === 400, "an unknown interest is refused");
  assert((await api(JOIN, { method: "POST", body: good({ email: "d@example.com" }), csrf: false })).status === 403, "requests without the verification header are refused");
  assert((await api(JOIN, { method: "POST", body: good({ email: "e@example.com" }), origin: "https://evil.example" })).status === 403, "requests from other origins are refused");
  assert(sql("SELECT COUNT(*) FROM studio_waitlist")[0][0] === 1, "none of the refused requests stored anything");

  console.log("\nBot traps look like success but store nothing");
  const bot = await api(JOIN, { method: "POST", body: good({ email: "bot@example.com", website: "http://spam.example" }) });
  const fast = await api(JOIN, { method: "POST", body: good({ email: "fast@example.com", elapsedMs: 200 }) });
  assert(bot.status === 200 && fast.status === 200 && sql("SELECT COUNT(*) FROM studio_waitlist WHERE email IN ('bot@example.com','fast@example.com')")[0][0] === 0, "the hidden field and an impossibly fast submit are silently dropped");

  console.log("\nText is stored safely");
  await api(JOIN, { method: "POST", body: good({ email: "xss@example.com", name: "<img src=x onerror=alert(1)>", notes: "=HYPERLINK(\"http://x\")" }), ip: "10.1.0.9" });
  const stored = sql("SELECT name,notes FROM studio_waitlist WHERE email='xss@example.com'")[0];
  assert(stored[0].includes("<img") , "markup is stored as inert text (the admin UI and email escape it)");

  console.log("\nAdmin visibility");
  assert((await api(ADMIN)).status === 401, "the list is not visible without signing in");
  assert([401, 403].includes((await api(ADMIN, { cookie: ordinary.cookie })).status), "an ordinary signed-in user cannot see the list");
  const list = await api(ADMIN, { cookie: admin.cookie });
  assert(list.status === 200 && list.data.total === 2 && list.data.byInterest.podcast === 2 && list.data.byStatus.WAITLISTED === 2, "a platform admin sees totals, interest and status breakdowns");
  const sam = list.data.entries.find((e) => e.email === "sam@example.com");
  assert(sam.company === "Sam's Show" && sam.consentVersion && sam.interestLabel === "Podcasts" && sam.confirmationEmailStatus === "simulated", "each entry shows consent, company, interest and email status");
  const csv = await api(`${ADMIN}?format=csv`, { cookie: admin.cookie });
  assert(csv.status === 200 && /text\/csv/.test(csv.headers.get("content-type")) && csv.text.includes("sam@example.com") && /'=HYPERLINK/.test(csv.text), "CSV export works and neutralises spreadsheet formulas");
  assert((await api(`${ADMIN}?format=csv`, { cookie: ordinary.cookie })).status !== 200, "CSV export is admin-only too");

  console.log("\nStatus management");
  const set = await api(`${ADMIN}/${sam.id}/status`, { method: "POST", cookie: admin.cookie, body: { status: "CONTACTED" } });
  assert(set.status === 200 && sql("SELECT status FROM studio_waitlist WHERE id=?", [sam.id])[0][0] === "CONTACTED", "an admin can mark an entry contacted");
  assert((await api(`${ADMIN}/${sam.id}/status`, { method: "POST", cookie: admin.cookie, body: { status: "BOGUS" } })).status === 400, "an unknown status is refused");
  assert([401, 403].includes((await api(`${ADMIN}/${sam.id}/status`, { method: "POST", cookie: ordinary.cookie, body: { status: "ARCHIVED" } })).status), "an ordinary user cannot change a status");

  console.log("\nUnsubscribe and re-consent");
  const unsubToken = (/unsubscribe\?t=([^"\s&<]+)/.exec(decodeURIComponent(out.replace(/&amp;/g, "&"))) || [])[1];
  assert(Boolean(unsubToken), "the confirmation email carries a signed unsubscribe link");
  assert((await api(`/api/organizations/studio-waitlist/unsubscribe?t=${sam.id}.forged`)).status === 400, "a forged unsubscribe token is refused");
  const unsub = await api(`/api/organizations/studio-waitlist/unsubscribe?t=${encodeURIComponent(unsubToken)}`);
  assert(unsub.status === 200 && sql("SELECT consent_withdrawn_at FROM studio_waitlist WHERE id=?", [sam.id])[0][0], "the unsubscribe link withdraws consent (recorded, row kept)");
  await api(JOIN, { method: "POST", body: good(), ip: "10.1.0.77" });
  const after = sql("SELECT consent_withdrawn_at, (SELECT COUNT(*) FROM studio_waitlist) FROM studio_waitlist WHERE id=?", [sam.id])[0];
  assert(after[0] === null && after[1] === 2, "signing up again re-consents on the SAME row");

  console.log("\nRate limiting");
  let limited = 0;
  for (let i = 0; i < 12; i++) { const r = await api(JOIN, { method: "POST", body: good({ email: `flood${i}@example.com` }), ip: "10.1.0.200" }); if (r.status === 429) limited++; }
  assert(limited > 0, "a burst from one address is rate limited");
  console.log("\nALL PASSED — Studio waitlist: persistent, deduplicated, consented, rate limited and admin-visible.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e.message || e); console.error("--- server ---\n" + out.slice(-2000)); process.exit(1); });
