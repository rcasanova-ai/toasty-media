import { studioApiEndpoint } from "./studio-api.js";

const DEFAULT_POLL_MS = 1500;

export class ProgramServerSubscriber {
  constructor({
    roomId,
    endpoint,
    fetchImpl,
    intervalMs = DEFAULT_POLL_MS,
    onBundle,
    onProgram,
    onError,
    setIntervalImpl,
    clearIntervalImpl
  } = {}) {
    this.roomId = roomId;
    this.endpoint = endpoint || (typeof window !== "undefined" ? studioApiEndpoint() : "");
    this.fetchImpl = fetchImpl || globalThis.fetch?.bind(globalThis);
    this.intervalMs = Math.max(750, Number(intervalMs) || DEFAULT_POLL_MS);
    this.onBundle = typeof onBundle === "function" ? onBundle : null;
    this.onProgram = typeof onProgram === "function" ? onProgram : null;
    this.onError = typeof onError === "function" ? onError : null;
    this.setIntervalImpl = setIntervalImpl || globalThis.setInterval?.bind(globalThis);
    this.clearIntervalImpl = clearIntervalImpl || globalThis.clearInterval?.bind(globalThis);
    this.timerId = null;
    this.lastSignature = "";
    this.lastRevision = 0;
    this.lastUpdateAt = null;
    this.lastError = "";
  }

  start() {
    this.stop();
    void this.poll({ force: true });
    if (this.setIntervalImpl) {
      this.timerId = this.setIntervalImpl(() => void this.poll(), this.intervalMs);
    }
  }

  stop() {
    if (this.timerId && this.clearIntervalImpl) {
      this.clearIntervalImpl(this.timerId);
    }
    this.timerId = null;
  }

  async poll({ force = false } = {}) {
    if (!this.roomId || !this.endpoint || !this.fetchImpl) return null;
    try {
      const response = await this.fetchImpl(`${this.endpoint}/api/presence/room?roomId=${encodeURIComponent(this.roomId)}`);
      if (!response?.ok) throw new Error(`presence_room_${response?.status || 0}`);
      const bundle = await response.json();
      this.lastError = "";
      this.lastUpdateAt = Date.now();
      this.onBundle?.(bundle);
      const program = bundle?.program || null;
      if (!program) return bundle;
      const signature = programSignature(program);
      if (force || signature !== this.lastSignature) {
        this.lastSignature = signature;
        this.lastRevision = Number(program.revision) || this.lastRevision || 0;
        this.onProgram?.(program, { source: "server-poll", bundle });
      }
      return bundle;
    } catch (error) {
      this.lastError = String(error?.message || error || "server-sync-error");
      this.onError?.(this.lastError);
      return null;
    }
  }
}

export function programSignature(program = {}) {
  return [
    Number(program.revision) || 0,
    program.updatedAt || "",
    program.scene || "",
    program.ticker?.enabled ? "ticker-on" : "ticker-off",
    program.ticker?.text || "",
    (program.participants || []).map((participant) => `${participant.participantId}:${participant.transportSourceId || ""}:${participant.onProgram !== false ? "on" : "off"}`).join("|"),
    program.screenShare?.active ? program.screenShare?.transportSourceId || "screen" : "no-screen",
    program.asset?.id || ""
  ].join("::");
}
