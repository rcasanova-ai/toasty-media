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
//   pointerup   -> held=false, MediaRecorder stops, recorded blob POSTed to /api/transcribe
//
// The RECORDED AUDIO is the authoritative source when a transcription backend is available (see
// transcribeAudio below) — SpeechRecognition only supplies live interim captions and a same-session
// fallback transcript if the backend call fails or isn't configured. See this session's report for why
// no transcription provider is wired in server-side yet (no free/local option exists in this codebase
// today; the real choices all need either a paid API key or VPS access this environment doesn't have) —
// scripts/render-production-server.mjs's /api/transcribe honestly returns "not configured" until that
// decision is made, rather than this silently only ever using SpeechRecognition and calling it done.
const LOCAL_TRANSCRIBE_ENDPOINT = "http://127.0.0.1:4174/api/transcribe";
const PRODUCTION_TRANSCRIBE_ENDPOINT = "https://render.toasty.media/api/transcribe";

function getTranscribeEndpoint() {
  if (window.TOASTY_TRANSCRIBE_ENDPOINT) return window.TOASTY_TRANSCRIBE_ENDPOINT;
  const host = window.location.hostname;
  return (host === "localhost" || host === "127.0.0.1" || host === "") ? LOCAL_TRANSCRIBE_ENDPOINT : PRODUCTION_TRANSCRIBE_ENDPOINT;
}

async function transcribeAudio(blob) {
  try {
    const response = await fetch(getTranscribeEndpoint(), {
      method: "POST",
      headers: { "content-type": blob.type || "audio/webm" },
      body: blob,
      signal: AbortSignal.timeout(10000)
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { ok: false, error: body.error || `transcribe-backend-${response.status}` };
    return { ok: true, text: String(body.transcript || "").trim() };
  } catch (error) {
    return { ok: false, error: "transcribe-backend-unreachable" };
  }
}

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

  // The only thing allowed to end a hold from the outside (pointerup/pointercancel/user cancellation).
  // Always resolves via onResult or onError exactly once, and onResult is only ever called once per hold
  // — there is exactly one path to it below, never a race between a transcription result and a fallback.
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

    // Empty recording (e.g. an instant tap-release with no audio captured at all) — nothing to
    // transcribe and nothing to fall back to.
    if (!recordedAudioBlob || recordedAudioBlob.size === 0) {
      this.onError?.(new Error("Didn't catch that — hold the button and try again, or type it."));
      return;
    }

    const transcription = await transcribeAudio(recordedAudioBlob);
    if (transcription.ok && transcription.text) {
      this.onResult?.(transcription.text, { recordedAudioBlob, source: "transcription" });
      return;
    }

    // Transcription backend unavailable, not configured, or returned nothing usable — fall back to
    // whatever SpeechRecognition captured live during this SAME hold rather than losing the instruction
    // outright. This is explicitly a fallback, not the authoritative path (see this file's top comment).
    if (!transcription.ok) console.warn("Recorded-audio transcription unavailable, falling back to live captions:", transcription.error);
    const fallbackText = this._finalText.trim();
    if (fallbackText) this.onResult?.(fallbackText, { recordedAudioBlob, source: "speech-recognition-fallback" });
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
