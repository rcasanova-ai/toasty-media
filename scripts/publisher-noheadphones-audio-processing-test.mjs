#!/usr/bin/env node
// Regression test: every VDO.Ninja publisher (Host's mountDirectorFrame, Guest's
// buildGuestPublisherParams) requests VDO's own &noheadphones (nhp) parameter — a real, documented
// parameter (confirmed by reading VDO.Ninja's own main.js source: urlParams.has("noheadphones") ||
// urlParams.has("nhp") forces echoCancellation/autoGainControl/noiseSuppression on, plus
// voiceIsolation/noisegate), specifically built for "speaker-based setups without headphones" — the
// acceptance bar for this fix (four people, normal laptop/phone mics and speakers, no headphones
// required). Toasty's own native prejoin preview requests AEC/NS/AGC on its getUserMedia call, but that
// only ever configures the LOCAL PREVIEW stream — VDO's publisher independently re-acquires the same
// physical mic for actual publishing and needs to be told the same thing, in its own vocabulary.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGuestPublisherParams } from "../js/video-engine.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("\nHost's publisher (mountDirectorFrame) requests noheadphones audio processing");
{
  const src = readFileSync(join(ROOT, "js/video-engine.js"), "utf8");
  const start = src.indexOf("mountDirectorFrame(container");
  assert(start !== -1, "mountDirectorFrame exists");
  const fn = src.slice(start, start + 500);
  assert(/nhp\s*:\s*"1"/.test(fn), "mountDirectorFrame passes nhp:\"1\"");
}

console.log("\nGuest's publisher (buildGuestPublisherParams) requests noheadphones audio processing");
{
  const { params } = buildGuestPublisherParams({ roomId: "tmroom", guestName: "Tukta" });
  assert(params.nhp === "1", "buildGuestPublisherParams sets nhp:\"1\" (behavioral, actual return value)");
  // Every guest still gets their own distinct push id — this param must not collapse per-guest identity.
  const a = buildGuestPublisherParams({ roomId: "tmroom", guestName: "Guest A" });
  const b = buildGuestPublisherParams({ roomId: "tmroom", guestName: "Guest B" });
  assert(a.streamId !== b.streamId, "two guests in the same room still get distinct push ids with nhp present");
}

console.log("\nALL PASSED — every VDO publisher asks for speaker-safe audio processing.");
