import { cleanMicAudioConstraint } from "./microphone-capture.js";

const DEFAULT_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "audio/webm;codecs=opus",
  "audio/webm"
];

export class LocalIsolatedRecorder {
  // chunkSinks = { audio(blob), video(blob) }: when given, every MediaRecorder timeslice is handed to the
  // sink the moment it exists (resumable upload — see js/recording-uploader.js) and NOTHING is accumulated
  // in memory or saved locally on stop. Without sinks this is the original local-package behaviour.
  constructor({ role, roomId, status, mode = "video", saveOnStop = true, chunkSinks = null, timesliceMs = 1000 }) {
    this.role = role;
    this.roomId = roomId;
    this.status = status;
    this.mode = mode;
    this.chunkSinks = chunkSinks;
    this.timesliceMs = timesliceMs;
    this.saveOnStop = chunkSinks ? false : saveOnStop;
    this.ownsStream = true;
    this.audioStartedAt = null;
    this.videoStartedAt = null;
    this.stream = null;
    this.audioRecorder = null;
    this.videoRecorder = null;
    this.audioChunks = [];
    this.videoChunks = [];
    this.startedAt = null;
    this.stoppedAt = null;
  }

  static isSupported() {
    return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }

  get mimeType() {
    return this.videoRecorder?.mimeType || this.audioRecorder?.mimeType || null;
  }

  // `stream`: record an already-acquired camera+mic stream (Personal Recording shares ONE getUserMedia
  // between the isolated recorders and the program compositor — browsers often refuse a second capture of
  // the same device). The caller then owns the stream's lifetime.
  async start({ audioDeviceId, videoDeviceId, stream = null } = {}) {
    if (!LocalIsolatedRecorder.isSupported()) {
      throw new Error("This browser does not support getUserMedia and MediaRecorder.");
    }

    this.audioChunks = [];
    this.videoChunks = [];
    this.stoppedAt = null;
    const audioOnly = this.mode === "audio";
    this.ownsStream = !stream;
    this.stream = stream || await navigator.mediaDevices.getUserMedia({
      audio: audioDeviceConstraint(audioDeviceId),
      video: audioOnly ? false : videoDeviceConstraint(videoDeviceId)
    });

    const audioTracks = this.stream.getAudioTracks();
    const videoTracks = this.stream.getVideoTracks();
    if (!audioTracks.length) throw new Error("No microphone track was available for recording.");
    if (!audioOnly && !videoTracks.length) throw new Error("No camera track was available for recording.");

    const audioMimeType = chooseMimeType(["audio/webm;codecs=opus", "audio/webm"]);
    const videoMimeType = chooseMimeType(DEFAULT_MIME_TYPES);
    this.audioRecorder = new MediaRecorder(new MediaStream(audioTracks), recorderOptions(audioMimeType));
    this.audioRecorder.addEventListener("dataavailable", (event) => this.chunkSinks?.audio ? sinkChunk(event, this.chunkSinks.audio) : pushChunk(event, this.audioChunks));
    if (!audioOnly) {
      this.videoRecorder = new MediaRecorder(new MediaStream(videoTracks), recorderOptions(videoMimeType));
      this.videoRecorder.addEventListener("dataavailable", (event) => this.chunkSinks?.video ? sinkChunk(event, this.chunkSinks.video) : pushChunk(event, this.videoChunks));
      this.videoRecorder.start(this.timesliceMs);
      this.videoStartedAt = Date.now();
    }
    this.audioRecorder.start(this.timesliceMs);
    this.audioStartedAt = Date.now();
    this.startedAt = new Date();
    this.status?.(audioOnly ? "Recording local isolated audio." : "Recording local isolated audio and video.");
  }

  async stop() {
    if (!this.audioRecorder) {
      throw new Error("Recording has not started.");
    }
    await Promise.all([this.audioRecorder, this.videoRecorder].filter(Boolean).map(stopRecorder));
    this.stoppedAt = new Date();
    if (this.ownsStream) this.stream?.getTracks().forEach((track) => track.stop());
    if (this.chunkSinks) {
      // Streamed: every chunk already went to its sink. Nothing to assemble or save here.
      const info = {
        audio: { mimeType: this.audioRecorder.mimeType || "audio/webm", startedAtMs: this.audioStartedAt },
        video: this.videoRecorder ? { mimeType: this.videoRecorder.mimeType || "video/webm", startedAtMs: this.videoStartedAt } : null
      };
      this.audioRecorder = null;
      this.videoRecorder = null;
      this.stream = null;
      return { session: null, audioBlob: null, videoBlob: null, streamed: true, info };
    }
    const audioBlob = new Blob(this.audioChunks, { type: this.audioRecorder.mimeType || "audio/webm" });
    const videoBlob = this.videoRecorder
      ? new Blob(this.videoChunks, { type: this.videoRecorder.mimeType || "video/webm" })
      : null;
    const session = this.buildSessionManifest(audioBlob, videoBlob);
    if (this.saveOnStop) {
      await saveRecordingPackage({
        role: this.role,
        session,
        audioBlob,
        videoBlob
      });
    }
    this.audioRecorder = null;
    this.videoRecorder = null;
    this.stream = null;
    this.status?.("Recording saved locally.");
    return { session, audioBlob, videoBlob };
  }

  buildSessionManifest(audioBlob, videoBlob) {
    const participantPath = this.role === "host" ? "host" : "guest-1";
    const audioOnly = this.mode === "audio";
    return {
      roomId: this.roomId,
      participantRole: this.role,
      recordingMode: audioOnly ? "audio-only" : "audio-video",
      participantPath,
      startedAt: this.startedAt?.toISOString(),
      stoppedAt: this.stoppedAt?.toISOString(),
      files: {
        session: "session/session.json",
        audio: `session/${participantPath}/audio.webm`,
        video: audioOnly ? null : `session/${participantPath}/video.webm`
      },
      sizes: {
        audioBytes: audioBlob.size,
        videoBytes: videoBlob?.size || 0
      },
      notes: [
        "This is browser-local isolated recording for this participant only. It is a SOURCE tape, not the Master Program Recording.",
        "Program Audio (soundboard / catalogue files) is not on this recorder. ProgramAudioBus.captureStream() is the native-stream mix hook; the master is Program Output tab capture in js/program-recording.js.",
        audioOnly
          ? "AI Production uses real creator voice audio as the future avatar provider input."
          : "The guest must stop and save their own local package; hosted VDO.Ninja iframes do not expose remote isolated tracks to this page."
      ]
    };
  }
}

function sinkChunk(event, sink) {
  if (event.data?.size) sink(event.data);
}

export function chooseMimeType(types) {
  return types.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function recorderOptions(mimeType) {
  return mimeType ? { mimeType } : undefined;
}

function pushChunk(event, chunks) {
  if (event.data?.size) chunks.push(event.data);
}

function stopRecorder(recorder) {
  return new Promise((resolve, reject) => {
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.addEventListener("error", () => reject(new Error("Recorder failed.")), { once: true });
    recorder.stop();
  });
}

function audioDeviceConstraint(deviceId) {
  return cleanMicAudioConstraint(deviceId);
}

function videoDeviceConstraint(deviceId) {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

async function saveRecordingPackage({ role, session, audioBlob, videoBlob }) {
  if ("showDirectoryPicker" in window) {
    const root = await window.showDirectoryPicker({ mode: "readwrite" });
    const sessionDir = await root.getDirectoryHandle("session", { create: true });
    await writeTextFile(sessionDir, "session.json", JSON.stringify(session, null, 2));
    const participantDir = await sessionDir.getDirectoryHandle(session.participantPath, { create: true });
    await writeBlobFile(participantDir, "audio.webm", audioBlob);
    if (videoBlob) await writeBlobFile(participantDir, "video.webm", videoBlob);
    return;
  }

  downloadBlob(new Blob([JSON.stringify(session, null, 2)], { type: "application/json" }), `${role}-session.json`);
  downloadBlob(audioBlob, `${role}-audio.webm`);
  if (videoBlob) downloadBlob(videoBlob, `${role}-video.webm`);
}

async function writeTextFile(directory, name, value) {
  await writeBlobFile(directory, name, new Blob([value], { type: "application/json" }));
}

async function writeBlobFile(directory, name, blob) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
