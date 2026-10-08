#!/usr/bin/env node
// Runs the Peeps test suite sequentially and prints a summary. Needs Node >= 20 and Python 3; no network, no
// secrets, no dependencies. Each server test starts its own sandboxed server on its own port and database.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = [
  "peeps-demo-test", "peeps-fit-engine-test", "peeps-auth-gate-test", "peeps-jam-lobby-test", "peeps-josip-roast-test",
  "peeps-colosseum-golden-path-test", "solana-real-transaction-verification-test", "peeps-waitlist-server-test",
  "peeps-agent-lifecycle-server-test", "peeps-introduction-execution-server-test", "peeps-jam-lifecycle-server-test", "peeps-post-session-server-test",
  "dough-ledger-test", "dough-money-loop-server-test", "accounts-solana-server-test"
];
const only = process.argv.slice(2);
const results = [];
for (const name of TESTS.filter((t) => !only.length || only.some((o) => t.includes(o)))) {
  process.stdout.write(`${name} ... `);
  const started = Date.now();
  const r = spawnSync("node", [join(ROOT, "scripts", `${name}.mjs`)], { cwd: ROOT, encoding: "utf8", env: { ...process.env, TOASTY_SOLANA_PAYER_KEYPAIR: "", SVM_KEYPAIR_PATH: "" } });
  const ok = r.status === 0;
  console.log(`${ok ? "PASS" : "FAIL"} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  if (!ok) console.log((r.stdout + r.stderr).split("\n").slice(-25).join("\n"));
  results.push([name, ok]);
}
const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? `; failed: ${failed.map(([n]) => n).join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
