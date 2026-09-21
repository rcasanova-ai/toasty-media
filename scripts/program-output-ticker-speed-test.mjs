#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeTickerSpeed,
  tickerDurationSeconds,
  tickerPixelsPerSecond
} from "../js/program-ticker.js";
import { buildCanonicalState } from "../js/session-control.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("Program Output ticker speed semantics");
{
  assert(normalizeTickerSpeed(999) === 40, "ticker speed clamps to the supported upper bound");
  assert(normalizeTickerSpeed(-1) === 8, "ticker speed clamps to the supported lower bound");
  assert(tickerPixelsPerSecond(32) > tickerPixelsPerSecond(12), "higher ticker speed maps to faster pixels-per-second");

  const viewportWidth = 1280;
  const shortTextWidth = 420;
  const longTextWidth = 2200;
  const slow = tickerDurationSeconds({ speed: 10, viewportWidth, textWidth: shortTextWidth });
  const fast = tickerDurationSeconds({ speed: 32, viewportWidth, textWidth: shortTextWidth });
  assert(fast < slow, "higher slider value produces a shorter duration, not a slower crawl");
  assert(tickerDurationSeconds({ speed: 16, viewportWidth, textWidth: longTextWidth }) > tickerDurationSeconds({ speed: 16, viewportWidth, textWidth: shortTextWidth }), "longer ticker text gets more travel time");
  assert(tickerDurationSeconds({ speed: 16, viewportWidth, textWidth: shortTextWidth }) >= 12, "default readable ticker duration has a floor");

  const state = buildCanonicalState({
    roomId: "tmroom",
    ticker: { enabled: true, text: "Builder demo starts at 7 PM Bangkok", speed: 32 }
  });
  assert(state.ticker.speed === 32, "canonical program state preserves the Producer slider value");
}

console.log("\nProgram Output ticker rendering path");
{
  const listener = readFileSync(join(ROOT, "js/listener.js"), "utf8");
  const css = readFileSync(join(ROOT, "css/program-output.css"), "utf8");
  assert(listener.includes("tickerDurationSeconds"), "listener computes ticker duration from speed and measured width");
  assert(listener.includes("scrollWidth"), "listener measures actual ticker text width");
  assert(listener.includes("--po-ticker-start") && listener.includes("--po-ticker-end"), "listener writes viewport/text travel offsets");
  assert(!/programState\.ticker\?\.speed[^;]+s`\)/.test(listener), "listener no longer treats ticker speed as seconds");
  assert(css.includes("var(--po-ticker-start") && css.includes("var(--po-ticker-end"), "ticker keyframes use measured travel offsets");
}

console.log("\nAll Program Output ticker speed checks passed.");
