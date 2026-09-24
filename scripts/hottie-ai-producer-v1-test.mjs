#!/usr/bin/env node
import { ParticipantRegistry, createParticipant, ParticipantRole, ConnectionStatus } from "../js/participant-registry.js";
import { TranscriptStore, ShowContextMemory } from "../js/show-context.js";
import { SessionPolicy } from "../js/session-policy.js";
import { RunOfShow } from "../js/run-of-show.js";
import { AudienceStore } from "../js/audience.js";
import { ProducerFeed, ProducerEntryType } from "../js/ai-producer.js";
import {
  detectHostDirective,
  extractAddressedCommand,
  detectImplicitProductionCue,
  DirectiveIntent,
  HostDirectiveLog,
  hottieIntentFromDirective,
  ensureAddressedText,
  inferResponseAudience,
  wantsProgramVisual
} from "../js/host-directive.js";
import { LiveProducerController, ingestAttributedTranscript } from "../js/live-producer.js";
import { ProgramAssetCatalog, ProgramAssetStatus } from "../js/program-asset.js";
import { ProgramController, ProductionActionLog, ProductionActionType } from "../js/production-controller.js";
import { SeededResearchProvider, EmptyResearchProvider, FLUIDVOICE_GITHUB_CANDIDATE } from "../js/hottie-research.js";
import { riskForIntent, requiresApproval, ActionRiskLevel, MoxieIntent, MoxieActionBus, ProductionActionStatus, ResponseAudience } from "../js/hottie-action.js";
import { resolveReferences, recallTranscript } from "../js/hottie-context.js";
import { createMomentMarker } from "../js/program-recording.js";
import { composeProgram } from "../js/program-composition.js";
import { isMoxieSelfEcho, createMoxieVoicePlan, serializeMoxieVoice } from "../js/hottie-voice.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

function fixtureSession({ researchProvider } = {}) {
  const participants = new ParticipantRegistry();
  participants.upsert(participant("host", ParticipantRole.HOST, "Ricardo"));
  participants.upsert(participant("g-anders", ParticipantRole.GUEST, "Anders"));
  participants.upsert(participant("g-tukta", ParticipantRole.GUEST, "Tukta"));
  const session = {
    roomId: "hottie-v1",
    policy: new SessionPolicy(),
    participants,
    transcript: new TranscriptStore(),
    showMemory: new ShowContextMemory(),
    hostDirectives: new HostDirectiveLog(),
    aiProducerFeed: new ProducerFeed(),
    runOfShow: new RunOfShow(),
    audience: new AudienceStore(),
    guestSeats: [],
    elapsedMs: () => 0,
    demoMode: true,
    assets: new ProgramAssetCatalog(),
    productionLog: new ProductionActionLog(),
    researchProvider: researchProvider || new SeededResearchProvider(),
    program: { assetLayout: null, scene: "live", live: true },
    programOutput: { connection: "disconnected" }
  };
  session.programController = new ProgramController(session);
  session.emit = () => {};
  session._syncProgramPreview = () => {};
  session.publishProgramState = () => {};
  session.setScene = (scene) => { session.program.scene = scene; };
  session.markers = { items: [], add(item) { this.items.push(item); return item; } };
  session.timeline = { record() {} };
  session.liveProducer = new LiveProducerController(session);
  return session;
}

console.log("Wake-name detection");
{
  assert(extractAddressedCommand("Moxie, look that up"), "Moxie comma address");
  assert(extractAddressedCommand("Moxie look up FluidVoice"), "Moxie verb address");
  assert(extractAddressedCommand("Toasty, find the article"), "legacy Toasty still wakes");
  assert(!extractAddressedCommand("Moxie is interesting"), "subject Moxie is not a wake");
  assert(!extractAddressedCommand("I told Moxie about it"), "mid-sentence Moxie is not a wake");
  const d = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, pull up his LinkedIn." });
  assert(d, "explicit Moxie command is a directive");
  assertEqual(d.wakeWord, "moxie", "wake word is Moxie");
  assertEqual(extractAddressedCommand("Hottie, find that")?.wakeWord, "hottie", "legacy Hottie still wakes");
  assert(!detectHostDirective({ role: "guest", participantId: "g-tukta", text: "Moxie, find that." }), "guest cannot command");
}

console.log("\nCommand extraction + intent routing");
{
  const find = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, look up FluidVoice and pull up the GitHub repo." });
  assertEqual(find.intent, DirectiveIntent.FIND, "lookup+pull-up is FIND");
  assert(find.payload.query.toLowerCase().includes("fluidvoice"), "query keeps FluidVoice");
  const recall = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, what did Anders say about pricing earlier?" });
  assertEqual(recall.intent, DirectiveIntent.RECALL, "recall intent");
  const fact = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, fact check me. Thailand has more than 1,000 islands, right?" });
  assertEqual(fact.intent, DirectiveIntent.FACT_CHECK, "fact check intent");
  const clip = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, mark that last minute." });
  assertEqual(clip.intent, DirectiveIntent.MARK, "mark moment");
  const clip2 = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, clip that." });
  assertEqual(clip2.intent, DirectiveIntent.CLIP, "clip moment");
  const scene = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, go to BRB" });
  assertEqual(scene.intent, DirectiveIntent.CHANGE_SCENE, "scene change");
  assertEqual(scene.payload.scene, "brb", "BRB scene payload");
  assertEqual(hottieIntentFromDirective(DirectiveIntent.FIND, "pull up a picture"), MoxieIntent.SHOW_IMAGE, "picture pull-up maps to SHOW_IMAGE");
}

console.log("\nRisk classification + approval");
{
  assertEqual(riskForIntent(MoxieIntent.SEARCH_WEB), ActionRiskLevel.GREEN, "search is green");
  assertEqual(riskForIntent(MoxieIntent.RECALL_TRANSCRIPT), ActionRiskLevel.GREEN, "recall is green");
  assertEqual(riskForIntent(MoxieIntent.FACT_CHECK), ActionRiskLevel.GREEN, "fact check is green");
  assertEqual(riskForIntent(MoxieIntent.SHOW_URL), ActionRiskLevel.AMBER, "show url is amber");
  assertEqual(riskForIntent(MoxieIntent.CHANGE_SCENE), ActionRiskLevel.AMBER, "scene is amber");
  assertEqual(riskForIntent("END_SHOW"), ActionRiskLevel.RED, "end show is red");
  assert(!requiresApproval(ActionRiskLevel.GREEN), "green does not require approval");
  assert(requiresApproval(ActionRiskLevel.AMBER), "amber requires approval");
  assert(requiresApproval(ActionRiskLevel.RED), "red requires approval");
}

console.log("\nReference resolution");
{
  const high = resolveReferences("look up FluidVoice", { researchResults: [] });
  assertEqual(high.needsClarification, false, "explicit query does not clarify");
  const low = resolveReferences("pull that up", { entities: [], researchResults: [], transcript: [] });
  assert(low.needsClarification, "that with no referents asks for clarification");
  const either = resolveReferences("pull that up", {
    researchResults: [
      { title: "FluidVoice repo", query: "FluidVoice", timestamp: 2 },
      { title: "drone article", query: "drone", timestamp: 1 }
    ]
  });
  assert(either.needsClarification, "two recent research results require clarification");
  assert(/FluidVoice|drone/i.test(either.clarification), "clarification names both");
  const one = resolveReferences("look that up", {
    researchResults: [{ title: "FluidVoice", query: "FluidVoice", timestamp: 3 }]
  });
  assert(!one.needsClarification, "single recent result can bind that");
  assert(/FluidVoice/i.test(one.resolvedQuery), "that resolves to FluidVoice");
}

console.log("\nAction lifecycle");
{
  const bus = new MoxieActionBus();
  const action = bus.push({ intent: MoxieIntent.SEARCH_WEB, heardText: "Moxie, look that up" });
  assertEqual(action.status, ProductionActionStatus.RECEIVED, "starts received");
  bus.setStatus(action.id, ProductionActionStatus.PROCESSING);
  bus.setStatus(action.id, ProductionActionStatus.AWAITING_APPROVAL);
  assertEqual(bus.ready()[0].id, action.id, "awaiting approval is ready queue");
  bus.setStatus(action.id, ProductionActionStatus.LIVE);
  assertEqual(bus.history()[0].status, ProductionActionStatus.LIVE, "live is history");
}

console.log("\nVertical slice: lookup → ready → take live → recall → moment marker");
{
  const session = fixtureSession();
  ingestAttributedTranscript(session, {
    participantId: "g-anders", role: "guest", speaker: "Anders",
    text: "Pricing only works if FluidVoice stays on-device."
  });
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, look up FluidVoice and pull up the GitHub repo."
  });
  await session.liveProducer.ready();
  assertEqual(session.liveProducer.status, "awaiting-approval", "status waiting for approval after find");
  const proposal = session.aiProducerFeed.visible().find((e) => e.type === ProducerEntryType.ASSET_PROPOSAL);
  assert(proposal, "producer has a ready asset");
  assertEqual(proposal.proposal.asset.sourceUrl, FLUIDVOICE_GITHUB_CANDIDATE.sourceUrl, "real GitHub URL, not invented");
  assert(proposal.proposal.requiresApproval, "take live still needs approval");
  assertEqual(session.programController.liveAsset(), null, "nothing live yet");

  const take = session.liveProducer.takeProposalLive(proposal.id);
  assert(take.ok, "take live ok");
  assertEqual(session.programController.liveAsset().status, ProgramAssetStatus.LIVE, "asset is live");
  const composition = composeProgram(session.participants.list(), {
    asset: session.programController.liveAsset(),
    assetLayout: session.program.assetLayout
  });
  assert(composition.asset, "program composition includes the source card");

  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, what did Anders say about pricing earlier?"
  });
  await session.liveProducer.ready();
  const recall = session.aiProducerFeed.visible().find((e) => e.title === "From earlier");
  assert(recall, "recall is private");
  assert(/FluidVoice|on-device|Pricing/i.test(recall.summary), "recall quotes Anders");

  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, mark that last minute."
  });
  const marker = session.liveProducer.momentMarkers[0];
  assert(marker, "moment marker created");
  assertEqual(marker.kind, "moment-marker", "moment marker kind");
  assertEqual(marker.preRollSeconds, 60, "last minute is 60s pre-roll");
  assert(marker.transcriptContext.length > 0, "marker keeps transcript context");
}

console.log("\nTyped Ask Moxie uses the same pipeline");
{
  const session = fixtureSession();
  await session.liveProducer.handleManualRequest("look up FluidVoice and pull up the GitHub repo");
  await session.liveProducer.ready();
  assert(session.hostDirectives.items[0], "typed request became a directive");
  assertEqual(session.hostDirectives.items[0].intent, DirectiveIntent.FIND, "typed FIND");
  assert(session.aiProducerFeed.visible().some((e) => e.type === ProducerEntryType.ASSET_PROPOSAL), "typed path proposes an asset");
}

console.log("\nFailure handling stays private");
{
  const session = fixtureSession({ researchProvider: new EmptyResearchProvider() });
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, look up a source that does not exist anywhere."
  });
  await session.liveProducer.ready();
  const fail = session.aiProducerFeed.visible()[0];
  assert(/couldn|trust|source/i.test(fail.summary), "empty research is graceful");
  assertEqual(session.assets.items.length, 0, "no fake asset");
  assertEqual(session.programController.liveAsset(), null, "program untouched");
}

console.log("\nImplicit cues suggest, they do not execute");
{
  const cue = detectImplicitProductionCue({ role: "host", participantId: "host", text: "Can we pull that article up?" });
  assert(cue, "implicit producer language is detected");
  assertEqual(cue.execute, false, "implicit cue is not executable");
  const session = fixtureSession();
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Can we pull that article up?"
  });
  assertEqual(session.hostDirectives.items.length, 0, "implicit cue is not a wake command");
  assert(session.aiProducerFeed.visible().some((e) => /suggestion/i.test(e.title)), "suggestion is surfaced");
  assertEqual(session.assets.items.length, 0, "implicit cue does not research");
}

console.log("\nRED actions never auto-run");
{
  const session = fixtureSession();
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, end the show"
  });
  assertEqual(session.program.scene, "live", "end show did not change scene");
  const red = session.aiProducerFeed.visible()[0];
  assert(red.proposal?.riskLevel === ActionRiskLevel.RED, "end show is red");
}

console.log("\nSession context recall helper");
{
  const lines = [
    { speaker: "Anders", text: "Pricing should stay simple." },
    { speaker: "Tukta", text: "The company is still private." }
  ];
  const hits = recallTranscript(lines, { speakerName: "Anders", topic: "pricing" });
  assertEqual(hits.length, 1, "speaker+topic recall");
  const marker = createMomentMarker({ sessionId: "x", reason: "clip that", transcriptContext: lines });
  assertEqual(marker.preRollSeconds, 45, "default pre-roll");
}

console.log("\nEnsure typed text is addressed");
{
  assertEqual(ensureAddressedText("look that up").startsWith("Moxie,"), true, "typed commands are addressed");
  assert(ensureAddressedText("Moxie, look that up").startsWith("Moxie"), "already addressed stays");
}

console.log("\nResponse audience routing");
{
  const founded = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, who founded FluidVoice?" });
  assertEqual(founded.intent, DirectiveIntent.ANSWER, "who-founded is a conversational answer");
  assertEqual(founded.responseAudience, ResponseAudience.PROGRAM, "public question is PROGRAM");
  assertEqual(founded.riskLevel, ActionRiskLevel.GREEN, "ordinary informational answer is GREEN");
  assert(!requiresApproval(founded.riskLevel), "PROGRAM answers do not wait on Producer");

  const prep = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, find an article about FluidVoice and get it ready." });
  assertEqual(prep.intent, DirectiveIntent.FIND, "prep stays FIND");
  assertEqual(prep.responseAudience, ResponseAudience.PRIVATE_PRODUCER, "prep is PRIVATE_PRODUCER");
  assert(!prep.spokenResponse, "prep is not a spoken program answer");

  const visual = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, put that article on screen." });
  assert(wantsProgramVisual(visual.rawText), "put on screen is a visual production action");
  assertEqual(visual.hottieIntent, MoxieIntent.SHOW_URL, "visual maps to SHOW_URL");
  assertEqual(visual.riskLevel, ActionRiskLevel.AMBER, "visual take-live is AMBER");
  assert(requiresApproval(visual.riskLevel), "visual production still needs approval");
  assert(visual.responseAudience !== ResponseAudience.PROGRAM, "public answer is not a public production action");

  const chat = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, what is chat saying?" });
  assertEqual(chat.intent, DirectiveIntent.AUDIENCE, "chat summary intent");
  assertEqual(chat.responseAudience, ResponseAudience.PROGRAM, "chat summary is PROGRAM");

  const privateChat = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, privately tell me what chat is saying." });
  assertEqual(privateChat.intent, DirectiveIntent.AUDIENCE, "private chat is still a chat read");
  assertEqual(privateChat.responseAudience, ResponseAudience.PRIVATE_HOST, "privately tell me is PRIVATE_HOST");

  const tellEveryone = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, tell everyone what you found." });
  assertEqual(tellEveryone.responseAudience, ResponseAudience.PROGRAM, "tell everyone is PROGRAM");
  assertEqual(inferResponseAudience("Moxie, tell the Producer what you found."), ResponseAudience.PRIVATE_PRODUCER, "tell the Producer override");
  assertEqual(inferResponseAudience("Moxie, don't say this on air."), ResponseAudience.PRIVATE_CREW, "off-air override");

  const yes = detectHostDirective({ role: "host", participantId: "host", text: "yes" });
  assertEqual(yes.intent, DirectiveIntent.TAKE_ASSET, "bare yes approves pending Moxie result");
  const useThat = detectHostDirective({ role: "host", participantId: "host", text: "Moxie, use that" });
  assertEqual(useThat.intent, DirectiveIntent.TAKE_ASSET, "use that approves pending result");
  const shareIt = detectHostDirective({ role: "host", participantId: "host", text: "share it" });
  assertEqual(shareIt.intent, DirectiveIntent.TAKE_ASSET, "share it approves pending result");
}

console.log("\nPROGRAM conversational answer does not propose TAKE LIVE");
{
  const session = fixtureSession();
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, who founded FluidVoice?"
  });
  await session.liveProducer.ready();
  const action = session.liveProducer.actions.items[0];
  assertEqual(action.responseAudience, ResponseAudience.PROGRAM, "action audience is PROGRAM");
  assertEqual(action.riskLevel, ActionRiskLevel.GREEN, "spoken research is GREEN");
  assert(session.liveProducer.voicePlan.speak, "MoxieVoice will speak on Program Audio");
  assertEqual(session.liveProducer.voicePlan.mode, "PROGRAM_AUDIO", "voice mode is PROGRAM_AUDIO");
  assert(session.program.hottieVoice?.speak, "canonical program carries hottieVoice");
  assert(/hottie-voice/.test(session.program.hottieVoice.source), "voice source is hottie-voice");
  assertEqual(session.liveProducer.status, "speaking", "Host/Producer see MOXIE SPEAKING");
  assert(!session.aiProducerFeed.visible().some((e) => e.type === ProducerEntryType.ASSET_PROPOSAL), "answer does not propose TAKE LIVE");
  assertEqual(session.programController.liveAsset(), null, "program visual unchanged");
}

console.log("\nPRIVATE prep still proposes an asset");
{
  const session = fixtureSession();
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, find an article about FluidVoice and get it ready."
  });
  await session.liveProducer.ready();
  const action = session.liveProducer.actions.items[0];
  assertEqual(action.responseAudience, ResponseAudience.PRIVATE_PRODUCER, "prep stays private to Producer");
  assert(!session.liveProducer.voicePlan.speak, "prep is not spoken on Program Audio");
  assert(session.aiProducerFeed.visible().some((e) => e.type === ProducerEntryType.ASSET_PROPOSAL), "prep is ready for Producer Preview");
}

console.log("\nPUBLIC chat summary vs explicit private chat");
{
  const session = fixtureSession();
  session.audience.ingest({ displayName: "Sarah", message: "Does FluidVoice stay on-device?", type: "question" });
  session.audience.ingest({ displayName: "Lee", message: "What about pricing?", type: "question" });
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, what is chat saying?"
  });
  await session.liveProducer.ready();
  assertEqual(session.liveProducer.actions.items[0].responseAudience, ResponseAudience.PROGRAM, "chat summary speaks to the room");
  assert(session.liveProducer.voicePlan.speak, "chat summary uses Program Audio");

  const privateSession = fixtureSession();
  privateSession.audience.ingest({ displayName: "Sarah", message: "Does FluidVoice stay on-device?", type: "question" });
  ingestAttributedTranscript(privateSession, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, privately tell me what chat is saying."
  });
  await privateSession.liveProducer.ready();
  assertEqual(privateSession.liveProducer.actions.items[0].responseAudience, ResponseAudience.PRIVATE_HOST, "explicit private chat stays in-ear");
  assert(!privateSession.liveProducer.voicePlan.speak, "private chat is not Program Audio");
}

console.log("\nExplicit public recall of what Moxie found");
{
  const session = fixtureSession();
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, find an article about FluidVoice and get it ready."
  });
  await session.liveProducer.ready();
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, tell everyone what you found."
  });
  await session.liveProducer.ready();
  const spoken = session.liveProducer.actions.items[0];
  assertEqual(spoken.responseAudience, ResponseAudience.PROGRAM, "tell everyone speaks the finding");
  assert(session.liveProducer.voicePlan.speak, "finding is spoken on Program Audio");
}

console.log("\nSELF-ECHO: Program Audio must not retrigger wake");
{
  const session = fixtureSession();
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, who founded FluidVoice?"
  });
  await session.liveProducer.ready();
  const first = session.hostDirectives.items.length;
  const spoken = session.liveProducer.voicePlan.text;
  assert(isMoxieSelfEcho({
    role: "host",
    participantId: "host",
    speaker: "Moxie",
    text: spoken,
    source: "hottie-voice"
  }, { speaking: true, lastSpoken: spoken, spokenAt: Date.now() }), "hottie-voice source is self-echo");
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Moxie, who founded FluidVoice?",
    source: "hottie-voice"
  });
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: spoken
  });
  assertEqual(session.hostDirectives.items.length, first, "Moxie's own audio does not create a new command");
  const plan = createMoxieVoicePlan({ responseAudience: ResponseAudience.PROGRAM, text: "Short answer." });
  assert(serializeMoxieVoice(plan).speak, "serialized program voice is speakable");
}

console.log("\nProgram Output consumes MoxieVoice");
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const listener = readFileSync(join(root, "js/listener.js"), "utf8");
  assert(listener.includes("syncMoxieVoice"), "Program Output syncs Moxie Program Audio");
  assert(listener.includes("speakMoxieVoiceOnProgram"), "Program Output uses the TTS provider boundary");
}

console.log("\nALL PASSED — Moxie V1 command pipeline.");
