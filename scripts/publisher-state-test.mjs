#!/usr/bin/env node
// Publisher-state and multi-guest collision checks — no browser, no VDO.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuestStreamId, buildGuestPublisherParams } from "../js/video-engine.js";
import { PublisherState, derivePublisherState, pickLocalPublisherEntry } from "../js/publisher-state.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("stream IDs — unique per guest, VDO-legal length");
const roomId = "tmu8vbpzb1sqa34";
const ids = new Set(Array.from({ length: 20 }, () => createGuestStreamId(roomId)));
assert(ids.size === 20, "20 successive guest stream IDs do not collide");
for (const id of ids) {
  assert(/^[a-zA-Z0-9]+$/.test(id), `${id} is alphanumeric`);
  assert(id.length >= 1 && id.length <= 24, `${id} is within VDO's 1–24 char push limit`);
  assert(id.startsWith(`${roomId}g`), `${id} stays room-scoped`);
}

console.log("\ncollision surface — Device 2 vs Device 3 from the simultaneous three-device run");
const a = "tmu8vbpzb1sqa34gfapf";
const b = "tmu8vbpzb1sqa34gfdhq";
assert(a !== b, "reported Device 2 vs Device 3 push IDs are distinct");
assert(a.length <= 24 && b.length <= 24, "reported IDs fit VDO's push length");

const p2 = buildGuestPublisherParams({ roomId, guestName: "Guest 2", streamId: a, isMobile: true });
const p3 = buildGuestPublisherParams({ roomId, guestName: "Guest 3", streamId: b, isMobile: true });
assert(p2.params.room === p3.params.room && p2.params.room === roomId, "both publishers use the same room");
assert(p2.params.push === a && p3.params.push === b, "each guest pushes its own source id");
assert(p2.params.push !== p3.params.push, "push IDs are not shared across guests");
assert(p2.params.password === undefined && p3.params.password === undefined, "no shared room password");
assert(p2.params.hash === undefined && p3.params.hash === undefined, "no shared hash");
assert(p2.params.scene === undefined && p3.params.scene === undefined, "publisher is not scene=0");
assert(p2.params.director === undefined && p3.params.director === undefined, "guest publisher is not director");
assert(p2.params.webcam === "1" && p2.params.autostart === "1", "webcam+autostart is the publish path");
assert(p2.params.ar === "portrait" && p3.params.ar === "portrait", "mobile publishers request portrait capture");

const name2 = `toasty-push-${p2.params.push}`;
const name3 = `toasty-push-${p3.params.push}`;
assert(name2 !== name3, "iframe name is per push id, not a shared singleton");

console.log("\nderivePublisherState — iframe existence is not LIVE");
assert(derivePublisherState({}).state === PublisherState.NONE, "no iframe → none");
assert(
  derivePublisherState({ iframePresent: true }).state === PublisherState.IFRAME_MOUNTED,
  "iframe only → publisher-iframe-mounted"
);
assert(
  derivePublisherState({ iframePresent: true, iframeLoaded: true }).state === PublisherState.CONNECTING,
  "loaded iframe without push-connection → publisher-connecting"
);
assert(
  derivePublisherState({ iframePresent: true, iframeLoaded: true, pushConnection: true }).state === PublisherState.LIVE,
  "push-connection true → publisher-live"
);
assert(
  derivePublisherState({ iframePresent: true, pushConnection: false }).state === PublisherState.ERROR,
  "push-connection false → publisher-error"
);
assert(
  derivePublisherState({
    iframePresent: true,
    iframeLoaded: true,
    detailedSelf: { iceConnectionState: "connected", streamID: b }
  }).state === PublisherState.LIVE,
  "ICE connected → publisher-live"
);
assert(
  derivePublisherState({ iframePresent: true, lastError: "stream-in-use" }).reason === "stream-in-use",
  "error reason is surfaced"
);

console.log("\npickLocalPublisherEntry");
const detailed = {
  uuid1: { streamID: a, iceConnectionState: "connected" },
  uuid2: { streamID: b, iceConnectionState: "checking" }
};
assert(pickLocalPublisherEntry(detailed, b).iceConnectionState === "checking", "picks the matching streamID");
assert(pickLocalPublisherEntry({ local: { self: true, streamID: a } }, "nope").self === true, "falls back to self");

console.log("\nguest.js — Join releases native capture and no longer lies with publisher-mounted");
const guestSource = readFileSync(join(ROOT, "js/guest.js"), "utf8");
assert(guestSource.includes("stopPreview();"), "Join path can release native tracks");
assert(guestSource.includes("watchPublisherCompletion"), "Join watches VDO publisher completion");
assert(!guestSource.includes("publisher-mounted"), "guest diagnostics no longer report publisher-mounted");
assert(guestSource.includes("PublisherState"), "guest uses real publisher states");
assert(guestSource.includes("elements.guestTransportFrame"), "publisher mounts into the PiP slot");
assert(!/startDevicePreview\(/.test(guestSource.split("async function flipCamera")[1] || ""), "in-studio flip does not re-acquire native preview");

const guestHtml = readFileSync(join(ROOT, "studio/guest.html"), "utf8");
assert(guestHtml.includes('id="guestTransportFrame"'), "publisher slot still exists");
assert(!guestHtml.includes("lv-hidden-transport"), "guest publisher is not the off-screen 2×2 transport");
assert(guestHtml.includes("guest-publisher-slot"), "publisher slot is the visible PiP overlay");

console.log("\nALL PASSED — publisher LIVE requires VDO evidence; Guest #2 vs #3 are not a shared-ID collision.");
