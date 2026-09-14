const CHANNEL_PREFIX = "toasty-program:";
const STORAGE_PREFIX = "toastyProgramState:";

// Director-to-ProgramOutput state bus. Both pages run in the same browser (Program Output is opened
// from Director via window.open, and is later tab-captured for RTMP), so a same-origin BroadcastChannel
// is enough to keep them in sync in real time. The last known state is also mirrored to localStorage so
// a Program Output tab that loads after Director already has one can hydrate immediately on open.
export class ProgramSync {
  constructor(roomId) {
    this.roomId = roomId;
    this.storageKey = `${STORAGE_PREFIX}${roomId}`;
    this.channel = "BroadcastChannel" in window ? new BroadcastChannel(`${CHANNEL_PREFIX}${roomId}`) : null;
    this.listeners = new Set();
    this.channel?.addEventListener("message", (event) => this.listeners.forEach((callback) => callback(event.data)));
  }

  publishState(payload) {
    const message = { type: "state", payload, sentAt: Date.now() };
    try { localStorage.setItem(this.storageKey, JSON.stringify(payload)); } catch (_) {}
    this.channel?.postMessage(message);
  }

  requestState() {
    this.channel?.postMessage({ type: "request-state" });
  }

  readLastState() {
    try { return JSON.parse(localStorage.getItem(this.storageKey) || "null"); } catch (_) { return null; }
  }

  onMessage(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  close() {
    this.channel?.close();
  }
}
