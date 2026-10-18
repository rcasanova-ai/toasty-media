#!/usr/bin/env node
// Tests scripts/sync-nginx-managed-block.py: insertion, idempotence, in-place update, and fail-closed cases.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "sync-nginx-managed-block.py");
let n = 0;
function assert(c, m) { if (!c) throw new Error(`FAILED: ${m}`); n += 1; console.log(`  ok - ${m}`); }
function run(example, live) {
  const dir = join(process.env.TMPDIR || "/tmp", `nmb-${process.pid}.conf`);
  return (async () => {
    const { writeFileSync, rmSync } = await import("node:fs");
    writeFileSync(dir, example);
    const r = spawnSync("python3", [SCRIPT, dir], { input: live, encoding: "utf8" });
    rmSync(dir);
    return r;
  })();
}
const block = (body) => `    # BEGIN toasty-managed:demo\n${body}\n    # END toasty-managed:demo\n`;
const live = "server {\n    location ~ ^/keep$ {\n        return 200;\n    }\n    location / {\n        return 404;\n    }\n}\n";
const real = readFileSync(join(ROOT, "scripts", "nginx-render.conf.example"), "utf8");

const a = await run(block("    location = /one { return 200; }"), live);
assert(a.status === 0 && a.stdout.includes("location = /one") && a.stdout.includes("location ~ ^/keep$"), "a missing block is inserted and other routes are preserved");
assert(a.stdout.indexOf("/one") < a.stdout.indexOf("location / {"), "the block lands before the catch-all");
const b = await run(block("    location = /one { return 200; }"), a.stdout);
assert(b.status === 0 && b.stdout === a.stdout, "running again changes nothing");
const c = await run(block("    location = /two { return 200; }"), a.stdout);
assert(c.stdout.includes("/two") && !c.stdout.includes("/one") && c.stdout.includes("^/keep$"), "a changed block is updated in place");
assert((c.stdout.match(/BEGIN toasty-managed:demo/g) || []).length === 1, "markers are never duplicated");
assert((await run(block("x"), "server { }\n")).status === 1, "no catch-all anchor fails closed");
assert((await run("no markers here\n", live)).status === 1, "an example without managed blocks fails");
assert((await run(block("x"), live + "    # BEGIN toasty-managed:demo\n")).status === 1, "unbalanced live markers fail closed");
const r = await run(real, live);
assert(r.status === 0 && r.stdout.includes("/api/human-presence/") && r.stdout.includes("human-presence(/requests|/cancel)"), "the real example syncs the human presence block");
console.log(`\n${n} passed`);
