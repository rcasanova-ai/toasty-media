#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeProgram, ProgramLayout } from "../js/program-composition.js";
import { serializeProgramParticipant, programLayoutCount, programFeedBindings, inspectSourceHealth } from "../js/program-renderer.js";
import { createParticipant, ParticipantRole, ConnectionStatus, SourceKind } from "../js/participant-registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

console.log("serializeProgramParticipant — JSON-safe, no MediaStream");
const host = createParticipant({
  participantId: "host",
  role: ParticipantRole.HOST,
  displayName: "Ricardo",
  title: "Host",
  company: "Toasty",
  connectionStatus: ConnectionStatus.CONNECTED,
  videoSource: { kind: SourceKind.NATIVE_MEDIA_STREAM, stream: { fake: true } },
  transportSourceId: "tmroomh",
  joinedAt: 1
});
const serialized = serializeProgramParticipant(host);
assert(!("videoSource" in serialized), "drops native MediaStream");
assert(!("audioSource" in serialized), "drops audio MediaStream");
assertEqual(serialized.transportSourceId, "tmroomh", "keeps VDO source id");
assertEqual(serialized.displayName, "Ricardo", "keeps name");
assertEqual(serialized.company, "Toasty", "keeps company");
JSON.stringify(serialized);

console.log("\ncomposeProgram from serialized slots matches live registry");
const guest = createParticipant({
  participantId: "g2",
  role: ParticipantRole.GUEST,
  displayName: "Tukta",
  title: "CEO",
  company: "Acme",
  connectionStatus: ConnectionStatus.CONNECTED,
  transportSourceId: "tmroomgabc",
  joinedAt: 2
});
const live = composeProgram([host, guest]);
const fromSync = composeProgram([serializeProgramParticipant(host), serializeProgramParticipant(guest)]);
assertEqual(fromSync.layout, ProgramLayout.DUO, "serialized duo layout");
assertEqual(fromSync.layout, live.layout, "listener composition matches director composition");
assertEqual(fromSync.slots.map((s) => s.participantId).join(","), "host,g2", "host first, guest second");
assertEqual(programLayoutCount(fromSync.layout), "2", "duo maps to stage data-layout=2");
assertEqual(programLayoutCount("single"), "1", "single → 1");
assertEqual(programLayoutCount("trio"), "3", "trio → 3");
assertEqual(programLayoutCount("quad"), "4", "quad → 4");

console.log("\n1/2/3/4 professional layouts");
assertEqual(composeProgram([host]).layout, ProgramLayout.SINGLE, "1 → single");
assertEqual(composeProgram([host, guest]).layout, ProgramLayout.DUO, "2 → duo");
const g3 = createParticipant({
  participantId: "g3",
  role: ParticipantRole.GUEST,
  displayName: "Pat",
  connectionStatus: ConnectionStatus.CONNECTED,
  transportSourceId: "tmroomgdef",
  joinedAt: 3
});
assertEqual(composeProgram([host, guest, g3]).layout, ProgramLayout.TRIO, "3 → trio");
const g4 = createParticipant({
  participantId: "g4",
  role: ParticipantRole.GUEST,
  displayName: "Lee",
  connectionStatus: ConnectionStatus.CONNECTED,
  transportSourceId: "tmroomgghi",
  joinedAt: 4
});
assertEqual(composeProgram([host, guest, g3, g4]).layout, ProgramLayout.QUAD, "4 → quad");

console.log("\nsource inspection — first slice does not use visible scene=0");
const listener = readFileSync(join(ROOT, "js/listener.js"), "utf8");
assert(!listener.includes("mountProgramFrame"), "listener no longer mounts scene=0 program frame");
assert(listener.includes("syncProgramRenderer"), "listener uses the Program Renderer");
assert(!listener.includes("poLiveBadge"), "top-right LIVE badge is gone from listener JS");

const liveSession = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
assert(liveSession.includes("serializeProgramParticipant"), "ProgramSync publishes participant slots");
assert(!/mountRoomFrame\(this\._containers\.roomPreview/.test(liveSession), "setLayout does not remount scene=0 onto the Host participant stage");

const directorJs = readFileSync(join(ROOT, "js/director.js"), "utf8");
assert(directorJs.includes("programPreview: elements.programPreviewStage"), "director passes Program Preview stage into LiveSession");

const directorHtml = readFileSync(join(ROOT, "studio/director.html"), "utf8");
assert(directorHtml.includes("lvProgramPreviewStage"), "director markup has Program Preview stage");
assert(directorHtml.includes("Participant View"), "Host panel is labeled Participant View");

assert(liveSession.includes("_teardownProgramPreview"), "leave/end/start tear down Program Preview tiles");
assert(liveSession.includes("_syncProgramPreview"), "guest roster refreshes Program Preview");

const guestJs = readFileSync(join(ROOT, "js/guest.js"), "utf8");
assert(guestJs.includes("stopPreview();"), "guest Join still releases native camera");
const engine = readFileSync(join(ROOT, "js/video-engine.js"), "utf8");
assert(engine.includes("view:true"), "guest publisher still uses bare &view (self-PiP freeze)");

console.log("\nProgram Output binds participant sources; empty frames are not ready");
{
  const emptyMounted = new Map([
    ["host", { videoContainer: { querySelector: () => null, classList: { contains: (name) => name === "po-tile-video--empty" } } }],
    ["g2", { videoContainer: { querySelector: () => null, classList: { contains: (name) => name === "po-tile-video--empty" } } }]
  ]);
  const emptyFeeds = programFeedBindings(emptyMounted);
  assertEqual(emptyFeeds.bound, 0, "empty frames are not bound");
  assertEqual(emptyFeeds.empty, 2, "two empty frames counted");
  const boundMounted = new Map([
    ["host", { videoContainer: { querySelector: () => ({ tagName: "VIDEO" }), classList: { contains: () => false } } }],
    ["g2", { videoContainer: { querySelector: () => ({ tagName: "IFRAME" }), classList: { contains: () => false } } }]
  ]);
  const boundFeeds = programFeedBindings(boundMounted);
  assertEqual(boundFeeds.bound, 2, "host video + guest iframe count as bound feeds");
  assertEqual(boundFeeds.empty, 0, "no empty frames when sources are attached");
  assertEqual(
    inspectSourceHealth({ videoContainer: { querySelector: (sel) => sel === "iframe" ? { tagName: "IFRAME" } : null, classList: { contains: () => false } } }),
    "attached",
    "iframe existence is ATTACHED, not PLAYING"
  );
  assertEqual(
    inspectSourceHealth({
      videoContainer: {
        querySelector: (sel) => sel === "video" ? { readyState: 4, paused: false, ended: false } : null,
        classList: { contains: () => false }
      }
    }),
    "playing",
    "HTMLMediaElement playing is PLAYING"
  );
  const mixed = programFeedBindings(new Map([
    ["host", { videoContainer: { querySelector: () => ({ tagName: "VIDEO" }), classList: { contains: () => false } } }],
    ["g2", { videoContainer: { querySelector: () => null, classList: { contains: (name) => name === "po-tile-video--empty" } } }]
  ]));
  assertEqual(mixed.bound, 1, "one bound feed");
  assertEqual(mixed.empty, 1, "one empty feed");
  const readyToRecord = mixed.bound === 2 && mixed.empty === 0;
  assertEqual(readyToRecord, false, "readiness is false while any frame is empty");

  const renderer = readFileSync(join(ROOT, "js/program-renderer.js"), "utf8");
  assert(renderer.includes("resolveOwnedStream"), "renderer can bind an opener-owned Host MediaStream");
  assert(renderer.includes("mountNativeProgramVideo"), "native/owned streams mount a <video>, not an empty frame");
  assert(renderer.includes('vdo:${participant?.transportSourceId || ""}:${muted ? "muted" : "unmuted"}'), "muted vs unmuted remounts the VDO iframe");
}

console.log("\nProgram Output receives serialized participants and always mounts video");
{
  assert(serialized.transportSourceId === "tmroomh", "Program Output still receives Host VDO source id");
  assert(fromSync.slots.every((slot) => slot.transportSourceId), "serialized slots keep transportSourceId for iframe src");
  assert(listener.includes("videoEnabled: true"), "Program Output always enables video while live");
  assert(listener.includes("muted: !audioUnlocked"), "VDO mounts muted until program audio is enabled");
  assert(listener.includes("resolveOwnedStream: ownedStreamFor"), "Host tile binds Director's native stream via opener");
  assert(listener.includes("__toastyProgramSources"), "Program Output reads window.opener hostStream");
  assert(listener.includes("publishOutputStatus"), "Program Output publishes readiness on ProgramSync");
  assert(listener.includes('role: "output"'), "Program Output joins the canonical presence session");
  assert(listener.includes("programFeedHealth"), "VIDEO READY uses source health, not iframe existence");
  assert(listener.includes("readyToRecord: connection === OutputConnection.CONNECTED && videoReady && audioReady"), "readyToRecord requires connected + playing + audio");
  assert(!/videoEnabled:\s*audioUnlocked/.test(listener), "video is not gated on the audio click");
  const outputCss = readFileSync(join(ROOT, "css/program-output.css"), "utf8");
  assert(outputCss.includes("must NOT cover the"), "audio gate documents that it must not cover tiles");
  assert(!/^\s*inset:\s*0;/m.test(outputCss.slice(outputCss.indexOf(".po-audio-gate {"), outputCss.indexOf(".po-audio-gate[hidden]"))), "audio gate is not a full-canvas overlay");
  const liveSessionSrc = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
  assert(liveSessionSrc.includes("exposeProgramSources"), "Director exposes hostStream to Program Output");
  assert(liveSessionSrc.includes("output-status"), "Director consumes ProgramSync output-status");
  assert(liveSessionSrc.includes("recordingBlockReasonFromOutput"), "Record is gated on acknowledged Program Output truth");
  const controlSrc = readFileSync(join(ROOT, "js/session-control.js"), "utf8");
  assert(controlSrc.includes("playing === expected && empty === 0"), "VIDEO READY requires playing feeds and refuses empty frames");
  const syncSrc = readFileSync(join(ROOT, "js/program-sync.js"), "utf8");
  assert(syncSrc.includes('type: "output-status"'), "ProgramSync serializes output-status without breaking state messages");
  assert(syncSrc.includes('type: "state"'), "ProgramSync state messages remain");
}

const listenerHtml = readFileSync(join(ROOT, "studio/listener.html"), "utf8");
assert(!listenerHtml.includes("poLiveBadge"), "top-right LIVE markup removed");
assert(listenerHtml.includes("poLiveChip"), "bottom-left LIVE chip remains");
assert(listenerHtml.includes("Enable program audio"), "Program Output still has the audio gate");
assert(!listener.includes("getUserMedia"), "Program Output does not reacquire cameras");

console.log("\nProgramSync output-status does not break state messages");
globalThis.window = globalThis;
const posted = [];
globalThis.BroadcastChannel = class {
  constructor(name) { this.name = name; this.handler = null; }
  addEventListener(type, cb) { if (type === "message") this.handler = cb; }
  postMessage(data) { posted.push(data); this.handler?.({ data }); }
  close() {}
};
globalThis.localStorage = {
  data: {},
  setItem(key, value) { this.data[key] = String(value); },
  getItem(key) { return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null; }
};
{
  const { ProgramSync } = await import("../js/program-sync.js");
  const received = [];
  const sync = new ProgramSync("tmroomtest1");
  sync.onMessage((message) => received.push(message));
  sync.publishState({ scene: "live", participants: [serialized] });
  sync.publishOutputStatus({ connected: true, boundFeeds: 2, expectedFeeds: 2, emptyFeeds: 0, videoReady: true, audioReady: true, readyToRecord: true });
  assert(posted.some((message) => message.type === "state"), "state messages still publish");
  assert(posted.some((message) => message.type === "output-status"), "output-status messages publish");
  assertEqual(received.filter((message) => message.type === "state").length, 1, "state listener still fires");
  assertEqual(received.filter((message) => message.type === "output-status").length, 1, "output-status listener fires");
  const stored = sync.readLastState();
  assertEqual(stored.scene, "live", "localStorage still hydrates program state, not output-status");
  sync.requestState();
  assert(posted.some((message) => message.type === "request-state"), "request-state remains");
  sync.close();
}

console.log("\nALL PASSED — Program Renderer is composeProgram + per-person sources, not scene=0.");
