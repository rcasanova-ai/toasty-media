#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ParticipantRegistry, createParticipant, ParticipantRole, ConnectionStatus } from "../js/participant-registry.js";
import { TranscriptStore, ShowContextMemory, attributeTranscriptLine, buildShowContext } from "../js/show-context.js";
import { SessionPolicy, CapturePolicy, SessionType } from "../js/session-policy.js";
import { RunOfShow } from "../js/run-of-show.js";
import { AudienceStore } from "../js/audience.js";
import { ProducerFeed, ProducerEntryType } from "../js/ai-producer.js";
import {
  detectHostDirective,
  extractAddressedCommand,
  DirectiveIntent,
  HostDirectiveLog
} from "../js/host-directive.js";
import { LiveProducerController, ingestAttributedTranscript, ProducerEventType } from "../js/live-producer.js";
import { createTranscriptionProvider, HOTTIE_LIVE_PRODUCER_SCRIPT, HOTTIE_LIVE_PRODUCER_RESEARCH } from "../js/transcription.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function participant(id, role, displayName) {
  return createParticipant({
    participantId: id,
    role,
    displayName,
    connectionStatus: ConnectionStatus.CONNECTED
  });
}

function fixtureSession({ policy, researchContext } = {}) {
  const participants = new ParticipantRegistry();
  participants.upsert(participant("host", ParticipantRole.HOST, "Ricardo"));
  participants.upsert(participant("g-tukta", ParticipantRole.GUEST, "Tukta"));
  participants.upsert(participant("g-pat", ParticipantRole.GUEST, "Pat"));
  participants.upsert(participant("g-sarah", ParticipantRole.GUEST, "Sarah"));
  const session = {
    roomId: "hottiefixture",
    policy: policy || new SessionPolicy(),
    participants,
    transcript: new TranscriptStore(),
    showMemory: new ShowContextMemory(),
    hostDirectives: new HostDirectiveLog(),
    aiProducerFeed: new ProducerFeed(),
    runOfShow: new RunOfShow(),
    audience: new AudienceStore(),
    researchContext: researchContext || { ...HOTTIE_LIVE_PRODUCER_RESEARCH },
    guestSeats: [],
    elapsedMs: () => 0
  };
  session.liveProducer = new LiveProducerController(session);
  return session;
}

console.log("Host directive detection — Host only, explicit wake");
{
  const hostFind = detectHostDirective({
    participantId: "host",
    role: "host",
    speaker: "Ricardo",
    text: "Toasty, find me that article about Thailand data centers."
  });
  assert(hostFind, "Host Toasty, find… is a directive");
  assertEqual(hostFind.intent, DirectiveIntent.FIND, "find intent");
  assertEqual(hostFind.payload.query, "that article about Thailand data centers.", "find payload strips the verb");

  const uncovered = detectHostDirective({
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Toasty, what haven’t we covered?"
  });
  assertEqual(uncovered.intent, DirectiveIntent.UNCOVERED, "uncovered intent");

  const quiet = detectHostDirective({
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Toasty, who hasn’t answered this?"
  });
  assertEqual(quiet.intent, DirectiveIntent.QUIET, "quiet/who-hasn’t intent");

  const audience = detectHostDirective({
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Toasty, bring up the audience question about regulation."
  });
  assertEqual(audience.intent, DirectiveIntent.AUDIENCE, "audience intent");
  assertEqual(audience.payload.query, "regulation.", "audience payload is the topic");

  const recall = detectHostDirective({
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Toasty, remind me what Sarah said about pricing."
  });
  assertEqual(recall.intent, DirectiveIntent.RECALL, "recall intent");
  assertEqual(recall.payload.speakerName, "Sarah", "recall names Sarah");

  assert(!detectHostDirective({
    participantId: "g-tukta", role: "guest", speaker: "Tukta",
    text: "Toasty is interesting as a distribution layer."
  }), "guest ‘Toasty is interesting’ is not a directive");

  assert(!detectHostDirective({
    participantId: "g-pat", role: "guest", speaker: "Pat",
    text: "Toasty, find the article — wait, I'm just saying the name."
  }), "guest Toasty, find… is not a Host directive");

  assert(!detectHostDirective({
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "I think Toasty is the right platform for this."
  }), "Host mentioning Toasty mid-sentence is not a wake");

  assert(!extractAddressedCommand("Toasty is interesting"), "subject-Toasty is not an address");
}

console.log("\nSpeaker attribution uses ParticipantRegistry");
{
  const session = fixtureSession();
  const line = attributeTranscriptLine(
    { participantId: "g-tukta", speaker: "wrong", text: "hello" },
    session.participants
  );
  assertEqual(line.speaker, "Tukta", "registry displayName wins over provider label");
  assertEqual(line.role, "guest", "registry role");
  assertEqual(line.participantId, "g-tukta", "canonical participantId");
}

console.log("\nSeeded Hottie producer sequence");
{
  const session = fixtureSession();
  const events = [];
  session.liveProducer.onEvent((event) => events.push(event));
  HOTTIE_LIVE_PRODUCER_SCRIPT.forEach((line) => ingestAttributedTranscript(session, line));
  session.liveProducer.checkpoint();

  assertEqual(session.transcript.lines.length, HOTTIE_LIVE_PRODUCER_SCRIPT.length, "all fixture lines stored");
  assert(session.transcript.lines.every((l) => l.participantId && l.role && l.speaker && l.text), "every line is attributed");
  assert(session.transcript.lines.some((l) => l.participantId === "host" && l.role === "host"), "Host turns retained");
  assert(session.transcript.lines.some((l) => l.participantId === "g-tukta"), "Tukta turns retained");
  assert(!session.transcript.lines.some((l) => l.participantId === "g-sarah"), "quiet Sarah has no transcript turns");

  const directives = session.hostDirectives.items;
  assertEqual(directives.length, 2, "two Host Toasty directives");
  assertEqual(directives[0].intent, DirectiveIntent.FIND, "first directive is find");
  assert(directives[0].payload.query.includes("Thailand"), "find query keeps Thailand article");
  assertEqual(directives[1].intent, DirectiveIntent.RECALL, "second directive is recall");

  const guestToasty = session.transcript.lines.filter((l) => /toasty/i.test(l.text) && l.role === "guest");
  assert(guestToasty.length >= 2, "guest mentioned Toasty without creating extra directives");

  const feed = session.aiProducerFeed.visible();
  assert(feed.some((e) => e.type === ProducerEntryType.DIRECTIVE && /Find:/i.test(e.summary)), "find directive is on the private feed");
  assert(feed.some((e) => e.type === ProducerEntryType.DIRECTIVE && /Research action is not wired yet/.test(e.items?.[0]?.text || "")), "find feed says research is not wired");
  assert(feed.some((e) => /not heard from Sarah/i.test(e.summary)), "quiet Sarah surfaced privately");
  assert(feed.some((e) => (e.items || []).some((item) => /stop you from using this/i.test(item.text))), "uncovered research question surfaced");
  assert(feed.some((e) => e.title === "Disagreement" && /Pat/.test(e.summary)), "disagreement surfaced");
  assert(events.some((e) => e.type === ProducerEventType.HOST_DIRECTIVE), "HOST_DIRECTIVE event fired");
  assert(events.some((e) => e.type === ProducerEventType.PARTICIPANT_QUIET && e.participantId === "g-sarah"), "PARTICIPANT_QUIET event for Sarah");

  const context = buildShowContext(session);
  assertEqual(context.researchContext.objective, HOTTIE_LIVE_PRODUCER_RESEARCH.objective, "focus-group research context still on ShowContext");
  assert(context.memory.speakers.some((s) => s.participantId === "g-pat" && s.turnCount > 0), "compact memory has Pat’s turns");
  assert(context.hostDirectives.length === 2, "ShowContext carries structured Host directives");
  assert(!JSON.stringify(context.transcript).includes(HOTTIE_LIVE_PRODUCER_RESEARCH.objective), "research objective is not copied into transcript lines");
}

console.log("\nSessionPolicy still gates transcription and Hottie");
{
  const jam = new SessionPolicy({ sessionType: SessionType.JAM });
  assert(!jam.canTranscribe(), "jam default forbids transcription");
  assert(!jam.canAiProcess(), "jam default forbids AI processing");
  assertEqual(createTranscriptionProvider({ policy: jam, preferDemo: true }), null, "no hidden demo transcription under jam");

  const session = fixtureSession({ policy: jam });
  const line = ingestAttributedTranscript(session, HOTTIE_LIVE_PRODUCER_SCRIPT[0]);
  assertEqual(line, null, "ingest refuses when transcription is forbidden");
  assertEqual(session.transcript.lines.length, 0, "transcript stays empty");
  assertEqual(session.aiProducerFeed.entries.length, 0, "no Hottie feed entries");

  const liveNoAi = new SessionPolicy();
  liveNoAi.set({ aiProcessingAllowed: false });
  assert(liveNoAi.canTranscribe(), "transcript still allowed");
  assert(!liveNoAi.canAiProcess(), "AI processing off");
  const session2 = fixtureSession({ policy: liveNoAi });
  ingestAttributedTranscript(session2, HOTTIE_LIVE_PRODUCER_SCRIPT[5]);
  assertEqual(session2.transcript.lines.length, 1, "transcript still accumulates");
  assertEqual(session2.hostDirectives.items.length, 0, "Hottie does not take Host directives when AI is forbidden");
  assertEqual(session2.aiProducerFeed.entries.length, 0, "Hottie feed stays empty when AI is forbidden");
}

console.log("\nLive path does not fake demo transcript; renderer/publisher stay frozen");
{
  const live = new SessionPolicy();
  assertEqual(createTranscriptionProvider({ policy: live, preferDemo: false }), null, "node/live without SpeechRecognition does not drip demo lines");

  const liveSession = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
  assert(liveSession.includes("ingestAttributedTranscript"), "LiveSession ingests attributed transcript");
  assert(liveSession.includes("_startLiveTranscription"), "Join starts live transcription");
  assert(liveSession.includes("this.stopTranscription()"), "leave/end stop transcription");
  assert(!/mountRoomFrame\(this\._containers\.roomPreview/.test(liveSession), "setLayout still does not remount scene=0 onto Host stage");

  const guestJs = readFileSync(join(ROOT, "js/guest.js"), "utf8");
  assert(guestJs.includes("stopPreview();"), "guest Join still releases native camera");
  const engine = readFileSync(join(ROOT, "js/video-engine.js"), "utf8");
  assert(engine.includes("view:true"), "guest publisher still uses bare &view");
  const renderer = readFileSync(join(ROOT, "js/program-renderer.js"), "utf8");
  assert(renderer.includes("Never scene=0"), "Program Renderer freeze");
  const listener = readFileSync(join(ROOT, "js/listener.js"), "utf8");
  assert(listener.includes("syncProgramRenderer"), "listener still uses Program Renderer");
  assert(!listener.includes("mountProgramFrame"), "listener still has no scene=0 mixer");
}

console.log("\nALL PASSED — Hottie live context is attributed, Host-only, private, and policy-gated.");
