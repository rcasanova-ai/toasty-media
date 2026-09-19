#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { composeProgram, ProgramLayout } from "../js/program-composition.js";
import { serializeProgramParticipant, programLayoutCount } from "../js/program-renderer.js";
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

const listenerHtml = readFileSync(join(ROOT, "studio/listener.html"), "utf8");
assert(!listenerHtml.includes("poLiveBadge"), "top-right LIVE markup removed");
assert(listenerHtml.includes("poLiveChip"), "bottom-left LIVE chip remains");

console.log("\nALL PASSED — Program Renderer is composeProgram + per-person sources, not scene=0.");
