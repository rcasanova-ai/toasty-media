#!/usr/bin/env node
// Unit tests for js/media-diagnostics.js — no browser, no credentials. Proves the overlay formatter
// is default-off, redacts secret-looking keys, and prints the presence vs publish fields the next
// three-device test has to fill in.
import { isDebugMediaEnabled, sanitizeDiagnostics, formatDiagnostics, trackSnapshot, startMediaDiagnostics } from "../js/media-diagnostics.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("debugMedia flag");
assert(isDebugMediaEnabled("?debugMedia=1") === true, "?debugMedia=1 enables diagnostics");
assert(isDebugMediaEnabled("?room=abc") === false, "missing flag stays off");
assert(isDebugMediaEnabled("?debugMedia=0") === false, "?debugMedia=0 stays off");
assert(isDebugMediaEnabled("?debugMedia=true") === false, "only the exact value 1 enables it");

console.log("\nsanitize — never leak credentials");
const sanitized = sanitizeDiagnostics({
  participantId: "guest-abc",
  token: "SECRET",
  accessToken: "SECRET",
  password: "SECRET",
  cookie: "SECRET",
  authorization: "SECRET",
  nested: { refreshToken: "SECRET", heartbeatStatus: "ok" }
});
assert(sanitized.participantId === "guest-abc", "keeps non-secret fields");
assert(sanitized.token === undefined, "drops token");
assert(sanitized.accessToken === undefined, "drops accessToken");
assert(sanitized.password === undefined, "drops password");
assert(sanitized.cookie === undefined, "drops cookie");
assert(sanitized.authorization === undefined, "drops authorization");
assert(sanitized.nested.refreshToken === undefined, "drops nested refreshToken");
assert(sanitized.nested.heartbeatStatus === "ok", "keeps nested heartbeatStatus");

console.log("\nsanitize — never leak deviceIds");
const noDevice = sanitizeDiagnostics({ facingMode: "user", deviceId: "deadbeefcamera" });
assert(noDevice.facingMode === "user", "keeps facingMode");
assert(noDevice.deviceId === undefined, "drops deviceId");

console.log("\nformat — matrices the next test will fill");
const text = formatDiagnostics({
  buildId: "test",
  role: "guest",
  roomId: "tmroom",
  lifecycle: "in-studio",
  self: {
    participantId: "guest-3",
    presenceState: "admitted",
    heartbeatStatus: "ok",
    lastHttpStatus: 200,
    rosterContainsSelf: true,
    transportSourceId: "tmroomgabc1",
    publisherSourceId: "tmroomgabc1",
    videoTrack: { readyState: "live", width: 720, height: 1280, aspectRatio: 0.5625, facingMode: "user" },
    audioTrack: { readyState: "live" },
    transportState: "publisher-live",
    publisherReason: "push-connection",
    requested: { video: "facingMode:user" },
    nativePreview: { videoWidth: 720, videoHeight: 1280, clientWidth: 120, clientHeight: 90, objectFit: "cover" },
    vdoAr: "portrait"
  },
  remotes: [
    { participantId: "host", role: "host", requestedSourceId: "tmroomh", mounted: true, mediaState: "iframe-mounted" },
    { participantId: "guest-2", role: "guest", requestedSourceId: "tmroomgdef", mounted: true, mediaState: "iframe-mounted" }
  ],
  host: {
    vdoGuestCount: 1,
    presenceGuestCount: 2,
    uiGuestCount: 1,
    vdoGuestIds: ["tmroomgdef"],
    presenceIds: ["guest-2", "guest-3"],
    presenceNotInVdo: ["tmroomgabc1"]
  }
});
assert(text.includes("rosterHasSelf yes"), "prints whether server roster contains self");
assert(text.includes("src tmroomgabc1"), "prints transport source id");
assert(text.includes("pub tmroomgabc1"), "prints publisher source id");
assert(text.includes("720x1280"), "prints actual track dimensions");
assert(text.includes("face=user"), "prints facingMode");
assert(text.includes("fit=cover"), "prints preview object-fit");
assert(text.includes("transport publisher-live"), "prints real publisher completion state, not iframe-mounted");
assert(text.includes("pubReason push-connection"), "prints why publisher is live");
assert(text.includes("presence∉vdo tmroomgabc1"), "prints presence-not-in-vdo mismatch");
assert(!/SECRET|token|password|cookie/i.test(text), "formatted text has no secret-looking values");

console.log("\ntrackSnapshot — missing stream is explicit, not thrown");
assert(trackSnapshot(null, "video").readyState === "missing", "null stream → missing");
assert(trackSnapshot({ getTracks: () => [] }, "audio").readyState === "missing", "empty tracks → missing");

console.log("\nfail-open — diagnostics must not throw into Join");
const failedOpen = startMediaDiagnostics(() => ({ role: "guest" }));
assert(typeof failedOpen.stop === "function", "startMediaDiagnostics returns a stop handle without window/document");

console.log("\nstatic import — Guest/Host module graph must not depend on media-diagnostics.js");
for (const relative of ["js/guest.js", "js/director.js", "js/live-session.js"]) {
  const source = readFileSync(join(ROOT, relative), "utf8");
  const staticImport = source.match(/^import\s+[^;]*from\s+["']\.\/media-diagnostics\.js["'];/m);
  assert(!staticImport, `${relative} has no static import of media-diagnostics.js`);
}

console.log("\nALL PASSED — media diagnostics stay default-off, non-secret, and fail-open.");
