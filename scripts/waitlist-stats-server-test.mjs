#!/usr/bin/env node
// Server test for the Santati waitlist-stats endpoint (server-to-server, bearer token) against the real production
// server and a throwaway SQLite DB. Proves: disabled without a token, 403 without/with a wrong token, exact counts that
// match the underlying rows (duplicates, honeypot and too-fast submissions are never persisted so never counted),
// 7d/30d windows, pagination, and that a browser session cookie cannot read it.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const scratch = mkdtempSync(join(tmpdir(), "toasty-wl-stats-"));
const servers = [];
const outputs = new Map();
const TOKEN = "t".repeat(40);

function assert(ok, message) { if (!ok) throw new Error(`FAILED: ${message}`); console.log(`  ok — ${message}`); }
function startServer(port, extraEnv = {}) {
  const dbPath = join(scratch, `db-${port}.sqlite`);
  const child = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], {
    env: { ...process.env, TOASTY_RENDER_PORT: String(port), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "wl-stats-test-secret", RESEND_API_KEY: "",
      SANTATI_WAITLIST_PING_URL: "http://127.0.0.1:9/never", TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "", SVM_KEYPAIR_PATH: "", ...extraEnv },
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
async function call(srv, path, { method = "GET", body, headers = {} } = {}) {
  const h = { "x-forwarded-for": "10.9.0.1", "x-toasty-csrf": "1", ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  const r = await fetch(`${srv.base}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text(); let data = {}; try { data = JSON.parse(text); } catch (_) { data = { text }; }
  return { status: r.status, data };
}
function sql(srv, statement, params = []) {
  const script = "import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\ncur=c.execute(sys.argv[2], json.loads(sys.argv[3]))\nc.commit()\nprint(json.dumps(cur.fetchall()))";
  const r = spawnSync("python3", ["-c", script, srv.dbPath, statement, JSON.stringify(params)], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim());
}
const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString().replace(/\.\d{3}Z$/, "+00:00");
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const studio = (n, over = {}) => ({ name: `Studio Person ${n}`, email: `studio${n}@example.com`, interest: "podcast", consent: true, website: "", elapsedMs: 5000, ...over });
const peeps = (n, over = {}) => ({ name: `Peeps Person ${n}`, email: `peeps${n}@example.com`, interest: "mentorship", consent: true, website: "", elapsedMs: 5000, ...over });

async function main() {
  const off = startServer(4261);
  await waitFor(off.base);
  assert((await call(off, "/api/organizations/waitlist-stats?brand=studio", { headers: bearer(TOKEN) })).status === 503, "disabled (503) until TOASTY_WAITLIST_STATS_TOKEN is configured");

  const srv = startServer(4262, { TOASTY_WAITLIST_STATS_TOKEN: TOKEN });
  await waitFor(srv.base);
  const path = (brand, q = "") => `/api/organizations/waitlist-stats?brand=${brand}${q}`;

  assert((await call(srv, path("studio"))).status === 403, "no token is refused");
  assert((await call(srv, path("studio"), { headers: bearer("x".repeat(40)) })).status === 403, "a wrong token is refused");
  assert((await call(srv, path("nope"), { headers: bearer(TOKEN) })).status === 400, "an unknown brand is rejected");
  const empty = await call(srv, path("studio"), { headers: bearer(TOKEN) });
  assert(empty.status === 200 && empty.data.total === 0 && empty.data.lastSignupAt === null && empty.data.entries.length === 0, "an empty source reports a real zero with no last signup");

  for (let i = 1; i <= 4; i++) assert((await call(srv, "/api/organizations/studio-waitlist", { method: "POST", body: studio(i) })).status === 200, `studio signup ${i} accepted`);
  await call(srv, "/api/organizations/studio-waitlist", { method: "POST", body: studio(1) }); // duplicate
  await call(srv, "/api/organizations/studio-waitlist", { method: "POST", body: studio(99, { website: "http://spam" }) }); // honeypot
  await call(srv, "/api/organizations/studio-waitlist", { method: "POST", body: studio(98, { elapsedMs: 10 }) }); // too fast
  for (let i = 1; i <= 2; i++) await call(srv, "/api/peeps/waitlist", { method: "POST", body: peeps(i) });

  sql(srv, "UPDATE studio_waitlist SET created_at=? WHERE email='studio3@example.com'", [iso(10)]);
  sql(srv, "UPDATE studio_waitlist SET created_at=? WHERE email='studio4@example.com'", [iso(60)]);
  const rowCount = sql(srv, "SELECT COUNT(*) FROM studio_waitlist")[0][0];
  const stats = await call(srv, path("studio"), { headers: bearer(TOKEN) });
  assert(rowCount === 4 && stats.data.total === rowCount, "total equals the actual number of rows (duplicate, honeypot and too-fast are not counted)");
  assert(stats.data.last7 === 2 && stats.data.last30 === 3, "7-day and 30-day windows count the right rows");
  assert(stats.data.lastSignupAt === sql(srv, "SELECT MAX(created_at) FROM studio_waitlist")[0][0], "last signup is the newest row");
  assert(stats.data.entries.length === 4 && stats.data.entries[0].createdAt >= stats.data.entries[3].createdAt, "recent signups are newest first");
  assert(stats.data.entries.every((e) => e.consent === true && e.id && e.email), "entries carry id, email and consent");

  const page = await call(srv, path("studio", "&limit=2&offset=2"), { headers: bearer(TOKEN) });
  assert(page.data.entries.length === 2 && page.data.total === 4 && page.data.entries[0].id === stats.data.entries[2].id, "pagination honours limit and offset");

  const pe = await call(srv, path("peeps"), { headers: bearer(TOKEN) });
  assert(pe.data.total === 2 && pe.data.last7 === 2 && pe.data.entries.length === 2, "peeps counts are separate from studio counts");

  const reg = await call(srv, "/auth/register", { method: "POST", body: { name: "Admin", email: "admin-stats@example.com", password: "password10chars" } });
  assert(reg.status === 201, "an admin account exists");
  const cookieRes = await fetch(`${srv.base}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "x-toasty-csrf": "1" }, body: JSON.stringify({ email: "admin-stats@example.com", password: "password10chars" }) });
  const cookie = (cookieRes.headers.get("set-cookie") || "").split(";")[0];
  assert((await call(srv, path("studio"), { headers: { cookie } })).status === 403, "a platform-admin browser session alone cannot read the stats endpoint");

  console.log("\nAll waitlist-stats tests passed.");
}
main()
  .then(() => { servers.forEach((s) => s.kill()); rmSync(scratch, { recursive: true, force: true }); process.exit(0); })
  .catch((error) => { console.error(error.message || error); for (const [p, o] of outputs) console.error(`--- server ${p} ---\n${o.slice(-1500)}`); servers.forEach((s) => s.kill()); rmSync(scratch, { recursive: true, force: true }); process.exit(1); });
