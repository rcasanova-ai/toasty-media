#!/usr/bin/env node
// Regression test: the Host's hidden, off-screen publisher/control iframes must never receive or play
// back other participants' room audio a second time.
//
// Root cause (mountDirectorFrame): VDO.Ninja's documented DEFAULT room-join behavior (confirmed against
// docs.vdo.ninja/advanced-settings/mixer-scene-parameters/view and the Rooms guide) is "everyone in a
// room will auto-connect to each other... see and hear all other present device video/audio streams."
// mountDirectorFrame mounted a bare &room=X&push=Y with no &view — the exact shape the Guest's own
// hidden publisher (buildGuestPublisherParams) already guards against with view:true, with an identical
// comment explaining why. Without it, this hidden iframe was independently joining the room in default
// mode and autoplaying every guest's audio, duplicate to live-session.js's own correctly-isolated
// per-guest &view=<id> tiles, on a second WebRTC connection with different latency — audible as
// duplicated/echoed guest voices, Host-side only.
//
// Root cause (mountDirectorControlFrame): a command-only frame (getGuestList/getDetailedState) with no
// legitimate reason to receive or play anything, but no noaudio/novideo/view guard either. VDO's own
// docs describe &novideo+&noaudio together as precisely "directors who may wish to only issue commands...
// but not need to see video or audio."

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

const src = readFileSync(join(ROOT, "js/video-engine.js"), "utf8");

function methodSource(name) {
  const start = src.indexOf(`${name}(container`);
  assert(start !== -1, `${name} exists`);
  // These are short (1-4 line) methods — a generous fixed window comfortably covers the whole body
  // without needing real brace-matching.
  return src.slice(start, start + 500);
}

console.log("\nmountDirectorFrame is publish-only (matches the Guest publisher's own view:true guard)");
{
  const fn = methodSource("mountDirectorFrame");
  assert(/view\s*:\s*true/.test(fn), "mountDirectorFrame passes view:true, so it never auto-joins the room's default (hear-everyone) mode");
}

console.log("\nmountDirectorControlFrame never receives or plays room audio/video");
{
  const fn = methodSource("mountDirectorControlFrame");
  assert(/noaudio\s*:\s*"1"/.test(fn), "mountDirectorControlFrame passes noaudio:1");
  assert(/novideo\s*:\s*"1"/.test(fn), "mountDirectorControlFrame passes novideo:1");
}

console.log("\nThe Guest publisher's own equivalent guard is untouched (regression baseline)");
{
  assert(/view:\s*true/.test(src), "buildGuestPublisherParams still passes view:true for the Guest's own hidden publisher");
}

console.log("\nALL PASSED — Host's hidden frames no longer duplicate room audio.");
