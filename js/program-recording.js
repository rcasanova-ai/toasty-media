// Master Program Recording — the produced show, not an isolated participant tape.
//
// Program Renderer is DOM (tiles + lower thirds + asset cards) with cross-origin VDO iframes.
// There is no Program canvas to captureStream(), and parent JS cannot read VDO MediaStreams.
// Capturing a second compositor would miss iframe pixels (tainted canvas) and would be a second
// visual truth. The audience picture+sound IS Program Output's tab:
//
//   Program Output tab video  = Program Renderer (layouts, lower thirds, TAKE LIVE)
//   Program Output tab audio  = VDO participant speech + ProgramAudioBus destination (soundboard)
//   → MediaRecorder
//
// Isolated Host getUserMedia (LocalIsolatedRecorder) remains a SOURCE tape, never the master.
//
// Participant-audio boundary (do not fake a mix we cannot hear):
//   Program Output plays VDO iframe audio to the tab destination. Those tracks are cross-origin;
//   MediaStreamAudioSourceNode cannot tap them from parent JS. Native streams this page owns CAN
//   enter ProgramAudioBus.connectStream() → captureDest. That hook is for native/host-owned streams
//   and a future server mix — not a substitute for missing tab audio.
//
// Next layer when tab-capture is the ceiling:
//   server-side mix (FFmpeg/GStreamer) of participant WebRTC tracks + catalogue files from the
//   PLAY_AUDIO timeline, plus a frame-accurate Program video encode. Same manifest schema.
//   In-progress recordings survive tab close via chunked/resumable upload of MediaRecorder timeslices.

import { saveMediaBlob, getMediaBlob } from "./media-store.js";
import { serializeProgramAsset } from "./program-asset.js";

export const RecordingKind = Object.freeze({
  MASTER: "master-program",
  ISOLATED: "isolated-participant"
});

export const MarkerType = Object.freeze({
  MANUAL: "manual",
  TAKE_LIVE: "take-live",
  REMOVE_ASSET: "remove-asset",
  PLAY_AUDIO: "play-audio",
  STOP_AUDIO: "stop-audio",
  TOPIC: "topic",
  HOTTIE: "hottie",
  AUDIENCE: "audience",
  FOCUS_GROUP: "focus-group"
});

export const MARKER_FROM_ACTION = Object.freeze({
  "play-audio": MarkerType.PLAY_AUDIO,
  "stop-audio": MarkerType.STOP_AUDIO,
  "take-live": MarkerType.TAKE_LIVE,
  "remove-asset": MarkerType.REMOVE_ASSET,
  manual: MarkerType.MANUAL,
  topic: MarkerType.TOPIC,
  hottie: MarkerType.HOTTIE,
  audience: MarkerType.AUDIENCE,
  "focus-group": MarkerType.FOCUS_GROUP
});

const MASTER_MIME = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm"
];

let recordingSeq = 0;
export function nextRecordingId() {
  recordingSeq += 1;
  return `rec-${Date.now().toString(36)}-${recordingSeq.toString(36)}`;
}

let markerSeq = 0;
export function nextMarkerId() {
  markerSeq += 1;
  return `mrk-${Date.now().toString(36)}-${markerSeq.toString(36)}`;
}

export function markerTypeFromProduction(type) {
  return MARKER_FROM_ACTION[type] || MarkerType.MANUAL;
}

export function recordingOffsetSeconds(startedAt, timestamp) {
  if (!startedAt || !timestamp) return 0;
  return Math.max(0, Number(((timestamp - startedAt) / 1000).toFixed(3)));
}

export function createMarker({ timestamp = Date.now(), type = MarkerType.MANUAL, label = "", source = "producer" } = {}) {
  return {
    id: nextMarkerId(),
    timestamp,
    type: Object.values(MarkerType).includes(type) ? type : MarkerType.MANUAL,
    label: String(label || "").slice(0, 180),
    source: String(source || "producer").slice(0, 40)
  };
}

export function createMomentMarker({
  sessionId = null,
  timestamp = Date.now(),
  preRollSeconds = 45,
  postRollSeconds = 15,
  reason = "",
  transcriptContext = []
} = {}) {
  const marker = createMarker({
    timestamp,
    type: MarkerType.HOTTIE,
    label: reason || "Moment",
    source: "hottie"
  });
  return {
    ...marker,
    sessionId,
    preRollSeconds: Number(preRollSeconds) || 45,
    postRollSeconds: Number(postRollSeconds) || 15,
    reason: String(reason || "").slice(0, 240),
    transcriptContext: Array.isArray(transcriptContext) ? transcriptContext.slice(-8) : [],
    kind: "moment-marker"
  };
}

export class MarkerLog {
  constructor() {
    this.items = [];
  }

  add(fields) {
    const marker = fields?.kind === "moment-marker" ? fields : createMarker(fields);
    if (fields?.kind === "moment-marker" && !fields.id) {
      marker.id = nextMarkerId();
    }
    this.items.push(marker);
    return marker;
  }

  during(startedAt, stoppedAt = Date.now()) {
    return this.items.filter((item) => item.timestamp >= startedAt && item.timestamp <= stoppedAt);
  }

  clear() {
    this.items = [];
  }
}

export function productionTimeline(actions = [], startedAt, stoppedAt = Date.now()) {
  return (actions || [])
    .filter((item) => item?.timestamp >= startedAt && item.timestamp <= stoppedAt)
    .map((item) => ({
      id: item.id,
      type: item.type,
      timestamp: item.timestamp,
      offsetSeconds: recordingOffsetSeconds(startedAt, item.timestamp),
      assetId: item.assetId || null,
      initiator: item.initiator || null,
      duration: item.duration ?? null,
      layout: item.layout || null,
      src: item.src || null,
      sourceUrl: item.sourceUrl || null,
      note: item.note || null
    }));
}

export function assetsUsedFromTimeline(timeline = [], assets = []) {
  const byId = new Map();
  for (const event of timeline) {
    const assetId = event.assetId;
    if (!assetId) continue;
    if (event.type !== "TAKE_ASSET" && event.type !== "PLAY_AUDIO" && event.type !== "PLAY_ASSET" && event.type !== "REMOVE_ASSET" && event.type !== "STOP_AUDIO") {
      continue;
    }
    const existing = byId.get(assetId) || {
      assetId,
      type: null,
      category: null,
      title: null,
      firstUsedAt: event.timestamp,
      lastUsedAt: event.timestamp,
      sourceUrl: event.sourceUrl || null,
      provenance: null,
      actions: []
    };
    existing.firstUsedAt = Math.min(existing.firstUsedAt, event.timestamp);
    existing.lastUsedAt = Math.max(existing.lastUsedAt, event.timestamp);
    existing.actions.push(event.type);
    if (event.sourceUrl) existing.sourceUrl = event.sourceUrl;
    const record = assets.find((asset) => asset.id === assetId);
    if (record) {
      const serialized = serializeProgramAsset(record) || record;
      existing.type = serialized.type || existing.type;
      existing.category = serialized.provenance?.assetType || serialized.type || existing.category;
      existing.title = serialized.title || existing.title;
      existing.provenance = serialized.provenance || existing.provenance;
      existing.sourceUrl = serialized.sourceUrl || existing.sourceUrl;
    }
    byId.set(assetId, existing);
  }
  return [...byId.values()];
}

export const PROGRAM_OUTPUT_PICKER_INSTRUCTION =
  "SELECT THE TOASTY PROGRAM OUTPUT TAB\nENABLE “SHARE TAB AUDIO”\nTHEN CLICK SHARE";

function trackReadyState(track) {
  if (!track) return "missing";
  return track.readyState || "unknown";
}

function trackIsLive(track) {
  if (!track) return false;
  // Node fakes and some polyfills omit readyState; presence of the track is enough there.
  if (!track.readyState) return true;
  return track.readyState === "live";
}

export function assertMasterTracks({ videoTracks = [], audioTracks = [] } = {}) {
  const video = (videoTracks || []).filter(Boolean);
  const audio = (audioTracks || []).filter(Boolean);
  if (!video.length) return { ok: false, reason: "missing-video", videoReadyState: "missing", audioReadyState: trackReadyState(audio[0]) };
  if (!audio.length) return { ok: false, reason: "missing-audio", videoReadyState: trackReadyState(video[0]), audioReadyState: "missing" };
  if (!trackIsLive(video[0])) {
    return { ok: false, reason: "video-not-live", videoReadyState: trackReadyState(video[0]), audioReadyState: trackReadyState(audio[0]) };
  }
  if (!trackIsLive(audio[0])) {
    return { ok: false, reason: "audio-not-live", videoReadyState: trackReadyState(video[0]), audioReadyState: trackReadyState(audio[0]) };
  }
  return {
    ok: true,
    videoTracks: video,
    audioTracks: audio,
    videoReadyState: trackReadyState(video[0]),
    audioReadyState: trackReadyState(audio[0])
  };
}

export function inspectMasterCapture(stream) {
  const videoTracks = stream?.getVideoTracks?.() || [];
  const audioTracks = stream?.getAudioTracks?.() || [];
  const check = assertMasterTracks({ videoTracks, audioTracks });
  return {
    ...check,
    streamActive: stream?.active !== false,
    videoTrackCount: videoTracks.length,
    audioTrackCount: audioTracks.length,
    surfaceLabel: videoTracks[0]?.label || "",
    looksLikeProgramOutput: looksLikeProgramOutput(videoTracks[0]),
    selectedProgramOutput: looksLikeProgramOutput(videoTracks[0]) === true
  };
}

// Kept for tests and a future server-mix composer. MediaRecorder must record the original
// getDisplayMedia stream — wrapping those tracks in a new MediaStream is what threw
// InvalidStateError on MediaRecorder.start() in production (BUILD 2026.09.20-masterrec).
export function composeMasterMediaStream(tracks) {
  const check = assertMasterTracks(tracks);
  if (!check.ok) {
    const error = new Error(captureFailureMessage(check.reason));
    error.reason = check.reason;
    error.diagnostics = check;
    throw error;
  }
  if (typeof MediaStream !== "function") return check;
  const stream = new MediaStream();
  check.videoTracks.forEach((track) => stream.addTrack(track));
  check.audioTracks.forEach((track) => stream.addTrack(track));
  return stream;
}

export function captureFailureMessage(reason) {
  if (reason === "missing-audio" || reason === "audio-not-live") {
    return "Recording needs Program Output audio. Select the Toasty Program Output tab and enable Share tab audio.";
  }
  if (reason === "missing-video" || reason === "video-not-live") {
    return "Program Output video capture is unavailable.";
  }
  if (reason === "unsupported") {
    return "This browser cannot capture Program Output (getDisplayMedia + MediaRecorder).";
  }
  if (reason === "invalid-recorder-state") {
    return "Program Output capture could not start. Select “Toasty Studio — Program Output” and turn Share tab audio ON.";
  }
  return "Master recording could not capture Program Output.";
}

export function isInvalidStateError(error) {
  return error?.name === "InvalidStateError" || /invalid state|state is invalid/i.test(String(error?.message || error || ""));
}

export function describeRecorderDiagnostics({
  recorder = null,
  capture = null,
  mimeType = "",
  operation = "",
  attempt = "",
  error = null
} = {}) {
  const inspection = capture ? inspectMasterCapture(capture) : {};
  return {
    operation,
    attempt,
    recorderState: recorder?.state || "none",
    mimeType: recorder?.mimeType || mimeType || "",
    streamActive: inspection.streamActive ?? capture?.active ?? null,
    videoReadyState: inspection.videoReadyState || "missing",
    audioReadyState: inspection.audioReadyState || "missing",
    videoTrackCount: inspection.videoTrackCount ?? 0,
    audioTrackCount: inspection.audioTrackCount ?? 0,
    surfaceLabel: inspection.surfaceLabel || "",
    selectedProgramOutput: inspection.selectedProgramOutput ?? null,
    errorName: error?.name || "",
    errorMessage: error?.message || "",
    errorStack: error?.stack || ""
  };
}

export function wrapMediaRecorderError(error, diagnostics = {}, operation = "MediaRecorder.start") {
  const reason = isInvalidStateError(error) ? "invalid-recorder-state" : (diagnostics.reason || "recorder-failed");
  const wrapped = new Error(captureFailureMessage(reason));
  wrapped.reason = reason;
  wrapped.operation = diagnostics.operation || operation;
  wrapped.userMessage = wrapped.message;
  wrapped.causeName = error?.name || "";
  wrapped.causeMessage = error?.message || String(error || "");
  wrapped.causeStack = error?.stack || "";
  wrapped.diagnostics = diagnostics;
  try {
    console.error("[MasterProgramRecorder]", wrapped.operation, wrapped.reason, diagnostics, error);
  } catch (_) {}
  return wrapped;
}

export function startMasterMediaRecorder(Rec, stream, mimeType, { onRecorder } = {}) {
  const attempts = [
    {
      id: "mime-bitrate-timeslice",
      options: mimeType ? { mimeType, audioBitsPerSecond: 160000, videoBitsPerSecond: 6000000 } : undefined,
      timeslice: 1000
    },
    { id: "mime-timeslice", options: mimeType ? { mimeType } : undefined, timeslice: 1000 },
    { id: "mime", options: mimeType ? { mimeType } : undefined, timeslice: undefined },
    { id: "default", options: undefined, timeslice: undefined }
  ];
  let lastError = null;
  let lastOperation = "MediaRecorder";
  let lastAttempt = "";
  let lastRecorder = null;
  for (const attempt of attempts) {
    lastAttempt = attempt.id;
    lastRecorder = null;
    try {
      lastOperation = `MediaRecorder constructor (${attempt.id})`;
      lastRecorder = attempt.options ? new Rec(stream, attempt.options) : new Rec(stream);
      onRecorder?.(lastRecorder);
      lastOperation = `MediaRecorder.start (${attempt.id})`;
      if (attempt.timeslice != null) lastRecorder.start(attempt.timeslice);
      else lastRecorder.start();
      return { recorder: lastRecorder, attempt: attempt.id, mimeType: lastRecorder.mimeType || mimeType || "" };
    } catch (error) {
      lastError = error;
      lastError.operation = lastOperation;
    }
  }
  throw wrapMediaRecorderError(lastError, describeRecorderDiagnostics({
    recorder: lastRecorder,
    capture: stream,
    mimeType,
    operation: lastOperation,
    attempt: lastAttempt,
    error: lastError
  }), lastOperation);
}

export function programOutputDisplayConstraints() {
  return {
    video: { frameRate: { ideal: 30, max: 30 } },
    audio: true,
    preferCurrentTab: false,
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    systemAudio: "include"
  };
}

export function looksLikeProgramOutput(track) {
  const label = String(track?.label || "").toLowerCase();
  if (!label) return null;
  return label.includes("program output") || label.includes("listener.html");
}

export function masterCaptureSupported({
  mediaDevices = globalThis.navigator?.mediaDevices,
  MediaRecorderImpl = globalThis.MediaRecorder
} = {}) {
  return Boolean(mediaDevices?.getDisplayMedia && MediaRecorderImpl);
}

export function idleRecordingState(last = null) {
  return {
    kind: RecordingKind.MASTER,
    active: false,
    startedAt: null,
    recordingId: last?.recordingId || null,
    status: last ? "recorded" : "idle",
    last
  };
}

export function activeRecordingState({ recordingId, startedAt, last = null } = {}) {
  return {
    kind: RecordingKind.MASTER,
    active: true,
    startedAt,
    recordingId,
    status: "recording",
    last
  };
}

export function lastMasterRecordingKey(roomId) {
  return `toastyMasterRecording:${roomId}`;
}

export function rememberLastMasterRecording(roomId, recordingId) {
  try { globalThis.localStorage?.setItem(lastMasterRecordingKey(roomId), recordingId); } catch (_) {}
}

export function recalledMasterRecordingId(roomId) {
  try { return globalThis.localStorage?.getItem(lastMasterRecordingKey(roomId)) || null; } catch (_) { return null; }
}

export function assembleMasterPackage({
  sessionId = null,
  roomId,
  recordingId,
  startedAt,
  stoppedAt,
  brandTheme = "",
  participants = [],
  captureResult = {},
  productionActions = [],
  assets = [],
  liveAsset = null,
  playingAudio = null,
  markers = [],
  transcript = null,
  chat = null,
  isolatedTracks = []
} = {}) {
  let timeline = productionTimeline(productionActions, startedAt, stoppedAt);
  if (liveAsset?.id && !timeline.some((event) => event.assetId === liveAsset.id && event.type === "TAKE_ASSET")) {
    timeline = [{
      id: "already-live",
      type: "TAKE_ASSET",
      timestamp: startedAt,
      offsetSeconds: 0,
      assetId: liveAsset.id,
      initiator: "producer",
      layout: null,
      src: null,
      sourceUrl: liveAsset.sourceUrl || null,
      note: "already-live-at-record-start"
    }, ...timeline];
  }
  if (playingAudio?.assetId && playingAudio.action !== "STOP_AUDIO" && !timeline.some((event) => event.assetId === playingAudio.assetId && event.type === "PLAY_AUDIO")) {
    timeline = [{
      id: "already-playing",
      type: "PLAY_AUDIO",
      timestamp: startedAt,
      offsetSeconds: 0,
      assetId: playingAudio.assetId,
      initiator: playingAudio.initiator || "producer",
      duration: playingAudio.duration ?? null,
      layout: null,
      src: playingAudio.src || null,
      sourceUrl: null,
      note: "already-playing-at-record-start"
    }, ...timeline];
  }
  const assetsUsed = assetsUsedFromTimeline(timeline, assets);
  const manifest = buildMasterManifest({
    sessionId,
    roomId,
    recordingId,
    startedAt,
    stoppedAt,
    brandTheme,
    participants,
    master: {
      filename: `session/master/${recordingId}.webm`,
      mediaId: masterMediaId(recordingId),
      mimeType: captureResult.mimeType,
      bytes: captureResult.bytes || captureResult.blob?.size || 0
    },
    isolatedTracks,
    transcriptRef: transcript,
    chatRef: chat,
    productionActions: timeline,
    assetsUsed,
    markers,
    audioSources: captureResult.audioSources || ["program-output-tab"],
    capture: {
      visual: "program-output-tab",
      audio: "program-output-tab",
      surfaceLabel: captureResult.surfaceLabel || ""
    },
    notes: [
      "Master Program Recording is Program Output tab capture (the audience picture and sound).",
      "Isolated Host getUserMedia recordings are source tapes, not this master.",
      "Participant speech is in the master only when Program Output tab audio is captured (VDO iframe audio + ProgramAudioBus destination).",
      "Parent JS cannot MediaStreamAudioSourceNode cross-origin VDO iframe tracks. Next layer: server mix of WebRTC participant tracks + catalogue files from this timeline.",
      "In-progress recordings are lost on tab close until chunked/resumable upload of MediaRecorder timeslices exists."
    ]
  });
  return { manifest, timeline, assetsUsed };
}

export function buildMasterManifest({
  sessionId = null,
  roomId,
  recordingId,
  startedAt,
  stoppedAt,
  brandTheme = "",
  participants = [],
  master = {},
  isolatedTracks = [],
  transcriptRef = null,
  chatRef = null,
  productionActions = [],
  assetsUsed = [],
  markers = [],
  audioSources = [],
  capture = {},
  notes = []
} = {}) {
  const started = startedAt || Date.now();
  const stopped = stoppedAt || started;
  return {
    kind: RecordingKind.MASTER,
    schemaVersion: 1,
    sessionId,
    recordingId,
    roomId: roomId || null,
    startedAt: new Date(started).toISOString(),
    stoppedAt: new Date(stopped).toISOString(),
    durationSeconds: recordingOffsetSeconds(started, stopped),
    brandTheme,
    participants: (participants || []).map((p) => ({
      participantId: p.participantId,
      role: p.role,
      displayName: p.displayName || "",
      title: p.title || "",
      company: p.company || ""
    })),
    files: {
      master: master.filename || "session/master/program.webm",
      manifest: "session/master/manifest.json",
      isolated: isolatedTracks
    },
    media: {
      masterMediaId: master.mediaId || null,
      mimeType: master.mimeType || "video/webm",
      bytes: master.bytes || 0
    },
    isolatedTracks,
    transcript: transcriptRef,
    chat: chatRef,
    productionActions,
    assetsUsed,
    markers: (markers || []).map((marker) => ({
      ...marker,
      offsetSeconds: recordingOffsetSeconds(started, marker.timestamp)
    })),
    capture: {
      visual: capture.visual || "program-output-tab",
      audio: capture.audio || "program-output-tab",
      audioSources,
      surfaceLabel: capture.surfaceLabel || "",
      programRenderer: "dom+vdo-iframes",
      programAudioBus: "listener-destination-in-tab-mix"
    },
    notes
  };
}

export function masterMediaId(recordingId) {
  return `master-recording:${recordingId}:webm`;
}

export function masterManifestId(recordingId) {
  return `master-recording:${recordingId}:manifest`;
}

export async function persistMasterRecording({ recordingId, blob, manifest }) {
  await saveMediaBlob({
    id: masterMediaId(recordingId),
    blob,
    metadata: { kind: RecordingKind.MASTER, recordingId, mimeType: blob.type }
  });
  await saveMediaBlob({
    id: masterManifestId(recordingId),
    blob: new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
    metadata: { kind: "master-manifest", recordingId }
  });
  return { recordingId, mediaId: masterMediaId(recordingId), manifestId: masterManifestId(recordingId) };
}

export async function loadMasterRecording(recordingId) {
  const blob = await getMediaBlob(masterMediaId(recordingId));
  const manifestBlob = await getMediaBlob(masterManifestId(recordingId));
  const manifest = manifestBlob ? JSON.parse(await manifestBlob.text()) : null;
  return { blob, manifest };
}

export class MasterProgramRecorder {
  constructor({ status, displayMedia, MediaRecorderImpl } = {}) {
    this.status = status;
    this.displayMedia = displayMedia;
    this.MediaRecorderImpl = MediaRecorderImpl || globalThis.MediaRecorder;
    this.captureStream = null;
    this.masterStream = null;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = null;
    this.stoppedAt = null;
    this.recordingId = null;
    this.mimeType = "";
    this.surfaceLabel = "";
    this._stopping = false;
  }

  static isSupported() {
    return masterCaptureSupported();
  }

  async start({ recordingId } = {}) {
    const Rec = this.MediaRecorderImpl;
    const getDisplayMedia = this.displayMedia || globalThis.navigator?.mediaDevices?.getDisplayMedia?.bind(globalThis.navigator.mediaDevices);
    if (!getDisplayMedia || !Rec) {
      throw Object.assign(new Error(captureFailureMessage("unsupported")), { reason: "unsupported" });
    }
    this.recordingId = recordingId || nextRecordingId();
    this.chunks = [];
    this.stoppedAt = null;
    this._stopping = false;
    this.status?.(PROGRAM_OUTPUT_PICKER_INSTRUCTION);
    const capture = await getDisplayMedia(programOutputDisplayConstraints());
    this.captureStream = capture;
    const inspection = inspectMasterCapture(capture);
    if (!inspection.ok) {
      capture.getTracks().forEach((track) => track.stop());
      this.captureStream = null;
      const error = new Error(captureFailureMessage(inspection.reason));
      error.reason = inspection.reason;
      error.operation = "assertMasterTracks";
      error.diagnostics = describeRecorderDiagnostics({
        capture,
        operation: "assertMasterTracks",
        error
      });
      error.diagnostics = { ...error.diagnostics, ...inspection };
      try { console.error("[MasterProgramRecorder] capture rejected", error.diagnostics); } catch (_) {}
      throw error;
    }
    this.surfaceLabel = inspection.surfaceLabel;
    if (inspection.looksLikeProgramOutput === false) {
      this.status?.("That share does not look like Program Output. Stop and select “Toasty Studio — Program Output”.");
    }
    // Record the original getDisplayMedia stream. Do not wrap tracks in a new MediaStream —
    // that reconstructed stream made MediaRecorder.start() throw InvalidStateError.
    this.masterStream = capture;
    capture.getVideoTracks()[0]?.addEventListener?.("ended", () => {
      if (this.recorder?.state === "recording") this.stop().catch(() => {});
    });
    this.mimeType = MASTER_MIME.find((type) => Rec.isTypeSupported?.(type)) || "";
    const started = startMasterMediaRecorder(Rec, capture, this.mimeType, {
      onRecorder: (recorder) => {
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data?.size) this.chunks.push(event.data);
        });
      }
    });
    this.recorder = started.recorder;
    this.mimeType = started.mimeType || this.mimeType;
    this.startAttempt = started.attempt;
    this.startedAt = Date.now();
    this.status?.("RECORDING");
    return {
      recordingId: this.recordingId,
      startedAt: this.startedAt,
      surfaceLabel: this.surfaceLabel,
      diagnostics: describeRecorderDiagnostics({
        recorder: this.recorder,
        capture,
        mimeType: this.mimeType,
        operation: `MediaRecorder.start (${started.attempt})`,
        attempt: started.attempt
      })
    };
  }

  async stop() {
    if (this._stopping) return this._stopPromise;
    if (!this.recorder) {
      throw Object.assign(new Error("Master recording has not started."), { reason: "not-started" });
    }
    this._stopping = true;
    this._stopPromise = this._finalizeStop();
    return this._stopPromise;
  }

  _finalizeStop() {
    return new Promise((resolve, reject) => {
      const finish = () => {
        this.stoppedAt = Date.now();
        this.captureStream?.getTracks().forEach((track) => track.stop());
        const blob = new Blob(this.chunks, { type: this.recorder.mimeType || this.mimeType || "video/webm" });
        const result = {
          recordingId: this.recordingId,
          startedAt: this.startedAt,
          stoppedAt: this.stoppedAt,
          blob,
          mimeType: blob.type,
          bytes: blob.size,
          audioSources: ["program-output-tab"],
          surfaceLabel: this.surfaceLabel
        };
        this.recorder = null;
        this.masterStream = null;
        this.captureStream = null;
        this.chunks = [];
        this.status?.("SAVING RECORDING…");
        resolve(result);
      };
      this.recorder.addEventListener("stop", finish, { once: true });
      this.recorder.addEventListener("error", () => reject(new Error("Master recorder failed.")), { once: true });
      if (this.recorder.state !== "inactive") this.recorder.stop();
      else finish();
    });
  }
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
