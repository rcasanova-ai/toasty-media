// ProgramFeed: THE single Program media graph for a Studio/Creator page.
//
// Program is captured exactly once (Studio: the Program Output tab via getDisplayMedia; Creator: its
// canvas + mixed-audio graph). Every consumer — master recording, external broadcast, anything later —
// "retains" the same MediaStream instead of capturing again, so going Live while recording (or recording
// while Live) never opens a second browser capture picker and never builds a second pipeline. The
// underlying capture is released only when the last consumer lets go.
export class ProgramFeed {
  constructor({ acquire, label = "Program" } = {}) {
    if (typeof acquire !== "function") throw new Error("ProgramFeed needs an acquire() function.");
    this._acquire = acquire;
    this.label = label;
    this._stream = null;
    this._dispose = null;
    this._opening = null;
    this._holders = new Set();
    this._listeners = new Map();
    this.captureCount = 0;
  }

  get stream() { return this._stream; }
  get active() { return Boolean(this._stream); }
  get holders() { return [...this._holders]; }

  on(event, fn) {
    const list = this._listeners.get(event) || [];
    list.push(fn);
    this._listeners.set(event, list);
    return () => this._listeners.set(event, (this._listeners.get(event) || []).filter((f) => f !== fn));
  }

  _emit(event, payload) {
    for (const fn of this._listeners.get(event) || []) {
      try { fn(payload); } catch (error) { console.error("[ProgramFeed] listener failed", error); }
    }
  }

  // Resolves to the shared stream. Opens the capture (browser picker) only when none is live yet.
  async retain(owner) {
    if (!owner) throw new Error("ProgramFeed.retain needs an owner.");
    if (!this._stream) {
      this._opening = this._opening || this._open().finally(() => { this._opening = null; });
      await this._opening;
    }
    this._holders.add(owner);
    return this._stream;
  }

  release(owner) {
    if (!this._holders.delete(owner)) return;
    if (!this._holders.size) this._close();
  }

  async _open() {
    const acquired = await this._acquire();
    const stream = acquired?.stream || acquired;
    const video = stream?.getVideoTracks?.()[0];
    if (!video) {
      acquired?.dispose?.();
      stream?.getTracks?.().forEach((track) => track.stop());
      throw Object.assign(new Error("Program has no video to share."), { reason: "missing-video" });
    }
    this._stream = stream;
    this._dispose = typeof acquired?.dispose === "function" ? acquired.dispose : null;
    this.captureCount += 1;
    video.addEventListener?.("ended", () => this._onSourceEnded(stream), { once: true });
    this._emit("open", stream);
  }

  _onSourceEnded(stream) {
    if (this._stream !== stream) return;
    // The capture is gone out from under every consumer (browser "Stop sharing"); they hear about it via
    // "ended" and must not be left holding a dead stream.
    this._holders.clear();
    this._close();
    this._emit("ended", stream);
  }

  _close() {
    const stream = this._stream;
    this._stream = null;
    if (!stream) return;
    try { this._dispose?.(); } catch (_) {}
    this._dispose = null;
    stream.getTracks?.().forEach((track) => { try { track.stop(); } catch (_) {} });
    this._emit("close", stream);
  }
}
