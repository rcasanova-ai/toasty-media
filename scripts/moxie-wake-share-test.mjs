#!/usr/bin/env node
// Moxie's hands-free flow: the "Hey Moxie" wake phrase on the host's transcript, private answers, explicit host approval
// before anything reaches the session chat, and taking an approved item off the program output again. Pure modules and a
// stub session: no browser, no network, no language model.
import { ParticipantRegistry, createParticipant, ParticipantRole, ConnectionStatus } from "../js/participant-registry.js";
import { TranscriptStore, ShowContextMemory } from "../js/show-context.js";
import { SessionPolicy, CapturePolicy } from "../js/session-policy.js";
import { RunOfShow } from "../js/run-of-show.js";
import { AudienceStore } from "../js/audience.js";
import { ProducerFeed, ProducerEntryType } from "../js/ai-producer.js";
import { HostDirectiveLog, detectHostDirective, extractAddressedCommand, isBareWake, isShareApproval, DirectiveIntent } from "../js/host-directive.js";
import { ResponseAudience } from "../js/hottie-action.js";
import { LiveProducerController, ingestAttributedTranscript } from "../js/live-producer.js";
import { ProgramAssetCatalog } from "../js/program-asset.js";
import { ProgramController, ProductionActionLog } from "../js/production-controller.js";
import { composeProgram } from "../js/program-composition.js";

const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };
const participant = (id, role, displayName) => createParticipant({ participantId: id, role, displayName, connectionStatus: ConnectionStatus.CONNECTED });

const CANDIDATE = { title: "Example Corp announces acquisition of Widgets Ltd", sourceName: "Example News", sourceUrl: "https://news.example.com/acquisition", excerpt: "Example Corp agreed to acquire Widgets Ltd.", type: "article", retrievedAt: Date.parse("2026-10-01T00:00:00Z") };

function fixture({ policy } = {}) {
  const participants = new ParticipantRegistry();
  participants.upsert(participant("host", ParticipantRole.HOST, "Sam"));
  participants.upsert(participant("g1", ParticipantRole.GUEST, "Maya"));
  const searches = [];
  const chat = [];
  const session = {
    roomId: "wake", policy: policy || new SessionPolicy(), participants, transcript: new TranscriptStore(), showMemory: new ShowContextMemory(),
    hostDirectives: new HostDirectiveLog(), aiProducerFeed: new ProducerFeed(), runOfShow: new RunOfShow(), audience: new AudienceStore(), researchContext: null,
    guestSeats: [], elapsedMs: () => 0, demoMode: false, assets: new ProgramAssetCatalog(), productionLog: new ProductionActionLog(),
    researchProvider: { search: async (q) => { searches.push(q); return [CANDIDATE]; } },
    program: { assetLayout: null, scene: "live", live: true },
    audienceAdapter: { ingest: (m) => { chat.push(m); return m; } }
  };
  session.programController = new ProgramController(session);
  session.emit = () => {};
  session._syncProgramPreview = () => {};
  session.publishProgramState = () => {};
  session.liveProducer = new LiveProducerController(session);
  session.liveProducer.speakProgram = () => { session.spoke = (session.spoke || 0) + 1; };
  session.searches = searches; session.chat = chat;
  return session;
}
const say = async (session, who, text) => {
  ingestAttributedTranscript(session, who === "host" ? { participantId: "host", role: "host", speaker: "Sam", text } : { participantId: "g1", role: "guest", speaker: "Maya", text });
  await session.liveProducer.ready();
};
const visible = (s, type) => s.aiProducerFeed.visible().filter((e) => e.type === type);

console.log("Wake phrase recognition");
const cmd = (text) => detectHostDirective({ text, role: "host", speaker: "Sam" });
assert(cmd("Hey Moxie, who won the election in 2016?")?.intent === DirectiveIntent.ANSWER, "\"Hey Moxie, who won the election in 2016?\" is a question for Moxie");
assert(cmd("Okay, hey Moxie, can you find the article we mentioned?")?.intent === DirectiveIntent.FIND, "a lead-in and a polite request still reach Moxie");
assert(cmd("Hey Moxie, remind me what our guest said earlier about the acquisition")?.intent === DirectiveIntent.RECALL, "recall of what a guest said is understood");
assert(cmd("Hey Moxie, pull up the information about that company.")?.intent === DirectiveIntent.FIND, "pulling up information is a find request");
assert(cmd("Hey Moxy who is the CEO?")?.wakeWord === "moxy", "a common spelling of the name from speech recognition works");
assert(extractAddressedCommand("Okay, thanks Moxie. Take it off.")?.rest === "Take it off.", "\"thanks Moxie. Take it off.\" is addressed to Moxie");
assert(cmd("Okay, thanks Moxie. Take it off.")?.intent === DirectiveIntent.REMOVE_ASSET, "and it means take the item off the program");
for (const talk of ["Moxie is interesting", "I was telling Moxie about it yesterday", "We should ask Moxie later", "So the acquisition closed in March", "Hey everyone, welcome back", "Moxie is the best producer I have worked with"]) {
  assert(cmd(talk) === null, `ordinary conversation is ignored: "${talk}"`);
}
assert(detectHostDirective({ text: "Hey Moxie, find the article", role: "guest", speaker: "Maya" }) === null, "a guest saying the wake phrase does nothing");
assert(isBareWake("Hey Moxie.") && !isBareWake("Hey Moxie, find it"), "a bare \"Hey Moxie\" is recognised as getting Moxie's attention");
assert(isShareApproval("Yes, share that with everyone.") && isShareApproval("Post that to the chat") && !isShareApproval("share the screen"), "approval phrases for sharing are specific");

console.log("\nNormal conversation costs nothing");
{
  const s = fixture();
  for (const t of ["Welcome back to the show.", "Today we are talking about acquisitions.", "I think that deal was surprising.", "Moxie is interesting, I think."]) await say(s, "host", t);
  await say(s, "guest", "Hey Moxie, find the article");
  assert(s.hostDirectives.items.length === 0 && s.searches.length === 0 && s.chat.length === 0, "no commands, no lookups and no chat messages from ordinary talk");
}

console.log("\nPolicy and consent");
{
  const s = fixture({ policy: new SessionPolicy({ capturePolicy: CapturePolicy.NONE }) });
  await say(s, "host", "Hey Moxie, who won the election in 2016?");
  assert(s.hostDirectives.items.length === 0 && s.searches.length === 0, "when the session does not allow transcription or AI processing, Moxie does not act on anything");
}

console.log("\nPrivate by default");
{
  const s = fixture();
  await say(s, "host", "Hey Moxie, who won the election in 2016?");
  assert(s.searches.length === 1 && !s.spoke, "an answer is looked up once and never spoken on the program by itself");
  const answer = visible(s, ProducerEntryType.RESEARCH)[0];
  assert(answer && answer.responseAudience === ResponseAudience.PRIVATE_HOST, "the answer appears privately in the host's feed");
  assert(s.chat.length === 0, "nothing was posted to the session chat");
  await say(s, "host", "Hey Moxie, who won the election in 2016?");
  assert(s.searches.length === 1, "the same command repeated straight away is handled once");
}

console.log("\nHost approval before anything is shared");
{
  const s = fixture();
  await say(s, "host", "Hey Moxie, find me the article about the acquisition");
  const proposal = visible(s, ProducerEntryType.ASSET_PROPOSAL)[0];
  assert(proposal && s.chat.length === 0, "Moxie's find waits privately with the host");
  await say(s, "guest", "Yes, share that with everyone");
  assert(s.chat.length === 0, "a guest cannot approve sharing");
  await say(s, "host", "Yes, share that with everyone.");
  assert(s.chat.length === 1, "when the host says yes, it is published to the chat once");
  assert(s.chat[0].author === "Moxie · Toasty Producer" && s.chat[0].text.includes(CANDIDATE.title) && s.chat[0].text.includes(CANDIDATE.sourceUrl), "the message keeps Moxie's attribution, the title and the source link");
  assert(s.aiProducerFeed.entries.find((e) => e.id === proposal.id).sharedToChat === true, "the feed marks it as shared");
  await say(s, "host", "Yes, share that with everyone.");
  assert(s.chat.length === 1, "saying it again does not post it twice");
  await say(s, "host", "Hey Moxie, share that with everyone");
  assert(s.chat.length === 1 && s.aiProducerFeed.visible().some((e) => e.title === "Nothing to share yet"), "asked directly with nothing left to share, Moxie says so instead of posting");
}
{
  const s = fixture();
  await say(s, "host", "Hey Moxie, find me the article about the acquisition");
  const proposal = visible(s, ProducerEntryType.ASSET_PROPOSAL)[0];
  const shared = s.liveProducer.shareToChat(proposal.id, { via: "button" });
  assert(shared.ok && s.chat.length === 1, "the Share to chat button works the same way");
  assert(s.liveProducer.shareToChat(proposal.id).ok === false && s.chat.length === 1, "a second click does nothing");
}
{
  const s = fixture();
  await say(s, "host", "Hey Moxie, remind me what our guest said earlier about the acquisition");
  assert(s.chat.length === 0, "recall results stay private until approved");
  await say(s, "guest", "I think the acquisition was a surprise to everyone.");
  await say(s, "host", "Hey Moxie, what did Maya say about the acquisition?");
  const recall = s.aiProducerFeed.visible().find((e) => e.title === "From earlier");
  assert(recall?.shareable === true && s.chat.length === 0, "a recalled quote is offered for sharing but not posted");
  await say(s, "host", "Share that with everyone");
  assert(s.chat.length === 1 && s.chat[0].text.includes("surprise"), "approving it posts the quote");
}
{
  const s = fixture();
  await say(s, "host", "Hey Moxie, find me the article about the acquisition");
  s.aiProducerFeed.dismiss(visible(s, ProducerEntryType.ASSET_PROPOSAL)[0].id);
  await say(s, "host", "Share that with everyone");
  assert(s.chat.length === 0, "a dismissed result is never shared");
}

console.log("\nProgram output: put it on screen and take it off");
{
  const s = fixture();
  await say(s, "host", "Hey Moxie, put that article on screen");
  const proposal = visible(s, ProducerEntryType.ASSET_PROPOSAL)[0];
  assert(proposal && s.programController.liveAsset() === null, "Moxie prepares the article but does not put it on the program");
  const before = composeProgram(s.participants.list(), {});
  const take = s.liveProducer.takeProposalLive(proposal.id);
  assert(take.ok && s.programController.liveAsset(), "the host approves it and it goes on the program");
  const during = composeProgram(s.participants.list(), { asset: s.programController.liveAsset(), assetLayout: s.program.assetLayout });
  assert(/asset/.test(during.layout) && during.slots.some((slot) => slot.participantId === "host"), "the article becomes the main visual with the host in a smaller position");
  await say(s, "host", "Okay, thanks Moxie. Take it off.");
  assert(s.programController.liveAsset() === null, "\"Take it off\" removes it");
  const after = composeProgram(s.participants.list(), { asset: s.programController.liveAsset(), assetLayout: s.program.assetLayout });
  assert(after.layout === before.layout, "the previous program layout is restored");
  assert(s.chat.length === 0, "putting something on screen never posts to chat");
}

console.log("\nALL PASSED: Moxie listens for \"Hey Moxie\", answers privately, shares only with host approval and restores the program output.");
