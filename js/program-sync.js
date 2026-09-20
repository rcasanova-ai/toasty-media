const CHANNEL_PREFIX = "toasty-program:";
const STORAGE_PREFIX = "toastyProgramState:";

// Director-to-ProgramOutput state bus. Both pages run in the same browser (Program Output is opened
// from Director via window.open, and is later tab-captured for RTMP), so BroadcastChannel is the primary
// realtime path. The last known state is also mirrored to localStorage; Program Output listens for those
// storage writes as a fallback and hydrates from them when opened after Director already has state.
export class ProgramSync {
  constructor(roomId) {
    this.roomId = roomId;
    this.storageKey = `${STORAGE_PREFIX}${roomId}`;
    this.channel = "BroadcastChannel" in window ? new BroadcastChannel(`${CHANNEL_PREFIX}${roomId}`) : null;
    this.listeners = new Set();
    this.channel?.addEventListener("message", (event) => this.listeners.forEach((callback) => callback(event.data)));
    this._onStorage = (event) => {
      if (event.key !== this.storageKey || !event.newValue) return;
      const payload = safeParse(event.newValue);
      if (!payload) return;
      this.listeners.forEach((callback) => callback({ type: "state", payload, sentAt: Date.now(), source: "storage" }));
    };
    if (typeof window.addEventListener === "function") {
      window.addEventListener("storage", this._onStorage);
    }
  }

  publishState(payload) {
    const message = { type: "state", payload, sentAt: Date.now() };
    try { localStorage.setItem(this.storageKey, JSON.stringify(payload)); } catch (_) {}
    this.channel?.postMessage(message);
  }

  requestState() {
    this.channel?.postMessage({ type: "request-state" });
  }

  publishOutputStatus(payload) {
    this.channel?.postMessage({ type: "output-status", payload, sentAt: Date.now() });
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
    if (this._onStorage && typeof window.removeEventListener === "function") {
      window.removeEventListener("storage", this._onStorage);
    }
  }
}

function safeParse(value) {
  try { return JSON.parse(value || "null"); } catch (_) { return null; }
}
