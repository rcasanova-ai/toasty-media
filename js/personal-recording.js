// Personal Recording Mode — one person, camera + mic, recorded locally at full quality.
//
// Three tracks come out of ONE getUserMedia (browsers often refuse a second capture of the same device):
//
//   program    composed Program Output: the camera drawn by ProgramCompositor with the chosen skin, layout,
//              lower third, asset cards, ticker and End Card, mixed with the mic (+ optional program audio
//              such as soundboard/Moxie cues). This is the ready-to-use recording.
//   camera     the isolated camera, video only   (js/recording.js LocalIsolatedRecorder)
//   microphone the isolated microphone, audio only (js/recording.js LocalIsolatedRecorder)
//
// Every MediaRecorder timeslice goes straight into the durable upload queue (js/recording-uploader.js);
// nothing accumulates in memory. Stopping flushes the queue and asks the server to finalize MP4/M4A
// asynchronously. A refresh or crash leaves queued chunks in IndexedDB and uploaded chunks on the server —
// recoverInterruptedRecording() (re-exported below) finishes the recording on the next page load.
//
// Guests and other sources are NOT handled here: isolated guest recording needs the guest's own browser to
// upload its own tracks (next milestone). The manifest/track model already accommodates them.

import { LocalIsolatedRecorder, chooseMimeType } from "./recording.js";
import { cleanMicAudioConstraint } from "./microphone-capture.js";
import { ProgramCompositor, PROGRAM_RESOLUTIONS, PersonalLayout } from "./program-compositor.js";
import { nextRecordingId } from "./program-recording.js";
import {
  ChunkUploader,
  clearActiveRecording,
  createDefaultChunkStore,
  recoverInterruptedRecording,
  rememberActiveRecording
} from "./recording-uploader.js";

export { recoverInterruptedRecording };

export const PersonalRecordingState = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  RECORDING: "recording",
  STOPPING: "stopping",
  UPLOADING: "uploading",
  PROCESSING: "processing",
  DONE: "done",
  ERROR: "error"
});

const PROGRAM_MIME_TYPES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const MAX_TIMELINE_EVENTS = 120;
const TERMINAL_RECORDING_STATES = new Set(["finalized", "partial", "failed"]);

export const PERSONAL_TRACK_IDS = Object.freeze({ PROGRAM: "program", CAMERA: "camera", MICROPHONE: "microphone" });

function codecsFromMime(mimeType) {
  const match = /codecs=([^;]+)/i.exec(mimeType || "");
  const list = match ? match[1].split(",").map((c) => c.trim().replace(/"/g, "")) : [];
  return {
    video: list.find((c) => /^(vp8|vp9|av01|avc1|h264)/i.test(c)) || "",
    audio: list.find((c) => /^(opus|vorbis|mp4a)/i.test(c)) || ""
  };
}

// Maps the server's canonical program state (ProgramServerSubscriber.onProgram) onto compositor state.
// The local choices that don't belong to Moxie/the producer (layout, who is on camera) stay as given.
export function compositorStateFromProgram(program = {}, local = {}) {
  return {
    scene: program.scene || local.scene || "live",
    brandTheme: local.lockBrand ? local.brandTheme : (program.brandTheme || local.brandTheme),
    sessionTitle: program.sessionTitle || local.sessionTitle || "",
    topic: program.topic || "",
    asset: program.asset && program.asset.status !== "removed" ? program.asset : null,
    ticker: program.ticker || { enabled: false, text: "", speed: 16 },
    endCard: program.endCard || local.endCard
  };
}

export class PersonalRecordingSession {
  constructor({
    api,
    store = createDefaultChunkStore(),
    storage = globalThis.localStorage,
    sessionId,
    participant = {},
    brandTheme = "toasty",
    layout = PersonalLayout.SINGLE,
    resolution = "720p",
    endCard = null,
    programAudioStream = null,
    timesliceMs = 2000,
    getUserMedia = (constraints) => navigator.mediaDevices.getUserMedia(constraints),
    MediaRecorderImpl = globalThis.MediaRecorder,
    AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
    CompositorImpl = ProgramCompositor,
    IsolatedRecorderImpl = LocalIsolatedRecorder,
    UploaderImpl = ChunkUploader,
    uploaderOptions = {},
    status = null,
    onUploadState = null,
    onStateChange = null,
    nowImpl = () => Date.now()
  } = {}) {
    this.api = api;
    this.store = store;
    this.storage = storage;
    this.sessionId = sessionId;
    this.participant = {
      participantId: participant.participantId || "host",
      role: participant.role || "host",
      displayName: participant.displayName || "",
      title: participant.title || "",
      company: participant.company || ""
    };
    this.brandTheme = brandTheme;
    this.layout = layout;
    this.resolution = PROGRAM_RESOLUTIONS[resolution] ? resolution : "720p";
    this.endCard = endCard;
    this.programAudioStream = programAudioStream;
    this.timesliceMs = timesliceMs;
    this.getUserMedia = getUserMedia;
    this.MediaRecorderImpl = MediaRecorderImpl;
    this.AudioContextImpl = AudioContextImpl;
    this.CompositorImpl = CompositorImpl;
    this.IsolatedRecorderImpl = IsolatedRecorderImpl;
    this.UploaderImpl = UploaderImpl;
    this.uploaderOptions = uploaderOptions;
    this.status = status;
    this.onUploadState = onUploadState;
    this.onStateChange = onStateChange;
    this.nowImpl = nowImpl;
    this.state = PersonalRecordingState.IDLE;
    this.recordingId = null;
    this.startedAtMs = null;
    this.stream = null;
    this.compositor = null;
    this.programRecorder = null;
    this.isolated = null;
    this.audioContext = null;
    this.uploader = null;
    this.seqCounters = { program: 0, camera: 0, microphone: 0 };
    this.markers = [];
    this.timeline = [];
    this._ready = null;
    this._markReady = null;
    this.error = null;
  }

  static isSupported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && globalThis.MediaRecorder && globalThis.HTMLCanvasElement?.prototype?.captureStream);
  }

  _setState(state) {
    this.state = state;
    this.onStateChange?.(state);
  }

  get elapsedMs() {
    return this.startedAtMs ? this.nowImpl() - this.startedAtMs : 0;
  }

  // `stream` / `compositor`: reuse an already-open camera preview and its compositor (what the user has
  // been looking at, WYSIWYG). The session then does NOT stop them on teardown — the page owns them.
  async start({ audioDeviceId = "", videoDeviceId = "", previewVideo = null, stream = null, compositor = null } = {}) {
    if (this.state !== PersonalRecordingState.IDLE && this.state !== PersonalRecordingState.DONE && this.state !== PersonalRecordingState.ERROR) {
      throw new Error("A recording is already in progress.");
    }
    this._setState(PersonalRecordingState.STARTING);
    this.error = null;
    try {
      this.status?.("Starting camera and microphone…");
      const videoConstraint = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
      if (videoDeviceId) videoConstraint.deviceId = { exact: videoDeviceId };
      this.ownsMedia = !stream;
      this.stream = stream || await this.getUserMedia({ audio: cleanMicAudioConstraint(audioDeviceId), video: videoConstraint });
      const audioTracks = this.stream.getAudioTracks();
      const videoTracks = this.stream.getVideoTracks();
      if (!audioTracks.length) throw new Error("No microphone track was available for recording.");
      if (!videoTracks.length) throw new Error("No camera track was available for recording.");

      this.recordingId = nextRecordingId();
      this._ready = new Promise((resolve) => { this._markReady = resolve; });
      this.uploader = new this.UploaderImpl({
        api: this.api,
        store: this.store,
        sessionId: this.sessionId,
        recordingId: this.recordingId,
        onState: this.onUploadState,
        ...this.uploaderOptions
      });

      // Composed Program Output: first-party canvas, same skins/layouts/overlays as live Program Output.
      this.ownsCompositor = !compositor;
      this.compositor = compositor || new this.CompositorImpl({
        resolution: this.resolution,
        state: {
          scene: "live",
          brandTheme: this.brandTheme,
          layout: this.layout,
          participants: [{ ...this.participant, onProgram: true }],
          ...(this.endCard ? { endCard: this.endCard } : {})
        }
      });
      if (this.ownsCompositor) await this.compositor.attachStream(this.stream);
      if (previewVideo) previewVideo.srcObject = this.stream;
      this.compositor.start();
      const programVideo = this.compositor.captureStream();
      const programStream = new MediaStream();
      programVideo.getVideoTracks().forEach((track) => programStream.addTrack(track));
      this._buildProgramAudio(audioTracks).forEach((track) => programStream.addTrack(track));

      const programMime = chooseMimeType(PROGRAM_MIME_TYPES);
      const size = PROGRAM_RESOLUTIONS[this.resolution];
      const bitrate = this.resolution === "1080p" ? 8_000_000 : 5_000_000;
      this.programRecorder = new this.MediaRecorderImpl(programStream, {
        ...(programMime ? { mimeType: programMime } : {}),
        videoBitsPerSecond: bitrate,
        audioBitsPerSecond: 192_000
      });
      this.programRecorder.addEventListener("dataavailable", (event) => this._sink("program", event.data));

      this.isolated = new this.IsolatedRecorderImpl({
        role: this.participant.role,
        roomId: this.sessionId,
        status: null,
        mode: "video",
        timesliceMs: this.timesliceMs,
        chunkSinks: {
          audio: (blob) => this._sink("microphone", blob),
          video: (blob) => this._sink("camera", blob)
        }
      });

      this.startedAtMs = this.nowImpl();
      this.programRecorder.start(this.timesliceMs);
      const programStartedAtMs = this.nowImpl();
      await this.isolated.start({ stream: this.stream });

      const cameraSettings = videoTracks[0].getSettings?.() || {};
      const tracks = [
        {
          trackId: PERSONAL_TRACK_IDS.PROGRAM, participantId: this.participant.participantId, type: "program",
          label: "Program Output", mimeType: this.programRecorder.mimeType || programMime || "video/webm",
          codecs: codecsFromMime(this.programRecorder.mimeType || programMime), hasVideo: true, hasAudio: true,
          video: { width: size.width, height: size.height, frameRate: 30 },
          source: { kind: "canvas-compositor", label: `${this.brandTheme}/${this.layout}` }, startedAtMs: programStartedAtMs
        },
        {
          trackId: PERSONAL_TRACK_IDS.CAMERA, participantId: this.participant.participantId, type: "camera",
          label: videoTracks[0].label || "Camera", mimeType: this.isolated.videoRecorder?.mimeType || "video/webm",
          codecs: codecsFromMime(this.isolated.videoRecorder?.mimeType), hasVideo: true, hasAudio: false,
          video: { width: cameraSettings.width || null, height: cameraSettings.height || null, frameRate: cameraSettings.frameRate || null },
          source: { kind: "local-camera", label: videoTracks[0].label || "" }, startedAtMs: this.isolated.videoStartedAt || programStartedAtMs
        },
        {
          trackId: PERSONAL_TRACK_IDS.MICROPHONE, participantId: this.participant.participantId, type: "microphone",
          label: audioTracks[0].label || "Microphone", mimeType: this.isolated.audioRecorder?.mimeType || "audio/webm",
          codecs: codecsFromMime(this.isolated.audioRecorder?.mimeType), hasVideo: false, hasAudio: true,
          source: { kind: "local-microphone", label: audioTracks[0].label || "" }, startedAtMs: this.isolated.audioStartedAt || programStartedAtMs
        }
      ];
      await this.api.createRecording({
        sessionId: this.sessionId,
        recordingId: this.recordingId,
        mode: "personal",
        startedAt: this.startedAtMs,
        brandTheme: this.brandTheme,
        layout: this.layout,
        participants: [{ participantId: this.participant.participantId, role: this.participant.role, displayName: this.participant.displayName }],
        tracks,
        metadata: { resolution: this.resolution, timesliceMs: this.timesliceMs, userAgent: String(globalThis.navigator?.userAgent || "").slice(0, 200) }
      });
      rememberActiveRecording({ sessionId: this.sessionId, recordingId: this.recordingId, startedAt: this.startedAtMs, lastActivityAt: this.startedAtMs }, this.storage);
      this._activityTimer = setInterval(() => rememberActiveRecording({ sessionId: this.sessionId, recordingId: this.recordingId, startedAt: this.startedAtMs, lastActivityAt: this.nowImpl() }, this.storage), 5000);
      this._markReady();
      this._setState(PersonalRecordingState.RECORDING);
      this.status?.("Recording");
      this.logTimeline("recording-started", { layout: this.layout, brandTheme: this.brandTheme });
      return { recordingId: this.recordingId, sessionId: this.sessionId, startedAtMs: this.startedAtMs };
    } catch (error) {
      this.error = error;
      await this._teardownMedia();
      this._markReady?.();
      this._setState(PersonalRecordingState.ERROR);
      throw error;
    }
  }

  _buildProgramAudio(micTracks) {
    if (!this.AudioContextImpl) return micTracks;
    try {
      this.audioContext = new this.AudioContextImpl();
      const destination = this.audioContext.createMediaStreamDestination();
      this.audioContext.createMediaStreamSource(new MediaStream(micTracks)).connect(destination);
      // Program audio (soundboard / catalogue cues / Moxie voice) enters the same mix, as it does live.
      if (this.programAudioStream?.getAudioTracks?.().length) {
        this.audioContext.createMediaStreamSource(this.programAudioStream).connect(destination);
      }
      return destination.stream.getAudioTracks();
    } catch (error) {
      console.error("[PersonalRecording] audio mix unavailable, recording mic directly", error);
      return micTracks;
    }
  }

  // Assigns the sequence number synchronously (chunks stay ordered) and enqueues once the server-side
  // recording exists. Persistence happens inside enqueue(), before any upload attempt.
  _sink(trackId, blob) {
    if (!blob?.size) return;
    const seq = this.seqCounters[trackId]++;
    this._lastChunkAt = this.nowImpl();
    const participantId = this.participant.participantId;
    this._enqueueChain = (this._enqueueChain || Promise.resolve())
      .then(() => this._ready)
      .then(() => this.uploader.enqueue({ participantId, trackId, seq, blob }))
      .catch((error) => { console.error("[PersonalRecording] could not queue chunk", trackId, seq, error); });
  }

  // Live program changes (Moxie/producer scene, asset, ticker, end card, or a local control) — drawn into
  // the composed track immediately and noted in the manifest timeline.
  setProgramState(patch = {}) {
    if (!this.compositor) return;
    const previous = this.compositor.state;
    this.compositor.setState(patch);
    if (patch.scene && patch.scene !== previous.scene) this.logTimeline("scene", { scene: patch.scene });
    if (patch.layout && patch.layout !== previous.layout) this.logTimeline("layout", { layout: patch.layout });
    if (patch.brandTheme && patch.brandTheme !== previous.brandTheme) this.logTimeline("brand", { brandTheme: patch.brandTheme });
    if (patch.asset !== undefined && (patch.asset?.id || null) !== (previous.asset?.id || null)) this.logTimeline("asset", { assetId: patch.asset?.id || null, title: patch.asset?.title || "" });
    if (patch.ticker && patch.ticker.text !== previous.ticker?.text) this.logTimeline("ticker", { enabled: Boolean(patch.ticker.enabled) });
  }

  logTimeline(type, detail = {}) {
    if (this.timeline.length >= MAX_TIMELINE_EVENTS) return;
    this.timeline.push({ type, offsetMs: this.elapsedMs, ...detail });
  }

  addMarker(type = "manual", label = "") {
    const marker = { id: `mrk-${this.markers.length + 1}`, timestamp: this.nowImpl(), offsetMs: this.elapsedMs, type, label: String(label).slice(0, 180) };
    this.markers.push(marker);
    return marker;
  }

  async _stopRecorder(recorder) {
    if (!recorder || recorder.state === "inactive") return;
    await new Promise((resolve) => {
      recorder.addEventListener("stop", resolve, { once: true });
      recorder.stop();
    });
  }

  async _teardownMedia() {
    clearInterval(this._activityTimer);
    if (this.ownsCompositor !== false) { try { this.compositor?.stop(); } catch { /* already stopped */ } }
    if (this.ownsMedia !== false) { try { this.stream?.getTracks().forEach((track) => track.stop()); } catch { /* already stopped */ } }
    try { await this.audioContext?.close?.(); } catch { /* already closed */ }
    this.audioContext = null;
  }

  async stop({ flushTimeoutMs = 120000 } = {}) {
    if (this.state !== PersonalRecordingState.RECORDING) throw new Error("Recording has not started.");
    this._setState(PersonalRecordingState.STOPPING);
    this.status?.("Finishing recording…");
    const stoppedAtMs = this.nowImpl();
    this.logTimeline("recording-stopped");
    await Promise.all([this._stopRecorder(this.programRecorder), this.isolated.stop()]);
    await this._teardownMedia();
    await (this._enqueueChain || Promise.resolve());
    this._setState(PersonalRecordingState.UPLOADING);
    this.status?.("Uploading final chunks…");
    let flushed;
    try {
      flushed = await this.uploader.flush({ timeoutMs: flushTimeoutMs });
    } catch (error) {
      // Offline at stop: queued chunks stay in the durable store; the next page load finishes the job.
      this.status?.("Some chunks are still waiting to upload. They are saved and will finish when you are back online.");
      this._setState(PersonalRecordingState.ERROR);
      return { recordingId: this.recordingId, sessionId: this.sessionId, pending: error.pending ?? this.uploader.stats().queued, recoverable: true };
    }
    const lastSeq = (id) => (this.seqCounters[id] > 0 ? this.seqCounters[id] - 1 : null);
    const tracks = Object.values(PERSONAL_TRACK_IDS).map((trackId) => ({
      trackId, lastSeq: lastSeq(trackId), stoppedAtMs, durationMs: stoppedAtMs - this.startedAtMs
    }));
    const completed = await this.api.complete(this.sessionId, this.recordingId, {
      stoppedAt: stoppedAtMs,
      tracks,
      markers: this.markers,
      metadata: { timeline: this.timeline.slice(0, MAX_TIMELINE_EVENTS), failedChunks: flushed.failed.length }
    });
    clearActiveRecording(this.storage);
    this.uploader.close();
    this._setState(PersonalRecordingState.PROCESSING);
    this.status?.("Recording uploaded. Preparing your MP4…");
    return { recordingId: this.recordingId, sessionId: this.sessionId, recording: completed.recording, failedChunks: flushed.failed };
  }

  // Polls the server until finalization reaches a terminal state.
  async waitForFinalization({ timeoutMs = 15 * 60 * 1000, pollMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const deadline = this.nowImpl() + timeoutMs;
    let recording = null;
    while (this.nowImpl() < deadline) {
      recording = (await this.api.getRecording(this.sessionId, this.recordingId)).recording;
      if (TERMINAL_RECORDING_STATES.has(recording.state)) {
        this._setState(PersonalRecordingState.DONE);
        return recording;
      }
      await sleep(pollMs);
    }
    throw new Error("Your recording is still processing. Check the Recordings list in a moment.");
  }
}
