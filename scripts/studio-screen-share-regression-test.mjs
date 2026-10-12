#!/usr/bin/env node
// Regression guard for the Studio screen-share + simplified-controls fix.
// IMPORTANT: this is a static/unit test. It does NOT prove a real browser can capture a screen; that needs
// the manual test in docs (real getDisplayMedia, real picker, macOS Screen Recording permission).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { VideoEngine } from "../js/video-engine.js";
import { screenPublisherEndedMessage } from "../js/screen-share-source.js";
import { screenShareTimeoutReason } from "../js/live-session.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => readFileSync(join(ROOT, f), "utf8");
const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };

console.log("Screen publisher is user-clickable (user activation reaches the frame that calls getDisplayMedia)");
{
  const calls = [];
  const engine = Object.create(VideoEngine.prototype);
  engine.mountFrame = (c, id, params) => { calls.push({ id, params }); };
  engine.mountScreenPublisher({}, { roomId: "r", streamId: "s", interactive: true });
  engine.mountScreenPublisher({}, { roomId: "r", streamId: "s" });
  assert(calls[0].id === "screen-push" && calls[0].params.screenshare === "1" && calls[0].params.webcam === "0", "separate screen-push frame, camera untouched");
  assert(!("autostart" in calls[0].params) && !("cleanoutput" in calls[0].params), "interactive publisher has no autostart/cleanoutput (VDO shows its own share button)");
  assert(calls[1].params.autostart === "1", "non-interactive default unchanged");
}

console.log("\\nFailure reasons are honest");
{
  const timeout = screenShareTimeoutReason(null);
  assert(!/cancelled or blocked/.test(timeout), "timeout no longer claims 'cancelled or blocked'");
  assert(/macOS/.test(timeout) && /Screen/.test(timeout), "timeout names the macOS Screen Recording permission");
  assert(/NotAllowedError|denied by system/.test(screenShareTimeoutReason({ error: "NotAllowedError: Permission denied by system" })), "real VDO error is included");
  assert(screenPublisherEndedMessage({ action: "push-connection", value: false }), "user cancel / track end message is recognised");
  assert(screenPublisherEndedMessage({ action: "stream-ended" }), "stream-ended (shared window closed) is recognised");
  assert(!screenPublisherEndedMessage({ action: "push-connection", value: true }), "successful connect is not an end");
}

console.log("\\nLive session wiring");
{
  const ls = read("js/live-session.js");
  assert(/SCREEN_SHARE_CONNECT_TIMEOUT_MS = 120000/.test(ls), "timeout is human-speed (picker), not 15s");
  assert(ls.includes("interactive: true"), "host share mounts the interactive publisher");
  assert(ls.includes("_closeScreenSharePanel") && /_confirmScreenShare\(\) \{[\s\S]*?_closeScreenSharePanel/.test(ls), "panel closes on confirm");
  assert(/_failScreenShare\(reason\) \{[\s\S]*?_closeScreenSharePanel/.test(ls), "panel closes on failure");
  assert(/async stopScreenShare\(\) \{[\s\S]*?_closeScreenSharePanel/.test(ls) && ls.includes("track.stop()"), "stop closes panel and stops tracks");
  assert(/stopScreenShare\(\)[\s\S]*?this\.program\.layout = restore\.layout/.test(ls), "previous layout restored when sharing stops");
  assert(ls.includes("message.error || message.failed"), "VDO error while connecting fails immediately with the real reason");
  assert(/screenShare\?\.state === ScreenShareState\.BINDING\) \{\s*await this\.stopScreenShare/.test(ls), "clicking while connecting cancels");
}

console.log("\\nSimplified controls");
{
  const html = read("studio/director.html");
  assert(!html.includes("lv-workspace-tabs") && !/<button[^>]*data-producer-workspace/.test(html), "Production/Focus Group/Moxie tab strip removed from main interface");
  assert(!html.includes('id="lvTopGoLive"'), "no duplicate top-bar Go Live");
  assert(!html.includes('id="lvTopRecord"') && !html.includes('id="lvTopShareScreen"'), "no duplicate hidden Record/Share buttons");
  const bar = html.slice(html.indexOf('class="lv-bottom-bar"'));
  for (const id of ["lvToggleMic", "lvToggleCamera", "lvToggleScreen", "lvRecordToggle", "lvBottomGoLive", "lvBottomProgramOutput", "lvLeaveStudio"]) assert(bar.includes(`id="${id}"`), `${id} lives in the one control bar`);
}

console.log("\\nConsistent 16:9 canvas");
{
  const css = read("css/program-output.css");
  assert(/\.po-canvas \{[\s\S]*?width: min\(100vw, calc\(100vh \* 16 \/ 9\)\)/.test(css) && /height: min\(100vh, calc\(100vw \* 9 \/ 16\)\)/.test(css), "program canvas is a fixed 16:9 letterbox");
  assert(/data-layout="1"\] \.po-tile \{\s*aspect-ratio: 16 \/ 9/.test(css), "solo tile is 16:9, not 4:3");
}
console.log("\\nPASS (static checks only; real capture needs the manual test)");
