#!/usr/bin/env node
// One-time beta demo credit: lets a signed-in beta account try paid steps without real money. Labelled, idempotent, capped.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "toasty-dc-"));
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const servers = [];
function start(port, extra = {}) {
  const child = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], { env: { ...process.env, TOASTY_RENDER_PORT: String(port), TOASTY_AUTH_DB: join(scratch, `db-${port}.sqlite`), TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"), TOASTY_SESSION_SECRET: "dc-secret", RESEND_API_KEY: "", TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", ...extra }, stdio: "ignore" });
  servers.push(child); return `http://127.0.0.1:${port}`;
}
async function ready(base) { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("server did not start"); }
const call = async (base, path, { method = "GET", cookie, body } = {}) => { const r = await fetch(base + path, { method, headers: { "x-toasty-csrf": "1", ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); let data = {}; try { data = await r.json(); } catch (_) {} return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
try {
  const base = start(4721); await ready(base);
  const reg = await call(base, "/auth/register", { method: "POST", body: { name: "Judge", email: "judge-dc@example.com", password: "password10chars" } });
  const cookie = reg.cookie;
  let d = await call(base, "/api/peeps/dough", { cookie });
  assert(d.data.demoCredit.available === true && d.data.demoCredit.amount === 5 && d.data.account.spendBalance === 0, "new account: $0 and a $5 demo credit is available");
  let c = await call(base, "/api/peeps/dough/demo-credit", { method: "POST", cookie, body: {} });
  assert(c.status === 200 && c.data.claimed && c.data.account.spendBalance === 5, "claim adds $5 to spendable Dough");
  d = await call(base, "/api/peeps/dough", { cookie });
  assert(d.data.entries.some((e) => e.kind === "demo_credit") && d.data.demoCredit.available === false, "ledger entry is labelled demo_credit; no longer available");
  c = await call(base, "/api/peeps/dough/demo-credit", { method: "POST", cookie, body: {} });
  assert(c.data.alreadyClaimed === true, "second claim is refused (idempotent)");
  d = await call(base, "/api/peeps/dough", { cookie });
  assert(d.data.account.spendBalance === 5, "balance unchanged after repeat claim");
  const anon = await call(base, "/api/peeps/dough/demo-credit", { method: "POST", body: {} });
  assert(anon.status === 401, "requires sign-in");
  const off = start(4722, { PEEPS_DEMO_CREDIT_USD: "0" }); await ready(off);
  const r2 = await call(off, "/auth/register", { method: "POST", body: { name: "J2", email: "judge-dc2@example.com", password: "password10chars" } });
  const o = await call(off, "/api/peeps/dough/demo-credit", { method: "POST", cookie: r2.cookie, body: {} });
  assert(o.status === 404, "can be switched off (PEEPS_DEMO_CREDIT_USD=0)");
  console.log("\nPASS");
} finally { servers.forEach((s) => s.kill()); }
