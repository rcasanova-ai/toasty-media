#!/usr/bin/env node
// One-command local runner for Toasty Peeps. Zero dependencies (Node >= 20, Python 3 with the stdlib sqlite3).
//
//   node scripts/dev.mjs                 static site + local API sandbox
//   node scripts/dev.mjs --static-only   static site only (enough for the /peeps/demo/ walkthrough)
//   node scripts/dev.mjs --seed          also create a local sandbox account with $50 of Dough
//
// Everything stays on 127.0.0.1. The API runs against a throwaway SQLite database in ./.peeps-local/ (git-ignored),
// with the test email adapter (messages are recorded, never sent) and NO payment recipient configured, so payments
// use the clearly-labelled demo provider. No Toasty production service is contacted.
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const STATIC_PORT = Number(process.env.PEEPS_STATIC_PORT || 4173); // the API's CORS allow-list expects 4173
const API_PORT = Number(process.env.PEEPS_API_PORT || 4174);       // js/studio-api.js expects 4174 on localhost
const staticOnly = args.has("--static-only");
const seed = args.has("--seed");

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon", ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8" };

function staticServer() {
  return createServer((req, res) => {
    let path;
    try { path = decodeURIComponent(new URL(req.url, "http://x").pathname); } catch { res.writeHead(400).end("Bad request"); return; }
    // Never serve dotfiles (.env, .git, ...), the local DB directory, node_modules or the server-side scripts' data.
    const parts = path.split("/").filter(Boolean);
    if (parts.some((p) => p.startsWith(".") || p === "node_modules") || path.includes("\0")) { res.writeHead(404).end("Not found"); return; }
    let file = normalize(join(ROOT, path));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end("Forbidden"); return; }
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith("/")) { res.writeHead(301, { Location: `${path}/` }).end(); return; }
      file = join(file, "index.html");
    }
    if (!existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache" });
    createReadStream(file).pipe(res);
  });
}

function listen(server, port) {
  return new Promise((ok, fail) => { server.once("error", fail); server.listen(port, "127.0.0.1", ok); });
}

async function waitForHealth(base) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("API did not start. Run `node scripts/render-production-server.mjs` directly to see the error.");
}

const python = spawnSync("python3", ["--version"]);
if (!staticOnly && python.status !== 0) {
  console.error("python3 is required for the local API (it provides the SQLite helper). Use `npm run demo` for the static-only demo.");
  process.exit(1);
}

const web = staticServer();
try { await listen(web, STATIC_PORT); } catch (error) {
  console.error(`Port ${STATIC_PORT} is unavailable (${error.code}). Set PEEPS_STATIC_PORT, but note the local API only allows 4173 by default.`);
  process.exit(1);
}
const children = [];
function shutdown() { children.forEach((c) => c.kill()); web.close(); process.exit(0); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

const base = `http://127.0.0.1:${STATIC_PORT}`;
console.log(`\nToasty Peeps (local)\n  Demo (no login, no API):   ${base}/peeps/demo/`);

if (!staticOnly) {
  const dataDir = join(ROOT, ".peeps-local");
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "peeps.sqlite");
  const env = {
    ...process.env,
    TOASTY_RENDER_PORT: String(API_PORT), TOASTY_AUTH_DB: dbPath, TOASTY_AUTH_DB_HELPER: join(ROOT, "scripts", "toasty-auth-db.py"),
    TOASTY_SESSION_SECRET: process.env.TOASTY_SESSION_SECRET || randomBytes(24).toString("hex"),
    TOASTY_APP_BASE_URL: base, TOASTY_PUBLIC_API_BASE: `http://127.0.0.1:${API_PORT}`,
    PEEPS_TEST_ADAPTERS: process.env.PEEPS_TEST_ADAPTERS ?? "1", RESEND_API_KEY: process.env.RESEND_API_KEY ?? "",
    TOASTY_DISABLE_VOYAGEURS_BOOTSTRAP: "1", TOASTY_DISABLE_MATEO_BOOTSTRAP: "1"
  };
  const api = spawn("node", [join(ROOT, "scripts", "render-production-server.mjs")], { cwd: ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
  children.push(api);
  api.on("exit", (code) => { if (code) { console.error(`API exited with code ${code}`); shutdown(); } });
  await waitForHealth(`http://127.0.0.1:${API_PORT}`);
  const paymentsReal = Boolean(env.SVM_PAY_TO || env.TOASTY_EXPERTS_X402_RECIPIENT);
  console.log(`  App + API sandbox:         ${base}/peeps/app/   (API on 127.0.0.1:${API_PORT}, database ${dbPath})`);
  console.log(`  Judge path:                ${base}/peeps/app/golden-path.html`);
  console.log(`  Payments:                  ${paymentsReal ? "REAL Solana verification is ON (a recipient is configured in your environment)" : "simulated (demo provider). Set SVM_PAY_TO etc. for devnet, see peeps/README.md"}`);
  if (seed) {
    const email = "judge@peeps.local";
    const password = randomBytes(9).toString("base64url");
    const post = async (path, body) => fetch(`http://127.0.0.1:${API_PORT}${path}`, { method: "POST", headers: { "content-type": "application/json", "x-toasty-csrf": "1" }, body: JSON.stringify(body) });
    const r = await post("/auth/register", { name: "Local Judge", email, password });
    if (r.status === 201) {
      const { user } = await r.json();
      spawnSync("python3", [join(ROOT, "scripts", "toasty-auth-db.py")], { input: JSON.stringify({ action: "dough_post", dbPath, id: "dle_local_seed", subjectType: "user", subjectId: user.id, bucket: "spend", direction: "credit", amount: 50, kind: "funding", referenceId: "local-seed" }), encoding: "utf8" });
      console.log(`\n  Local sandbox login (this machine only):\n    email:    ${email}\n    password: ${password}\n    Dough:    $50.00 (seeded ledger credit; not real money)`);
    } else if (r.status === 409) {
      console.log(`\n  Sandbox account ${email} already exists from a previous run (delete ${dataDir} to reset).`);
    } else {
      console.log(`\n  Could not create the sandbox account (HTTP ${r.status}).`);
    }
  }
}
console.log("\nCtrl+C to stop.\n");
