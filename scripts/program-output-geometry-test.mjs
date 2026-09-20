#!/usr/bin/env node
// Program Output geometry regression — see the commit this test shipped with for the full root-cause
// writeup. Short version: .po-topic (a flex item of .po-chrome-bottom) had no min-width:0, and .po-chrome
// (top and bottom) had no min-width:0 as grid items of .po-canvas's single shared column. With a real
// topic string + a real ticker + the LIVE badge all present together, .po-topic's un-guarded min-content
// forced .po-chrome-bottom wider than the viewport — and because .po-canvas has ONE shared grid column,
// that excess width propagated to EVERY row sharing it, including .po-stage, clipping whatever sat at the
// right edge of ANY row (a participant tile, the waiting room's 4th slot). This had nothing to do with
// VDO.Ninja, iframes, or video aspect ratios — the very first CSS fix (PR #33) patched a real but
// different gap in .po-stage and was necessary but not sufficient.
//
// This environment has no headless browser (no puppeteer/playwright, confirmed: `node -e
// "require('puppeteer')"` fails), so this cannot assert on live getBoundingClientRect() the way a real
// browser test would. What WAS verified live, interactively, in a real browser (documented with exact
// numbers in the commit message): a 20-combination matrix of 5 participant counts (0/1/2/3/4, including
// the real .po-waitingroom markup for 0) x 4 viewports (1920x1080, 1440x900, 1366x768, 900x600), each with
// a long topic string + long ticker text + visible LIVE badge simultaneously (the exact combination that
// reproduced the bug), plus 4 extreme media aspect ratios (16:9, 4:3, portrait 9:16, ultrawide 32:9) via a
// real <video> element with genuine intrinsic dimensions. All 24 checks: zero elements right of the
// viewport edge, document.documentElement.scrollWidth === viewport width exactly.
//
// What this test DOES assert, and can keep asserting in CI without a browser: the exact CSS properties
// that are mathematically necessary for that result to hold — min-width:0 on every grid/flex item in the
// .po-canvas -> .po-chrome/.po-stage -> .po-waitingroom/.po-tile chain, and NO bare `1fr` track anywhere
// in this stylesheet's grid-template-columns/rows (a `1fr` track's automatic minimum is `auto`, i.e.
// content-based, unless wrapped in minmax(0, ...) — the exact defect class this bug and the previous
// PR's .po-stage bug both were).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(ROOT, "css/program-output.css"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

// Some class names (.po-tile, .po-chrome, .po-ticker-track) appear in more than one standalone rule
// (an early `.po-tile { transition: ... }` before the real declaration block, etc). Rather than chase
// index offsets, find every place the selector opens its OWN rule (immediately after a `}` or at the
// top of the file — never mid compound-selector-list) and return the body with the most declarations,
// which is always the "real" rule, not an incidental single-property override.
function ruleBody(selectorText) {
  const bare = selectorText.replace(/\s*\{\s*$/, "");
  const escaped = bare.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:\\}|^)\\s*${escaped}\\s*\\{`, "gm");
  const matches = [...css.matchAll(pattern)];
  if (matches.length === 0) throw new Error(`selector not found as a standalone rule: ${bare}`);
  const bodies = matches.map((m) => {
    const open = m.index + m[0].length - 1;
    const close = css.indexOf("}", open);
    return css.slice(open, close + 1);
  });
  return bodies.sort((a, b) => b.split(";").length - a.split(";").length)[0];
}

console.log("No bare `1fr` grid tracks anywhere in the stylesheet, except the one root container that's provably safe");
{
  // Matches `1fr` NOT already preceded by `minmax(0, ` or `minmax(0,` — i.e. a track whose automatic
  // minimum is still content-based (`auto`), the exact bug in both .po-stage (fixed previously) and
  // .po-topic/.po-chrome/.po-waitingroom/.po-stage[data-layout="asset-speaker-pip"] (fixed in this pass).
  // Strip comments first so documentation text that quotes CSS syntax (like this file's own header)
  // can't produce a false match.
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const bareOneFr = [...withoutComments.matchAll(/grid-template-(?:columns|rows):[^;]*?(?<!minmax\(0,\s?)\b1fr\b/g)]
    // .po-canvas itself is the ONE legitimate exception: it's the root layout container (sized via
    // 100vw/100vh directly, not nested as a grid item inside anything else), so nothing external can
    // ever force its track wider than intended the way a nested grid item can. Find the enclosing rule
    // (back to the last unclosed "{") and check whether ITS selector is .po-canvas.
    .filter((match) => {
      const enclosingOpenBrace = withoutComments.lastIndexOf("{", match.index);
      const selectorStart = withoutComments.lastIndexOf("}", enclosingOpenBrace) + 1;
      const selector = withoutComments.slice(selectorStart, enclosingOpenBrace).trim();
      return selector !== ".po-canvas";
    });
  assert(bareOneFr.length === 0, `zero bare (unguarded) 1fr tracks outside the root .po-canvas container (found ${bareOneFr.length}: ${bareOneFr.map((m) => m[0]).join(" | ")})`);
}

console.log("\n.po-canvas -> .po-chrome chain (the actual root cause of this pass)");
{
  const canvasRule = ruleBody(".po-canvas {");
  assert(/grid-template-columns:\s*1fr/.test(canvasRule), ".po-canvas declares an explicit single column track");

  const chromeRule = ruleBody(".po-chrome {");
  assert(/min-width:\s*0/.test(chromeRule), ".po-chrome (both -top and -bottom, grid items of .po-canvas's shared column) has min-width:0 — this is the actual fix for this pass");

  // .po-topic (bottom-bar headline) was removed in the visual pass that replaced it with the masthead
  // (.po-masthead-headline, top of the canvas) — same flex-min-content risk, same fix required: the flex
  // item wrapping the headline needs min-width:0, and the headline itself still visually truncates.
  const masteadTextRule = ruleBody(".po-masthead-text {");
  assert(/min-width:\s*0/.test(masteadTextRule), ".po-masthead-text (the flex item that replaced .po-topic's un-guarded min-content risk) has min-width:0");
  const headlineRule = ruleBody(".po-masthead-headline {");
  assert(/overflow:\s*hidden/.test(headlineRule) && /text-overflow:\s*ellipsis/.test(headlineRule), ".po-masthead-headline still truncates long text visually instead of just relying on min-width:0 to prevent overflow");

  const tickerRule = ruleBody(".po-ticker {");
  assert(/min-width:\s*0/.test(tickerRule) && /overflow:\s*hidden/.test(tickerRule), ".po-ticker (also a .po-chrome-bottom flex item) remains bounded");
}

console.log("\n.po-stage chain (fixed in the previous pass, guarded here against regressing back)");
{
  const stageRule = ruleBody(".po-stage {");
  assert(/min-width:\s*0/.test(stageRule), ".po-stage (a grid item of .po-canvas) has min-width:0");
  assert(/min-height:\s*0/.test(stageRule), ".po-stage has min-height:0");
  assert(/overflow:\s*hidden/.test(stageRule), ".po-stage clips its own content");

  for (const layout of ["1", "2", "3", "4", "screen-strip"]) {
    const marker = `.po-stage[data-layout="${layout}"]`;
    assert(css.includes(marker), `layout selector ${marker} still exists`);
  }
  assert((css.match(/minmax\(0,\s?1fr\)/g) || []).length >= 6, "single/2/3/4-person and spotlight layouts all use minmax(0, 1fr) column tracks, not bare 1fr");

  const tileRule = ruleBody(".po-tile {");
  assert(/min-width:\s*0/.test(tileRule) && /min-height:\s*0/.test(tileRule) && /overflow:\s*hidden/.test(tileRule), ".po-tile is bounded on every axis");

  const tileVideoRule = ruleBody(".po-tile-video {");
  assert(/overflow:\s*hidden/.test(tileVideoRule), ".po-tile-video clips its video/iframe child directly");
}

console.log("\n.po-waitingroom chain (found via code review in this pass — same defect class, not yet observed to overflow at tested viewports, fixed defensively per the explicit 'every grid/flex child must be shrinkable' requirement)");
{
  const waitingRoomRule = ruleBody(".po-waitingroom {");
  assert(/grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/.test(waitingRoomRule), ".po-waitingroom uses minmax(0, 1fr) x4, not bare repeat(4, 1fr)");

  const waitingSlotRule = ruleBody(".po-waitingroom-slot {");
  assert(/min-width:\s*0/.test(waitingSlotRule), ".po-waitingroom-slot has min-width:0");
}

console.log("\nTicker contrast (guarded against regressing back from the prior pass)");
{
  const trackRule = ruleBody(".po-ticker-track {");
  const trackRuleNoComments = trackRule.replace(/\/\*[\s\S]*?\*\//g, "");
  assert(trackRuleNoComments.includes("color: var(--studio-cream)"), ".po-ticker-track's active color declaration uses the brand-aware --studio-cream");
  assert(!trackRuleNoComments.includes("color: var(--po-video-text)"), ".po-ticker-track's active color declaration does not use the fixed-light --po-video-text (explanatory comment mentioning it by name is fine)");
}

console.log("\nAll program-output geometry regression checks passed (static CSS invariants — see file header for what was verified live in a real browser).");
