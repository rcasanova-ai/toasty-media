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
  ensureAddressedText
} from "../js/host-directive.js";
import { LiveProducerController, ingestAttributedTranscript } from "../js/live-producer.js";
import { ProgramAssetCatalog, ProgramAssetStatus } from "../js/program-asset.js";
import { ProgramController, ProductionActionLog, ProductionActionType } from "../js/production-controller.js";
import { SeededResearchProvider, EmptyResearchProvider, FLUIDVOICE_GITHUB_CANDIDATE } from "../js/hottie-research.js";
import { riskForIntent, requiresApproval, ActionRiskLevel, HottieIntent, HottieActionBus, ProductionActionStatus } from "../js/hottie-action.js";
import { resolveReferences, recallTranscript } from "../js/hottie-context.js";
import { createMomentMarker } from "../js/program-recording.js";
import { composeProgram } from "../js/program-composition.js";

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
  assert(extractAddressedCommand("Hottie, look that up"), "Hottie comma address");
  assert(extractAddressedCommand("Hottie look up FluidVoice"), "Hottie verb address");
  assert(extractAddressedCommand("Toasty, find the article"), "legacy Toasty still wakes");
  assert(!extractAddressedCommand("Hottie is interesting"), "subject Hottie is not a wake");
  assert(!extractAddressedCommand("I told Hottie about it"), "mid-sentence Hottie is not a wake");
  const d = detectHostDirective({ role: "host", participantId: "host", text: "Hottie, pull up his LinkedIn." });
  assert(d, "explicit Hottie command is a directive");
  assertEqual(d.wakeWord, "hottie", "wake word is hottie");
  assert(!detectHostDirective({ role: "guest", participantId: "g-tukta", text: "Hottie, find that." }), "guest cannot command");
}

console.log("\nCommand extraction + intent routing");
{
  const find = detectHostDirective({ role: "host", participantId: "host", text: "Hottie, look up FluidVoice and pull up the GitHub repo." });
  assertEqual(find.intent, DirectiveIntent.FIND, "lookup+pull-up is FIND");
  assert(find.payload.query.toLowerCase().includes("fluidvoice"), "query keeps FluidVoice");
  const recall = detectHostDirective({ role: "host", participantId: "host", text: "Hottie, what did Anders say about pricing earlier?" });
  assertEqual(recall.intent, DirectiveIntent.RECALL, "recall intent");
  const fact = detectHostDirective({ role: "host", participantId: "host", text: "Hottie, fact check me. Thailand has more than 1,000 islands, right?" });
  assertEqual(fact.intent, DirectiveIntent.FACT_CHECK, "fact check intent");
  const clip = detectHostDirective({ role: "host", participantId: "host", text: "Hottie, mark that last minute." });
  assertEqual(clip.intent, DirectiveIntent.MARK, "mark moment");
  const clip2 = detectHostDirective({ role: "host", participantId: "host", text: "Hottie, clip that." });
  assertEqual(clip2.intent, DirectiveIntent.CLIP, "clip moment");
  const scene = detectHostDirective({ role: "host", participantId: "host", text: "Hottie, go to BRB" });
  assertEqual(scene.intent, DirectiveIntent.CHANGE_SCENE, "scene change");
  assertEqual(scene.payload.scene, "brb", "BRB scene payload");
  assertEqual(hottieIntentFromDirective(DirectiveIntent.FIND, "pull up a picture"), HottieIntent.SEARCH_IMAGE, "picture maps to SEARCH_IMAGE");
}

console.log("\nRisk classification + approval");
{
  assertEqual(riskForIntent(HottieIntent.SEARCH_WEB), ActionRiskLevel.GREEN, "search is green");
  assertEqual(riskForIntent(HottieIntent.RECALL_TRANSCRIPT), ActionRiskLevel.GREEN, "recall is green");
  assertEqual(riskForIntent(HottieIntent.FACT_CHECK), ActionRiskLevel.GREEN, "fact check is green");
  assertEqual(riskForIntent(HottieIntent.SHOW_URL), ActionRiskLevel.AMBER, "show url is amber");
  assertEqual(riskForIntent(HottieIntent.CHANGE_SCENE), ActionRiskLevel.AMBER, "scene is amber");
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
  const bus = new HottieActionBus();
  const action = bus.push({ intent: HottieIntent.SEARCH_WEB, heardText: "Hottie, look that up" });
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
    text: "Hottie, look up FluidVoice and pull up the GitHub repo."
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
    text: "Hottie, what did Anders say about pricing earlier?"
  });
  await session.liveProducer.ready();
  const recall = session.aiProducerFeed.visible().find((e) => e.title === "From earlier");
  assert(recall, "recall is private");
  assert(/FluidVoice|on-device|Pricing/i.test(recall.summary), "recall quotes Anders");

  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Hottie, mark that last minute."
  });
  const marker = session.liveProducer.momentMarkers[0];
  assert(marker, "moment marker created");
  assertEqual(marker.kind, "moment-marker", "moment marker kind");
  assertEqual(marker.preRollSeconds, 60, "last minute is 60s pre-roll");
  assert(marker.transcriptContext.length > 0, "marker keeps transcript context");
}

console.log("\nTyped Ask Hottie uses the same pipeline");
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
    text: "Hottie, look up a source that does not exist anywhere."
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
    text: "Hottie, end the show"
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
  assertEqual(ensureAddressedText("look that up").startsWith("Hottie,"), true, "typed commands are addressed");
  assert(ensureAddressedText("Hottie, look that up").startsWith("Hottie"), "already addressed stays");
}

console.log("\nALL PASSED — Hottie V1 command pipeline.");
