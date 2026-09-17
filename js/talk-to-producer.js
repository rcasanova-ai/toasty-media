// Push-to-talk instruction capture. One SpeechRecognition instance per hold, deliberately non-continuous
// (single utterance per hold-gesture, not per browser sentence-boundary) — reliability over always-
// listening magic, per the product call to prioritize a hold-to-talk gesture over wake-word detection.
//
// The critical invariant this file exists to protect: the user's PHYSICAL hold state (`_held`) and the
// SpeechRecognition engine's own lifecycle are two SEPARATE state machines. Browsers can and do end a
// `continuous:true` recognition on their own — after a silence timeout, or (a well-documented Chrome
// quirk) sometimes right after the first detected phrase despite continuous mode — and that must never
// be read as "the user let go of the button." Only an explicit stop() (driven by the caller's own
// pointerup/pointercancel handling) sets `_held = false`; an unexpected `end` while still held silently
// restarts recognition instead.
export class PushToTalkCapture {
  static isSupported() { return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition); }

  // onInterim fires repeatedly with the best-guess-so-far transcript while the mic is open, so the UI
  // can show "what Toasty is hearing" live during the LISTENING state. onResult fires once, on release,
  // with the final transcript.
  constructor({ onListening, onInterim, onResult, onError } = {}) {
    this.onListening = onListening;
    this.onInterim = onInterim;
    this.onResult = onResult;
    this.onError = onError;
    this._recognition = null;
    this._finalText = "";
    this._held = false;
    this._restartAttempts = 0;
  }

  get isHeld() { return this._held; }

  start() {
    const Impl = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Impl) {
      this.onError?.(new Error("Voice capture isn't supported in this browser — type the instruction instead."));
      return;
    }
    // Guards the mouse+touch compatibility-event double-fire this class used to be vulnerable to (a
    // touchstart followed by a synthesized mousedown on the same physical press): a second start() while
    // already held is a no-op, never a second recognition instance racing the first.
    if (this._held) return;
    this._held = true;
    this._finalText = "";
    this._restartAttempts = 0;
    this._beginRecognition(Impl);
    this.onListening?.();
  }

  _beginRecognition(Impl) {
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
      if (event.error === "no-speech" || event.error === "aborted") return;
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        this._held = false;
        this.onError?.(new Error("Microphone access was denied — allow it in the browser, or type the instruction instead."));
      }
      // Any other error: don't decide anything here. The 'end' event that follows is what determines
      // whether this was a real stop or something to transparently restart from.
    });
    recognition.addEventListener("end", () => {
      if (!this._held) return; // stop() already ran — this is the expected end of a real release, not a bug
      if (this._restartAttempts >= 4) {
        this._held = false;
        this.onError?.(new Error("Voice capture kept stopping — try again or type the instruction."));
        return;
      }
      this._restartAttempts += 1;
      try {
        this._beginRecognition(Impl);
      } catch (_) {
        this._held = false;
        this.onError?.(new Error("Voice capture stopped unexpectedly — try again or type the instruction."));
      }
    });
    try {
      recognition.start();
    } catch (_) {
      // Thrown if invoked while a just-stopped prior instance hasn't finished tearing down yet — the
      // 'end' handler above already owns retrying, so a thrown start() here is safe to swallow.
    }
  }

  // The only thing allowed to end a hold from the outside. Always resolves via onResult (non-empty
  // transcript) or onError (empty) exactly once, whether the release was a clean pointerup or a
  // pointercancel — see js/host-view.js's binding for why both route here identically.
  stop() {
    if (!this._held) return;
    this._held = false;
    const text = this._finalText.trim();
    try { this._recognition?.stop(); } catch (_) {}
    if (text) this.onResult?.(text);
    else this.onError?.(new Error("Didn't catch that — hold the button and try again, or type it."));
  }
}
