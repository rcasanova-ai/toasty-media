#!/usr/bin/env node
// Program Output "stuck on Starting Soon" regression — the REAL root cause, found by tracing an actual
// Studio-created session end-to-end (Director durable session id/roomId, presence, and Program Output's
// bootstrap all matched byte-for-byte; the room/session-mismatch hypothesis was disproven live). The bug
// was a temporal-dead-zone crash in js/listener.js itself:
//
//   let lastSocialLinksKey = "";   // was declared down near renderSocialLinks(), far below init()
//
// init() is invoked at module top level (`init().catch(...)`) and runs synchronously up to its first
// `await`. That synchronous prefix calls `sync.readLastState()` (ProgramSync's localStorage cache) and,
// if a cached state exists, renders it immediately via render() -> renderSocialLinks(), which reads/writes
// lastSocialLinksKey. In virtually every real session this cache IS populated — Director publishes
// control state via _publishControlNow() as soon as it joins, well before "Open Program Output" is ever
// clicked. Because lastSocialLinksKey's own `let` declaration sits AFTER init()'s call site in source
// order, the module's execution had not yet reached that line — so this synchronous render hit it while
// still in the variable's temporal dead zone and threw:
//   ReferenceError: Cannot access 'lastSocialLinksKey' before initialization
// That exception propagated out of the synchronous portion of init(), aborting it before it ever reached
// presence.start() (RoomPresence role=output) or serverSync.start() (ProgramServerSubscriber polling) —
// the only two things that let Program Output ever learn about a LATER scene change. Result: Program
// Output permanently freezes on whatever it rendered first (its initial "Starting Soon" markup), and NO
// sync path — not BroadcastChannel, not localStorage, not server polling — ever fires again for that page
// load, no matter how many times Director changes scene. This reproduced 100% of the time against a real
// Studio-created session in production (confirmed via the actual browser console:
// "[Program Output] init failed ... Cannot access 'lastSocialLinksKey' before initialization").
//
// The fix is a pure reordering: lastSocialLinksKey is now declared with the other module-level state
// (line ~54, well above `elements` and `init()`), not a logic change. This environment has no headless
// browser (no puppeteer/playwright), so this test cannot itself execute listener.js in a DOM. What WAS
// verified live: (1) the exact ReferenceError above, captured from the real production console before the
// fix; (2) after the fix, loading studio/listener.html locally with a pre-seeded
// localStorage["toastyProgramState:<room>"] cache (the exact condition that crashed init()) renders
// correctly with no console error — confirmed via document.body.dataset.scene reflecting the cached
// scene and no init-failed log.
//
// What this test asserts statically, and can keep asserting in CI without a browser: EVERY top-level
// `let`/`const` state declaration in js/listener.js appears BEFORE the `init()` invocation. This is the
// exact invariant the bug violated — any top-level state variable declared after init() is a landmine,
// since init()'s synchronous prefix (before its first `await`) can call into arbitrary render/handler code
// that may reference it. A future edit that reintroduces a bare "declare state near where it's used, at
// the bottom of the file" pattern to this specific file will fail this test before it reaches production.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(ROOT, "js/listener.js"), "utf8");
const lines = src.split("\n");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

const initCallLine = lines.findIndex((line) => /^init\(\)\.catch\(/.test(line));
assert(initCallLine !== -1, "found the top-level init().catch(...) invocation");

// Every top-level `let NAME = ...;` / `const NAME = ...;` declaration (module scope, not inside a
// function — i.e. zero leading whitespace) must be declared before init() is ever invoked.
const declarationPattern = /^(?:let|const)\s+([A-Za-z_$][\w$]*)\s*=/;
const topLevelDeclarations = [];
lines.forEach((line, index) => {
  const match = line.match(declarationPattern);
  if (match) topLevelDeclarations.push({ name: match[1], line: index });
});

assert(topLevelDeclarations.length > 10, `found a plausible number of top-level state declarations (${topLevelDeclarations.length})`);

const declaredAfterInit = topLevelDeclarations.filter((decl) => decl.line > initCallLine);
assert(
  declaredAfterInit.length === 0,
  declaredAfterInit.length === 0
    ? "no top-level state variable is declared after init() is invoked (the exact TDZ landmine class)"
    : `state declared after init(): ${declaredAfterInit.map((d) => `${d.name}@${d.line + 1}`).join(", ")}`
);

// The specific regression: lastSocialLinksKey must exist and sit before init().
const social = topLevelDeclarations.find((d) => d.name === "lastSocialLinksKey");
assert(!!social, "lastSocialLinksKey is declared at module top level");
assert(social.line < initCallLine, `lastSocialLinksKey (line ${social.line + 1}) is declared before init() (line ${initCallLine + 1})`);

// renderSocialLinks() itself must no longer carry its own `let lastSocialLinksKey` (would shadow/duplicate).
const renderSocialLinksBody = src.slice(src.indexOf("function renderSocialLinks("));
assert(
  !/\blet lastSocialLinksKey\b/.test(renderSocialLinksBody.slice(0, 400)),
  "renderSocialLinks() no longer redeclares lastSocialLinksKey locally"
);

console.log("\nAll program-output-listener-init-order checks passed.");
