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
// The RECORDED AUDIO is the authoritative source when the transcription backend returns something usable
// — SpeechRecognition only supplies live interim captions and a same-session fallback transcript if the
// backend call fails, times out, or isn't configured.
//
// Every step below logs to console.debug under the "[PTT]" prefix — a real-device test reported "Didn't
// catch that" with no way to tell WHICH of a dozen possible steps actually failed, so this trades a bit of
// console noise for being able to answer that from the next real test's console output instead of
// guessing again. See PushToTalkCapture.stop()'s own comment for a real bug this logging exposed: an
// empty MediaRecorder blob used to hard-fail immediately WITHOUT ever checking whether SpeechRecognition
// had already captured a perfectly good fallback transcript during the same hold — fixed below.
const LOCAL_TRANSCRIBE_ENDPOINT = "http://127.0.0.1:4174/api/transcribe";
const PRODUCTION_TRANSCRIBE_ENDPOINT = "https://render.toasty.media/api/transcribe";
const AUDIO_MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

function log(...args) { console.debug("[PTT]", ...args); }

function getTranscribeEndpoint() {
  if (window.TOASTY_TRANSCRIBE_ENDPOINT) return window.TOASTY_TRANSCRIBE_ENDPOINT;
  const host = window.location.hostname;
  return (host === "localhost" || host === "127.0.0.1" || host === "") ? LOCAL_TRANSCRIBE_ENDPOINT : PRODUCTION_TRANSCRIBE_ENDPOINT;
}

// Explicit, in preference order, rather than leaving it to MediaRecorder's own default — matches the
// same isTypeSupported-probing pattern js/broadcast-client.js already uses, so the mimeType actually sent
// to /api/transcribe (and thus what ffmpeg on the server has to decode) is known, not whatever a given
// browser happens to pick silently.
function pickAudioMimeType() {
  if (!window.MediaRecorder) return "";
  return AUDIO_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function transcribeAudio(blob) {
  const endpoint = getTranscribeEndpoint();
  log("POST", endpoint, "blob", blob.type, blob.size, "bytes");
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": blob.type || "audio/webm" },
      body: blob,
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    log("fetch threw", error?.name, error?.message);
    return { ok: false, error: "transcribe-backend-unreachable" };
  }
  const body = await response.json().catch((error) => { log("response body wasn't valid JSON", error?.message); return {}; });
  log("response", response.status, body);
  if (!response.ok) return { ok: false, error: body.error || `transcribe-backend-${response.status}` };
  return { ok: true, text: String(body.transcript || "").trim() };
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
    if (this._held) { log("start() ignored — already held"); return; }
    if (!PushToTalkCapture.isSupported()) {
      log("getUserMedia unsupported in this browser");
      this.onError?.(new Error("Voice capture isn't supported in this browser — type the instruction instead."));
      return;
    }
    this._held = true;
    this._finalText = "";
    this._chunks = [];
    this._restartAttempts = 0;
    log("requesting microphone…");
    try {
      this._micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      log("getUserMedia OK, tracks:", this._micStream.getAudioTracks().map((t) => ({ label: t.label, readyState: t.readyState, muted: t.muted })));
    } catch (error) {
      this._held = false;
      log("getUserMedia FAILED", error?.name, error?.message);
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      this.onError?.(new Error(denied ? "Microphone access was denied — allow it in the browser, or type the instruction instead." : "Couldn't reach the microphone — try again or type the instruction."));
      return;
    }
    // A user could release before getUserMedia's permission prompt even resolves — honor that instead of
    // starting a recording nobody asked for anymore.
    if (!this._held) { log("released before getUserMedia resolved — aborting"); this._micStream.getTracks().forEach((t) => t.stop()); this._micStream = null; return; }

    const mimeType = pickAudioMimeType();
    if (window.MediaRecorder) {
      try {
        this._recorder = new MediaRecorder(this._micStream, mimeType ? { mimeType } : undefined);
        log("MediaRecorder created, mimeType:", this._recorder.mimeType || "(browser default)", "state:", this._recorder.state);
        this._recorder.addEventListener("dataavailable", (event) => {
          log("dataavailable", event.data?.size, "bytes", event.data?.type);
          if (event.data?.size) this._chunks.push(event.data);
        });
        this._recorder.addEventListener("error", (event) => log("MediaRecorder error event", event.error?.name, event.error?.message));
        this._recorder.start();
        log("MediaRecorder.start() called, state now:", this._recorder.state);
      } catch (error) {
        log("MediaRecorder construction/start threw — recording disabled for this hold, SpeechRecognition-only", error?.name, error?.message);
        this._recorder = null; // best-effort — SpeechRecognition alone still works below if this fails
      }
    } else {
      log("window.MediaRecorder unavailable in this browser");
    }
    this._startSpeechRecognition();
    this.onListening?.();
  }

  _startSpeechRecognition() {
    const Impl = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Impl) { log("SpeechRecognition unavailable — recording alone still works, no live captions/fallback text"); return; }
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
    recognition.addEventListener("error", (event) => {
      log("SpeechRecognition error event", event.error);
      // Never decide anything from 'error' alone (see the 'end' handler) — a lot of these fire together
      // with a following 'end' as part of the same hiccup, and 'end' is the one place restart happens.
    });
    recognition.addEventListener("end", () => {
      if (!this._held) return; // a real stop() already ran — this is its expected trailing 'end', not a bug
      log("SpeechRecognition ended on its own while still held (restart attempt", this._restartAttempts + 1, "of 6)");
      if (this._restartAttempts >= 6) { log("giving up on SpeechRecognition restarts — recording continues regardless"); return; }
      this._restartAttempts += 1;
      window.setTimeout(() => { if (this._held) this._startSpeechRecognition(); }, 150);
    });
    try { recognition.start(); } catch (error) { log("SpeechRecognition.start() threw", error?.name, error?.message); }
  }

  // The only thing allowed to end a hold from the outside (pointerup/pointercancel/user cancellation).
  // Always resolves via onResult or onError exactly once, and onResult is only ever called once per hold
  // — there is exactly one path to it below, never a race between a transcription result and a fallback.
  async stop() {
    if (!this._held) { log("stop() ignored — not held"); return; }
    this._held = false;
    log("stop() — releasing at", this._recorder?.state);
    this.onTranscribing?.();

    const recorder = this._recorder;
    const stream = this._micStream;
    this._recorder = null;
    this._micStream = null;
    try { this._recognition?.stop(); } catch (_) {}

    const recordedAudioBlob = await this._finalizeRecording(recorder);
    stream?.getTracks().forEach((track) => track.stop());
    log("final blob:", recordedAudioBlob ? `${recordedAudioBlob.size} bytes, ${recordedAudioBlob.type}` : "none", "| SpeechRecognition fallback text so far:", JSON.stringify(this._finalText));

    // A real recording (even a very short one) always attempts transcription first — the ONLY thing that
    // skips straight to the SpeechRecognition fallback is having no recording at all (MediaRecorder
    // unsupported, construction failed, or genuinely zero bytes captured). Previously an empty blob
    // short-circuited straight to an error WITHOUT ever checking whether SpeechRecognition already had a
    // perfectly good transcript from the same hold — that was a real bug, not just a missing feature: a
    // user could speak clearly, have MediaRecorder fail for any reason, and lose the instruction entirely
    // even though the live transcript was sitting right there in this._finalText.
    let transcription = { ok: false, error: "no-recording" };
    if (recordedAudioBlob && recordedAudioBlob.size > 0) {
      transcription = await transcribeAudio(recordedAudioBlob);
    } else {
      log("no recorded audio to transcribe — skipping /api/transcribe, going straight to SpeechRecognition fallback");
    }

    if (transcription.ok && transcription.text) {
      log("using TRANSCRIPTION result:", JSON.stringify(transcription.text));
      this.onResult?.(transcription.text, { recordedAudioBlob, source: "transcription" });
      return;
    }

    // Transcription backend unavailable, not configured, empty recording, or returned nothing usable —
    // fall back to whatever SpeechRecognition captured live during this SAME hold rather than losing the
    // instruction outright. This is explicitly a fallback, not the authoritative path (see top comment).
    if (!transcription.ok) log("transcription unavailable (", transcription.error, ") — falling back to SpeechRecognition text");
    const fallbackText = this._finalText.trim();
    if (fallbackText) {
      log("using SPEECHRECOGNITION FALLBACK result:", JSON.stringify(fallbackText));
      this.onResult?.(fallbackText, { recordedAudioBlob, source: "speech-recognition-fallback" });
      return;
    }

    // Nothing usable from either path — surface WHY, not just a generic catch-all, so a real-device test
    // can tell the difference between "no audio was ever captured" and "we recorded fine but transcription
    // failed and SpeechRecognition also produced nothing" without needing the console open.
    log("no usable result from either transcription or SpeechRecognition fallback");
    const reason = !recordedAudioBlob || recordedAudioBlob.size === 0
      ? "No audio was captured — check microphone permission."
      : transcription.error === "transcribe-backend-unreachable"
        ? "Couldn't reach the transcription service, and no live captions were available either."
        : "Didn't catch that — hold the button and try again, or type it.";
    this.onError?.(new Error(reason));
  }

  _finalizeRecording(recorder) {
    if (!recorder || recorder.state === "inactive") { log("_finalizeRecording: no active recorder (state:", recorder?.state ?? "none", ")"); return Promise.resolve(this._blobFromChunks()); }
    return new Promise((resolve) => {
      recorder.addEventListener("stop", () => { log("MediaRecorder 'stop' event fired, chunks so far:", this._chunks.length); resolve(this._blobFromChunks()); }, { once: true });
      try { recorder.stop(); } catch (error) { log("recorder.stop() threw", error?.name, error?.message); resolve(this._blobFromChunks()); }
    });
  }

  _blobFromChunks() {
    return this._chunks.length ? new Blob(this._chunks, { type: this._chunks[0].type || "audio/webm" }) : null;
  }
}
