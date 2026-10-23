// Moxie's live clip listening. While a recording runs it follows the transcript and the host microphone, keeps a rolling window
// of context (js/clip-detector.js), bookmarks promising moments as they settle, and handles the spoken "Moxie, clip that".
// Bookmarks are timed in seconds from the start of the recording, so they line up with the saved file and open directly in
// Toasty Clips. All of this runs in the browser; no audio or transcript leaves the computer.
import { ClipDetector } from "./clip-detector.js";
import { AudioEventDetector } from "./audio-events.js";

export class LiveClips {
  constructor({ transcript, getMicStream, onBookmark, onClose, onCommand, now = () => Date.now(), AudioContextImpl = globalThis.AudioContext } = {}) {
    Object.assign(this, { transcript, getMicStream, onBookmark, onClose, onCommand, now, AudioContextImpl });
    this.startedAt = null;
    this.detector = null;
    this._off = null; this._timer = null; this._ctx = null; this._node = null; this._events = null;
    this.audioSource = "none";
  }

  get active() { return this.startedAt != null; }
  elapsed(ts = this.now()) { return Math.max(0, (ts - this.startedAt) / 1000); }

  async start(startedAt = this.now()) {
    this.stop();
    this.startedAt = startedAt;
    this.detector = new ClipDetector({
      onBookmark: (bm, info) => this.onBookmark?.(bm, info),
      onClose: (bm) => this.onClose?.(bm)
    });
    this._off = this.transcript?.on?.((line) => {
      if (!this.active || !line?.text) return;
      const t = this.elapsed(line.timestamp || this.now());
      const cmd = this.detector.addTranscript({ t, speaker: line.speaker || "", text: line.text });
      if (cmd) this.onCommand?.(cmd);
    });
    this._timer = setInterval(() => { if (this.active) this.detector.tick(this.elapsed()); }, 1000);
    await this._startAudio();
  }

  // Laughter, loud reactions and silence from the host microphone, measured on the audio thread so a background tab keeps working.
  async _startAudio() {
    const stream = this.getMicStream?.();
    const Ctx = this.AudioContextImpl;
    if (!stream?.getAudioTracks?.().length || !Ctx || typeof AudioWorkletNode === "undefined") return;
    try {
      this._ctx = new Ctx({ latencyHint: "playback", sampleRate: 16000 });   // speech and laughter analysis needs no more, and it costs a third as much
      await this._ctx.audioWorklet.addModule(new URL("./audio-features-worklet.js", import.meta.url).href);
      this._node = new AudioWorkletNode(this._ctx, "toasty-features", { numberOfInputs: 1, numberOfOutputs: 0 });
      this._events = new AudioEventDetector({ onEvent: (ev) => { if (this.active) this.detector.addAudioEvent({ ...ev, t: ev.t + this._audioOffset, end: ev.end != null ? ev.end + this._audioOffset : undefined }); } });
      this._audioOffset = this.elapsed();                       // the feature clock starts at 0 when the worklet starts
      this._node.port.onmessage = (e) => { if (this._events && Array.isArray(e.data)) this._events.pushFrames(e.data); };
      this._ctx.createMediaStreamSource(new MediaStream([stream.getAudioTracks()[0]])).connect(this._node);
      await this._ctx.resume();
      this.audioSource = "host-mic";
    } catch (_) { this.audioSource = "none"; try { await this._ctx?.close(); } catch (__) {} this._ctx = null; }
  }

  // Ends the listening and returns every bookmark (a final pass catches moments that never settled while live).
  finish() {
    if (!this.active) return [];
    this._events?.finish();
    const list = this.detector.finish(this.elapsed());
    this.stop();
    return list;
  }

  stop() {
    this._off?.(); this._off = null;
    clearInterval(this._timer); this._timer = null;
    try { this._node?.disconnect(); } catch (_) {}
    try { this._ctx?.close(); } catch (_) {}
    this._node = null; this._ctx = null; this._events = null;
    this.startedAt = null;
  }
}
