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

  append({ speaker, text, timestamp = Date.now() }) {
    const line = { id: `t-${timestamp}-${this.lines.length}`, speaker, text, timestamp };
    this.lines.push(line);
    if (this.lines.length > MAX_TRANSCRIPT_LINES) this.lines.shift();
    this._emit(line);
    return line;
  }

  recent(limit = 60) { return this.lines.slice(-limit); }
  speakers() { return [...new Set(this.lines.map((l) => l.speaker))]; }

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

// Builds the compact snapshot AIProducerService hands to a provider (heuristic or LLM). This is the
// answer to "what context does the AI Producer actually get" — recent transcript window, current/previous
// topics (via RunOfShow, whose notes already ARE the compact per-topic summary), recent audience
// messages, elapsed time, and its own recent history so it doesn't repeat itself.
export function buildShowContext(session) {
  const runOfShow = session.runOfShow;
  const current = runOfShow.current();
  return {
    roomId: session.roomId,
    currentTopic: current ? { id: current.id, title: current.title, notes: current.notes, preparedQuestions: current.preparedQuestions } : null,
    topicElapsedMs: runOfShow.currentElapsedMs(),
    elapsedMs: session.elapsedMs(),
    agenda: runOfShow.items.map((item) => ({ id: item.id, title: item.title, status: item.status, notes: item.notes })),
    previousTopics: runOfShow.completed().map((item) => ({ title: item.title, notes: item.notes })),
    transcript: session.transcript.recent(60),
    speakers: session.transcript.speakers(),
    audienceMessages: session.audience.recent(200),
    producerHistory: session.aiProducerFeed.recent(10).map((entry) => ({ type: entry.type, title: entry.title, summary: entry.summary, instruction: entry.instruction, sources: entry.sources }))
  };
}
