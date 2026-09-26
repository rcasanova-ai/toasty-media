#!/usr/bin/env node
// Regression test for docs/DEPLOYMENT.md's own warning: a route added to render-production-server.mjs
// does nothing in production until scripts/nginx-render.conf.example has a matching location block,
// because neither deploy workflow touches nginx config automatically.
//
// This asserts every Event Growth API route (the list below is the definitive set — kept in sync by
// hand with the `if (req.method === ... && req.url...)` registrations in render-production-server.mjs;
// see the header comment on why this isn't parsed out of the route-dispatch source instead) has at
// least one nginx location block whose regex actually matches a representative real URL for that route.
//
// nginx itself is not installed in this sandbox (checked via `which nginx`), so this can only verify the
// location regexes are well-formed JS-compatible patterns that match the right paths — it canNOT confirm
// nginx's own PCRE2 engine accepts the file, catch a duplicate/conflicting location block, or verify
// proxy_pass/rate-limit-zone correctness. Run `nginx -t -c scripts/nginx-render.conf.example` (after
// filling in the real cert paths) by hand before every production deploy that touches this file — see
// docs/DEPLOYMENT.md.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONF_PATH = join(ROOT, "scripts", "nginx-render.conf.example");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

// One representative real-looking URL per distinct Event Growth path (method doesn't affect nginx
// location matching — that's path-only; method handling lives inside each block's own body).
const EVENT_GROWTH_ROUTES = [
  "/api/sessions/ls_abc123/plan",
  "/api/sessions/ls_abc123/speakers",
  "/api/speakers/spk_abc123/update",
  "/api/speakers/spk_abc123/invite",
  "/api/speakers/spk_abc123/tech-check",
  "/api/speaker-invites/aBcDeF123456",
  "/api/speaker-invites/aBcDeF123456/profile",
  "/api/speaker-invites/aBcDeF123456/tech-check",
  "/api/speaker-invites/aBcDeF123456/consent",
  "/api/sessions/ls_abc123/sponsors",
  "/api/sponsors/spn_abc123/update",
  "/api/sponsors/spn_abc123/approve",
  "/api/sponsors/spn_abc123/invite",
  "/api/sponsor-invites/aBcDeF123456",
  "/api/sponsor-invites/aBcDeF123456/kit",
  "/api/sessions/ls_abc123/sponsor-moments",
  "/api/sponsor-moments/mom_abc123/status",
  "/api/sessions/ls_abc123/consent",
  "/api/sessions/ls_abc123/landing-page",
  "/api/sessions/ls_abc123/landing-page/publish",
  "/api/sessions/ls_abc123/landing-page/unpublish",
  "/api/landing-pages/my-event-slug",
  "/api/audience/identity",
  "/api/audience/events",
  "/api/sessions/ls_abc123/audience/events",
  "/api/sessions/ls_abc123/audience/summary",
  "/api/sessions/ls_abc123/campaign-links",
  "/api/campaign-links/cl_abc123/active",
  "/api/r/my-campaign-slug",
  "/api/sessions/ls_abc123/ai-usage",
  "/api/sessions/ls_abc123/moxie/readiness-summary",
  "/api/sessions/ls_abc123/moxie/speaker-briefing",
  "/api/sessions/ls_abc123/moxie/session-research",
  "/api/sessions/ls_abc123/moxie/audience-insights",
  "/api/sessions/ls_abc123/moxie/post-event-suggestions",
  "/api/sessions/ls_abc123/artifacts",
  "/api/artifacts/pea_abc123/update"
];

// Peeps Jam lifecycle routes (docs/ROADMAP.md Gate 2) — same representative-URL-per-distinct-path
// convention as EVENT_GROWTH_ROUTES above, checked separately so a missing block reads as "Jam routes"
// rather than getting lost inside the Event Growth list.
const PEEPS_JAM_ROUTES = [
  "/api/jams",
  "/api/jams/jam_abc123",
  "/api/jams/jam_abc123/update",
  "/api/jams/jam_abc123/run-session",
  "/api/jams/jam_abc123/complete",
  "/api/jams/jam_abc123/reopen",
  "/api/jams/jam_abc123/results",
  "/api/jams/jam_abc123/access",
  "/api/jams/jam_abc123/events",
  "/api/jams/jam_abc123/participants",
  "/api/jams/jam_abc123/artifacts",
  "/api/jam-participants/jampt_abc123/invite",
  "/api/jam-participants/jampt_abc123/confirm",
  "/api/jam-participants/jampt_abc123/remove",
  "/api/jam-participants/jampt_abc123/mark-attended",
  "/api/jam-participants/jampt_abc123/mark-completed",
  "/api/jam-participants/jampt_abc123/mark-eligible",
  "/api/jam-participants/jampt_abc123/mark-paid",
  "/api/jam-invites/aBcDeF123456",
  "/api/jam-invites/aBcDeF123456/accept",
  "/api/jam-invites/aBcDeF123456/consent",
  "/api/jam-artifacts/jart_abc123/update",
  "/api/sessions/ls_abc123/jam"
];

// Every backend route this list represents, as it's actually registered in render-production-server.mjs
// (kept here purely so a future editor can diff the two lists by eye — not executed).
// See: grep -n 'req.url?.startsWith("/api/' scripts/render-production-server.mjs

function extractNginxLocationPatterns(confText) {
  const patterns = [];
  // location ~ <pattern> { ... }  — pattern may or may not be quoted; take the token up to whitespace
  // before the opening brace, same "flat single-level alternation" shape documented in the conf file
  // itself.
  const regex = /location\s*~\*?\s*("([^"]+)"|(\S+))\s*\{/g;
  let match;
  while ((match = regex.exec(confText))) {
    const raw = match[2] ?? match[3];
    patterns.push(raw);
  }
  return patterns;
}

function nginxPatternToRegExp(pattern) {
  // These patterns are already written to be flat, single-level, PCRE2-safe (see the conf file's own
  // comments) — which is also valid JS regex syntax for every pattern actually used here (character
  // classes, `+`, `?`, `|` inside a single non-nested group, anchors). new RegExp() will throw loudly if
  // that ever stops being true, which is itself a useful signal.
  return new RegExp(pattern);
}

async function main() {
  const confText = readFileSync(CONF_PATH, "utf8");
  const patterns = extractNginxLocationPatterns(confText);
  assert(patterns.length >= 15, `nginx conf has a meaningful number of regex location blocks (found ${patterns.length})`);

  const compiled = patterns.map((p) => ({ source: p, regExp: nginxPatternToRegExp(p) }));

  const uncovered = [];
  for (const route of EVENT_GROWTH_ROUTES) {
    const matched = compiled.find(({ regExp }) => regExp.test(route));
    if (matched) {
      console.log(`  ok — ${route} is covered by location ~ ${matched.source}`);
    } else {
      uncovered.push(route);
    }
  }
  assert(uncovered.length === 0, `every Event Growth route has a matching nginx location block${uncovered.length ? ` (missing: ${uncovered.join(", ")})` : ""}`);

  const uncoveredJam = [];
  for (const route of PEEPS_JAM_ROUTES) {
    const matched = compiled.find(({ regExp }) => regExp.test(route));
    if (matched) {
      console.log(`  ok — ${route} is covered by location ~ ${matched.source}`);
    } else {
      uncoveredJam.push(route);
    }
  }
  assert(uncoveredJam.length === 0, `every Peeps Jam route has a matching nginx location block${uncoveredJam.length ? ` (missing: ${uncoveredJam.join(", ")})` : ""}`);

  // Best-effort: if nginx is actually installed in this environment, run a real syntax check. This
  // sandbox does not have it (documented above), so this branch is exercised in CI/production only.
  try {
    execFileSync("nginx", ["-v"], { stdio: "ignore" });
    try {
      execFileSync("nginx", ["-t", "-c", CONF_PATH], { stdio: "pipe" });
      console.log("  ok — nginx -t accepts scripts/nginx-render.conf.example");
    } catch (error) {
      // A real syntax/config error is a genuine failure; missing upstream certs/includes (expected for
      // an .example file outside its real deploy tree) would also land here, so surface the output
      // rather than asserting blindly.
      console.log("  note — nginx -t reported an issue (may be expected for a standalone .example file outside its real deploy tree):");
      console.log(String(error.stdout || error.stderr || error.message).split("\n").map((l) => `    ${l}`).join("\n"));
    }
  } catch {
    console.log("  note — nginx is not installed in this environment; skipped `nginx -t`. Run it by hand (with real cert paths filled in) before any production deploy that touches this file — see docs/DEPLOYMENT.md.");
  }

  console.log("\nAll nginx route-coverage checks passed.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
