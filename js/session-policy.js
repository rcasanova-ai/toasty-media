// Session policy — the enforceable rules a room runs under, not a decorative label.
// Live Studio shows and Toasty Peeps Jams share the same room/session plumbing (LiveSession); what
// differs is what a Jam is allowed to capture and hand to the AI Producer. A "live" session is the
// public-broadcast default and is unrestricted. A "jam" session defaults to locked down, and every
// capture/AI surface (recording control, transcript pipeline, AI Producer context feed) must check this
// policy before acting — not just hide its own button — so a permission can't be reached by another path.

export const SessionType = Object.freeze({ LIVE: "live", JAM: "jam" });
export const Privacy = Object.freeze({ PRIVATE: "private", CONFIDENTIAL: "confidential", BLIND: "blind" });
export const CapturePolicy = Object.freeze({
  NONE: "none",
  TRANSCRIPT: "transcript",
  RECORDING: "recording",
  RECORDING_AND_TRANSCRIPT: "recording_and_transcript"
});
export const Access = Object.freeze({ PUBLIC: "public", INVITED_ONLY: "invited_only" });

function defaultsFor(sessionType) {
  if (sessionType === SessionType.JAM) {
    return {
      sessionType: SessionType.JAM,
      privacy: Privacy.CONFIDENTIAL,
      capturePolicy: CapturePolicy.NONE,
      aiProcessingAllowed: false,
      jamRecordAllowed: false,
      access: Access.INVITED_ONLY
    };
  }
  return {
    sessionType: SessionType.LIVE,
    privacy: null,
    capturePolicy: CapturePolicy.RECORDING_AND_TRANSCRIPT,
    aiProcessingAllowed: true,
    jamRecordAllowed: true,
    access: Access.PUBLIC
  };
}

export class SessionPolicy {
  constructor(overrides = {}) {
    this._state = { ...defaultsFor(overrides.sessionType || SessionType.LIVE), ...overrides };
    this._normalize();
  }

  get state() { return { ...this._state }; }
  get sessionType() { return this._state.sessionType; }

  // A capture policy that forbids transcript also forbids AI processing outright: AI Producer has
  // nothing lawful left to read. A capture policy that forbids recording also forbids jam-record.
  // Re-run on every mutation so an inconsistent combination can never be reached, from any call site.
  _normalize() {
    if (!this.canTranscribe()) this._state.aiProcessingAllowed = false;
    if (!this.canRecord()) this._state.jamRecordAllowed = false;
  }

  canRecord() {
    return this._state.capturePolicy === CapturePolicy.RECORDING || this._state.capturePolicy === CapturePolicy.RECORDING_AND_TRANSCRIPT;
  }

  canTranscribe() {
    return this._state.capturePolicy === CapturePolicy.TRANSCRIPT || this._state.capturePolicy === CapturePolicy.RECORDING_AND_TRANSCRIPT;
  }

  canAiProcess() {
    return Boolean(this._state.aiProcessingAllowed) && this.canTranscribe();
  }

  canJamRecord() {
    return Boolean(this._state.jamRecordAllowed) && this.canRecord();
  }

  set(patch) {
    Object.assign(this._state, patch);
    this._normalize();
    return this.state;
  }

  setSessionType(sessionType) {
    this._state = defaultsFor(sessionType);
    return this.state;
  }

  // null for a "live" session — nothing is restricted, so there is nothing worth badging.
  summary() {
    if (this._state.sessionType !== SessionType.JAM) return null;
    const label = this._state.privacy === Privacy.BLIND ? "BLIND JAM"
      : this._state.privacy === Privacy.PRIVATE ? "PRIVATE JAM"
      : "CONFIDENTIAL JAM";
    const detail = [
      this.canTranscribe() ? "Transcript allowed" : "Transcript disabled",
      this.canRecord() ? "Recording allowed" : "Recording disabled"
    ].join(" · ");
    return { icon: "🔒", label, detail };
  }
}
