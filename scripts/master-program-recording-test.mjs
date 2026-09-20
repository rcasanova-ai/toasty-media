#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RecordingKind,
  MarkerType,
  MarkerLog,
  MasterProgramRecorder,
  assertMasterTracks,
  composeMasterMediaStream,
  assembleMasterPackage,
  buildMasterManifest,
  productionTimeline,
  assetsUsedFromTimeline,
  createMarker,
  markerTypeFromProduction,
  idleRecordingState,
  activeRecordingState,
  captureFailureMessage,
  looksLikeProgramOutput,
  programOutputDisplayConstraints,
  masterCaptureSupported,
  masterMediaId,
  masterManifestId,
  inspectMasterCapture,
  wrapMediaRecorderError,
  startMasterMediaRecorder,
  isInvalidStateError,
  PROGRAM_OUTPUT_PICKER_INSTRUCTION
} from "../js/program-recording.js";
import { ProgramAssetCatalog, createProgramAsset, serializeProgramAsset, ProgramAssetStatus } from "../js/program-asset.js";
import { ProgramController, ProductionActionLog, ProductionActionType } from "../js/production-controller.js";
import { AssetCatalogue } from "../js/asset-catalogue.js";
import { composeProgram, ProgramLayout } from "../js/program-composition.js";
import { createParticipant, ParticipantRole, ConnectionStatus } from "../js/participant-registry.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function read(path) {
  return readFileSync(join(ROOT, path), "utf8");
}

function fakeTrack(kind, label = "", { readyState = "live" } = {}) {
  return {
    kind,
    label,
    readyState,
    stop() { this.stopped = true; this.readyState = "ended"; },
    addEventListener() {}
  };
}

function fakeCapture({ video = true, audio = true, label = "Toasty Studio — Program Output" } = {}) {
  const videoTracks = video ? [fakeTrack("video", label)] : [];
  const audioTracks = audio ? [fakeTrack("audio", "Tab")] : [];
  return {
    getVideoTracks: () => videoTracks,
    getAudioTracks: () => audioTracks,
    getTracks: () => [...videoTracks, ...audioTracks]
  };
}

class FakeMediaRecorder {
  constructor(stream, options) {
    this.stream = stream;
    this.options = options;
    this.state = "inactive";
    this.mimeType = options?.mimeType || "video/webm";
    this._listeners = new Map();
  }

  static isTypeSupported(type) {
    return String(type).includes("webm");
  }

  addEventListener(type, callback) {
    const list = this._listeners.get(type) || [];
    list.push(callback);
    this._listeners.set(type, list);
  }

  start(timeslice) {
    this.state = "recording";
    this.timeslice = timeslice;
  }

  stop() {
    this.state = "inactive";
    const chunk = new Blob(["master-program-bytes"], { type: this.mimeType });
    (this._listeners.get("dataavailable") || []).forEach((callback) => callback({ data: chunk }));
    (this._listeners.get("stop") || []).forEach((callback) => callback());
  }
}

function loadCatalogue() {
  return AssetCatalogue.fromDocument(JSON.parse(read("assets/catalogue/catalogue.json")));
}

console.log("Master vs isolated are different artifacts");
{
  assertEqual(RecordingKind.MASTER, "master-program", "master kind");
  assertEqual(RecordingKind.ISOLATED, "isolated-participant", "isolated kind");
  const idle = idleRecordingState();
  assertEqual(idle.kind, RecordingKind.MASTER, "session recording defaults to master");
  assertEqual(idle.active, false, "idle is not recording");
  assertEqual(idle.status, "idle", "idle status");
  const active = activeRecordingState({ recordingId: "rec-1", startedAt: 10, last: idle.last });
  assertEqual(active.status, "recording", "active status is recording");
  assertEqual(active.kind, RecordingKind.MASTER, "active is still master, not isolated");
}

console.log("\nProgram Renderer capture source is Program Output, not a second compositor");
{
  const recording = read("js/program-recording.js");
  const renderer = read("js/program-renderer.js");
  assert(recording.includes("getDisplayMedia"), "master uses getDisplayMedia of Program Output");
  assert(recording.includes("program-output-tab"), "capture visual is the Program Output tab");
  assert(recording.includes("original getDisplayMedia stream"), "InvalidStateError fix records original capture stream");
  const startBody = recording.slice(recording.indexOf("async start("), recording.indexOf("async stop("));
  assert(!startBody.includes("composeMasterMediaStream"), "start does not wrap capture tracks in a new MediaStream");
  assert(startBody.includes("this.masterStream = capture"), "start assigns the original capture stream");
  assert(startBody.includes("inspectMasterCapture"), "start validates live video and audio tracks before MediaRecorder");
  assert(startBody.includes("startMasterMediaRecorder"), "start uses the fallback MediaRecorder lifecycle");
  assert(recording.includes("ONE") || recording.includes("second compositor") || recording.includes("second visual truth"), "forbids a second visual truth");
  assert(!recording.includes("document.createElement(\"canvas\")"), "master does not spin a recording canvas");
  assert(renderer.includes("Never scene=0"), "Program Renderer freeze");
  assert(renderer.includes("syncProgramRenderer") || renderer.includes("export function syncProgramRenderer"), "renderer still exports syncProgramRenderer");
  const constraints = programOutputDisplayConstraints();
  assertEqual(constraints.audio, true, "tab audio is requested");
  assertEqual(constraints.selfBrowserSurface, "exclude", "Director surface is excluded so Producer picks Program Output");
  assert(looksLikeProgramOutput({ label: "Toasty Studio — Program Output" }) === true, "Program Output tab title matches");
  assert(looksLikeProgramOutput({ label: "Director" }) === false, "Director title is not Program Output");
}

console.log("\nProgramAudioBus capture source and native-stream mix hook");
{
  const bus = read("js/program-audio.js");
  assert(bus.includes("captureStream()"), "bus exposes captureStream");
  assert(bus.includes("createMediaStreamDestination"), "bus has a MediaStreamDestination");
  assert(bus.includes("connectStream"), "native streams can enter the program graph");
  assert(bus.includes("createMediaStreamSource"), "connectStream uses MediaStreamAudioSourceNode");
  assert(bus.includes("Program Output cannot do this for"), "VDO iframe boundary is documented");
  assert(bus.includes("Producer-local playback is a MONITOR"), "producer play is not Program Audio");
  const listener = read("js/listener.js");
  assert(listener.includes("programMixer.applyBusCommand") || listener.includes("programAudio.applyCommand"), "Program Output plays through the bus/mixer");
  assert(!listener.includes("createMediaStreamSource"), "Program Output does not fake-tap VDO iframe tracks");
}

console.log("\nMaster MediaStream composition and missing-track failure");
{
  const missingAudio = assertMasterTracks({ videoTracks: [{}], audioTracks: [] });
  assertEqual(missingAudio.ok, false, "missing audio fails");
  assertEqual(missingAudio.reason, "missing-audio", "reason is missing-audio");
  const missingVideo = assertMasterTracks({ videoTracks: [], audioTracks: [{}] });
  assertEqual(missingVideo.ok, false, "missing video fails");
  assertEqual(missingVideo.reason, "missing-video", "reason is missing-video");
  const ok = assertMasterTracks({ videoTracks: [{ id: "v" }], audioTracks: [{ id: "a" }] });
  assertEqual(ok.ok, true, "both tracks pass");
  const composed = composeMasterMediaStream({ videoTracks: [{ id: "v" }], audioTracks: [{ id: "a" }] });
  assert(composed.ok !== false, "compose does not throw when tracks exist");
  assert(captureFailureMessage("missing-audio").includes("Share tab audio"), "missing-audio message tells the operator to enable tab audio");
  assertEqual(captureFailureMessage("missing-audio"), "Program Output audio was not shared. Start again and enable Share tab audio.", "exact missing-audio copy");
  assertEqual(captureFailureMessage("missing-video"), "Program Output video capture is unavailable.", "exact missing-video copy");
  const endedVideo = assertMasterTracks({ videoTracks: [fakeTrack("video", "Program Output", { readyState: "ended" })], audioTracks: [fakeTrack("audio")] });
  assertEqual(endedVideo.ok, false, "ended video fails");
  assertEqual(endedVideo.reason, "video-not-live", "reason is video-not-live");
  const endedAudio = assertMasterTracks({ videoTracks: [fakeTrack("video")], audioTracks: [fakeTrack("audio", "Tab", { readyState: "ended" })] });
  assertEqual(endedAudio.ok, false, "ended audio fails");
  assertEqual(endedAudio.reason, "audio-not-live", "reason is audio-not-live");
  const liveOk = assertMasterTracks({ videoTracks: [fakeTrack("video")], audioTracks: [fakeTrack("audio")] });
  assertEqual(liveOk.ok, true, "live tracks pass");
  assertEqual(liveOk.videoReadyState, "live", "video readyState recorded");
  assertEqual(captureFailureMessage("audio-not-live"), captureFailureMessage("missing-audio"), "not-live audio uses the share-tab-audio copy");
}

console.log("\nMediaRecorder start/stop lifecycle");
{
  assertEqual(masterCaptureSupported({ mediaDevices: {}, MediaRecorderImpl: null }), false, "unsupported without getDisplayMedia");
  assertEqual(masterCaptureSupported({ mediaDevices: { getDisplayMedia: () => {} }, MediaRecorderImpl: FakeMediaRecorder }), true, "supported when both exist");
  const capture = fakeCapture({ audio: true, video: true });
  const recorder = new MasterProgramRecorder({
    displayMedia: async () => capture,
    MediaRecorderImpl: FakeMediaRecorder
  });
  const started = await recorder.start({ recordingId: "rec-test" });
  assertEqual(started.recordingId, "rec-test", "start returns recordingId");
  assert(started.startedAt, "start stamps startedAt");
  assertEqual(recorder.masterStream, capture, "records the original getDisplayMedia stream, not a reconstructed MediaStream");
  assertEqual(recorder.captureStream, capture, "captureStream is the original share");
  assert(started.diagnostics?.operation.includes("MediaRecorder.start"), "start returns diagnostics for the start operation");
  const stopped = await recorder.stop();
  assertEqual(stopped.recordingId, "rec-test", "stop keeps recordingId");
  assert(stopped.blob?.size > 0, "stop produces a real Blob");
  assertEqual(stopped.audioSources[0], "program-output-tab", "audio source is Program Output tab");
  assert(stopped.bytes > 0, "byte length is recorded");

  const silent = new MasterProgramRecorder({
    displayMedia: async () => fakeCapture({ audio: false, video: true }),
    MediaRecorderImpl: FakeMediaRecorder
  });
  let failed = null;
  try {
    await silent.start({ recordingId: "rec-silent" });
  } catch (error) {
    failed = error;
  }
  assert(failed, "missing tab audio throws");
  assertEqual(failed.reason, "missing-audio", "does not silently substitute host-mic + catalogue");
  assertEqual(failed.message, "Program Output audio was not shared. Start again and enable Share tab audio.", "missing audio is human-readable");

  const noVideo = new MasterProgramRecorder({
    displayMedia: async () => fakeCapture({ audio: true, video: false }),
    MediaRecorderImpl: FakeMediaRecorder
  });
  let videoFailed = null;
  try {
    await noVideo.start({ recordingId: "rec-novideo" });
  } catch (error) {
    videoFailed = error;
  }
  assertEqual(videoFailed?.reason, "missing-video", "missing video throws");
  assertEqual(videoFailed.message, "Program Output video capture is unavailable.", "missing video is human-readable");

  class InvalidStateRecorder extends FakeMediaRecorder {
    start() {
      const error = new Error("Failed to execute 'start' on 'MediaRecorder': The MediaRecorder's state is invalid.");
      error.name = "InvalidStateError";
      throw error;
    }
  }
  const invalid = new MasterProgramRecorder({
    displayMedia: async () => fakeCapture({ audio: true, video: true }),
    MediaRecorderImpl: InvalidStateRecorder
  });
  let invalidFailed = null;
  try {
    await invalid.start({ recordingId: "rec-invalid" });
  } catch (error) {
    invalidFailed = error;
  }
  assert(invalidFailed, "InvalidStateError from MediaRecorder.start is caught");
  assertEqual(invalidFailed.reason, "invalid-recorder-state", "reason is invalid-recorder-state, not a raw browser string");
  assert(invalidFailed.operation.includes("MediaRecorder.start"), "operation names MediaRecorder.start");
  assertEqual(invalidFailed.causeName, "InvalidStateError", "cause name is preserved for logs");
  assert(/state is invalid|invalid state/i.test(invalidFailed.causeMessage), "cause message keeps the browser InvalidStateError text");
  assert(!/^invalid state$/i.test(invalidFailed.message), "user-facing message is not raw 'invalid state'");
  assert(invalidFailed.diagnostics?.videoReadyState === "live", "diagnostics include live video track state");
  assert(invalidFailed.diagnostics?.audioReadyState === "live", "diagnostics include live audio track state");
  assert(PROGRAM_OUTPUT_PICKER_INSTRUCTION.includes("Share tab audio"), "picker instruction names Share tab audio");

  let recoveredAttempts = 0;
  class RecoveringRecorder extends FakeMediaRecorder {
    start(timeslice) {
      recoveredAttempts += 1;
      if (recoveredAttempts < 4) {
        const error = new Error("invalid state");
        error.name = "InvalidStateError";
        throw error;
      }
      super.start(timeslice);
    }
  }
  const recovered = new MasterProgramRecorder({
    displayMedia: async () => fakeCapture({ audio: true, video: true }),
    MediaRecorderImpl: RecoveringRecorder
  });
  const recoveredStart = await recovered.start({ recordingId: "rec-recovered" });
  assertEqual(recoveredStart.diagnostics.attempt, "default", "falls back to default MediaRecorder.start after InvalidStateError");
  await recovered.stop();

  const wrapped = wrapMediaRecorderError(Object.assign(new Error("invalid state"), { name: "InvalidStateError" }), {}, "MediaRecorder.start");
  assertEqual(isInvalidStateError({ name: "InvalidStateError" }), true, "InvalidStateError detector");
  assertEqual(wrapped.userMessage.includes("invalid state"), false, "wrapped user message does not say invalid state");

  const inspection = inspectMasterCapture(fakeCapture({ audio: true, video: true }));
  assertEqual(inspection.ok, true, "inspect accepts live Program Output tracks");
  assertEqual(inspection.selectedProgramOutput, true, "inspect recognizes Program Output surface");
  const startedRecorder = startMasterMediaRecorder(FakeMediaRecorder, fakeCapture(), "video/webm");
  assertEqual(startedRecorder.attempt, "mime-bitrate-timeslice", "happy path uses the first MediaRecorder attempt");
  assertEqual(startedRecorder.recorder.state, "recording", "MediaRecorder state is recording after start");
}

console.log("\nRecording manifest, production actions, assets-used, markers");
{
  const startedAt = 1_000_000;
  const stoppedAt = 1_090_000;
  const catalogue = loadCatalogue();
  const assets = new ProgramAssetCatalog();
  const drum = assets.add(createProgramAsset({
    id: "drum-roll-01",
    type: "sound",
    title: "Drum roll",
    sourceUrl: catalogue.get("drum-roll-01").sourceUrl,
    status: ProgramAssetStatus.APPROVED
  }));
  const article = assets.add(createProgramAsset({
    id: "article-123",
    type: "article",
    title: "Thailand data centers",
    sourceUrl: "https://en.wikipedia.org/wiki/Thailand",
    status: ProgramAssetStatus.LIVE
  }));
  const log = new ProductionActionLog();
  log.record(ProductionActionType.TAKE_ASSET, { assetId: article.id, layout: "asset-speaker", sourceUrl: article.sourceUrl, timestamp: startedAt + 2000 });
  log.items[log.items.length - 1].timestamp = startedAt + 2000;
  log.record(ProductionActionType.PLAY_AUDIO, { assetId: drum.id, src: "/assets/catalogue/audio/drum-roll-01.ogg", initiator: "producer" });
  log.items[log.items.length - 1].timestamp = startedAt + 5000;
  log.record(ProductionActionType.STOP_AUDIO, { assetId: drum.id });
  log.items[log.items.length - 1].timestamp = startedAt + 8000;
  log.record(ProductionActionType.REMOVE_ASSET, { assetId: article.id });
  log.items[log.items.length - 1].timestamp = startedAt + 12000;
  const markers = new MarkerLog();
  markers.add({ timestamp: startedAt + 2000, type: MarkerType.TAKE_LIVE, label: article.title, source: "producer" });
  markers.add({ timestamp: startedAt + 5000, type: MarkerType.PLAY_AUDIO, label: "Drum roll", source: "producer" });
  markers.add({ timestamp: startedAt + 15000, type: MarkerType.MANUAL, label: "Marker", source: "producer" });
  const participants = [
    createParticipant({ participantId: "host", role: ParticipantRole.HOST, displayName: "Ricardo", title: "Host", company: "Toasty" }),
    createParticipant({ participantId: "g-tukta", role: ParticipantRole.GUEST, displayName: "Tukta" })
  ];
  const { manifest, timeline, assetsUsed } = assembleMasterPackage({
    sessionId: "sess-1",
    roomId: "room-1",
    recordingId: "rec-1",
    startedAt,
    stoppedAt,
    brandTheme: "toasty",
    participants,
    captureResult: { mimeType: "video/webm", bytes: 4096, audioSources: ["program-output-tab"], surfaceLabel: "Toasty Studio — Program Output" },
    productionActions: log.items,
    assets: assets.items,
    liveAsset: null,
    playingAudio: null,
    markers: markers.during(startedAt, stoppedAt),
    transcript: { kind: "TranscriptStore", available: false, lineCount: 0 },
    chat: { kind: "audience-chat", available: false, messageCount: 0 },
    isolatedTracks: []
  });
  assertEqual(manifest.kind, RecordingKind.MASTER, "manifest kind is master");
  assertEqual(manifest.schemaVersion, 1, "schema version 1");
  assertEqual(manifest.sessionId, "sess-1", "sessionId");
  assertEqual(manifest.recordingId, "rec-1", "recordingId");
  assertEqual(manifest.brandTheme, "toasty", "brand/theme");
  assertEqual(manifest.participants.length, 2, "participants");
  assertEqual(manifest.files.master, "session/master/rec-1.webm", "master filename");
  assertEqual(manifest.media.masterMediaId, masterMediaId("rec-1"), "media id");
  assertEqual(masterManifestId("rec-1"), "master-recording:rec-1:manifest", "manifest id");
  assert(manifest.transcript, "transcript reference exists even when empty");
  assert(manifest.chat, "chat reference exists even when empty");
  assert(timeline.some((item) => item.type === "TAKE_ASSET" && item.assetId === "article-123"), "TAKE_ASSET is on the timeline");
  assert(timeline.some((item) => item.type === "PLAY_AUDIO" && item.assetId === "drum-roll-01"), "PLAY_AUDIO is on the timeline");
  assert(timeline.some((item) => item.type === "REMOVE_ASSET"), "REMOVE_ASSET is on the timeline");
  assertEqual(timeline.find((item) => item.type === "PLAY_AUDIO").offsetSeconds, 5, "drum roll offset is 5s");
  assert(assetsUsed.some((item) => item.assetId === "drum-roll-01" && item.actions.includes("PLAY_AUDIO")), "drum roll is in assets-used");
  assert(assetsUsed.some((item) => item.assetId === "article-123" && item.actions.includes("TAKE_ASSET")), "article is in assets-used");
  assertEqual(manifest.markers.length, 3, "markers during the window");
  assertEqual(manifest.markers[2].type, MarkerType.MANUAL, "manual marker type");
  assertEqual(markerTypeFromProduction("take-live"), MarkerType.TAKE_LIVE, "TAKE LIVE maps to marker type");
  const marker = createMarker({ type: MarkerType.HOTTIE, label: "topic change", source: "hottie" });
  assert(marker.id.startsWith("mrk-"), "marker id");
  assertEqual(marker.source, "hottie", "marker source");
}

console.log("\nAlready-live assets at record start are not dropped");
{
  const startedAt = 50;
  const liveAsset = { id: "article-123", sourceUrl: "https://en.wikipedia.org/wiki/Thailand" };
  const { timeline, assetsUsed } = assembleMasterPackage({
    sessionId: "sess-2",
    roomId: "room-2",
    recordingId: "rec-2",
    startedAt,
    stoppedAt: 80,
    productionActions: [],
    assets: [liveAsset],
    liveAsset,
    playingAudio: { assetId: "drum-roll-01", action: "PLAY_AUDIO", src: "/assets/catalogue/audio/drum-roll-01.ogg" }
  });
  assert(timeline.some((item) => item.note === "already-live-at-record-start"), "live graphic at t=0");
  assert(timeline.some((item) => item.note === "already-playing-at-record-start"), "playing audio at t=0");
  assert(assetsUsed.some((item) => item.assetId === "article-123"), "already-live article is in assets-used");
  assert(assetsUsed.some((item) => item.assetId === "drum-roll-01"), "already-playing drum roll is in assets-used");
}

console.log("\nProducer controls are Producer-only; Program Output has no REC chrome");
{
  const director = read("studio/director.html");
  const producer = read("js/producer-view.js");
  const listener = read("js/listener.js");
  const listenerHtml = read("studio/listener.html");
  assert(director.includes("data-lv-only=\"producer\""), "recording panel is producer-only");
  assert(director.includes("Master Program Recording"), "panel is labeled master");
  assert(director.includes("lvMasterVideo"), "playback surface exists");
  assert(director.includes("lvMasterPlay"), "PLAY control exists");
  assert(director.includes("VIDEO READY") || director.includes("lvPoVideoFlag"), "VIDEO READY flag exists");
  assert(director.includes("AUDIO READY") || director.includes("lvPoAudioFlag"), "AUDIO READY flag exists");
  assert(director.includes("lvProgramOutputStatus"), "Program Output readiness panel exists");
  assert(director.includes("lvRecordMarker"), "manual marker control exists");
  assert(producer.includes("STOP RECORDING"), "STOP RECORDING control");
  assert(producer.includes("RECORD PROGRAM"), "RECORD PROGRAM control");
  assert(director.includes("Share tab audio ON"), "recording UX explicitly tells producer to enable tab audio");
  assert(producer.includes("RECORDING ·"), "RECORDING timer status");
  assert(producer.includes("SAVING RECORDING"), "SAVING RECORDING status");
  assert(producer.includes("RECORDING SAVED"), "RECORDING SAVED status");
  assert(producer.includes("renderProgramOutputStatus"), "Producer renders Program Output readiness");
  assert(!producer.includes("IndexedDB"), "Producer UX does not mention IndexedDB");
  assert(!listener.includes("lvRecordToggle"), "Program Output JS has no record toggle");
  assert(!listenerHtml.includes("Start recording"), "Program Output markup has no record button");
  assert(listener.includes("must never render") || listener.includes("Do not render recording chrome"), "listener documents no REC overlay");
}

console.log("\nLiveSession Producer record is master tab capture, not isolated getUserMedia");
{
  const liveSession = read("js/live-session.js");
  const startFn = liveSession.slice(liveSession.indexOf("async startRecording"), liveSession.indexOf("async stopRecording"));
  assert(startFn.includes("MasterProgramRecorder"), "startRecording constructs the master recorder");
  assert(!startFn.includes("LocalIsolatedRecorder"), "startRecording does not start isolated Host getUserMedia");
  assert(startFn.includes("ensureProgramOutputWindow") || startFn.includes("toasty-program-output"), "start opens Program Output");
  assert(startFn.includes("recordingBlockReason"), "start refuses until Program Output is ready");
  assert(liveSession.includes("PROGRAM_OUTPUT_PICKER_INSTRUCTION"), "picker instruction is shown before getDisplayMedia");
  assert(liveSession.includes("readyToRecord") && liveSession.includes("canRecord()"), "Record is gated on Program Output readiness");
  assert(!liveSession.includes("IndexedDB persist"), "persist failure does not mention IndexedDB");
  assert(liveSession.includes("assembleMasterPackage"), "stop attaches the session package");
  assert(liveSession.includes("persistMasterRecording"), "stop persists the master");
  const isolated = read("js/recording.js");
  assert(isolated.includes("getUserMedia"), "isolated recorder remains host-mic-only");
  assert(isolated.includes("SOURCE tape"), "isolated recorder is labeled a source tape");
  assert(isolated.includes("ProgramAudioBus.captureStream"), "isolated still documents the Program Audio boundary");
}

console.log("\nTAKE LIVE, catalogue PLAY_AUDIO, Program Renderer, publisher remain frozen");
{
  const catalogue = loadCatalogue();
  const published = [];
  const session = {
    roomId: "master-slice",
    assets: new ProgramAssetCatalog(),
    catalogue,
    productionLog: new ProductionActionLog(),
    program: { assetLayout: null, scene: "live", live: true, audio: null },
    programAudio: null,
    markers: new MarkerLog()
  };
  session.programController = new ProgramController(session);
  session.emit = () => {};
  session._syncProgramPreview = () => { session._previewSynced = true; };
  session.publishProgramState = () => {
    published.push({
      asset: serializeProgramAsset(session.programController.liveAsset()),
      assetLayout: session.program.assetLayout,
      audio: session.program.audio
    });
  };
  session.noteProductionMarker = (type, label, source) => session.markers.add({
    type: markerTypeFromProduction(type),
    label,
    source
  });
  const article = session.assets.add(createProgramAsset({
    id: "article-live",
    type: "article",
    title: "Article",
    sourceUrl: "https://en.wikipedia.org/wiki/Thailand",
    status: ProgramAssetStatus.PROPOSED
  }));
  const take = session.programController.takeAsset({ assetId: article.id });
  assert(take.ok, "TAKE LIVE still executes");
  assertEqual(take.layout, ProgramLayout.ASSET_SPEAKER, "default live layout is asset + speaker");
  const host = createParticipant({ participantId: "host", role: ParticipantRole.HOST, displayName: "Ricardo", connectionStatus: ConnectionStatus.CONNECTED });
  const guest = createParticipant({ participantId: "g-tukta", role: ParticipantRole.GUEST, displayName: "Tukta", connectionStatus: ConnectionStatus.CONNECTED });
  const composition = composeProgram([host, guest], { asset: session.programController.liveAsset(), assetLayout: session.program.assetLayout });
  assertEqual(composition.layout, ProgramLayout.ASSET_SPEAKER, "composition still uses asset-speaker");
  const play = session.programController.playAudio({ assetId: "drum-roll-01" });
  assert(play.ok, "drum roll PLAY_AUDIO still executes");
  assertEqual(play.command.src, "/assets/catalogue/audio/drum-roll-01.ogg", "catalogue file is unchanged");
  session.programController.removeAsset({});
  const restored = composeProgram([host, guest], { asset: session.programController.liveAsset(), assetLayout: session.program.assetLayout });
  assertEqual(restored.layout, ProgramLayout.DUO, "removing asset restores duo");
  assert(session.markers.items.some((item) => item.type === MarkerType.TAKE_LIVE), "TAKE LIVE writes a marker");
  assert(session.markers.items.some((item) => item.type === MarkerType.PLAY_AUDIO), "PLAY_AUDIO writes a marker");

  const liveSession = read("js/live-session.js");
  assert(!/mountRoomFrame\(this\._containers\.roomPreview/.test(liveSession), "setLayout still does not remount scene=0");
  const guestJs = read("js/guest.js");
  assert(guestJs.includes("stopPreview();"), "guest Join still releases native camera");
  const engine = read("js/video-engine.js");
  assert(engine.includes("view:true"), "guest publisher still uses bare &view");
  const renderer = read("js/program-renderer.js");
  assert(renderer.includes("Never scene=0"), "Program Renderer freeze");
  const listener = read("js/listener.js");
  assert(listener.includes("syncProgramRenderer"), "listener still uses Program Renderer");
  assert(listener.includes("asset: programState.asset"), "listener still consumes published live assets");
  const catalogueSrc = read("js/asset-catalogue.js");
  assert(catalogueSrc.includes("drum-roll-01") || read("assets/catalogue/catalogue.json").includes("drum-roll-01"), "drum roll remains in the catalogue");
}

console.log("\nALL PASSED — master Program Recording package, tab-capture mix, freezes intact.");
