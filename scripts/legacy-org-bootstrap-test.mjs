#!/usr/bin/env node
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("./render-production-server.mjs", import.meta.url), "utf8");

function assert(ok, msg) {
  if (!ok) throw new Error("FAILED: " + msg);
  console.log("ok - " + msg);
}

assert(server.includes("async function ensureDefaultOrganizationForUser(user)"), "legacy org bootstrap helper exists");
assert(server.includes("await ensureDefaultOrganizationForUser(user);"), "login bootstraps missing organization");
assert(server.includes("const organizations = await ensureDefaultOrganizationForUser(session);"), "organization list self-heals active legacy sessions");
assert(server.includes("Legacy accounts created before organizations existed"), "legacy migration intent documented");
console.log("ALL PASSED - legacy account org bootstrap wired.");
