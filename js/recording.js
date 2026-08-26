const DEFAULT_MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  "video/webm",
  "audio/webm;codecs=opus",
  "audio/webm"
];

export class LocalIsolatedRecorder {
  constructor({ role, roomId, status }) {
    this.role = role;
    this.roomId = roomId;
    this.status = status;
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

  async start({ audioDeviceId, videoDeviceId } = {}) {
    if (!LocalIsolatedRecorder.isSupported()) {
      throw new Error("This browser does not support getUserMedia and MediaRecorder.");
    }

    this.audioChunks = [];
    this.videoChunks = [];
    this.stoppedAt = null;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: deviceConstraint(audioDeviceId),
      video: deviceConstraint(videoDeviceId)
    });

    const audioTracks = this.stream.getAudioTracks();
    const videoTracks = this.stream.getVideoTracks();
    if (!audioTracks.length) throw new Error("No microphone track was available for recording.");
    if (!videoTracks.length) throw new Error("No camera track was available for recording.");

    const audioMimeType = chooseMimeType(["audio/webm;codecs=opus", "audio/webm"]);
    const videoMimeType = chooseMimeType(DEFAULT_MIME_TYPES);
    this.audioRecorder = new MediaRecorder(new MediaStream(audioTracks), recorderOptions(audioMimeType));
    this.videoRecorder = new MediaRecorder(new MediaStream(videoTracks), recorderOptions(videoMimeType));
    this.audioRecorder.addEventListener("dataavailable", (event) => pushChunk(event, this.audioChunks));
    this.videoRecorder.addEventListener("dataavailable", (event) => pushChunk(event, this.videoChunks));
    this.audioRecorder.start(1000);
    this.videoRecorder.start(1000);
    this.startedAt = new Date();
    this.status?.("Recording local isolated audio and video.");
  }

  async stop() {
    if (!this.audioRecorder || !this.videoRecorder) {
      throw new Error("Recording has not started.");
    }
    await Promise.all([stopRecorder(this.audioRecorder), stopRecorder(this.videoRecorder)]);
    this.stoppedAt = new Date();
    this.stream?.getTracks().forEach((track) => track.stop());
    const audioBlob = new Blob(this.audioChunks, { type: this.audioRecorder.mimeType || "audio/webm" });
    const videoBlob = new Blob(this.videoChunks, { type: this.videoRecorder.mimeType || "video/webm" });
    const session = this.buildSessionManifest(audioBlob, videoBlob);
    await saveRecordingPackage({
      role: this.role,
      session,
      audioBlob,
      videoBlob
    });
    this.audioRecorder = null;
    this.videoRecorder = null;
    this.stream = null;
    this.status?.("Recording saved locally.");
    return session;
  }

  buildSessionManifest(audioBlob, videoBlob) {
    const participantPath = this.role === "host" ? "host" : "guest-1";
    return {
      roomId: this.roomId,
      participantRole: this.role,
      participantPath,
      startedAt: this.startedAt?.toISOString(),
      stoppedAt: this.stoppedAt?.toISOString(),
      files: {
        session: "session/session.json",
        audio: `session/${participantPath}/audio.webm`,
        video: `session/${participantPath}/video.webm`
      },
      sizes: {
        audioBytes: audioBlob.size,
        videoBytes: videoBlob.size
      },
      notes: [
        "This is browser-local isolated recording for this participant only.",
        "The guest must stop and save their own local package; hosted VDO.Ninja iframes do not expose remote isolated tracks to this page."
      ]
    };
  }
}

function chooseMimeType(types) {
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

function deviceConstraint(deviceId) {
  return deviceId ? { deviceId: { exact: deviceId } } : true;
}

async function saveRecordingPackage({ role, session, audioBlob, videoBlob }) {
  if ("showDirectoryPicker" in window) {
    const root = await window.showDirectoryPicker({ mode: "readwrite" });
    const sessionDir = await root.getDirectoryHandle("session", { create: true });
    await writeTextFile(sessionDir, "session.json", JSON.stringify(session, null, 2));
    const participantDir = await sessionDir.getDirectoryHandle(session.participantPath, { create: true });
    await writeBlobFile(participantDir, "audio.webm", audioBlob);
    await writeBlobFile(participantDir, "video.webm", videoBlob);
    return;
  }

  downloadBlob(new Blob([JSON.stringify(session, null, 2)], { type: "application/json" }), `${role}-session.json`);
  downloadBlob(audioBlob, `${role}-audio.webm`);
  downloadBlob(videoBlob, `${role}-video.webm`);
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
