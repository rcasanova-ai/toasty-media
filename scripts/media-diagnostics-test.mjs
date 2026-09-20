#!/usr/bin/env node
// Unit tests for js/media-diagnostics.js — no browser, no credentials. Proves the overlay formatter
// is default-off, redacts secret-looking keys, and prints the presence vs publish fields the next
// three-device test has to fill in.
import { isDebugMediaEnabled, sanitizeDiagnostics, formatDiagnostics, formatPresenceBoard, heartbeatLabel, trackSnapshot, startMediaDiagnostics } from "../js/media-diagnostics.js";
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

console.log("\npresence board — Host + Guest + Output, same session, LIVE heartbeats");
const now = 1_747_000_000_000;
const sameSession = {
  sessionId: "sess-live-1",
  roomId: "tmroomlive",
  roster: [
    { role: "host", participantId: "host", lastSeenAt: now - 800, sessionId: "sess-live-1", roomId: "tmroomlive" },
    { role: "guest", participantId: "guest-1", lastSeenAt: new Date(now - 1200).toISOString(), sessionId: "sess-live-1", roomId: "tmroomlive" }
  ],
  outputs: [
    { role: "output", outputId: "output-1", connection: "connected", lastSeenAt: now - 500, sessionId: "sess-live-1", roomId: "tmroomlive" }
  ]
};
const board = formatPresenceBoard(sameSession, now);
assert(board.includes("session sess-live-1"), "prints sessionId");
assert(board.includes("room tmroomlive"), "prints roomId");
assert(board.includes("host host hb LIVE 0.8s"), "host heartbeat is LIVE");
assert(/guest guest-1 hb LIVE /.test(board), "guest heartbeat is LIVE (ISO lastSeenAt from SQLite)");
assert(board.includes("output output-1 connected hb LIVE 0.5s"), "output heartbeat is LIVE");
assert(!board.includes("MISSING"), "no role is missing when Host+Guest+Output are present");
assert(!board.includes("MISMATCH"), "same roomId/sessionId does not flag a mismatch");
assert(formatDiagnostics(sameSession).includes("— PRESENCE —"), "overlay formatter includes the presence board");

const missing = formatPresenceBoard({ sessionId: "sess-empty", roomId: "tmempty", roster: [], outputs: [] }, now);
assert(missing.includes("host MISSING"), "host MISSING when roster has no host");
assert(missing.includes("guest MISSING"), "guest MISSING when roster has no guest");
assert(missing.includes("output MISSING"), "output MISSING when no Program Output heartbeat");

const mismatched = formatPresenceBoard({
  sessionId: "sess-a",
  roomId: "room-a",
  roster: [
    { role: "host", participantId: "host", lastSeenAt: now, sessionId: "sess-a", roomId: "room-a" },
    { role: "guest", participantId: "guest-1", lastSeenAt: now, sessionId: "sess-b", roomId: "room-b" }
  ],
  outputs: [
    { role: "output", outputId: "output-1", lastSeenAt: now, sessionId: "sess-a", roomId: "room-a" }
  ]
}, now);
assert(mismatched.includes("ROOM MISMATCH"), "flags members on a different roomId");
assert(mismatched.includes("SESSION MISMATCH"), "flags members on a different sessionId");

assert(heartbeatLabel(now - 1000, now) === "LIVE 1.0s", "≤4s is LIVE");
assert(heartbeatLabel(now - 5000, now) === "STALE 5.0s", "≤8s is STALE");
assert(heartbeatLabel(now - 9000, now) === "DEAD 9.0s", ">8s is DEAD");
assert(heartbeatLabel(null, now) === "NO-HB", "missing heartbeat is NO-HB");

const localOutput = formatPresenceBoard({
  role: "output",
  sessionId: "sess-live-1",
  roomId: "tmroomlive",
  self: { participantId: "output-1", lastAnnounceAt: now - 200 },
  roster: [
    { role: "host", participantId: "host", lastSeenAt: now - 800, sessionId: "sess-live-1", roomId: "tmroomlive" },
    { role: "guest", participantId: "guest-1", lastSeenAt: now - 700, sessionId: "sess-live-1", roomId: "tmroomlive" }
  ],
  outputs: [
    { role: "output", outputId: "output-1", participantId: "output-1", connection: "connected", sessionId: "sess-live-1", roomId: "tmroomlive" }
  ]
}, now);
assert(localOutput.includes("output output-1 connected hb LIVE 0.2s"), "Program Output overlay uses its own lastAnnounceAt when server lastSeenAt is still catching up");

console.log("\nfail-open — diagnostics must not throw into Join");
const failedOpen = startMediaDiagnostics(() => ({ role: "guest" }));
assert(typeof failedOpen.stop === "function", "startMediaDiagnostics returns a stop handle without window/document");

console.log("\nstatic import — Guest/Host/Program Output module graph must not depend on media-diagnostics.js");
for (const relative of ["js/guest.js", "js/director.js", "js/live-session.js", "js/listener.js"]) {
  const source = readFileSync(join(ROOT, relative), "utf8");
  const staticImport = source.match(/^import\s+[^;]*from\s+["']\.\/media-diagnostics\.js["'];/m);
  assert(!staticImport, `${relative} has no static import of media-diagnostics.js`);
}
const listener = readFileSync(join(ROOT, "js/listener.js"), "utf8");
assert(listener.includes("startOutputDebugMedia"), "Program Output mounts the debug overlay");
assert(listener.includes("outputDiagnosticsSnapshot"), "Program Output snapshot feeds the presence board");
const poCss = readFileSync(join(ROOT, "css/program-output.css"), "utf8");
assert(poCss.includes("#toastyMediaDiagnostics"), "Program Output stylesheet styles the overlay");
assert(/#toastyMediaDiagnostics[\s\S]*z-index:\s*9999/.test(poCss), "overlay z-index sits above the audio gate");
const engine = readFileSync(join(ROOT, "js/video-engine.js"), "utf8");
assert(engine.includes("copyDebugMediaFlag"), "invite URLs copy debugMedia onto Guest and Program Output");
assert(engine.includes("getGuestInviteUrl") && engine.includes("getListenerInviteUrl"), "both invite helpers exist");

console.log("\nALL PASSED — media diagnostics stay default-off, non-secret, and fail-open.");
