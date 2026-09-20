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
import { nominateActiveSpeaker, ACTIVE_SPEAKER_HOLD_MS } from "../js/active-speaker.js";
import { lowerThirdModel } from "../js/participant-lower-third.js";
import { detectHostDirective, DirectiveIntent, productionActionFromDirective } from "../js/host-directive.js";
import { ProgramController, ProductionActionLog, ProductionActionType } from "../js/production-controller.js";
import { ProgramAssetCatalog, createProgramAsset, ProgramAssetStatus, serializeProgramAsset } from "../js/program-asset.js";
import { AssetCatalogue } from "../js/asset-catalogue.js";
import { LiveProducerController, ingestAttributedTranscript } from "../js/live-producer.js";
import { ParticipantRegistry, createParticipant, ParticipantRole, ConnectionStatus } from "../js/participant-registry.js";
import { TranscriptStore, ShowContextMemory } from "../js/show-context.js";
import { SessionPolicy } from "../js/session-policy.js";
import { ProducerFeed } from "../js/ai-producer.js";
import { HostDirectiveLog } from "../js/host-directive.js";
import { getBrandProfile } from "../js/brand-profile.js";
import { BRAND_THEMES } from "../js/brand-themes.js";
import { resolveSoundCommand } from "../js/soundboard.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function p(id, role, joinedAt, extra = {}) {
  return { participantId: id, role, connectionStatus: "connected", joinedAt, onProgram: true, displayName: extra.displayName || id, ...extra };
}

function loadCatalogue() {
  return AssetCatalogue.fromDocument(JSON.parse(readFileSync(join(ROOT, "assets/catalogue/catalogue.json"), "utf8")));
}

function fixtureSession() {
  const participants = new ParticipantRegistry();
  participants.upsert(createParticipant({
    participantId: "host",
    role: ParticipantRole.HOST,
    displayName: "Ricardo",
    company: "Santati Labs",
    title: "Co-Founder",
    connectionStatus: ConnectionStatus.CONNECTED
  }));
  participants.upsert(createParticipant({
    participantId: "g-tukta",
    role: ParticipantRole.GUEST,
    displayName: "Tukta",
    connectionStatus: ConnectionStatus.CONNECTED
  }));
  const session = {
    participants,
    policy: new SessionPolicy(),
    transcript: new TranscriptStore(),
    showMemory: new ShowContextMemory(),
    hostDirectives: new HostDirectiveLog(),
    aiProducerFeed: new ProducerFeed(),
    assets: new ProgramAssetCatalog(),
    productionLog: new ProductionActionLog(),
    catalogue: loadCatalogue(),
    program: {
      compositionMode: CompositionMode.BALANCED,
      spotlightParticipantId: null,
      activeParticipantId: null,
      shareLayout: null,
      layout: "grid",
      assetLayout: null,
      audio: null
    },
    screenShare: { active: false, participantId: "host", stream: null },
    _hostPreviewStream: { id: "camera-identity" },
    _preShareComposition: null,
    emit() {},
    _syncProgramPreview() { session._previewSynced = true; },
    publishProgramState() { session._published = true; },
    setCompositionMode(mode) {
      session.program.compositionMode = mode;
      if (mode === CompositionMode.BALANCED) session.program.spotlightParticipantId = null;
    },
    setSpotlight(participantId) {
      session.program.compositionMode = CompositionMode.SPOTLIGHT;
      session.program.spotlightParticipantId = participantId;
    },
    clearSpotlight() {
      session.program.spotlightParticipantId = null;
      session.program.compositionMode = CompositionMode.BALANCED;
    },
    setShareLayout(shareLayout) {
      session.program.shareLayout = shareLayout;
    },
    startScreenShare() {
      session._cameraBeforeShare = session._hostPreviewStream;
      session._preShareComposition = {
        mode: session.program.compositionMode,
        spotlightParticipantId: session.program.spotlightParticipantId,
        layout: session.program.layout,
        shareLayout: session.program.shareLayout
      };
      session.screenShare = { active: true, participantId: "host", stream: { id: "display" }, transportSourceId: null };
      session.program.shareLayout = session.program.shareLayout || ShareLayout.SCREEN_SPEAKER;
      return session.screenShare;
    },
    stopScreenShare() {
      const camera = session._cameraBeforeShare || session._hostPreviewStream;
      session.screenShare = { active: false, participantId: "host", stream: null };
      const restore = session._preShareComposition || {};
      session.program.shareLayout = null;
      session.program.compositionMode = restore.mode || CompositionMode.BALANCED;
      session.program.spotlightParticipantId = restore.spotlightParticipantId || null;
      session._hostPreviewStream = camera;
      session._preShareComposition = null;
    }
  };
  session.programController = new ProgramController(session);
  session.liveProducer = new LiveProducerController(session);
  return session;
}

const host = p("host", "host", 0, { displayName: "Ricardo", company: "Santati Labs", title: "Co-Founder" });
const guest = p("g-tukta", "guest", 1, { displayName: "Tukta" });
const pat = p("g-pat", "guest", 2, { displayName: "Pat" });
const lee = p("g-lee", "guest", 3, { displayName: "Lee" });

console.log("1. Accepted 2-person balanced composition");
{
  const duo = composeProgram([host, guest]);
  assertEqual(duo.layout, ProgramLayout.DUO, "Host+Guest → duo");
  assertEqual(duo.slots.map((s) => s.participantId).join(","), "host,g-tukta", "host-first duo order");
  assertEqual(duo.mode, CompositionMode.BALANCED, "default mode is balanced");
  assertEqual(duo.screen, null, "no screen source in the accepted duo");
}

console.log("\n2–3. Balanced 3- and 4-person");
{
  assertEqual(composeProgram([host, guest, pat]).layout, ProgramLayout.TRIO, "3 → trio");
  assertEqual(composeProgram([host, guest, pat, lee]).layout, ProgramLayout.QUAD, "4 → quad");
}

console.log("\n4–5. Spotlight and clear");
{
  const lit = composeProgram([host, guest], {
    mode: CompositionMode.SPOTLIGHT,
    spotlightParticipantId: "g-tukta"
  });
  assertEqual(lit.layout, ProgramLayout.SPOTLIGHT, "spotlight layout");
  assertEqual(lit.featuredId, "g-tukta", "guest is dominant");
  assertEqual(lit.slots[0].participantId, "g-tukta", "featured first");
  const session = fixtureSession();
  session.programController.execute({ type: ProductionActionType.SET_SPOTLIGHT, participantId: "g-tukta" });
  assertEqual(session.program.spotlightParticipantId, "g-tukta", "controller sets spotlight");
  session.programController.execute({ type: ProductionActionType.CLEAR_SPOTLIGHT });
  assertEqual(session.program.compositionMode, CompositionMode.BALANCED, "clear returns balanced");
  assertEqual(session.program.spotlightParticipantId, null, "spotlight id cleared");
}

console.log("\n6–7. Active speaker nomination + hysteresis");
{
  const first = nominateActiveSpeaker({
    levels: [{ participantId: "host", level: 0.8 }, { participantId: "g-tukta", level: 0.1 }],
    currentId: null,
    now: 1000,
    lastSwitchAt: 0
  });
  assertEqual(first.participantId, "host", "loud host is nominated");
  const active = composeProgram([host, guest], {
    mode: CompositionMode.ACTIVE_SPEAKER,
    activeParticipantId: first.participantId
  });
  assertEqual(active.layout, ProgramLayout.ACTIVE_SPEAKER, "active-speaker layout");
  assertEqual(active.featuredId, "host", "host is dominant");
  const held = nominateActiveSpeaker({
    levels: [{ participantId: "host", level: 0.3 }, { participantId: "g-tukta", level: 0.45 }],
    currentId: "host",
    now: 1100,
    lastSwitchAt: 1000
  });
  assertEqual(held.participantId, "host", "hold time blocks a quick interrupt");
  assertEqual(held.switched, false, "no switch during hold");
  const stillHeld = nominateActiveSpeaker({
    levels: [{ participantId: "host", level: 0.4 }, { participantId: "g-tukta", level: 0.45 }],
    currentId: "host",
    now: 1000 + ACTIVE_SPEAKER_HOLD_MS + 50,
    lastSwitchAt: 1000
  });
  assertEqual(stillHeld.participantId, "host", "hysteresis blocks a near-tie after hold");
  const switched = nominateActiveSpeaker({
    levels: [{ participantId: "host", level: 0.2 }, { participantId: "g-tukta", level: 0.9 }],
    currentId: "host",
    now: 1000 + ACTIVE_SPEAKER_HOLD_MS + 50,
    lastSwitchAt: 1000
  });
  assertEqual(switched.participantId, "g-tukta", "clear louder speaker can take over after hold");
}

console.log("\n8–12. Screen share compositions restore prior layout");
{
  const session = fixtureSession();
  const camera = session._hostPreviewStream;
  session.programController.execute({ type: ProductionActionType.SET_SPOTLIGHT, participantId: "g-tukta" });
  session.startScreenShare();
  assertEqual(session._hostPreviewStream, camera, "camera identity preserved when share starts");
  assert(session.screenShare.active, "share is active");
  const only = composeProgram([host, guest], {
    screenShare: session.screenShare,
    shareLayout: ShareLayout.SCREEN_ONLY
  });
  assertEqual(only.layout, ProgramLayout.SCREEN_ONLY, "screen only");
  assertEqual(only.slots.length, 0, "screen only has no camera slots");
  const speaker = composeProgram([host, guest], {
    screenShare: session.screenShare,
    shareLayout: ShareLayout.SCREEN_SPEAKER,
    spotlightParticipantId: "g-tukta"
  });
  assertEqual(speaker.layout, ProgramLayout.SCREEN_SPEAKER, "screen + speaker");
  assertEqual(speaker.slots.length, 1, "one speaker beside the screen");
  const strip = composeProgram([host, guest, pat], {
    screenShare: session.screenShare,
    shareLayout: ShareLayout.SCREEN_STRIP
  });
  assertEqual(strip.layout, ProgramLayout.SCREEN_STRIP, "screen + strip");
  assertEqual(strip.slots.length, 3, "strip keeps the cameras");
  session.programController.execute({ type: ProductionActionType.SET_SHARE_LAYOUT, shareLayout: ShareLayout.SCREEN_STRIP });
  assertEqual(session.program.shareLayout, ShareLayout.SCREEN_STRIP, "controller sets share layout");
  session.stopScreenShare();
  assertEqual(session._hostPreviewStream, camera, "camera identity preserved when share stops");
  assertEqual(session.program.compositionMode, CompositionMode.SPOTLIGHT, "prior spotlight restored");
  assertEqual(session.program.spotlightParticipantId, "g-tukta", "prior spotlight participant restored");
  assertEqual(session.screenShare.active, false, "share inactive");
}

console.log("\n13–14. Compact mark in lower-third model");
{
  const withMark = lowerThirdModel(host, { compactMark: "https://www.8alta.com/favicon.ico" });
  assertEqual(withMark.name, "Ricardo", "name from participant data, not hardcoded");
  assertEqual(withMark.secondary, "Santati Labs — Co-Founder", "Company — Title");
  assert(withMark.hasMark, "compact mark present");
  const fallback = lowerThirdModel(host);
  assertEqual(fallback.hasMark, false, "missing compact mark falls back");
  const alta = getBrandProfile("8alta");
  assert(Boolean(alta.compactMark), "8ALTA brand profile has a compact mark");
}

console.log("\n15. Environmental motif is theme-driven");
{
  const superteam = getBrandProfile("superteam");
  assert(Boolean(superteam.environmentalMotif || superteam.backgroundSilhouette), "Superteam has environmental motif artwork");
  assert(Boolean(superteam.broadcastWatermark || superteam.backgroundWatermark), "Superteam has broadcast watermark artwork");
  assert(BRAND_THEMES.superteam.artwork.backgroundSilhouette.includes("silhouette-skyline"), "theme owns Thai skyline artwork");
  assert(BRAND_THEMES.tangem.artwork == null || !BRAND_THEMES.tangem.artwork?.backgroundSilhouette, "themes without motif stay empty");
  const toasty = getBrandProfile("toasty");
  assertEqual(Boolean(toasty.environmentalMotif), false, "Toasty has no customer temple motif");
}

console.log("\n16–18. Hottie structured production directives, guests blocked");
{
  const session = fixtureSession();
  const spotlight = detectHostDirective({
    participantId: "host",
    role: "host",
    speaker: "Ricardo",
    text: "Toasty, put Tukta up big."
  }, { participants: session.participants.list() });
  assertEqual(spotlight.intent, DirectiveIntent.SET_SPOTLIGHT, "put Tukta up big → SET_SPOTLIGHT");
  assertEqual(spotlight.payload.participantId, "g-tukta", "resolves Tukta from roster");
  const action = productionActionFromDirective(spotlight);
  assertEqual(action.type, ProductionActionType.SET_SPOTLIGHT, "structured SET_SPOTLIGHT");
  ingestAttributedTranscript(session, {
    participantId: "host",
    role: "host",
    speaker: "Ricardo",
    text: "Toasty, put Tukta up big."
  });
  assertEqual(session.program.spotlightParticipantId, "g-tukta", "ProgramController executed spotlight");
  ingestAttributedTranscript(session, {
    participantId: "host",
    role: "host",
    speaker: "Ricardo",
    text: "Toasty, back to everyone."
  });
  assertEqual(session.program.compositionMode, CompositionMode.BALANCED, "back to everyone → balanced");
  session.screenShare = { active: true, participantId: "host", stream: { id: "display" } };
  ingestAttributedTranscript(session, {
    participantId: "host",
    role: "host",
    speaker: "Ricardo",
    text: "Toasty, make the screen full."
  });
  assertEqual(session.program.shareLayout, ShareLayout.SCREEN_ONLY, "SET_SHARE_LAYOUT screen-only");
  const guestLine = detectHostDirective({
    participantId: "g-tukta",
    role: "guest",
    speaker: "Tukta",
    text: "Toasty, spotlight Ricardo."
  }, { participants: session.participants.list() });
  assertEqual(guestLine, null, "guest Toasty command is not a directive");
}

console.log("\n19. Program Preview and Program Output share composition truth");
{
  const state = {
    compositionMode: CompositionMode.SPOTLIGHT,
    spotlightParticipantId: "g-tukta",
    asset: null,
    screenShare: { active: false }
  };
  const preview = composeProgram([host, guest], compositionOptionsFromState(state));
  const output = composeProgram([host, guest], compositionOptionsFromState(state));
  assertEqual(JSON.stringify(preview), JSON.stringify(output), "same state → identical composition");
  const listener = readFileSync(join(ROOT, "js/listener.js"), "utf8");
  const live = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
  assert(listener.includes("compositionState: programState"), "Program Output passes compositionState into the renderer");
  assert(live.includes("compositionState: this.canonicalControlState()"), "Program Preview passes the same canonical state");
}

console.log("\n20. ProgramAsset TAKE LIVE still works");
{
  const session = fixtureSession();
  const asset = session.assets.add(createProgramAsset({
    title: "AWS Thailand",
    createdBy: "hottie",
    status: ProgramAssetStatus.APPROVED,
    sourceUrl: "https://press.aboutamazon.com/2025/1/aws-launches-infrastructure-region-in-thailand"
  }));
  const take = session.programController.execute({ type: ProductionActionType.TAKE_ASSET, assetId: asset.id });
  assert(take.ok, "TAKE_ASSET executes");
  const composed = composeProgram([host, guest], {
    asset: serializeProgramAsset(session.assets.live()),
    assetLayout: session.program.assetLayout
  });
  assertEqual(composed.layout, ProgramLayout.ASSET_SPEAKER, "asset still wins composition");
}

console.log("\n21–23. Soundboard catalogue + wolf rename + cholo provenance");
{
  const catalogue = loadCatalogue();
  const wolf = catalogue.get("wolf-whistle-01");
  assert(wolf, "Wolf Whistle is in the catalogue");
  assertEqual(wolf.displayName, "Wolf Whistle", "renamed accurately");
  assertEqual(wolf.license, "Public domain", "wolf whistle remains a real public-domain recording");
  assertEqual(wolf.src, "/assets/catalogue/audio/wolf-whistle-01.ogg", "wolf whistle file path");
  const items = catalogue.soundboardItems();
  const wolfCue = resolveSoundCommand("give me a wolf whistle", items);
  assertEqual(wolfCue?.id, "wolf-whistle-01", "soundboard still resolves Wolf Whistle");
  const cholo = catalogue.get("cholo-whistle-01");
  assert(cholo, "cholo-whistle-01 slot is reserved");
  assertEqual(cholo.missing, true, "cholo whistle is documented missing, not faked");
  assert(!cholo.src, "no fake cholo media src");
  assert(!items.some((item) => item.id === "cholo-whistle-01"), "missing cholo is not on the soundboard");
  const session = fixtureSession();
  const blocked = session.programController.execute({ type: ProductionActionType.PLAY_AUDIO, assetId: "cholo-whistle-01" });
  assertEqual(blocked.ok, false, "missing cholo cannot play");
  const playWolf = session.programController.execute({ type: ProductionActionType.PLAY_AUDIO, assetId: "wolf-whistle-01" });
  assert(playWolf.ok, "Wolf Whistle plays through ProgramController");
  const missingDoc = readFileSync(join(ROOT, "assets/catalogue/MISSING-CHOLO-WHISTLE.md"), "utf8");
  assert(missingDoc.includes("NOT SHIPPED"), "missing-asset path is documented");
}

console.log("\n24. debugMedia remains default-off");
{
  const diagnostics = readFileSync(join(ROOT, "js/media-diagnostics.js"), "utf8");
  const listener = readFileSync(join(ROOT, "js/listener.js"), "utf8");
  const guest = readFileSync(join(ROOT, "js/guest.js"), "utf8");
  assert(listener.includes('get("debugMedia") !== "1"'), "Program Output debugMedia is opt-in");
  assert(guest.includes("debugMedia") || diagnostics.includes("debugMedia"), "debugMedia helper still exists");
  assert(!listener.includes("startMediaDiagnostics();\n"), "diagnostics are not started unconditionally");
}

console.log("\nDo-not-regress: camera share must not use VDO screenshare replace");
{
  const live = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
  const guest = readFileSync(join(ROOT, "js/guest.js"), "utf8");
  assert(live.includes("mountScreenPublisher"), "Host share uses a separate screen publisher");
  assert(live.includes("createScreenStreamId"), "Host share receives a separate transport source ID");
  assert(!live.includes("this.engine.setScreenShare"), "Host share never calls engine.setScreenShare");
  assert(!/engine\.setScreenShare\(/.test(live), "Host never posts {screenshare} on the camera iframe");
  assert(!guest.includes("setGuestScreenShare("), "Guest share does not replace the camera publisher");
  assert(guest.includes("mountScreenPublisher"), "Guest screen is a separate publisher");
  const renderer = readFileSync(join(ROOT, "js/program-renderer.js"), "utf8");
  assert(renderer.includes("Hottie · AI Producer"), "Hottie attribution exists on research cards");
}

console.log("\nAll broadcast visual production tests passed.");
