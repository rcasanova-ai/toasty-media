#!/usr/bin/env node
// Every request state a user can be in must have a plain-language label and a next step on My Requests (no raw codes).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const server = readFileSync(join(ROOT, "scripts/render-production-server.mjs"), "utf8");
const page = readFileSync(join(ROOT, "peeps/app/searches.html"), "utf8");
const order = JSON.parse(server.match(/const PEEPS_LIFECYCLE_ORDER = (\[[^\]]*\])/)[1]);
const states = ["researching", "candidates_ready", "introductions_authorized", ...order];
for (const state of states) assert(new RegExp(`\\b${state}: \\["[^"]+", "[^"]+", "(request|outcome)"\\]`).test(page), `My Requests explains "${state}" and says what to do next`);
assert(!page.includes("Introductions sent"), "no label claims introductions were 'sent' before anything is delivered");
console.log("\nPASS");
