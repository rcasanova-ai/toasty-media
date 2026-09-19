#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ParticipantRegistry, createParticipant, ParticipantRole, ConnectionStatus } from "../js/participant-registry.js";
import { TranscriptStore, ShowContextMemory } from "../js/show-context.js";
import { SessionPolicy, SessionType } from "../js/session-policy.js";
import { RunOfShow } from "../js/run-of-show.js";
import { AudienceStore } from "../js/audience.js";
import { ProducerFeed, ProducerEntryType } from "../js/ai-producer.js";
import { HostDirectiveLog, detectHostDirective } from "../js/host-directive.js";
import { LiveProducerController, ingestAttributedTranscript } from "../js/live-producer.js";
import { ProgramAssetCatalog, ProgramAssetStatus, createProgramAsset, serializeProgramAsset, allowlistedImageUrl } from "../js/program-asset.js";
import { ProgramController, ProductionActionLog, ProductionActionType } from "../js/production-controller.js";
import { composeProgram, ProgramLayout } from "../js/program-composition.js";
import { programLayoutCount } from "../js/program-renderer.js";
import { SeededResearchProvider, EmptyResearchProvider, THAILAND_DATA_CENTER_CANDIDATES } from "../js/hottie-research.js";

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

function fixtureSession({ policy, researchProvider } = {}) {
  const participants = new ParticipantRegistry();
  participants.upsert(participant("host", ParticipantRole.HOST, "Ricardo"));
  participants.upsert(participant("g-tukta", ParticipantRole.GUEST, "Tukta"));
  const published = [];
  const session = {
    roomId: "research-loop",
    policy: policy || new SessionPolicy(),
    participants,
    transcript: new TranscriptStore(),
    showMemory: new ShowContextMemory(),
    hostDirectives: new HostDirectiveLog(),
    aiProducerFeed: new ProducerFeed(),
    runOfShow: new RunOfShow(),
    audience: new AudienceStore(),
    researchContext: null,
    guestSeats: [],
    elapsedMs: () => 0,
    demoMode: false,
    assets: new ProgramAssetCatalog(),
    productionLog: new ProductionActionLog(),
    researchProvider: researchProvider || new SeededResearchProvider(),
    program: { assetLayout: null, scene: "live", live: true }
  };
  session.programController = new ProgramController(session);
  session.emit = () => {};
  session._syncProgramPreview = () => { session._previewSynced = true; };
  session.publishProgramState = () => {
    published.push({
      asset: serializeProgramAsset(session.programController.liveAsset()),
      assetLayout: session.program.assetLayout,
      participants: session.participants.list()
    });
  };
  session.published = published;
  session.liveProducer = new LiveProducerController(session);
  return session;
}

console.log("ProgramAsset is a general production source, not an article feature");
{
  const sound = createProgramAsset({ type: "sound", title: "Drum roll", sourceName: "Toasty Asset Catalogue" });
  assertEqual(sound.type, "sound", "sound effects share ProgramAsset");
  assertEqual(sound.status, ProgramAssetStatus.DRAFT, "new assets start draft/proposed by caller");
  assert(!allowlistedImageUrl("https://evil.example/track.png"), "random remote images are not trusted UI");
  assert(!allowlistedImageUrl("http://upload.wikimedia.org/x.jpg"), "http images rejected");
  const wiki = allowlistedImageUrl("https://upload.wikimedia.org/wikipedia/commons/a/a0/Example.jpg");
  assert(wiki, "Wikimedia https thumbnails may be used");
}

console.log("\nProposed assets never enter ProgramComposition");
{
  const host = participant("host", ParticipantRole.HOST, "Ricardo");
  const proposed = createProgramAsset({
    title: "Secret draft",
    sourceUrl: "https://press.aboutamazon.com/2025/1/aws-launches-infrastructure-region-in-thailand",
    status: ProgramAssetStatus.PROPOSED
  });
  const before = composeProgram([host], { asset: proposed, assetLayout: ProgramLayout.ASSET_SPEAKER });
  assertEqual(before.layout, ProgramLayout.SINGLE, "proposed asset does not change participant layout");
  assertEqual(before.asset, null, "proposed asset is not a program source");
}

console.log("\nFull loop: directive → research → proposal → private preview → TAKE LIVE → composition");
{
  const session = fixtureSession();
  const line = {
    participantId: "host",
    role: "host",
    speaker: "Ricardo",
    text: "Toasty, find me an article about Thailand data centers."
  };
  const directive = detectHostDirective(line);
  ingestAttributedTranscript(session, line);
  await session.liveProducer.ready();

  assert(directive, "host find is a structured directive");
  assertEqual(session.hostDirectives.items.length, 1, "directive stored");
  const proposalEntry = session.aiProducerFeed.visible().find((e) => e.type === ProducerEntryType.ASSET_PROPOSAL);
  assert(proposalEntry, "private feed has an asset proposal");
  assert(proposalEntry.proposal?.requiresApproval, "proposal requires approval");
  assert(proposalEntry.proposal?.asset?.sourceUrl.startsWith("https://"), "candidate has a real https source");
  assert(proposalEntry.proposal.asset.title.includes("Thailand") || /AWS|Google|Microsoft/i.test(proposalEntry.proposal.asset.title), "candidate title is a real source");
  assertEqual(session.programController.liveAsset(), null, "nothing is live before TAKE LIVE");
  assertEqual(composeProgram(session.participants.list(), { asset: session.assets.proposed()[0] }).layout, ProgramLayout.DUO, "proposed asset is not on Program Output");
  assert(session.published.every((snap) => !snap.asset), "ProgramSync never received the proposal");
  assert(session.productionLog.items.some((item) => item.type === ProductionActionType.RESEARCH_REQUEST), "research request is timestamped");
  assert(session.productionLog.items.some((item) => item.type === ProductionActionType.ASSET_PROPOSAL), "proposal is timestamped");

  const take = session.liveProducer.takeProposalLive(proposalEntry.id);
  assert(take.ok, "TAKE LIVE executes");
  assertEqual(take.layout, ProgramLayout.ASSET_SPEAKER, "default live layout is asset + speaker");
  const live = session.programController.liveAsset();
  assertEqual(live.status, ProgramAssetStatus.LIVE, "approved asset is live");
  const composition = composeProgram(session.participants.list(), {
    asset: live,
    assetLayout: session.program.assetLayout
  });
  assertEqual(composition.layout, ProgramLayout.ASSET_SPEAKER, "composition uses asset-speaker");
  assertEqual(composition.slots[0].participantId, "host", "featured speaker is Host");
  assertEqual(composition.asset.id, live.id, "asset is a composition source");
  assertEqual(programLayoutCount(composition.layout), ProgramLayout.ASSET_SPEAKER, "renderer layout key is asset-speaker");
  assert(session.published.some((snap) => snap.asset?.id === live.id && snap.asset.status === "live"), "TAKE LIVE publishes asset on ProgramSync");
  assert(session._previewSynced, "Producer Program Preview resynced after TAKE LIVE");
  assert(session.productionLog.items.some((item) => item.type === ProductionActionType.TAKE_ASSET), "TAKE LIVE is timestamped");
}

console.log("\nFIND ANOTHER, DISCARD, failure, removal, layout restore");
{
  const session = fixtureSession();
  ingestAttributedTranscript(session, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Toasty, find me an article about Thailand data centers."
  });
  await session.liveProducer.ready();
  const first = session.aiProducerFeed.visible().find((e) => e.type === ProducerEntryType.ASSET_PROPOSAL);
  const firstUrl = first.proposal.asset.sourceUrl;
  session.liveProducer.findAnother(first.id);
  const second = session.aiProducerFeed.entries.find((e) => e.id === first.id);
  assert(second.proposal.asset.sourceUrl !== firstUrl, "FIND ANOTHER selects a different candidate");
  assertEqual(second.proposal.asset.sourceUrl, THAILAND_DATA_CENTER_CANDIDATES[1].sourceUrl, "second candidate is the next real source");
  assert(session.productionLog.items.some((item) => item.type === ProductionActionType.SELECT_CANDIDATE), "candidate selection is timestamped");

  session.liveProducer.discardProposal(second.id);
  assertEqual(session.aiProducerFeed.visible().length, 0, "DISCARD hides the proposal");
  assert(session.assets.items.every((asset) => asset.status === ProgramAssetStatus.DISCARDED), "discarded assets are not live");
  assertEqual(session.programController.liveAsset(), null, "DISCARD never takes program");
  assert(session.productionLog.items.some((item) => item.type === ProductionActionType.DISCARD), "DISCARD is timestamped");

  const failSession = fixtureSession({ researchProvider: new EmptyResearchProvider() });
  ingestAttributedTranscript(failSession, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Toasty, find me an article about Thailand data centers."
  });
  await failSession.liveProducer.ready();
  const failEntry = failSession.aiProducerFeed.visible()[0];
  assertEqual(failEntry.summary, "I couldn’t find a source I trust enough to put on screen.", "research failure is graceful");
  assert(!failEntry.proposal?.asset, "failure does not invent an asset");
  assertEqual(failSession.assets.items.length, 0, "no fabricated catalogue row");

  const liveSession = fixtureSession();
  ingestAttributedTranscript(liveSession, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Toasty, find me an article about Thailand data centers."
  });
  await liveSession.liveProducer.ready();
  const proposal = liveSession.aiProducerFeed.visible().find((e) => e.type === ProducerEntryType.ASSET_PROPOSAL);
  liveSession.liveProducer.takeProposalLive(proposal.id);
  const withAsset = composeProgram(liveSession.participants.list(), {
    asset: liveSession.programController.liveAsset(),
    assetLayout: liveSession.program.assetLayout
  });
  assertEqual(withAsset.layout, ProgramLayout.ASSET_SPEAKER, "asset is on program");
  liveSession.liveProducer.removeLiveAsset(proposal.id);
  const restored = composeProgram(liveSession.participants.list(), {
    asset: liveSession.programController.liveAsset(),
    assetLayout: liveSession.program.assetLayout
  });
  assertEqual(restored.layout, ProgramLayout.DUO, "removing asset restores participant duo");
  assertEqual(restored.asset, null, "no leftover program asset");
  assertEqual(restored.slots.map((s) => s.participantId).join(","), "host,g-tukta", "host and guest keep stable order");
  assert(liveSession.productionLog.items.some((item) => item.type === ProductionActionType.REMOVE_ASSET), "REMOVE is timestamped");
}

console.log("\nFULL ASSET layout and guest cannot trigger research");
{
  const session = fixtureSession();
  ingestAttributedTranscript(session, {
    participantId: "g-tukta", role: "guest", speaker: "Tukta",
    text: "Toasty, find me an article about Thailand data centers."
  });
  await session.liveProducer.ready();
  assertEqual(session.hostDirectives.items.length, 0, "guest find is not a host directive");
  assertEqual(session.assets.items.length, 0, "guest speech does not create assets");

  const host = participant("host", ParticipantRole.HOST, "Ricardo");
  const liveAsset = createProgramAsset({
    title: THAILAND_DATA_CENTER_CANDIDATES[0].title,
    sourceUrl: THAILAND_DATA_CENTER_CANDIDATES[0].sourceUrl,
    sourceName: "Amazon",
    status: ProgramAssetStatus.LIVE
  });
  const full = composeProgram([host], { asset: liveAsset, assetLayout: ProgramLayout.ASSET_FULL });
  assertEqual(full.layout, ProgramLayout.ASSET_FULL, "full asset layout");
  assertEqual(full.slots.length, 0, "full asset has no speaker slots");
  const pip = composeProgram([host], { asset: liveAsset, assetLayout: ProgramLayout.ASSET_SPEAKER_PIP });
  assertEqual(pip.layout, ProgramLayout.ASSET_SPEAKER_PIP, "asset + speaker pip layout");
  assertEqual(pip.slots[0].participantId, "host", "pip still features host");
}

console.log("\nSessionPolicy still blocks research; Hottie cannot execute DOM/actions directly");
{
  const jam = fixtureSession({ policy: new SessionPolicy({ sessionType: SessionType.JAM }) });
  ingestAttributedTranscript(jam, {
    participantId: "host", role: "host", speaker: "Ricardo",
    text: "Toasty, find me an article about Thailand data centers."
  });
  await jam.liveProducer.ready();
  assertEqual(jam.transcript.lines.length, 0, "jam still forbids transcription");
  assertEqual(jam.assets.items.length, 0, "jam does not research");
  const unsupported = jam.programController.execute({ type: "document.body.innerHTML = 'pwn'" });
  assertEqual(unsupported.ok, false, "arbitrary action strings are rejected");
  const liveOnly = jam.programController.execute({ type: ProductionActionType.PLAY_AUDIO, assetId: "x" });
  assertEqual(liveOnly.ok, false, "future PLAY_AUDIO is reserved, not executed");
}

console.log("\nExisting participant layouts and publisher/renderer freeze");
{
  const host = participant("host", ParticipantRole.HOST, "Ricardo");
  const a = participant("A", ParticipantRole.GUEST, "A");
  const b = participant("B", ParticipantRole.GUEST, "B");
  const c = participant("C", ParticipantRole.GUEST, "C");
  assertEqual(composeProgram([host]).layout, ProgramLayout.SINGLE, "single unchanged");
  assertEqual(composeProgram([host, a]).layout, ProgramLayout.DUO, "duo unchanged");
  assertEqual(composeProgram([host, a, b]).layout, ProgramLayout.TRIO, "trio unchanged");
  assertEqual(composeProgram([host, a, b, c]).layout, ProgramLayout.QUAD, "quad unchanged");

  const liveSession = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
  assert(liveSession.includes("programController"), "LiveSession owns ProgramController");
  assert(!/mountRoomFrame\(this\._containers\.roomPreview/.test(liveSession), "setLayout still does not remount scene=0");
  const guestJs = readFileSync(join(ROOT, "js/guest.js"), "utf8");
  assert(guestJs.includes("stopPreview();"), "guest Join still releases native camera");
  const engine = readFileSync(join(ROOT, "js/video-engine.js"), "utf8");
  assert(engine.includes("view:true"), "guest publisher still uses bare &view");
  const renderer = readFileSync(join(ROOT, "js/program-renderer.js"), "utf8");
  assert(renderer.includes("Never scene=0"), "Program Renderer freeze");
  assert(renderer.includes("buildProgramAssetCard"), "renderer can display approved assets");
  const listener = readFileSync(join(ROOT, "js/listener.js"), "utf8");
  assert(listener.includes("syncProgramRenderer"), "listener still uses Program Renderer");
  assert(!listener.includes("mountProgramFrame"), "listener still has no scene=0 mixer");
  assert(listener.includes("asset: programState.asset"), "listener consumes published live assets");
}

console.log("\nALL PASSED — Host FIND researches, proposes privately, and TAKE LIVE is the only Program path.");
