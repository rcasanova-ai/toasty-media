#!/usr/bin/env node
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ProgramAssetCatalog,
  ProgramAssetStatus,
  ProgramAssetType,
  createProgramAsset,
  serializeProgramAsset,
  allowlistedImageUrl,
  allowlistedCatalogueSrc
} from "../js/program-asset.js";
import { ProgramController, ProductionActionLog, ProductionActionType } from "../js/production-controller.js";
import { AssetCatalogue, AssetCategory, programAssetFromCatalogueItem } from "../js/asset-catalogue.js";
import { buildPlayAudioCommand, buildStopAudioCommand, serializeProgramAudio } from "../js/program-audio.js";
import { composeProgram, ProgramLayout } from "../js/program-composition.js";
import { createParticipant, ParticipantRole, ConnectionStatus } from "../js/participant-registry.js";
import { resolveSoundCommand } from "../js/soundboard.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function loadCatalogue() {
  const document = JSON.parse(readFileSync(join(ROOT, "assets/catalogue/catalogue.json"), "utf8"));
  return AssetCatalogue.fromDocument(document);
}

function fixtureSession(catalogue) {
  const published = [];
  const session = {
    roomId: "audio-slice",
    assets: new ProgramAssetCatalog(),
    catalogue,
    productionLog: new ProductionActionLog(),
    program: { assetLayout: null, scene: "live", live: true, audio: null },
    programAudio: null
  };
  session.programController = new ProgramController(session);
  session.emit = () => {};
  session._syncProgramPreview = () => { session._previewSynced = true; };
  session.publishProgramState = () => {
    published.push({
      asset: serializeProgramAsset(session.programController.liveAsset()),
      assetLayout: session.program.assetLayout,
      audio: serializeProgramAudio(session.program.audio)
    });
  };
  session.published = published;
  return session;
}

console.log("Asset Catalogue loads real files with provenance");
{
  const catalogue = loadCatalogue();
  assert(catalogue.items.length >= 15, `useful catalogue size (${catalogue.items.length})`);
  assert(catalogue.items.length <= 30, "quality over a dump of tiny files");
  assertEqual(catalogue.standard.sampleRate, 48000, "48 kHz prepare standard");
  assertEqual(catalogue.standard.channels, 2, "stereo prepare standard");
  assertEqual(catalogue.standard.loudness.integratedLUFS, -16, "loudness target -16 LUFS");
  const required = ["id", "displayName", "category", "filename", "duration", "source", "sourceUrl", "license", "addedDate"];
  for (const item of catalogue.items) {
    if (item.missing) {
      assert(!item.src, `${item.id} missing slot has no media src`);
      continue;
    }
    for (const key of required) {
      assert(item[key] !== undefined && item[key] !== "", `${item.id} has ${key}`);
    }
    assert(["CC0 1.0", "Public domain", "CC BY 3.0"].includes(item.license), `${item.id} has a redistribution-safe license`);
    if (item.attributionRequired) assert(item.attribution, `${item.id} records attribution text`);
    const path = join(ROOT, item.src.replace(/^\//, ""));
    assert(existsSync(path), `${item.id} file exists on disk`);
    assert(statSync(path).size > 1000, `${item.id} is a real audio file, not a stub`);
    assert(allowlistedCatalogueSrc(item.src) === item.src, `${item.id} src is a first-party catalogue path`);
    assert(Object.values(AssetCategory).includes(item.category), `${item.id} uses an extensible catalogue category`);
  }
  assert(catalogue.get("drum-roll-01"), "drum roll is in the catalogue");
  assert(catalogue.get("applause-01"), "applause is in the catalogue");
  assert(catalogue.get("wolf-whistle-01"), "wolf whistle is in the catalogue");
  assertEqual(catalogue.get("wolf-whistle-01").license, "Public domain", "wolf whistle is a real public-domain recording");
  assertEqual(catalogue.get("cholo-whistle-01").missing, true, "cholo whistle slot is reserved as missing");
  assert(catalogue.get("intro-sting-01"), "intro sting is in the catalogue");
  assert(catalogue.byCategory(AssetCategory.STINGER).length >= 3, "stinger category is populated");
  assertEqual(catalogue.byCategory(AssetCategory.IMAGE).length, 0, "image category is reserved, not a second system");
}

console.log("\nCatalogue items become ProgramAssets without a parallel SoundboardAsset type");
{
  const catalogue = loadCatalogue();
  const drum = programAssetFromCatalogueItem(catalogue.get("drum-roll-01"));
  assertEqual(drum.type, ProgramAssetType.SOUND, "drum roll is a ProgramAsset sound");
  assertEqual(drum.media.kind, "audio", "audio media kind");
  assertEqual(drum.media.src, "/assets/catalogue/audio/drum-roll-01.ogg", "keeps local catalogue src");
  assertEqual(drum.status, ProgramAssetStatus.APPROVED, "catalogue items are approved library rows, not LIVE graphics");
  const serialized = serializeProgramAsset(drum);
  assertEqual(serialized.media.src, "/assets/catalogue/audio/drum-roll-01.ogg", "serialize keeps catalogue audio src");
  assert(!allowlistedCatalogueSrc("https://evil.example/boom.ogg"), "remote audio URLs are not trusted");
  assert(!allowlistedCatalogueSrc("/assets/catalogue/audio/../secret.ogg"), "path traversal is rejected");
  assert(!allowlistedCatalogueSrc("/assets/audio/legacy.ogg"), "only assets/catalogue/ is playable");
  const article = createProgramAsset({
    type: ProgramAssetType.ARTICLE,
    title: "AWS Thailand",
    sourceUrl: "https://press.aboutamazon.com/2025/1/aws-launches-infrastructure-region-in-thailand",
    imageUrl: "https://upload.wikimedia.org/wikipedia/commons/a/a0/Example.jpg"
  });
  assertEqual(serializeProgramAsset(article).preview.kind, "card", "article ProgramAssets stay cards");
  assert(allowlistedImageUrl(article.preview.imageUrl), "Wikimedia article images still serialize");
}

console.log("\nPLAY_AUDIO / STOP_AUDIO are structured production actions on the Program Audio path");
{
  const catalogue = loadCatalogue();
  const session = fixtureSession(catalogue);
  const host = createParticipant({
    participantId: "host",
    role: ParticipantRole.HOST,
    displayName: "Ricardo",
    connectionStatus: ConnectionStatus.CONNECTED
  });

  const missing = session.programController.execute({ type: ProductionActionType.PLAY_AUDIO, assetId: "no-such-cue" });
  assertEqual(missing.ok, false, "missing catalogue item fails");
  assertEqual(missing.reason, "missing-asset", "failure reason is missing-asset");
  assertEqual(session.program.audio, null, "failed play does not publish a command");

  const corrupt = { ...catalogue.get("drum-roll-01"), src: "/tmp/not-catalogue.wav" };
  catalogue.items = catalogue.items.map((item) => item.id === "drum-roll-01" ? corrupt : item);
  const badSrc = session.programController.execute({ type: ProductionActionType.PLAY_AUDIO, assetId: "drum-roll-01" });
  assertEqual(badSrc.ok, false, "non-catalogue src fails");
  assertEqual(badSrc.reason, "missing-media", "corrupt/unsafe src is missing-media, not a fake sound");
  catalogue.items = loadCatalogue().items;

  const play = session.programController.execute({
    type: ProductionActionType.PLAY_AUDIO,
    assetId: "drum-roll-01",
    initiator: "producer"
  });
  assert(play.ok, "drum roll PLAY_AUDIO executes");
  assertEqual(play.command.action, ProductionActionType.PLAY_AUDIO, "command is PLAY_AUDIO");
  assertEqual(play.command.assetId, "drum-roll-01", "command names the catalogue id");
  assertEqual(play.command.src, "/assets/catalogue/audio/drum-roll-01.ogg", "command carries the real file");
  assert(play.command.playId, "playId is present for listener identity");
  assertEqual(play.command.initiator, "producer", "initiator is recorded");
  assert(play.command.duration > 0, "duration is known");
  assertEqual(session.programController.liveAsset(), null, "audio play does not TAKE LIVE a graphic");
  const composition = composeProgram([host], {
    asset: session.programController.liveAsset(),
    assetLayout: session.program.assetLayout
  });
  assertEqual(composition.layout, ProgramLayout.SINGLE, "playing audio does not change participant layout");
  assertEqual(composition.asset, null, "playing audio does not put a card on Program Output");
  assert(session.published.some((snap) => snap.audio?.assetId === "drum-roll-01" && snap.audio.src.endsWith("drum-roll-01.ogg")), "ProgramSync received Program Audio, not producer-local playback");
  assert(session.productionLog.items.some((item) => item.type === ProductionActionType.PLAY_AUDIO && item.assetId === "drum-roll-01" && item.initiator === "producer"), "PLAY_AUDIO is in the production action log");

  const applause = session.programController.execute({ type: ProductionActionType.PLAY_AUDIO, assetId: "applause-01", initiator: "host" });
  assert(applause.ok, "applause PLAY_AUDIO executes");
  const whistle = session.programController.execute({ type: ProductionActionType.PLAY_AUDIO, assetId: "wolf-whistle-01", initiator: "producer" });
  assert(whistle.ok, "cholo whistle PLAY_AUDIO executes");
  assertEqual(whistle.command.src, "/assets/catalogue/audio/wolf-whistle-01.ogg", "wolf whistle uses the catalogue file, not a generated tone");
  const sting = session.programController.execute({ type: ProductionActionType.PLAY_AUDIO, assetId: "intro-sting-01" });
  assert(sting.ok, "stinger PLAY_AUDIO executes");

  const alias = session.programController.execute({ type: ProductionActionType.PLAY_ASSET, assetId: "whoosh-01" });
  assert(alias.ok, "PLAY_ASSET is the Hottie-facing alias for PLAY_AUDIO");
  assertEqual(alias.command.action, ProductionActionType.PLAY_AUDIO, "PLAY_ASSET still records PLAY_AUDIO on the bus");

  const stop = session.programController.execute({ type: ProductionActionType.STOP_AUDIO, initiator: "producer" });
  assert(stop.ok, "STOP_AUDIO executes");
  assertEqual(session.program.audio.action, ProductionActionType.STOP_AUDIO, "program audio command is STOP");
  assert(session.productionLog.items.some((item) => item.type === ProductionActionType.STOP_AUDIO && item.assetId === "whoosh-01"), "STOP_AUDIO is logged against the current asset");
}

console.log("\nSoundboard has no procedural fallback");
{
  const soundboard = readFileSync(join(ROOT, "js/soundboard.js"), "utf8");
  assert(!soundboard.includes("createOscillator"), "no oscillators");
  assert(!soundboard.includes("createBuffer"), "no procedural noise buffers");
  assert(!/case \"drumRoll\"/.test(soundboard), "procedural cue switch is gone");
  assert(soundboard.includes("ProductionActionType.PLAY_AUDIO"), "pads execute PLAY_AUDIO");
  const items = loadCatalogue().soundboardItems();
  const drum = resolveSoundCommand("Hottie give me a drum roll", items);
  assertEqual(drum?.id, "drum-roll-01", "host language still resolves to the real drum roll");
  const whistleCue = resolveSoundCommand("play the wolf whistle", items);
  assertEqual(whistleCue?.id, "wolf-whistle-01", "wolf whistle resolves through the same soundboard path");
  const stop = resolveSoundCommand("stop the sound", items);
  assertEqual(stop?.action, ProductionActionType.STOP_AUDIO, "stop is a structured action");
}

console.log("\nProgram Audio command builders never treat producer-local play as the program path");
{
  const catalogue = loadCatalogue();
  const command = buildPlayAudioCommand(catalogue.get("drum-roll-01"), { initiator: "producer", now: 1000, playId: "play-test" });
  const serialized = serializeProgramAudio(command);
  assertEqual(serialized.src, "/assets/catalogue/audio/drum-roll-01.ogg", "serialized program audio is the catalogue file");
  const stopped = buildStopAudioCommand(serialized, { initiator: "producer", now: 2000 });
  assertEqual(stopped.action, "STOP_AUDIO", "stop command");
  assertEqual(serializeProgramAudio({ action: "PLAY_AUDIO", src: "https://cdn.evil/x.mp3", assetId: "x" }), null, "remote play URLs cannot become Program Audio");
  const busSrc = readFileSync(join(ROOT, "js/program-audio.js"), "utf8");
  assert(busSrc.includes("createMediaStreamDestination"), "bus exposes a capture graph for future master recording");
  assert(busSrc.includes("captureStream()"), "captureStream is the recording hook");
  assert(busSrc.includes("Producer-local playback is a MONITOR"), "code states producer play is not Program Audio");
}

console.log("\nAudience path and recording hook are explicit");
{
  const listener = readFileSync(join(ROOT, "js/listener.js"), "utf8");
  assert(listener.includes("syncProgramAudio"), "Program Output consumes Program Audio commands");
  assert(listener.includes("programMixer.applyBusCommand") || listener.includes("programAudio.applyCommand"), "audience plays through ProgramAudioBus/mixer");
  assert(!listener.includes("new Audio("), "audience path is not a raw Audio() one-off");
  const recording = readFileSync(join(ROOT, "js/recording.js"), "utf8");
  assert(recording.includes("getUserMedia"), "isolated recorder is still host-mic-only");
  assert(recording.includes("ProgramAudioBus.captureStream"), "isolated recorder documents the missing Program Audio connection");
  const liveSession = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
  assert(liveSession.includes("audio: serializeProgramAudio"), "ProgramSync publishes the audio command");
}

console.log("\nExisting Program Renderer, publisher lifecycle, and TAKE LIVE remain frozen");
{
  const liveSession = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
  assert(!/mountRoomFrame\(this\._containers\.roomPreview/.test(liveSession), "setLayout still does not remount scene=0");
  const guestJs = readFileSync(join(ROOT, "js/guest.js"), "utf8");
  assert(guestJs.includes("stopPreview();"), "guest Join still releases native camera");
  const engine = readFileSync(join(ROOT, "js/video-engine.js"), "utf8");
  assert(engine.includes("view:true"), "guest publisher still uses bare &view");
  const renderer = readFileSync(join(ROOT, "js/program-renderer.js"), "utf8");
  assert(renderer.includes("Never scene=0"), "Program Renderer freeze");
  const listener = readFileSync(join(ROOT, "js/listener.js"), "utf8");
  assert(listener.includes("syncProgramRenderer"), "listener still uses Program Renderer");
  assert(listener.includes("asset: programState.asset"), "listener still consumes published live assets");
}

console.log("\nALL PASSED — real catalogue files, Program Audio commands, no procedural fallback.");
