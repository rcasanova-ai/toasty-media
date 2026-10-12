#!/usr/bin/env node
// Regression guard for Studio "Present". Runs LiveSession.startScreenShare against a fake
// navigator.mediaDevices.getDisplayMedia, so it proves the wiring (one picker call from the click, no camera
// request, camera stream untouched, cancel/deny/error handling, track-ended restore). It does NOT prove a
// real browser captures a screen; that needs the manual test.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveSession, screenCaptureErrorReason, isScreenCaptureCancel } from "../js/live-session.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };

function fakeTrack() { const l = {}; return { readyState: "live", kind: "video", stop() { this.readyState = "ended"; }, addEventListener: (e, f) => { l[e] = f; }, end() { this.readyState = "ended"; l.ended?.(); } }; }
function fakeStream(track) { return { getVideoTracks: () => [track], getTracks: () => [track] }; }
function setup(getDisplayMedia) {
  const calls = { display: 0, user: 0 };
  Object.defineProperty(globalThis, "navigator", { configurable: true, writable: true, value: { mediaDevices: { getDisplayMedia: async (c) => { calls.display++; calls.constraint = c; return getDisplayMedia(); }, getUserMedia: async () => { calls.user++; throw new Error("camera requested"); } } } });
  const ls = Object.create(LiveSession.prototype);
  const camera = { id: "cam", getTracks: () => [] };
  Object.assign(ls, {
    _hostPreviewStream: camera, hostProfile: { displayName: "Host" }, roomId: "r",
    program: { compositionMode: "balanced", spotlightParticipantId: null, layout: "grid", shareLayout: null },
    engine: { send() {}, frames: new Map(), unmountFrame() {} },
    timeline: { record() {} }, events: [],
    emit(n, v) { this.events.push([n, v?.state]); }, exposeProgramSources() {}, _publishControlNow() {}, _syncProgramPreview() {}, presence: null
  });
  return { ls, calls, camera };
}

console.log("Present opens the native picker and shows the screen as the main source");
{
  const track = fakeTrack(); const { ls, calls, camera } = setup(() => fakeStream(track));
  await ls.startScreenShare();
  assert(calls.display === 1 && calls.user === 0, "one getDisplayMedia call, no camera request");
  assert(calls.constraint.video === true && calls.constraint.audio === false, "video-only display capture");
  assert(ls.screenShare.active && ls.screenShare.state === "bound" && ls.screenShare.stream, "screen is active with a native stream");
  assert(ls.program.layout === ls.program.shareLayout && ls.program.shareLayout, "program switches to the screen + camera layout");
  assert(ls._hostPreviewStream === camera, "existing camera stream is reused, not replaced or duplicated");
  assert(!ls.engine.frames.has("screen-push"), "no second VDO participant/publisher frame created");
  await ls.startScreenShare(); assert(calls.display === 1, "second click while active does not open another picker");
  track.end();
  assert(!ls.screenShare.active && ls.program.layout === "grid" && ls.program.shareLayout === null, "ending the shared screen restores the previous (camera-only) layout");
  assert(ls.screenShare.stream === null, "stream released after stop");
}

console.log("\nCancellation, denial and errors");
for (const [name, message, cancel, text] of [
  ["NotAllowedError", "Permission denied", true, /cancelled/],
  ["AbortError", "aborted", true, /cancelled/],
  ["NotAllowedError", "Permission denied by system", false, /macOS blocked/],
  ["NotFoundError", "none", false, /No screen/],
  ["NotReadableError", "busy", false, /could not be read/]
]) {
  const { ls } = setup(() => { const e = new Error(message); e.name = name; throw e; });
  await ls.startScreenShare();
  assert(!ls.screenShare.active && ls.screenShare.stream === null, `${name} "${message}" leaves no share active`);
  assert(isScreenCaptureCancel({ name, message }) === cancel && text.test(screenCaptureErrorReason({ name, message })), `${name} "${message}" -> accurate message, cancel=${cancel}`);
  assert(cancel ? ls.screenShare.state === "ended" : ls.screenShare.state === "failed", "cancel is silent; real failures are surfaced");
}
{
  const { ls } = setup(() => null); globalThis.navigator.mediaDevices.getDisplayMedia = undefined;
  await ls.startScreenShare();
  assert(ls.screenShare.state === "failed" && /can't share a screen/.test(ls.screenShare.reason), "missing screen source reports unsupported browser");
}

console.log("\nControls and canvas");
{
  const html = read("studio/director.html");
  assert(!/<button[^>]*data-producer-workspace/.test(html), "no Production/Focus Group/Moxie tab strip");
  assert(!html.includes('id="lvTopGoLive"') && !html.includes('id="lvTopRecord"') && !html.includes('id="lvTopShareScreen"'), "no duplicate Record/Go Live/Share buttons");
  const bar = html.slice(html.indexOf('class="lv-bottom-bar"'));
  for (const id of ["lvToggleMic", "lvToggleCamera", "lvToggleScreen", "lvRecordToggle", "lvBottomGoLive", "lvBottomProgramOutput", "lvLeaveStudio"]) assert(bar.includes(`id="${id}"`), `${id} in the one control bar`);
  const css = read("css/program-output.css");
  assert(/width: min\(100vw, calc\(100vh \* 16 \/ 9\)\)/.test(css) && /height: min\(100vh, calc\(100vw \* 9 \/ 16\)\)/.test(css), "program canvas is fixed 16:9");
  assert(/data-layout="1"\] \.po-tile \{\s*aspect-ratio: 16 \/ 9/.test(css), "solo tile is 16:9");
  const listener = read("js/listener.js");
  assert(listener.includes("screenStream") && read("js/live-session.js").includes("screenStream: () => this.screenShare?.stream"), "Program Output receives the native screen stream from the Studio page");
}
console.log("\nPASS (wiring only; real capture needs the manual test)");
