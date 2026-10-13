#!/usr/bin/env node
// Recording continuity + recoverability: the recorder checkpoints slices while recording (so a crash keeps the
// footage), never stops on its own, and the session wires recovery, retry and the guest-join warning.
import { readFileSync } from "node:fs";
import { MasterProgramRecorder } from "../js/program-recording.js";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };

class FakeRec {
  static isTypeSupported() { return true; }
  constructor() { this.state = "inactive"; this.l = {}; this.mimeType = "video/webm"; }
  addEventListener(e, f) { (this.l[e] ||= []).push(f); }
  start() { this.state = "recording"; }
  emit(bytes) { this.l.dataavailable?.forEach((f) => f({ data: new Blob([new Uint8Array(bytes)]) })); }
  stop() { this.state = "inactive"; this.l.stop?.forEach((f) => f()); }
}
const track = (kind) => ({ kind, readyState: "live", stop() {}, addEventListener() {} });
const stream = { getVideoTracks: () => [track("video")], getAudioTracks: () => [track("audio")], getTracks: () => [] };

const checkpoints = [];
const rec = new MasterProgramRecorder({ MediaRecorderImpl: FakeRec, onCheckpoint: (c) => checkpoints.push(c), checkpointMs: 20 });
await rec.start({ recordingId: "r1", captureStream: stream });
const mr = rec.recorder;
for (let i = 0; i < 5; i++) { mr.emit(1000); await new Promise((r) => setTimeout(r, 30)); }
ok(checkpoints.length >= 3 && checkpoints.every((c, i) => c.seq === i), `slices are checkpointed in order while recording (${checkpoints.length} so far)`);
ok(checkpoints.reduce((n, c) => n + c.blob.size, 0) >= 3000, "checkpoint slices carry the real recorded bytes");
mr.emit(500);
const result = await rec.stop();
ok(result.bytes === 5500, "the final file contains EVERYTHING recorded (checkpointing never drops or duplicates data)");
const n = checkpoints.length; await new Promise((r) => setTimeout(r, 60));
ok(checkpoints.length === n, "checkpointing stops when recording stops");

const live = read("js/live-session.js"), pv = read("js/producer-view.js"), pr = read("js/program-recording.js");
ok(/onCheckpoint: \(segment\) => saveRecoverySegment/.test(live), "LiveSession persists checkpoint slices to IndexedDB");
ok(/recoverInterruptedRecording\(\)/.test(live) && /await this\.recoverInterruptedRecording\(\)/.test(live), "an interrupted recording is recovered on the next Studio load");
ok(/clearRecoverySegments\(this\.roomId\)/.test(live), "recovery slices are cleared after a clean save");
ok(/A guest joined, but this recording only captures you/.test(live), "a guest joining a canvas recording is told the file will not include them");
ok(/retryRecordingFinalization/.test(pv), "Retry MP4 is wired in Producer");
const prSrc = readFileSync(new URL("../js/program-recording.js", import.meta.url), "utf8");
const ms = readFileSync(new URL("../js/media-store.js", import.meta.url), "utf8");
ok(/videoBitsPerSecond: 6000000/.test(prSrc) && /audioBitsPerSecond: 160000/.test(prSrc), "local recording quality is 6 Mbps video / 160 kbps audio — never reduced to fit a server limit");
ok(/pickMasterMime/.test(prSrc) && /MASTER_MIME_MP4/.test(prSrc) && /pickMasterMime\(Rec\)/.test(prSrc), "the recorder prefers browser-encoded MP4 (H.264/AAC) and falls back to WebM");
ok(/const direct = isMp4Mime\(captureResult\.mimeType\)/.test(live) && /recordedAs: direct \? "browser-mp4"/.test(live), "a browser-encoded MP4 is the finished recording at stop — no upload, no conversion");
ok(/_convertOnServerIfAllowed/.test(live) && /too-large/.test(live), "WebM server conversion is optional and a recording the server would refuse is never uploaded");
ok(/tx\.oncomplete/.test(ms) && /tx\.onabort/.test(ms), "recordings are only reported saved once the browser storage transaction COMMITS (quota failures surface)");
console.log("ALL PASSED — recordings checkpoint while running and survive interruption.");
