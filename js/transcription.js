// TranscriptionProvider boundary: start() / stop() / onTranscript(callback). Two implementations ship
// today; a real hosted STT vendor can join later as a third without any call site changing — see
// createTranscriptionProvider at the bottom, which is the only place that picks one.
//
// Every emitted line is speaker-attributed: { participantId, role, speaker, text, timestamp }.
// Identity is resolved against ParticipantRegistry at ingest time (see show-context.js).

export class WebSpeechTranscriptionProvider {
  static isSupported() {
    return typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  constructor({ speaker = "Host", participantId = "host", role = "host" } = {}) {
    this.speaker = speaker;
    this.participantId = participantId;
    this.role = role;
    this._listeners = new Set();
    this._running = false;
    const Impl = typeof window !== "undefined" ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
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
  _emit(text) {
    this._listeners.forEach((cb) => cb({
      participantId: this.participantId,
      role: this.role,
      speaker: this.speaker,
      text,
      timestamp: Date.now()
    }));
  }

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
    this._timerId = typeof window !== "undefined" ? window.setInterval(() => this._tick(), intervalMs) : null;
  }

  stop() {
    if (this._timerId && typeof window !== "undefined") window.clearInterval(this._timerId);
    this._timerId = null;
  }

  _tick() {
    if (this._index >= this.script.length) { this.stop(); return; }
    const line = this.script[this._index++];
    this._listeners.forEach((cb) => cb({
      participantId: line.participantId || null,
      role: line.role || null,
      speaker: line.speaker,
      text: line.text,
      timestamp: Date.now()
    }));
  }
}

export const DEMO_TRANSCRIPT_SCRIPT = [
  { participantId: "host", role: "host", speaker: "Ricardo", text: "So let's get into Thailand — there's a real push toward AI data centres here." },
  { participantId: null, role: "guest", speaker: "Kristine", text: "Right, and the question everyone in-market keeps raising is power. Kristine here — the grid buildout hasn't kept pace with the announced pipeline." },
  { participantId: "host", role: "host", speaker: "Ricardo", text: "So it's not really an AI story yet, it's a power story." },
  { participantId: null, role: "guest", speaker: "Kristine", text: "Partly. Some of what's labeled AI data-centre capacity today is still fairly conventional cloud infrastructure, but a few of the newer announcements are genuinely GPU-dense." },
  { participantId: "host", role: "host", speaker: "Ricardo", text: "Right, we haven't actually named who's building what yet — that's probably worth a beat." },
  { participantId: null, role: "guest", speaker: "Kristine", text: "Yeah, I don't want to get into individual company names on air, but the pattern is consistent across the announced sites." },
  { participantId: "host", role: "host", speaker: "Ricardo", text: "Fair enough. Let's take a couple of audience questions on that before we move on." }
];

// Solo/Hottie producer fixture — Host + guests, a real Host "Toasty, …" directive, a guest mentioning
// Toasty without commanding, disagreement, an uncovered research question (never spoken), and a quiet
// participant (Sarah) who exists in the registry but never speaks. Used by tests and optional demo.
export const HOTTIE_LIVE_PRODUCER_SCRIPT = [
  { participantId: "host", role: "host", speaker: "Ricardo", text: "Welcome back. Thailand data-center announcements have been everywhere this week." },
  { participantId: "g-tukta", role: "guest", speaker: "Tukta", text: "The pipeline looks real, but Toasty is interesting as a distribution layer, not as a data-center play." },
  { participantId: "g-pat", role: "guest", speaker: "Pat", text: "I disagree — I wouldn't use this in a regulated industry without a lot more control." },
  { participantId: "host", role: "host", speaker: "Ricardo", text: "Pricing came up off-air. Let's stay with regulation for a minute." },
  { participantId: "g-pat", role: "guest", speaker: "Pat", text: "Toasty, find the article — wait, I'm just saying the name, I'm not asking the producer." },
  { participantId: "host", role: "host", speaker: "Ricardo", text: "Toasty, find me that article about the Thailand data-center announcement." },
  { participantId: "host", role: "host", speaker: "Ricardo", text: "Toasty, remind me what Tukta said about pricing." }
];

export const HOTTIE_LIVE_PRODUCER_RESEARCH = Object.freeze({
  id: "fixture-hottie-live",
  title: "Hottie live producer fixture",
  objective: "Exercise transcript attribution, Host directives, and private producer intelligence.",
  researchQuestions: ["What would stop you from using this?"],
  cohort: { label: "Fixture" },
  concepts: []
});

// preferDemo lets a caller explicitly ask for the deterministic path even when SpeechRecognition is
// available (useful for rehearsing a demo reliably). policy is checked FIRST and unconditionally: a
// capture policy that forbids transcription returns null no matter what the caller asked for.
// Live (preferDemo=false) never silently falls through to the seeded demo script — faking Ricardo/
// Kristine lines during a real show would poison ShowContext.
export function createTranscriptionProvider({
  policy,
  preferDemo = false,
  script,
  speaker = "Host",
  participantId = "host",
  role = "host"
} = {}) {
  if (!policy?.canTranscribe()) return null;
  if (preferDemo) return new DemoTranscriptionProvider(script);
  if (WebSpeechTranscriptionProvider.isSupported()) {
    return new WebSpeechTranscriptionProvider({ speaker, participantId, role });
  }
  return null;
}
