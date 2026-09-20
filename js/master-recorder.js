// MasterRecorder V2 — produced Program video + Program Master Audio.
//
// Preferred:
//   Program Renderer pixels (first-party canvas/element capture)
//     + ProgramAudioMixer.masterStream()
//     → MediaRecorder
//
// Reality of current Program Output:
//   Participant video lives in cross-origin VDO iframes. element.captureStream() does not include
//   those frames. A canvas compositor would be a second, incomplete picture.
//
// Fallback (honest, working): existing MasterProgramRecorder tab-capture of Program Output.
// Tab capture remains until a server compositor or first-party tracks exist for every tile.

import {
  MasterProgramRecorder,
  nextRecordingId,
  assembleMasterPackage
} from "./program-recording.js";

export const ProgramVideoSourceKind = Object.freeze({
  ELEMENT: "element-capture",
  DISPLAY: "display-capture",
  COMPOSITOR: "compositor",
  UNAVAILABLE: "unavailable"
});

export function createProgramVideoSource({
  kind = ProgramVideoSourceKind.UNAVAILABLE,
  stream = null,
  element = null,
  reason = ""
} = {}) {
  return { kind, stream: stream || null, element: element || null, reason: reason || "" };
}

export function createProgramMasterAudioSource({
  stream = null,
  mixer = null,
  reason = ""
} = {}) {
  const fromMixer = mixer?.masterStream?.() || null;
  return {
    stream: stream || fromMixer,
    mixer: mixer || null,
    reason: reason || ((stream || fromMixer) ? "" : "no-master-audio-stream")
  };
}

export function inspectComposedMaster({ video, audio } = {}) {
  const videoTracks = video?.stream?.getVideoTracks?.() || [];
  const audioTracks = audio?.stream?.getAudioTracks?.() || [];
  const liveVideo = videoTracks.some((track) => track.readyState === "live");
  const liveAudio = audioTracks.some((track) => track.readyState === "live");
  if (liveVideo && liveAudio) {
    return { ok: true, mode: "composed", reason: "" };
  }
  if (video?.kind === ProgramVideoSourceKind.ELEMENT && !liveVideo) {
    return { ok: false, mode: "fallback-display", reason: "element-capture-missing-iframe-pixels" };
  }
  return { ok: false, mode: "fallback-display", reason: liveVideo ? "missing-master-audio" : "missing-program-video" };
}

export function combineMasterStreams(videoStream, audioStream) {
  if (!videoStream) return null;
  const combined = new MediaStream();
  videoStream.getVideoTracks().forEach((track) => combined.addTrack(track));
  (audioStream?.getAudioTracks?.() || []).forEach((track) => combined.addTrack(track));
  return combined;
}

export class MasterRecorder {
  constructor(options = {}) {
    this.fallback = new MasterProgramRecorder(options);
    this.mode = "idle";
    this.reason = "";
    this.recordingId = null;
    this.startedAt = null;
    this._composedRecorder = null;
    this._composedStream = null;
    this.chunks = [];
  }

  static isSupported() {
    return MasterProgramRecorder.isSupported();
  }

  async start({ recordingId, video, audio } = {}) {
    this.recordingId = recordingId || nextRecordingId();
    const inspection = inspectComposedMaster({ video, audio });
    if (inspection.ok) {
      const combined = combineMasterStreams(video.stream, audio.stream);
      const Rec = this.fallback.MediaRecorderImpl || globalThis.MediaRecorder;
      if (combined && Rec) {
        this.mode = "composed";
        this.reason = "";
        this._composedStream = combined;
        this.chunks = [];
        const mime = "video/webm;codecs=vp9,opus";
        const recorder = new Rec(combined, Rec.isTypeSupported?.(mime) ? { mimeType: mime } : undefined);
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data?.size) this.chunks.push(event.data);
        });
        recorder.start(1000);
        this._composedRecorder = recorder;
        this.startedAt = Date.now();
        this.fallback.status?.("RECORDING");
        return {
          recordingId: this.recordingId,
          startedAt: this.startedAt,
          mode: this.mode,
          reason: this.reason
        };
      }
    }
    this.mode = "fallback-display";
    this.reason = inspection.reason || "tab-capture-fallback";
    const started = await this.fallback.start({ recordingId: this.recordingId });
    this.startedAt = started.startedAt;
    return { ...started, mode: this.mode, reason: this.reason };
  }

  async stop() {
    if (this.mode === "composed" && this._composedRecorder) {
      const blob = await stopComposed(this._composedRecorder, this.chunks);
      this._composedStream?.getTracks?.().forEach((track) => {
        if (track.kind === "audio") return;
      });
      this._composedRecorder = null;
      return {
        recordingId: this.recordingId,
        startedAt: this.startedAt,
        stoppedAt: Date.now(),
        blob,
        bytes: blob.size,
        mimeType: blob.type,
        objectUrl: URL.createObjectURL(blob),
        mode: this.mode,
        reason: this.reason
      };
    }
    const result = await this.fallback.stop();
    return { ...result, mode: this.mode, reason: this.reason };
  }
}

export { assembleMasterPackage };

function stopComposed(recorder, chunks) {
  return new Promise((resolve) => {
    recorder.addEventListener("stop", () => {
      resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
    }, { once: true });
    if (recorder.state === "recording") recorder.stop();
    else resolve(new Blob(chunks, { type: "video/webm" }));
  });
}
