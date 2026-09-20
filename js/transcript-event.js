// Canonical multi-participant transcript event.
// Attribution is the browser identity that owns the microphone, never guessed from wording.

export const TranscriptSource = Object.freeze({
  PARTICIPANT_LOCAL: "participant-local",
  WEB_SPEECH: "web-speech",
  PROVIDER: "provider",
  DEMO: "demo"
});

let seq = 0;
export function nextTranscriptEventId() {
  seq += 1;
  return `tx-${Date.now().toString(36)}-${seq.toString(36)}`;
}

export function createTranscriptEvent({
  id,
  sessionId = null,
  participantId = null,
  speaker = "",
  role = null,
  text = "",
  startedAt = null,
  endedAt = null,
  timestamp = Date.now(),
  confidence = null,
  final = true,
  source = TranscriptSource.PARTICIPANT_LOCAL
} = {}) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  return {
    id: id || nextTranscriptEventId(),
    sessionId,
    participantId: participantId || null,
    speaker: speaker || "",
    role: role || null,
    text: trimmed,
    startedAt: startedAt || timestamp,
    endedAt: endedAt || timestamp,
    timestamp: Number(timestamp) || Date.now(),
    confidence: confidence == null ? null : Number(confidence),
    final: final !== false,
    source
  };
}

export function serializeTranscriptEvent(event) {
  return createTranscriptEvent(event);
}

export function transcriptEventFromLegacyLine(line, { sessionId, source = TranscriptSource.WEB_SPEECH } = {}) {
  return createTranscriptEvent({
    sessionId,
    participantId: line?.participantId || null,
    speaker: line?.speaker || "",
    role: line?.role || null,
    text: line?.text || "",
    timestamp: line?.timestamp,
    source
  });
}

// Participant-local uplink. Deterministic attribution: THIS browser is THIS participantId.
// Chrome Web Speech cannot bind to a supplied MediaStream — that is a browser constraint,
// not a Toasty identity guess. We still stamp the known participantId/role/speaker.
export class ParticipantTranscriptionUplink {
  constructor({
    sessionId,
    participantId,
    speaker,
    role,
    provider,
    onEvent
  } = {}) {
    this.sessionId = sessionId;
    this.participantId = participantId;
    this.speaker = speaker;
    this.role = role;
    this.provider = provider || null;
    this.onEvent = onEvent || null;
    this._off = null;
  }

  start() {
    if (!this.provider) return { ok: false, reason: "no-provider" };
    this._off = this.provider.onTranscript?.((line) => {
      const event = createTranscriptEvent({
        sessionId: this.sessionId,
        participantId: line?.participantId || this.participantId,
        speaker: line?.speaker || this.speaker,
        role: line?.role || this.role,
        text: line?.text,
        timestamp: line?.timestamp,
        source: this.provider?.constructor?.name === "DemoTranscriptionProvider"
          ? TranscriptSource.DEMO
          : TranscriptSource.WEB_SPEECH
      });
      if (event) this.onEvent?.(event);
    });
    this.provider.start?.();
    return { ok: true, participantId: this.participantId };
  }

  stop() {
    this._off?.();
    this._off = null;
    this.provider?.stop?.();
  }
}
