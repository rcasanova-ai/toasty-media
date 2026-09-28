#!/usr/bin/env node
// Architecture-assertion test for the Jam Lobby + Join Flow (peeps/jam-invite.html -> peeps/room.html) —
// same style as scripts/microphone-capture-chain-test.mjs: no server, no browser, grep the real source for
// the specific contracts the brief requires. Covers:
//   - the Lobby's device preview uses the canonical clean mic constraint (not another mic implementation)
//   - the Lobby gates Join Jam on name + consent + a working preview, with the brief's exact consent copy
//   - device preferences are handed off to room.html, not silently dropped
//   - room.html is a genuinely public page (moved out of the gated peeps/app/ tree)
//   - the existing Studio guest flow (js/guest.js) is untouched by any of this
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(ROOT, path), "utf8");
function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("\nJam Lobby loads Jam details from the existing invite API (no duplicate Jam data model)");
{
  const lobby = read("js/peeps-jam-invite-page.js");
  assert(lobby.includes('import { getJamInvite, acceptJamInvite, submitJamConsent } from "./peeps-jam-api.js"'), "Lobby reuses the existing Jam invite API client, not a new one");
  assert(lobby.includes("jam.organizationName"), "Lobby displays the host/organization from the existing invite response");
  assert(lobby.includes("jam.objective"), "Lobby displays the Jam's purpose/description when available");
}

console.log("\nDevice preview reuses existing Studio device-picker + the canonical clean mic constraint");
{
  const lobby = read("js/peeps-jam-invite-page.js");
  assert(lobby.includes('import { getUserMediaWithFallback, deviceConstraint, hydrateDevices, selectedDeviceLabel, isCamoCamera } from "./device-picker.js"'), "Lobby reuses device-picker.js's enumeration/hydration/Camo-avoidance, not a reimplementation");
  assert(lobby.includes('import { cleanMicAudioConstraint, createMicMeter } from "./microphone-capture.js"'), "Lobby reuses the canonical mic capture module from 6e99ec4, not a second implementation");
  assert(lobby.includes("audio: cleanMicAudioConstraint(micId)"), "Lobby's preview requests audio with the canonical clean mic constraint");
  assert(!lobby.includes('deviceConstraint(') || !/deviceConstraint\([^,]*,\s*"audio"\)/.test(lobby), "Lobby never falls back to device-picker's raw/pro-audio constraint for its own preview");
  assert(lobby.includes("createMicMeter(stream"), "Lobby shows a live microphone level meter");
  assert(lobby.includes('$("cameraToggle")') && lobby.includes('$("micToggle")'), "Lobby exposes camera on/off and mic mute/unmute controls");
}

console.log("\nConsent — exact required checkbox copy, smallest persistence (the existing consent endpoint)");
{
  const html = read("peeps/jam-invite.html");
  assert(html.includes("I consent to participating in this Jam and understand that the session may be recorded and used to create session insights and artifacts."), "Lobby shows the exact required consent copy");
  assert((html.match(/type="checkbox"/g) || []).length === 1, "the Lobby offers exactly one consent checkbox, not the old multi-key checklist wizard");
  const lobby = read("js/peeps-jam-invite-page.js");
  assert(lobby.includes("submitJamConsent(token"), "consent is persisted through the existing Jam consent endpoint, not a new persistence mechanism");
  assert(lobby.includes("RequiredConsentKey.RECORDING"), "the single checkbox is mapped onto the existing consent-key model, including recording consent");
}

console.log("\nJoin Jam is gated on name + consent + invite + working preview (brief's REQUIREMENTS 2/5)");
{
  const lobby = read("js/peeps-jam-invite-page.js");
  assert(/updateJoinEnabled[\s\S]{0,400}nameOk[\s\S]{0,50}consentOk[\s\S]{0,50}previewStream/.test(lobby), "Join Jam stays disabled until name, consent, and a working device preview are all present");
  assert(lobby.includes('$("displayName").addEventListener("input", updateJoinEnabled)'), "typing a name re-evaluates whether Join Jam can be enabled");
  assert(lobby.includes('$("consentCheckbox").addEventListener("change", updateJoinEnabled)'), "checking consent re-evaluates whether Join Jam can be enabled");
}

console.log("\nInvalid invites show a Peeps-branded state, not a raw API error");
{
  const html = read("peeps/jam-invite.html");
  const lobby = read("js/peeps-jam-invite-page.js");
  assert(html.includes('id="stepError"'), "a dedicated error step exists in the Lobby shell");
  assert(lobby.includes("No invite token was provided"), "a missing token gets Peeps-branded copy, not a raw fetch error");
  assert(lobby.includes('jam.status === "canceled"'), "a canceled Jam is handled explicitly (Jam unavailable/closed)");
  assert(lobby.includes("This Jam is no longer available."), "a Jam that no longer resolves gets Peeps-branded copy");
}

console.log("\nDevice preferences (camera, mic, on/off state) and the name survive the handoff into the room");
{
  const lobby = read("js/peeps-jam-invite-page.js");
  assert(/sessionStorage\.setItem\(`toasty:jam:\$\{jam\.id\}:devicePrefs`/.test(lobby), "device prefs are stored keyed by this specific Jam's id");
  assert(lobby.includes("cameraLabel: selectedDeviceLabel"), "the selected camera's raw device label is preserved for handoff");
  assert(lobby.includes("microphoneLabel: selectedDeviceLabel"), "the selected microphone's raw device label is preserved for handoff");
  assert(lobby.includes("micMuted,\n      cameraOff") || (lobby.includes("micMuted") && lobby.includes("cameraOff")), "mic/camera on-off state is preserved for handoff");
  assert(lobby.includes("`./room.html?jam=${encodeURIComponent(jam.id)}&invite=${encodeURIComponent(token)}`"), "Join Jam hands off into room.html carrying the jam id and invite token, not a new video-room page");

  const room = read("js/peeps-room.js");
  assert(room.includes('import { studioApiEndpoint } from "./studio-api.js"'), "room.html's controller targets the API's real origin (render.toasty.media), not location.origin — peeps pages and the Jam API are served from different hosts in production");
  assert(room.includes("readDevicePrefs"), "room.html's controller reads the Lobby's stored device prefs");
  assert(room.includes("sessionStorage.getItem(`toasty:jam:${jamId}:devicePrefs`)"), "room.html reads prefs keyed by the same jam id the Lobby wrote them under");
  assert(room.includes("videoDeviceLabel:devicePrefs?.cameraLabel") || room.includes("videoDeviceLabel:devicePrefs?.cameraLabel,audioDeviceLabel:devicePrefs?.microphoneLabel"), "the chosen camera is carried into the existing Studio guest mount (mountGuestFrame), not a new video-room implementation");
  assert(room.includes("audioDeviceLabel:devicePrefs?.microphoneLabel"), "the chosen microphone is carried into the existing Studio guest mount");
  assert(room.includes("micMuted:Boolean(devicePrefs?.micMuted)"), "the mic mute preference is carried into the existing Studio guest mount");
  assert(room.includes("if(!cameraOn)engine.setGuestCamera(false)"), "a camera-off preference from the Lobby is applied once the room is joined");
}

console.log("\nroom.html is genuinely public — moved out of the gated peeps/app/ tree, not just unlinked");
{
  assert(existsSync(join(ROOT, "peeps/room.html")), "peeps/room.html exists");
  assert(!existsSync(join(ROOT, "peeps/app/room.html")), "the old gated peeps/app/room.html no longer exists (no duplicate room page)");
  const room = read("peeps/room.html");
  assert(!room.includes("peeps-app-gate.js"), "the public Jam room does not load the authenticated-app session gate");
  assert(!room.includes("peeps-app-gated"), "the public Jam room is not fail-closed hidden pending a Toasty account session");
  assert(room.includes('src="../js/peeps-room.js"'), "the public Jam room still wires up the existing peeps-room.js controller");
}

console.log("\nExisting Studio guest flow is untouched by the Lobby work");
{
  const guest = read("js/guest.js");
  assert(guest.includes('import { startDevicePreview, selectedDeviceLabel, classifyCameraFacing } from "./device-picker.js"'), "js/guest.js still uses its own existing device-picker integration, unmodified");
  assert(guest.includes('import { cleanMicSettings, createCleanMicMeterPair } from "./microphone-capture.js"'), "js/guest.js still uses its own existing microphone-capture integration, unmodified");
}

console.log("\nALL PASSED — Jam Lobby + Join Flow.");
