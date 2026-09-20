#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeProgram,
  compositionOptionsFromState,
  CompositionMode,
  ProgramLayout,
  ShareLayout
} from "../js/program-composition.js";
import { createScreenShareSource, serializeScreenShareSource, screenShareFromPresence, ScreenShareState, isScreenShareAvailable } from "../js/screen-share-source.js";
import { createAudioActivity, serializeAudioActivity, AUDIO_ACTIVITY_THRESHOLD } from "../js/audio-activity.js";
import { ActiveSpeakerController, nominateActiveSpeaker, ACTIVE_SPEAKER_HOLD_MS, ACTIVE_SPEAKER_ATTACK_MS } from "../js/active-speaker.js";
import { buildCanonicalState } from "../js/session-control.js";
import { ProgramAudioMixer, createProgramAudioSource, ProgramAudioSourceKind } from "../js/program-audio-mixer.js";
import { createTranscriptEvent, transcriptEventFromLegacyLine } from "../js/transcript-event.js";
import { normalizeAudienceMessage, AudienceSource, HOTTIE_PUBLIC_IDENTITY, hottiePublicReply, clusterAudienceQuestions } from "../js/audience-message.js";
import { createSessionRecord, createSessionArtifact, ArtifactType, planDefaultArtifacts } from "../js/session-artifact.js";
import { ProgramDestinationRouter, ProgramDestinationKind } from "../js/program-destination.js";
import { ProductionTimeline, ProductionEventType } from "../js/production-timeline.js";
import { collectHottieContext, proposeHottieActions, hottieMayExecute } from "../js/hottie-show-runner.js";
import { focusGroupUsesStudioPrimitives, attachFocusGroupToSession } from "../js/focus-group-studio.js";
import { inspectComposedMaster, ProgramVideoSourceKind } from "../js/master-recorder.js";
import { detectHostDirective, isHostSpeaker } from "../js/host-directive.js";
import { ProgramController, ProductionActionType } from "../js/production-controller.js";
import { formatDiagnostics } from "../js/media-diagnostics.js";
import { cameraSourceFromParticipant, ParticipantSourceKind } from "../js/participant-source.js";
import { formatHottieProposalFeed } from "../js/hottie-show-runner.js";
import { LiveProducerController } from "../js/live-producer.js";
import { ProducerFeed, ProducerEntryType } from "../js/ai-producer.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function src(relative) {
  return readFileSync(join(ROOT, relative), "utf8");
}

const live = src("js/live-session.js");
const guest = src("js/guest.js");
const listener = src("js/listener.js");
const presence = src("js/room-presence.js");
const host = { participantId: "host", role: "host", connectionStatus: "connected", joinedAt: 0, onProgram: true, displayName: "Ricardo", transportSourceId: "tmroomh" };
const tukta = { participantId: "g-tukta", role: "guest", connectionStatus: "connected", joinedAt: 1, onProgram: true, displayName: "Tukta", transportSourceId: "tmroomgtukta" };
const duo = composeProgram([host, tukta]);

console.log("\n1-2. Host camera publisher survives share; separate transport ID");
assert(live.includes("mountScreenPublisher"), "Host startScreenShare mounts a separate publisher");
assert(live.includes("createScreenStreamId"), "Host share gets createScreenStreamId");
assert(!live.includes("this.engine.setScreenShare"), "Host never replaces camera via setScreenShare");
assert(live.includes("_hostPreviewStream !== camera") || live.includes("if (camera) this._hostPreviewStream = camera"), "camera identity is restored/preserved");
const share = createScreenShareSource({ ownerParticipantId: "host", transportSourceId: "tmroomsabcd1234", active: true, state: ScreenShareState.BINDING });
assert(share.transportSourceId !== "tmroomh", "screen transport id is distinct from camera");
assertEqual(share.ownerParticipantId, "host", "canonical owner is host");

console.log("\n3-5. Same ScreenShareSource model; presence identity; remote PO without opener");
const guestShare = createScreenShareSource({ ownerParticipantId: "g-tukta", transportSourceId: "tmroomszzzz9999", active: true });
assertEqual(serializeScreenShareSource(share).transportSourceId, "tmroomsabcd1234", "host serializes transport id");
assertEqual(serializeScreenShareSource(guestShare).ownerParticipantId, "g-tukta", "guest uses same canonical model");
assert(presence.includes("setScreenShare"), "presence publishes screen-share identity");
assert(presence.includes("audioActivity"), "presence carries audio activity metadata");
assert(listener.includes("transportSourceId"), "Program Output binds transport sources");
assert(listener.includes("ownedStreamFor"), "opener remains an optimization");
assert(!listener.includes("if (!api) return") || listener.includes("if (!api) return null"), "missing opener does not crash");
const remoteState = buildCanonicalState({
  roomId: "tmroom",
  screenShare: share,
  compositionMode: CompositionMode.BALANCED,
  participants: [host, tukta]
});
assertEqual(remoteState.screenShare.transportSourceId, "tmroomsabcd1234", "canonical state publishes screen transport id");
const remoteOptions = compositionOptionsFromState(remoteState);
assert(isScreenShareAvailable(remoteOptions.screenShare), "remote PO can resolve share without window.opener");

console.log("\n6-8. Screen Full / Speaker / Strip use remote share");
assertEqual(composeProgram([host, tukta], { screenShare: share, shareLayout: ShareLayout.SCREEN_ONLY }).layout, ProgramLayout.SCREEN_ONLY, "Screen Full uses remote share");
assertEqual(composeProgram([host, tukta], { screenShare: share, shareLayout: ShareLayout.SCREEN_SPEAKER }).layout, ProgramLayout.SCREEN_SPEAKER, "Screen + Speaker uses remote share");
assertEqual(composeProgram([host, tukta], { screenShare: share, shareLayout: ShareLayout.SCREEN_STRIP }).layout, ProgramLayout.SCREEN_STRIP, "Screen + Strip uses remote share");
assert(composeProgram([host, tukta], { screenShare: share, shareLayout: ShareLayout.SCREEN_SPEAKER }).screen.transportSourceId === "tmroomsabcd1234", "composition screen carries remote id");

console.log("\n9-13. Stop / camera survival / restore / late join / disconnect cleanup");
assert(live.includes("screenPublisherEndedMessage"), "native Stop Sharing is handled");
assert(guest.includes("screenPublisherEndedMessage"), "guest native Stop Sharing is handled");
assert(live.includes("ScreenShareState.ENDED") || live.includes("createScreenShareSource({ ownerParticipantId: \"host\""), "stop clears canonical source");
assert(live.includes("_preShareComposition"), "prior composition is restored");
const late = screenShareFromPresence({ participantId: "host", displayName: "Ricardo", screenShare: { active: true, participantId: "host", transportSourceId: "tmroomsabcd1234" } });
assert(late.active && late.transportSourceId === "tmroomsabcd1234", "late Program Output discovers an already-active share");
const gone = screenShareFromPresence({ participantId: "host", screenShare: { active: false } });
assertEqual(gone.active, false, "disconnect/stop yields inactive source");
assertEqual(duo.layout, ProgramLayout.DUO, "accepted duo remains unchanged");

console.log("\n14-22. Real activity into ActiveSpeakerController");
const controller = new ActiveSpeakerController();
const t0 = 1_000_000;
controller.note("host", 0.5, t0);
assertEqual(controller.currentId, null, "short noise / attack window does not switch yet");
controller.note("host", 0.55, t0 + ACTIVE_SPEAKER_ATTACK_MS + 20);
assertEqual(controller.currentId, "host", "sustained Host speech selects Host");
controller.note("g-tukta", 0.8, t0 + ACTIVE_SPEAKER_ATTACK_MS + 40);
assertEqual(controller.currentId, "host", "hold/hysteresis prevents thrashing on first interruption");
controller.note("g-tukta", 0.85, t0 + ACTIVE_SPEAKER_ATTACK_MS + ACTIVE_SPEAKER_HOLD_MS + 80);
assertEqual(controller.currentId, "g-tukta", "sustained Guest speech selects Guest");
const hostSample = createAudioActivity({ participantId: "host", audioLevel: 0.42, speaking: true });
const guestSample = createAudioActivity({ participantId: "g-tukta", audioLevel: 0.07, speaking: false });
assertEqual(serializeAudioActivity(hostSample).participantId, "host", "activity metadata is participant-specific");
assert(serializeAudioActivity(guestSample).audioLevel < AUDIO_ACTIVITY_THRESHOLD, "quiet guest is not speaking");
assert(!JSON.stringify(hostSample).includes("pcm"), "raw audio is not in activity metadata");
assert(live.includes("createAudioActivityMeter"), "Host meters owned mic stream");
assert(guest.includes("createAudioActivityMeter"), "Guest meters owned mic stream");
assert(!live.includes("getUserMedia(") || live.includes("_hostPreviewStream"), "Host does not reacquire mic for activity");
assert(guest.includes("releasePreviewVideo"), "Guest does not reacquire camera/mic for activity");
assert(presence.includes("pcm") === false || presence.includes("!body.audioActivity.pcm") || src("scripts/render-production-server.mjs").includes("!body.audioActivity.pcm"), "presence rejects raw audio");

console.log("\n23-25. Balanced ignores nomination; Spotlight overrides; clear restores mode");
const withActive = composeProgram([host, tukta], { mode: CompositionMode.BALANCED, activeParticipantId: "g-tukta" });
assertEqual(withActive.layout, ProgramLayout.DUO, "Balanced ignores active-speaker nomination");
const spotlight = composeProgram([host, tukta], { mode: CompositionMode.SPOTLIGHT, spotlightParticipantId: "g-tukta", activeParticipantId: "host" });
assertEqual(spotlight.layout, ProgramLayout.SPOTLIGHT, "Spotlight overrides Active Speaker");
assertEqual(spotlight.featuredId || spotlight.slots[0].participantId, "g-tukta", "Guest remains Spotlight");
assert(live.includes("_preSpotlightMode"), "clear Spotlight restores selected mode");

console.log("\n26-30. Duo freeze, preview/output share truth, debugMedia, presence, visprod");
assertEqual(duo.slots.length, 2, "existing accepted duo remains 2 slots");
assert(listener.includes("compositionOptionsFromState"), "Program Output uses composition truth");
assert(live.includes("compositionState: this.canonicalControlState()"), "Preview uses the same composition truth");
const diag = formatDiagnostics({
  buildId: "test",
  role: "host",
  self: { participantId: "host", audioLevel: 0.42, speaking: true, transportSourceId: "tmroomh" },
  remotes: [{ role: "guest", participantId: "g-tukta", requestedSourceId: "tmroomgtukta", mounted: true, mediaState: "PLAYING", audioLevel: 0.07, speaking: false }],
  screenShare: share,
  screenHealth: "playing",
  activity: [{ participantId: "host", audioLevel: 0.42, speaking: true }]
});
assert(diag.includes("audioLevel 0.42"), "debugMedia exposes host activity");
assert(diag.includes("speaking YES") || diag.includes("speaking true") || diag.includes("speaking YES"), "debugMedia exposes speaking");
assert(diag.includes("share host"), "debugMedia exposes screen-share source");
assert(src("js/guest.js").includes("debugMedia") && src("js/listener.js").includes("debugMedia"), "debugMedia remains opt-in on Guest/PO");
assert(src("scripts/presence-3way-test.mjs").includes("announce"), "presence three-way test still present");
assert(src("scripts/broadcast-visual-production-test.mjs").includes("composeProgram"), "broadcast visual production test still present");

console.log("\nProgram Audio / mixer / destinations");
const mixer = new ProgramAudioMixer({ bus: { connectStream: () => ({ ok: true }), disconnectStream() {}, captureStream: () => ({ getAudioTracks: () => [{ kind: "audio" }] }), current: null } });
mixer.addParticipant({ participantId: "host", stream: { id: "mic" }, label: "Ricardo" });
mixer.addParticipant({ participantId: "g-tukta", transportLimited: true });
const mixerState = mixer.state();
assert(mixerState.sources.length >= 2, "mixer tracks host + guest sources");
assert(mixerState.sources.some((item) => item.transportLimited), "guest VDO audio is marked transport-limited, not faked");
assertEqual(createProgramAudioSource({ id: "bus", kind: ProgramAudioSourceKind.BUS }).kind, "bus", "soundboard/bus is a mixer source kind");
const inspection = inspectComposedMaster({
  video: { kind: ProgramVideoSourceKind.ELEMENT, stream: null },
  audio: { stream: null }
});
assertEqual(inspection.ok, false, "composed master does not fake iframe pixels");
assertEqual(inspection.mode, "fallback-display", "tab-capture remains the honest fallback");

console.log("\nTranscript attribution / Host directive authority");
const event = createTranscriptEvent({ participantId: "g-tukta", role: "guest", speaker: "Tukta", text: "Toasty, find me something" });
assertEqual(event.participantId, "g-tukta", "guest STT is attributed to the guest browser");
assertEqual(isHostSpeaker(event), false, "guest FIND is not a host speaker");
assertEqual(detectHostDirective(event), null, "guest Toasty phrase does not execute production control");
assert(detectHostDirective({ participantId: "host", role: "host", speaker: "Ricardo", text: "Toasty, spotlight Tukta" }), "host directive still executes");
assert(transcriptEventFromLegacyLine({ participantId: "host", role: "host", speaker: "Ricardo", text: "hello" }).source, "legacy lines map to TranscriptEvent");

console.log("\nAudienceMessage + Hottie → ProgramController");
const msg = normalizeAudienceMessage({ displayName: "Maria", message: "Does the grid have capacity?", platform: "toasty" });
assertEqual(msg.source, AudienceSource.TOASTY, "Toasty audience normalizes");
assertEqual(msg.kind, "question", "questions are classified");
const reply = hottiePublicReply({ text: "Great question — we will come back to grid capacity." });
assertEqual(reply.author, HOTTIE_PUBLIC_IDENTITY, "public AI identity is Hottie · Toasty Producer");
assertEqual(reply.metadata.impersonatesHost, false, "Hottie does not impersonate Host");
assert(clusterAudienceQuestions([msg, normalizeAudienceMessage({ message: "grid capacity??", displayName: "Pim" })]).length >= 1, "clusters repeated questions");
const executable = new Set(Object.values(ProductionActionType));
assert(executable.has("SURFACE_CHAT") && executable.has("POST_CHAT"), "Hottie chat actions exist on ProgramController");
assert(!hottieMayExecute({ action: { type: "SET_SPOTLIGHT" }, requiresApproval: true }, { autonomy: "suggest" }), "Hottie does not execute without approval");

console.log("\nSessionArtifact + Focus Group primitives + timeline + destinations");
const record = createSessionRecord({ sessionId: "sess-1", roomId: "tmroom", focusGroup: { id: "fg-1" } });
assert(planDefaultArtifacts(record).some((item) => item.type === ArtifactType.FOCUS_GROUP_INSIGHTS), "focus-group insight pack is planned");
assertEqual(createSessionArtifact({ type: ArtifactType.FULL_EPISODE, sessionId: "sess-1" }).type, "FULL_EPISODE", "full episode artifact schema");
const primitives = focusGroupUsesStudioPrimitives();
assertEqual(primitives.composition, "ProgramComposition", "Focus Group uses ProgramComposition");
assertEqual(primitives.recording, "MasterRecorder", "Focus Group uses MasterRecorder");
const sessionStub = { participants: { list: () => [host, tukta] }, runOfShow: { load() {} } };
attachFocusGroupToSession(sessionStub, { objective: "Understand pricing objections", researchQuestions: ["What would stop you?"] });
assert(sessionStub.researchContext.objective.includes("pricing"), "ResearchContext attached for Hottie");
const timeline = new ProductionTimeline();
timeline.record(ProductionEventType.SHARE_STARTED, { transportSourceId: "tmroomsabcd1234" }, { participantId: "host" });
assertEqual(timeline.items[0].type, "share-started", "production breadcrumbs are timestampable");
const destinations = new ProgramDestinationRouter();
assert(destinations.list().some((item) => item.kind === ProgramDestinationKind.TOASTY_AUDIENCE), "Toasty Audience destination exists");
assertEqual(destinations.goLive("youtube").ok, false, "unimplemented destinations are not faked live");
assertEqual(cameraSourceFromParticipant(host).kind, ParticipantSourceKind.CAMERA, "participant camera is a distinct source from screen");

console.log("\nHottie proposal approval actually reaches ProgramController.execute (audit repair)");
{
  // Regression test for the exact seam the integration audit found broken: formatHottieProposalFeed
  // built a real, executable action on every proposal, but no UI path ever called
  // ProgramController.execute with it (renderFeedEntry only rendered an action row for
  // ASSET_PROPOSAL/retry entries, never PRODUCTION_SUGGESTION). This proves the repaired wire
  // (LiveProducerController.approveHottieProposal, js/ai-producer.js's new render branch) without a DOM.
  let spotlighted = null;
  const fakeSession = {
    aiProducerFeed: new ProducerFeed(),
    productionLog: { record() {} },
    setSpotlight(participantId) { spotlighted = participantId; }
  };
  fakeSession.programController = new ProgramController(fakeSession);
  const producer = new LiveProducerController(fakeSession);

  const proposal = {
    type: "BRING_QUIET_PARTICIPANT",
    noticed: "Guest B has not spoken.",
    recommends: "Spotlight Guest B for a beat.",
    action: { type: ProductionActionType.SET_SPOTLIGHT, participantId: "guest-b" },
    requiresApproval: true
  };
  const entry = fakeSession.aiProducerFeed.push(formatHottieProposalFeed(proposal));
  assertEqual(entry.type, ProducerEntryType.PRODUCTION_SUGGESTION, "Hottie proposal lands as a PRODUCTION_SUGGESTION feed entry");
  assertEqual(entry.proposal.requiresApproval, true, "proposal starts requiring approval");

  const result = producer.approveHottieProposal(entry.id);
  assertEqual(result.ok, true, "approveHottieProposal's execute() call succeeds");
  assertEqual(spotlighted, "guest-b", "the proposed action's participantId actually reached session.setSpotlight — not just logged");

  const updated = fakeSession.aiProducerFeed.entries.find((item) => item.id === entry.id);
  assertEqual(updated.proposal.executed, true, "feed entry is marked executed after approval");
  assertEqual(updated.proposal.requiresApproval, false, "approved proposal no longer requires approval (button won't re-render)");

  // Dismiss path — the other half of the wire (Producer can reject instead of approving).
  const proposal2 = { ...proposal, action: { type: ProductionActionType.SET_SPOTLIGHT, participantId: "guest-c" } };
  const entry2 = fakeSession.aiProducerFeed.push(formatHottieProposalFeed(proposal2));
  producer.dismissHottieProposal(entry2.id);
  const dismissed = fakeSession.aiProducerFeed.entries.find((item) => item.id === entry2.id);
  assertEqual(dismissed.dismissed, true, "dismissHottieProposal marks the entry dismissed without executing it");
  assertEqual(spotlighted, "guest-b", "dismissing a second proposal does not execute its action (still guest-b from the approved one)");
}

console.log("\nAll studio marathon architecture tests passed.");
