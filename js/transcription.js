// TranscriptionProvider boundary: start() / stop() / onTranscript(callback). Two implementations ship
// today; a real hosted STT vendor can join later as a third without any call site changing — see
// createTranscriptionProvider at the bottom, which is the only place that picks one.

// Real, live transcription using the browser's native SpeechRecognition — zero extra infrastructure,
// works today in Chrome. This is the "real transcription" path the demo path below is a stand-in for.
export class WebSpeechTranscriptionProvider {
  static isSupported() { return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition); }

  constructor({ speaker = "Host" } = {}) {
    this.speaker = speaker;
    this._listeners = new Set();
    this._running = false;
    const Impl = window.SpeechRecognition || window.webkitSpeechRecognition;
    this._recognition = Impl ? new Impl() : null;
    if (this._recognition) {
      this._recognition.continuous = true;
      this._recognition.interimResults = false;
      this._recognition.lang = "en-US";
      this._recognition.addEventListener("result", (event) => {
        const result = event.results[event.results.length - 1];
        const text = result?.[0]?.transcript?.trim();
        if (text) this._emit(text);
      });
      // Chrome's SpeechRecognition stops itself after a pause; restart it while we're still meant to be on.
      this._recognition.addEventListener("end", () => { if (this._running) this._recognition.start(); });
    }
  }

  onTranscript(callback) { this._listeners.add(callback); return () => this._listeners.delete(callback); }
  _emit(text) { this._listeners.forEach((cb) => cb({ speaker: this.speaker, text, timestamp: Date.now() })); }

  start() {
    if (!this._recognition) throw new Error("SpeechRecognition isn't supported in this browser.");
    this._running = true;
    this._recognition.start();
  }

  stop() {
    this._running = false;
    this._recognition?.stop();
  }
}

// Deterministic seeded transcript so the full AI Producer demo (including "remind me what Kristine said
// about power") works end-to-end with no microphone at all. Content deliberately mirrors the seeded
// audience script (audience.js) — same Thailand grid-capacity thread — so cross-referencing between
// transcript and audience questions has real signal.
export class DemoTranscriptionProvider {
  constructor(script) {
    this.script = script || DEMO_TRANSCRIPT_SCRIPT;
    this._listeners = new Set();
    this._timerId = null;
    this._index = 0;
  }

  onTranscript(callback) { this._listeners.add(callback); return () => this._listeners.delete(callback); }

  start({ intervalMs = 4000 } = {}) {
    this.stop();
    this._index = 0;
    this._tick();
    this._timerId = window.setInterval(() => this._tick(), intervalMs);
  }

  stop() {
    if (this._timerId) window.clearInterval(this._timerId);
    this._timerId = null;
  }

  _tick() {
    if (this._index >= this.script.length) { this.stop(); return; }
    const line = this.script[this._index++];
    this._listeners.forEach((cb) => cb({ speaker: line.speaker, text: line.text, timestamp: Date.now() }));
  }
}

const DEMO_TRANSCRIPT_SCRIPT = [
  { speaker: "Ricardo", text: "So let's get into Thailand — there's a real push toward AI data centres here." },
  { speaker: "Kristine", text: "Right, and the question everyone in-market keeps raising is power. Kristine here — the grid buildout hasn't kept pace with the announced pipeline." },
  { speaker: "Ricardo", text: "So it's not really an AI story yet, it's a power story." },
  { speaker: "Kristine", text: "Partly. Some of what's labeled AI data-centre capacity today is still fairly conventional cloud infrastructure, but a few of the newer announcements are genuinely GPU-dense." },
  { speaker: "Ricardo", text: "Right, we haven't actually named who's building what yet — that's probably worth a beat." },
  { speaker: "Kristine", text: "Yeah, I don't want to get into individual company names on air, but the pattern is consistent across the announced sites." },
  { speaker: "Ricardo", text: "Fair enough. Let's take a couple of audience questions on that before we move on." }
];

// preferDemo lets a caller explicitly ask for the deterministic path even when SpeechRecognition is
// available (useful for rehearsing a demo reliably). policy is checked FIRST and unconditionally: a
// capture policy that forbids transcription returns null no matter what the caller asked for.
export function createTranscriptionProvider({ policy, preferDemo = false } = {}) {
  if (!policy?.canTranscribe()) return null;
  if (!preferDemo && WebSpeechTranscriptionProvider.isSupported()) return new WebSpeechTranscriptionProvider();
  return new DemoTranscriptionProvider();
}
