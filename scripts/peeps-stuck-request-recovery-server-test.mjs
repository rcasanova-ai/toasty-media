#!/usr/bin/env node
// A request that was charged the $0.25 introduction fee but never got an introduction (the pre-demo-participant state:
// candidates persisted as external_indirect, zero introductions) must recover: the fee is NOT charged again, the three demo
// personas become authorizable, and the receipt says exactly what was bought and that 0 introductions exist yet.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(ROOT, "scripts", "toasty-auth-db.py");
const scratch = mkdtempSync(join(tmpdir(), "toasty-stuck-"));
const dbPath = join(scratch, "db.sqlite");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const servers = [];
const start = (port) => { const c = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], { env: { ...process.env, TOASTY_RENDER_PORT: String(port), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: helper, TOASTY_SESSION_SECRET: "stuck-secret", RESEND_API_KEY: "", PEEPS_TEST_ADAPTERS: "", TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1", SVM_PAY_TO: "", TOASTY_EXPERTS_X402_RECIPIENT: "" }, stdio: "ignore" }); servers.push(c); return c; };
const ready = async (base) => { for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/health`)).ok) return; } catch (_) {} await new Promise((r) => setTimeout(r, 100)); } throw new Error("server did not start"); };
const sql = (statement, params = []) => { const r = spawnSync("python3", ["-c", "import sqlite3,sys,json\nc=sqlite3.connect(sys.argv[1])\ncur=c.execute(sys.argv[2], json.loads(sys.argv[3]))\nc.commit()\nprint(json.dumps(cur.fetchall()))", dbPath, statement, JSON.stringify(params)], { encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr); return JSON.parse(r.stdout); };
const callOn = (base) => async (path, { method = "GET", cookie, body } = {}) => { const r = await fetch(base + path, { method, headers: { "x-toasty-csrf": "1", ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined }); let data = {}; try { data = await r.json(); } catch (_) {} return { status: r.status, data, cookie: (r.headers.get("set-cookie") || "").split(";")[0] }; };
try {
  const a = start(4751); const baseA = "http://127.0.0.1:4751"; await ready(baseA);
  const call = callOn(baseA);
  const reg = await call("/auth/register", { method: "POST", body: { name: "Stuck", email: "stuck@example.com", password: "password10chars" } });
  const cookie = reg.cookie;
  await call("/api/peeps/dough/demo-credit", { method: "POST", cookie, body: {} });
  const created = await call("/api/peeps/requests", { method: "POST", cookie, body: { whoText: "Fintech/payment executives in Southeast Asia who understand offline payments", outcomeText: "I want 2 people for a recorded podcast about offline payments." } });
  const rid = created.data.request.id;
  const demo = created.data.candidates.filter((c) => c.reachability === "demo_participant");
  const first = await call(`/api/peeps/requests/${rid}/authorize`, { method: "POST", cookie, body: { candidates: [{ candidateId: demo[0].id }] } });
  assert(first.status === 200 && first.data.introductions.length === 1, "fee charged once and one introduction created");
  const balancePaid = (await call("/api/peeps/dough", { cookie })).data.account.spendBalance;
  // Reproduce the production state: introductions gone, candidates back to 'proposed' and stored the old way.
  sql("DELETE FROM peeps_introductions WHERE request_id = ?", [rid]);
  sql("UPDATE peeps_candidates SET status = 'proposed', reachability = 'external_indirect', dub_id = NULL WHERE request_id = ?", [rid]);
  a.kill();
  const b = start(4752); const baseB = "http://127.0.0.1:4752"; await ready(baseB);
  const callB = callOn(baseB);
  // The old session cookie is signed with the same secret, so it still works on the restarted server.
  const view = await callB(`/api/peeps/requests/${rid}`, { cookie });
  assert(view.status === 200 && view.data.introductions.length === 0, "the request loads and shows no introductions");
  const migrated = view.data.candidates.filter((c) => ["Anong Srisuk", "Budi Hartono", "Mei Lin Tan"].includes(c.displayName));
  assert(migrated.length >= 2 && migrated.every((c) => c.reachability === "demo_participant"), "the demo personas were reclassified by the startup migration");
  const rec = (await callB(`/api/peeps/requests/${rid}/receipt`, { cookie })).data;
  const pay = rec.checks.find((c) => c.key === "payment");
  assert(pay.state === "done" && /Introductions authorized: 0/.test(pay.detail) && /will not charge twice/.test(pay.detail), "receipt shows the fee was paid and that 0 introductions are authorized yet");
  const retry = await callB(`/api/peeps/requests/${rid}/authorize`, { method: "POST", cookie, body: { candidates: migrated.slice(0, 2).map((c) => ({ candidateId: c.id })) } });
  assert(retry.status === 200 && retry.data.introductions.length === 2 && retry.data.skipped.length === 0, "authorizing again now creates both introductions");
  const events = (await callB(`/api/peeps/requests/${rid}/receipt`, { cookie })).data.solana.events;
  assert(events.length === 1 && (await callB("/api/peeps/dough", { cookie })).data.account.spendBalance === balancePaid, "the introduction fee was NOT charged a second time");
  console.log("\nPASS");
} finally { servers.forEach((s) => s.kill()); }
