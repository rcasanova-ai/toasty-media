// StudioBroadcastClient: the browser half of Going Live.
//
// - Destination credentials (RTMP(S) URL + stream key) are saved ONCE to the server (encrypted, scoped to the
//   signed-in organization) and never read back — this file never stores a stream key anywhere, in memory
//   beyond the single save call, localStorage, or otherwise.
// - It consumes the shared Program MediaStream (see program-feed.js) — it NEVER captures anything itself.
// - Program travels to the server as many SHORT chunk POSTs (~1/s) rather than one request held open for
//   the whole show, so no proxy timeout/buffering can end the stream mid-show.
import { studioApiEndpoint } from "./studio-api.js";

const CHUNK_MS = 1000;
const MAX_QUEUED_CHUNKS = 45;
const CHUNK_RETRIES = 3;

export const DESTINATION_CATALOG = Object.freeze([
  { id: "x", label: "X" },
  { id: "youtube", label: "YouTube" },
  { id: "tiktok", label: "TikTok" },
  { id: "instagram", label: "Instagram" }
]);

function pickMimeType(Rec) {
  return ["video/webm;codecs=vp8,opus", "video/webm;codecs=vp9,opus", "video/webm"].find((type) => Rec?.isTypeSupported?.(type)) || "";
}

export class StudioBroadcastClient {
  constructor({ endpoint, fetchImpl, MediaRecorderImpl, getSessionId, getOrganizationId } = {}) {
    this.endpointOverride = endpoint;
    this.fetch = fetchImpl || ((...args) => fetch(...args));
    this.MediaRecorderImpl = MediaRecorderImpl || globalThis.MediaRecorder;
    this.getSessionId = typeof getSessionId === "function" ? getSessionId : () => null;
    this.getOrganizationId = typeof getOrganizationId === "function" ? getOrganizationId : () => null;
    this.listeners = new Set();
    this.broadcastId = null;
    this.recorder = null;
    this.queue = [];
    this.seq = 0;
    this.pumping = false;
    this.stopping = false;
    this.destinations = [];
  }

  get endpoint() { return this.endpointOverride || studioApiEndpoint(); }
  get active() { return Boolean(this.broadcastId); }

  onUpdate(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _emit(destinations) {
    this.destinations = destinations;
    for (const fn of this.listeners) { try { fn({ destinations }); } catch (error) { console.error("[StudioBroadcastClient] listener failed", error); } }
  }

  async _request(path, { method = "GET", body, raw, signal } = {}) {
    const headers = method === "GET" ? {} : { "X-Toasty-CSRF": "1" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (raw) headers["Content-Type"] = "application/octet-stream";
    const response = await this.fetch(`${this.endpoint}/api/organizations/creator-broadcast/${path}`, {
      method, credentials: "include", headers, signal,
      body: raw || (body !== undefined ? JSON.stringify(body) : undefined)
    });
    let payload = {};
    try { payload = await response.json(); } catch (_) {}
    if (!response.ok) {
      const error = new Error(payload.error || `Request failed (${response.status}).`);
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  // ---- connections (secrets stay server-side) ----
  async listDestinations() { return (await this._request("destinations")).destinations || []; }
  async saveDestination({ destination, streamUrl, streamKey }) {
    return (await this._request("destinations", { method: "POST", body: { destination, streamUrl, streamKey } })).destination;
  }
  async removeDestination(destination) { await this._request(`destinations/${encodeURIComponent(destination)}/delete`, { method: "POST", body: {} }); }

  // ---- broadcasting ----
  async start({ destinations, stream, width = 1920, height = 1080, fps = 30, bitrateKbps = 6000 }) {
    if (this.broadcastId) throw new Error("A broadcast is already running.");
    const Rec = this.MediaRecorderImpl;
    const mimeType = pickMimeType(Rec);
    if (!Rec || !mimeType) throw new Error("This browser cannot encode a Program feed. Use current Chrome or Edge.");
    const started = await this._request("start", {
      method: "POST",
      body: {
        destinations, width, height, fps, bitrateKbps,
        sessionId: this.getSessionId() || null,
        organizationId: this.getOrganizationId() || null
      }
    });
    this.broadcastId = started.id;
    this.queue = []; this.seq = 0; this.stopping = false;
    this._emit(started.destinations);
    try {
      this.recorder = new Rec(stream, { mimeType, videoBitsPerSecond: 6_000_000, audioBitsPerSecond: 160_000 });
      this.recorder.addEventListener("dataavailable", (event) => { if (event.data?.size) this._enqueue(event.data); });
      this.recorder.addEventListener("error", () => this._failAll("The Program encoder in this browser stopped."));
      this.recorder.start(CHUNK_MS);
    } catch (error) {
      await this._abort(error.message);
      throw error;
    }
    return started;
  }

  _enqueue(blob) {
    if (!this.broadcastId || this.stopping) return;
    this.queue.push(blob);
    if (this.queue.length > MAX_QUEUED_CHUNKS) { this._failAll("Your connection to Toasty is too slow to keep the stream going."); return; }
    void this._pump();
  }

  async _pump() {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && this.broadcastId && !this.stopping) {
        const blob = this.queue.shift();
        const media = new Uint8Array(await blob.arrayBuffer());
        const seq = this.seq;
        // 4-byte big-endian sequence number, then the media bytes (see acceptStudioBroadcastChunk).
        const bytes = new Uint8Array(4 + media.length);
        new DataView(bytes.buffer).setUint32(0, seq);
        bytes.set(media, 4);
        let result = null; let lastError = null;
        for (let attempt = 0; attempt < CHUNK_RETRIES && !result; attempt += 1) {
          try {
            result = await this._request(`${this.broadcastId}/chunk`, { method: "POST", raw: bytes });
          } catch (error) {
            lastError = error;
            if (error.status === 404 || error.status === 410) break; // the broadcast is gone — retrying cannot help
            await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          }
        }
        if (!result) {
          if (!this.stopping) this._failAll(lastError?.payload?.destinations ? "The broadcast ended." : "Lost connection to the Toasty broadcast service.", lastError?.payload?.destinations);
          return;
        }
        this.seq = seq + 1;
        this._emit(result.destinations);
      }
    } finally {
      this.pumping = false;
    }
  }

  _failAll(message, serverDestinations) {
    const base = serverDestinations || this.destinations;
    this._emit(base.map((d) => (d.state === "live" || d.state === "connecting" ? { ...d, state: "error", error: message } : d)));
    void this._abort(message);
  }

  async _abort() {
    const id = this.broadcastId;
    this.stopping = true;
    this.broadcastId = null;
    try { if (this.recorder?.state && this.recorder.state !== "inactive") this.recorder.stop(); } catch (_) {}
    this.recorder = null;
    this.queue = [];
    if (id) { try { await this._request(`${id}/stop`, { method: "POST", body: {} }); } catch (_) {} }
  }

  async stop() {
    const had = Boolean(this.broadcastId);
    await this._abort();
    if (had) this._emit(this.destinations.map((d) => ({ ...d, state: d.state === "error" ? "error" : "stopped" })));
  }
}
