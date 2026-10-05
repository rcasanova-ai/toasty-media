// ProgramOrchestrator: the Backstage / Record / Live product model, in one place, with no DOM and no
// browser APIs — so Studio and Creator run the exact same logic and it can be tested headlessly.
//
// User-facing modes (derived, never set directly):
//   LIVE      at least one external destination is ACTUALLY receiving Program
//   RECORD    nothing is Live, but Program is being recorded
//   BACKSTAGE everything else — camera/mic/guests/screen-share/Program Output connectivity never change this
//
// One Program (ProgramFeed), many consumers: recording and broadcast both retain the same stream, so
// GO LIVE never triggers a second capture. Going Live auto-starts a recording (origin "live-auto"); END
// LIVE finalizes only recordings it started itself — a recording the producer started by hand first
// (origin "manual") keeps running. Destination failures are isolated: Studio stays LIVE while any
// destination still is.
export const StudioMode = Object.freeze({ BACKSTAGE: "backstage", RECORD: "record", LIVE: "live" });
export const RecordingOrigin = Object.freeze({ MANUAL: "manual", LIVE_AUTO: "live-auto" });
export const DestinationState = Object.freeze({
  IDLE: "idle", CONNECTING: "connecting", LIVE: "live", ERROR: "error", STOPPED: "stopped"
});

export class ProgramOrchestrator {
  // feed:        ProgramFeed
  // recorder:    { start({ stream, origin }) -> Promise, stop() -> Promise }
  // broadcaster: { start({ destinations, stream }) -> Promise, stop() -> Promise, onUpdate(fn) }
  constructor({ feed, recorder, broadcaster } = {}) {
    this.feed = feed;
    this.recorder = recorder;
    this.broadcaster = broadcaster;
    this.recording = { active: false, origin: null, startedAt: null };
    this.destinations = new Map();
    this.busy = null;
    this.notice = "";
    this.recordingError = "";
    this._listeners = new Set();
    this._wasLive = false;
    this._autoRecordPromise = null;
    broadcaster?.onUpdate?.((update) => this._applyBroadcastUpdate(update));
    feed?.on?.("ended", () => this._onFeedEnded());
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  get mode() {
    if ([...this.destinations.values()].some((d) => d.state === DestinationState.LIVE)) return StudioMode.LIVE;
    if (this.recording.active) return StudioMode.RECORD;
    return StudioMode.BACKSTAGE;
  }

  snapshot() {
    return {
      mode: this.mode,
      recording: { ...this.recording },
      destinations: [...this.destinations.values()].map((d) => ({ ...d })),
      busy: this.busy,
      notice: this.notice,
      recordingError: this.recordingError
    };
  }

  _emit() {
    const snap = this.snapshot();
    for (const fn of this._listeners) {
      try { fn(snap); } catch (error) { console.error("[ProgramOrchestrator] listener failed", error); }
    }
  }

  // ---- Record (manual) ----
  async startRecording() {
    if (this.recording.active) return this.recording;
    return this._startRecording(RecordingOrigin.MANUAL);
  }

  async _startRecording(origin) {
    this.recordingError = "";
    const stream = await this.feed.retain("recording"); // reuses the live Program capture when Live already holds it
    try {
      const started = await this.recorder.start({ stream, origin });
      this.recording = { active: true, origin, startedAt: started?.startedAt || Date.now() };
    } catch (error) {
      this.feed.release("recording");
      throw error;
    }
    this._emit();
    return this.recording;
  }

  async stopRecording() {
    if (!this.recording.active) return null;
    const previous = this.recording;
    this.recording = { active: false, origin: null, startedAt: null };
    this._emit();
    try {
      return await this.recorder.stop({ origin: previous.origin });
    } finally {
      this.feed.release("recording");
      this._emit();
    }
  }

  // ---- Go Live / End Live ----
  async goLive(names = []) {
    const chosen = [...new Set(names)].filter(Boolean);
    if (!chosen.length) throw new Error("Choose at least one destination.");
    if (this.busy === "going-live") return;
    this.busy = "going-live";
    this.notice = "";
    this._emit();
    let retained = false;
    try {
      const stream = await this.feed.retain("broadcast");
      retained = true;
      this.destinations = new Map(chosen.map((name) => [name, { destination: name, label: name, state: DestinationState.CONNECTING, error: "" }]));
      this._emit();
      await this.broadcaster.start({ destinations: chosen, stream });
    } catch (error) {
      this.destinations = new Map();
      if (retained) this.feed.release("broadcast");
      this.busy = null;
      this._emit();
      throw error;
    }
    this.busy = null;
    this._reconcile();
    this._emit();
  }

  async endLive() {
    if (!this.destinations.size && !this._broadcastHeld()) return;
    this.busy = "ending-live";
    this._wasLive = false; // a deliberate End Live is not "all destinations dropped on their own"
    this._emit();
    try { await this.broadcaster.stop(); } catch (error) { console.error("[ProgramOrchestrator] broadcast stop failed", error); }
    this.destinations = new Map();
    this._wasLive = false;
    this.feed.release("broadcast");
    // Only a recording that Going Live started is ended with it. A manual recording is the producer's own.
    if (this.recording.active && this.recording.origin === RecordingOrigin.LIVE_AUTO) {
      try { await this.stopRecording(); } catch (error) { this.recordingError = String(error?.message || error); }
    }
    this.busy = null;
    this._emit();
  }

  _broadcastHeld() { return this.feed.holders.includes("broadcast"); }

  // Broadcast backend reports per-destination state. Destinations fail independently.
  _applyBroadcastUpdate(update) {
    for (const incoming of update?.destinations || []) {
      const existing = this.destinations.get(incoming.destination);
      if (!existing && !this._broadcastHeld() && this.busy !== "going-live") continue;
      this.destinations.set(incoming.destination, { ...(existing || {}), ...incoming });
    }
    this._reconcile();
    this._emit();
  }

  _reconcile() {
    const live = [...this.destinations.values()].some((d) => d.state === DestinationState.LIVE);
    if (live && !this._wasLive) {
      this._wasLive = true;
      // Going Live starts recording — on the SAME Program capture, no second picker.
      if (!this.recording.active && !this._autoRecordPromise) {
        this._autoRecordPromise = this._startRecording(RecordingOrigin.LIVE_AUTO)
          .catch((error) => {
            this.recordingError = `Live is on, but the automatic recording could not start: ${error?.message || error}`;
          })
          .finally(() => { this._autoRecordPromise = null; this._emit(); });
      }
    } else if (!live && this._wasLive) {
      this._wasLive = false;
      void this._onLiveLost();
    }
  }

  // Every destination ended on its own (not a user End Live). Release the broadcast; keep any recording
  // running — footage is never discarded because a destination dropped.
  async _onLiveLost() {
    try { await this.broadcaster.stop(); } catch (_) {}
    if (this._broadcastHeld()) this.feed.release("broadcast");
    this.notice = this.recording.active
      ? "All destinations ended. Recording is still running — stop it when you're done."
      : "All destinations ended.";
    this._emit();
  }

  _onFeedEnded() {
    // The shared capture was stopped from the browser's own "Stop sharing" UI: nothing can be live or recorded.
    const wasRecording = this.recording.active;
    const hadBroadcast = this.destinations.size > 0;
    if (hadBroadcast) {
      this.broadcaster.stop?.().catch?.(() => {});
      this.destinations = new Map();
      this._wasLive = false;
      this.notice = "Program sharing was stopped, so the broadcast ended.";
    }
    if (wasRecording) {
      this.stopRecording().catch(() => {});
      this.notice = "Program sharing was stopped, so recording was saved and ended.";
    }
    this._emit();
  }
}
