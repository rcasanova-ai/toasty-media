// Push-to-talk instruction capture. One SpeechRecognition instance per hold, deliberately non-continuous
// (single utterance) — reliability over always-listening magic, per the product call to prioritize a
// hold-to-talk gesture over wake-word detection for Phase 1.
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
  }

  start() {
    const Impl = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Impl) {
      this.onError?.(new Error("Voice capture isn't supported in this browser — type the instruction instead."));
      return;
    }
    this._finalText = "";
    this._recognition = new Impl();
    this._recognition.continuous = true;
    this._recognition.interimResults = true;
    this._recognition.lang = "en-US";
    this._recognition.addEventListener("result", (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) this._finalText = `${this._finalText} ${transcript}`.trim();
        else interim = transcript;
      }
      this.onInterim?.(`${this._finalText} ${interim}`.trim());
    });
    this._recognition.addEventListener("error", (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      this.onError?.(new Error(event.error));
    });
    this.onListening?.();
    this._recognition.start();
  }

  stop() {
    const text = this._finalText.trim();
    this._recognition?.stop();
    if (text) this.onResult?.(text);
    else this.onError?.(new Error("Didn't catch that — hold the button and try again, or type it."));
  }
}
