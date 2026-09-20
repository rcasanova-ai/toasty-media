const MAX_TRANSCRIPT_LINES = 400; // bounded rolling window — see class comment below.

// Rolling transcript window. Deliberately bounded (not "send everything to the model forever") — once a
// topic completes, whatever mattered about it is expected to live in that topic's RunOfShow notes, not
// in raw transcript we keep hauling around. Populated by whichever TranscriptionProvider is running
// (see transcription.js); if none is running (policy forbids it, or nothing started), this simply stays
// empty — there is no other path that writes to it.
export class TranscriptStore {
  constructor() {
    this.lines = [];
    this._listeners = new Set();
  }

  on(callback) { this._listeners.add(callback); return () => this._listeners.delete(callback); }
  _emit(line) { this._listeners.forEach((cb) => cb(line, this.lines)); }

  append({ participantId = null, speaker, role = null, text, timestamp = Date.now() }) {
    const line = {
      id: `t-${timestamp}-${this.lines.length}`,
      participantId: participantId || null,
      speaker,
      role: role || null,
      text,
      timestamp
    };
    this.lines.push(line);
    if (this.lines.length > MAX_TRANSCRIPT_LINES) this.lines.shift();
    this._emit(line);
    return line;
  }

  recent(limit = 60) { return this.lines.slice(-limit); }
  speakers() { return [...new Set(this.lines.map((l) => l.speaker).filter(Boolean))]; }

  // Lines from `speaker` (case-insensitive substring match) whose text mentions `keyword`. Backs
  // "remind me what Kristine said about power" — a real search over real captured lines, not a canned
  // answer.
  findBySpeakerAndKeyword(speaker, keyword) {
    const speakerLower = speaker?.toLowerCase();
    const keywordLower = keyword?.toLowerCase();
    return this.lines.filter((line) =>
      (!speakerLower || line.speaker.toLowerCase().includes(speakerLower)) &&
      (!keywordLower || line.text.toLowerCase().includes(keywordLower))
    );
  }

  clear() { this.lines = []; this._emit(null); }
}

const MAX_MEMORY_DIRECTIVES = 40;
const LAST_TEXT_CHARS = 160;

// Compact durable memory distinct from the rolling raw transcript window. Speaker stats and recent
// Host directives live here so a later model call doesn't have to haul the entire transcript.
export class ShowContextMemory {
  constructor() {
    this.speakers = new Map();
    this.directives = [];
  }

  observe(line) {
    if (!line) return;
    const key = line.participantId || line.speaker || "unknown";
    const existing = this.speakers.get(key) || {
      participantId: line.participantId || null,
      speaker: line.speaker || "Unknown",
      role: line.role || null,
      turnCount: 0,
      lastHeardAt: 0,
      lastText: ""
    };
    existing.speaker = line.speaker || existing.speaker;
    existing.role = line.role || existing.role;
    existing.participantId = line.participantId || existing.participantId;
    existing.turnCount += 1;
    existing.lastHeardAt = line.timestamp || Date.now();
    existing.lastText = String(line.text || "").slice(0, LAST_TEXT_CHARS);
    this.speakers.set(key, existing);
  }

  rememberDirective(directive) {
    if (!directive) return;
    this.directives.push({
      id: directive.id,
      intent: directive.intent,
      query: directive.payload?.query || "",
      timestamp: directive.timestamp
    });
    if (this.directives.length > MAX_MEMORY_DIRECTIVES) this.directives.shift();
  }

  speakerStats() {
    return [...this.speakers.values()];
  }

  compact() {
    return {
      speakers: this.speakerStats().map((s) => ({
        participantId: s.participantId,
        speaker: s.speaker,
        role: s.role,
        turnCount: s.turnCount,
        lastHeardAt: s.lastHeardAt,
        lastText: s.lastText
      })),
      recentDirectives: this.directives.slice(-10)
    };
  }

  clear() {
    this.speakers.clear();
    this.directives = [];
  }
}

export function attributeTranscriptLine(line, participants) {
  const raw = line || {};
  const text = String(raw.text || "").trim();
  const list = typeof participants?.list === "function" ? participants.list() : [];
  const fromId = raw.participantId ? list.find((p) => p.participantId === raw.participantId) : null;
  if (fromId) {
    return {
      participantId: fromId.participantId,
      speaker: fromId.displayName || raw.speaker || "Participant",
      role: fromId.role,
      text,
      timestamp: raw.timestamp || Date.now()
    };
  }
  const wantsHost = raw.role === "host" || raw.participantId === "host" || String(raw.speaker || "").toLowerCase() === "host";
  if (wantsHost) {
    const host = list.find((p) => p.role === "host" || p.participantId === "host");
    if (host) {
      return {
        participantId: host.participantId,
        speaker: host.displayName || raw.speaker || "Host",
        role: "host",
        text,
        timestamp: raw.timestamp || Date.now()
      };
    }
  }
  const speakerLower = String(raw.speaker || "").toLowerCase();
  const fromName = speakerLower ? list.find((p) => (p.displayName || "").toLowerCase() === speakerLower) : null;
  if (fromName) {
    return {
      participantId: fromName.participantId,
      speaker: fromName.displayName,
      role: fromName.role,
      text,
      timestamp: raw.timestamp || Date.now()
    };
  }
  return {
    participantId: raw.participantId || null,
    speaker: raw.speaker || "Unknown",
    role: raw.role || null,
    text,
    timestamp: raw.timestamp || Date.now()
  };
}

// Builds the compact snapshot AIProducerService hands to a provider (heuristic or LLM). This is the
// answer to "what context does the AI Producer actually get" — recent transcript window, current/previous
// topics (via RunOfShow, whose notes already ARE the compact per-topic summary), recent audience
// messages, elapsed time, and its own recent history so it doesn't repeat itself.
export function buildShowContext(session) {
  const runOfShow = session.runOfShow;
  const current = runOfShow.current();
  const next = runOfShow.next();
  return {
    roomId: session.roomId,
    currentTopic: current ? { id: current.id, title: current.title, notes: current.notes, preparedQuestions: current.preparedQuestions } : null,
    nextTopic: next ? { id: next.id, title: next.title, notes: next.notes, preparedQuestions: next.preparedQuestions } : null,
    topicElapsedMs: runOfShow.currentElapsedMs(),
    topicRemainingMs: current?.estimatedMinutes ? Math.max(0, current.estimatedMinutes * 60000 - runOfShow.currentElapsedMs()) : null,
    elapsedMs: session.elapsedMs(),
    agenda: runOfShow.items.map((item) => ({ id: item.id, title: item.title, status: item.status, notes: item.notes })),
    previousTopics: runOfShow.completed().map((item) => ({ title: item.title, notes: item.notes })),
    transcript: session.transcript.recent(60),
    speakers: session.transcript.speakers(),
    memory: session.showMemory?.compact() || null,
    hostDirectives: session.hostDirectives?.recent(10) || [],
    // Structured guest metadata (see live-session.js's parseGuestLabel) — lets the Producer reference a
    // connected guest by name/title before they've said a word, e.g. "you haven't asked Kristine about
    // grid capacity yet". Empty when no guest has joined; never fabricated.
    guests: session.guestSeats.filter(Boolean).map((seat) => ({ displayName: seat.displayName || seat.label, title: seat.title || "", company: seat.company || "" })),
    audienceMessages: session.audience.recent(200),
    producerHistory: session.aiProducerFeed.recent(10).map((entry) => ({ type: entry.type, title: entry.title, summary: entry.summary, instruction: entry.instruction, sources: entry.sources })),
    // Research sessions (focus groups, customer interviews, expert panels) can attach a bounded research
    // context to the same Producer/Hottie pipeline. This keeps the AI aware of the client objective and
    // questions without mixing client-private session content into reusable participant profiles.
    researchContext: session.researchContext ? {
      id: session.researchContext.id || null,
      title: session.researchContext.title || "",
      objective: session.researchContext.objective || "",
      researchQuestions: session.researchContext.researchQuestions || [],
      cohort: session.researchContext.cohort || {},
      concepts: session.researchContext.concepts || []
    } : null
  };
}
