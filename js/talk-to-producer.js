// Push-to-talk instruction capture.
//
// The physical hold owns recording duration — NOT SpeechRecognition's lifecycle. Real-device testing
// found SpeechRecognition can stop itself (~2s in, no user release) even with continuous:true and even
// with this class's own restart-on-end logic from an earlier pass — evidently unreliably enough on real
// hardware that it can't be trusted as the timer. MediaRecorder on a plain getUserMedia audio stream has
// no such internal cutoff: it records for exactly as long as start()...stop() spans, full stop. So:
//
//   pointerdown -> held=true, MediaRecorder starts (this owns "how long")
//   while held  -> recording continues no matter what SpeechRecognition does in the background
//   pointerup   -> held=false, MediaRecorder stops, whatever transcript text exists is sent
//
// SpeechRecognition still runs, restarted freely on its own 'end' events, purely to produce the
// interim/final TEXT — it just no longer has any power to end the hold early. See this class's own
// report entry for the honest gap this leaves: there is no free speech-to-text-from-a-recorded-blob
// backend in this codebase today, so the text sent to Hottie still comes from SpeechRecognition's
// output, not from transcribing the MediaRecorder blob itself. The blob is kept (recordedAudioBlob on
// the result) so a real transcription backend has something to plug into later without another rewrite.
export class PushToTalkCapture {
  static isSupported() { return Boolean(navigator.mediaDevices?.getUserMedia); }
  static hasSpeechRecognition() { return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition); }

  constructor({ onListening, onInterim, onTranscribing, onResult, onError } = {}) {
    this.onListening = onListening;
    this.onInterim = onInterim;
    this.onTranscribing = onTranscribing;
    this.onResult = onResult;
    this.onError = onError;
    this._held = false;
    this._micStream = null;
    this._recorder = null;
    this._chunks = [];
    this._recognition = null;
    this._finalText = "";
    this._restartAttempts = 0;
  }

  get isHeld() { return this._held; }

  async start() {
    if (this._held) return; // guards any double-fire (e.g. a stray duplicate pointerdown)
    if (!PushToTalkCapture.isSupported()) {
      this.onError?.(new Error("Voice capture isn't supported in this browser — type the instruction instead."));
      return;
    }
    this._held = true;
    this._finalText = "";
    this._chunks = [];
    this._restartAttempts = 0;
    try {
      this._micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      this._held = false;
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      this.onError?.(new Error(denied ? "Microphone access was denied — allow it in the browser, or type the instruction instead." : "Couldn't reach the microphone — try again or type the instruction."));
      return;
    }
    // A user could release before getUserMedia's permission prompt even resolves — honor that instead of
    // starting a recording nobody asked for anymore.
    if (!this._held) { this._micStream.getTracks().forEach((t) => t.stop()); this._micStream = null; return; }

    if (window.MediaRecorder) {
      try {
        this._recorder = new MediaRecorder(this._micStream);
        this._recorder.addEventListener("dataavailable", (event) => { if (event.data?.size) this._chunks.push(event.data); });
        this._recorder.start();
      } catch (_) {
        this._recorder = null; // best-effort — SpeechRecognition alone still works below if this fails
      }
    }
    this._startSpeechRecognition();
    this.onListening?.();
  }

  _startSpeechRecognition() {
    const Impl = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Impl) return; // no interim/final text source, but the hold + recording still work correctly
    const recognition = new Impl();
    this._recognition = recognition;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.addEventListener("result", (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) this._finalText = `${this._finalText} ${transcript}`.trim();
        else interim = transcript;
      }
      this.onInterim?.(`${this._finalText} ${interim}`.trim());
    });
    recognition.addEventListener("error", () => {
      // Never decide anything from 'error' alone (see the 'end' handler) — a lot of these fire together
      // with a following 'end' as part of the same hiccup, and 'end' is the one place restart happens.
    });
    recognition.addEventListener("end", () => {
      if (!this._held) return; // a real stop() already ran — this is its expected trailing 'end', not a bug
      if (this._restartAttempts >= 6) return; // give up quietly; the recording (and typed fallback) still work
      this._restartAttempts += 1;
      window.setTimeout(() => { if (this._held) this._startSpeechRecognition(); }, 150);
    });
    try { recognition.start(); } catch (_) {}
  }

  // The only thing allowed to end a hold from the outside (pointerup/pointercancel). Always resolves via
  // onResult or onError exactly once.
  async stop() {
    if (!this._held) return;
    this._held = false;
    this.onTranscribing?.();

    const recorder = this._recorder;
    const stream = this._micStream;
    this._recorder = null;
    this._micStream = null;
    try { this._recognition?.stop(); } catch (_) {}

    const recordedAudioBlob = await this._finalizeRecording(recorder);
    stream?.getTracks().forEach((track) => track.stop());

    const text = this._finalText.trim();
    if (text) this.onResult?.(text, { recordedAudioBlob });
    else this.onError?.(new Error("Didn't catch that — hold the button and try again, or type it."));
  }

  _finalizeRecording(recorder) {
    if (!recorder || recorder.state === "inactive") return Promise.resolve(this._blobFromChunks());
    return new Promise((resolve) => {
      recorder.addEventListener("stop", () => resolve(this._blobFromChunks()), { once: true });
      try { recorder.stop(); } catch (_) { resolve(this._blobFromChunks()); }
    });
  }

  _blobFromChunks() {
    return this._chunks.length ? new Blob(this._chunks, { type: this._chunks[0].type || "audio/webm" }) : null;
  }
}
