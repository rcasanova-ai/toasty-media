// Chunk-safe recording transport.
//
// MediaRecorder timeslices are written to a durable queue (IndexedDB in the browser) BEFORE any network
// attempt and deleted only after the server acknowledges them. A dropped connection just means retries; a
// refresh or crash leaves the un-acked chunks in the queue for ChunkUploader.resumePending() to send, and
// everything the server already acknowledged is safe on its disk (scripts/render-production-server.mjs,
// "Chunk-safe recording store"). Nothing here holds a whole recording in memory.
//
// Chunks are addressed session / recording / participant / track / seq, so any future source (a guest's
// own camera, a screen share, a second or phone camera, an uploaded video) is "another track" — same
// register-track, enqueue and complete calls.

import { studioApiEndpoint } from "./studio-api.js";

export class RecordingApiError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = "RecordingApiError";
    this.status = status;
    this.retryable = retryable;
  }
}

function isRetryableStatus(status) {
  return status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
}

export class RecordingApiClient {
  constructor({ endpoint, fetchImpl } = {}) {
    this.endpoint = endpoint ?? (typeof window !== "undefined" ? studioApiEndpoint() : "");
    this.fetchImpl = fetchImpl || globalThis.fetch?.bind(globalThis);
  }

  async _request(path, { method = "GET", json, body, headers = {}, binary = false } = {}) {
    let response;
    try {
      response = await this.fetchImpl(`${this.endpoint}${path}`, {
        method,
        credentials: "include",
        headers: {
          ...(method !== "GET" ? { "X-Toasty-CSRF": "1" } : {}),
          ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
          ...headers
        },
        body: json !== undefined ? JSON.stringify(json) : body
      });
    } catch (error) {
      throw new RecordingApiError(error?.message || "Network error", { status: 0, retryable: true });
    }
    if (binary && response.ok) return response;
    let payload = {};
    try { payload = await response.json(); } catch { /* empty body */ }
    if (!response.ok) {
      throw new RecordingApiError(payload.error || `Recording request failed (${response.status}).`, {
        status: response.status,
        retryable: isRetryableStatus(response.status)
      });
    }
    return payload;
  }

  createRecording(payload) { return this._request("/api/recordings", { method: "POST", json: payload }); }
  registerTrack(sessionId, recordingId, track) { return this._request(`/api/recordings/${sessionId}/${recordingId}/tracks`, { method: "POST", json: { track } }); }
  getRecording(sessionId, recordingId) { return this._request(`/api/recordings/${sessionId}/${recordingId}`); }
  listRecordings(sessionId = "") { return this._request(`/api/recordings${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`); }
  complete(sessionId, recordingId, payload = {}) { return this._request(`/api/recordings/${sessionId}/${recordingId}/complete`, { method: "POST", json: payload }); }

  uploadChunk({ sessionId, recordingId, participantId, trackId, seq, blob, sha256 = "" }) {
    const padded = String(seq).padStart(8, "0");
    const query = sha256 ? `?sha256=${sha256}` : "";
    return this._request(`/api/recordings/${sessionId}/${recordingId}/chunks/${participantId}/${trackId}/${padded}${query}`, {
      method: "POST",
      body: blob,
      headers: { "Content-Type": "application/octet-stream" }
    });
  }

  async downloadTrack(sessionId, recordingId, participantId, trackId, { kind = "final" } = {}) {
    const response = await this._request(
      `/api/recordings/${sessionId}/${recordingId}/files/${participantId}/${trackId}${kind === "source" ? "?kind=source" : ""}`,
      { binary: true }
    );
    return response.blob();
  }
}

// --- Durable queue stores -------------------------------------------------------------------------------

export class MemoryChunkStore {
  constructor() { this.map = new Map(); }
  async put(record) { this.map.set(record.key, record); }
  async delete(key) { this.map.delete(key); }
  async list(recordingId) { return [...this.map.values()].filter((r) => r.recordingId === recordingId).sort((a, b) => a.queuedAt - b.queuedAt); }
  async listRecordings() { return [...new Set([...this.map.values()].map((r) => r.recordingId))]; }
  get size() { return this.map.size; }
}

const IDB_NAME = "toasty-recording-queue";
const IDB_STORE = "chunks";

export class IdbChunkStore {
  constructor({ indexedDBImpl = globalThis.indexedDB } = {}) {
    this.indexedDB = indexedDBImpl;
    this._dbPromise = null;
  }

  static isSupported() { return typeof globalThis.indexedDB !== "undefined"; }

  _db() {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(IDB_NAME, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(IDB_STORE, { keyPath: "key" });
          store.createIndex("recordingId", "recordingId", { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return this._dbPromise;
  }

  async _tx(mode, fn) {
    const db = await this._db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, mode);
      const store = tx.objectStore(IDB_STORE);
      let result;
      try { result = fn(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result?.result ?? result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
    });
  }

  put(record) { return this._tx("readwrite", (store) => store.put(record)); }
  delete(key) { return this._tx("readwrite", (store) => store.delete(key)); }
  async list(recordingId) {
    const rows = await this._tx("readonly", (store) => store.index("recordingId").getAll(recordingId));
    return (rows || []).sort((a, b) => a.queuedAt - b.queuedAt);
  }
  async listRecordings() {
    const rows = await this._tx("readonly", (store) => store.getAll());
    return [...new Set((rows || []).map((r) => r.recordingId))];
  }
}

export function createDefaultChunkStore() {
  return IdbChunkStore.isSupported() ? new IdbChunkStore() : new MemoryChunkStore();
}

// --- Uploader ---------------------------------------------------------------------------------------------

export async function sha256Hex(blob, cryptoImpl = globalThis.crypto) {
  if (!cryptoImpl?.subtle) return "";
  const digest = await cryptoImpl.subtle.digest("SHA-256", await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function chunkKey({ recordingId, participantId, trackId, seq }) {
  return `${recordingId}/${participantId}/${trackId}/${String(seq).padStart(8, "0")}`;
}

export class ChunkUploader {
  constructor({
    api,
    store,
    sessionId,
    recordingId,
    maxConcurrent = 3,
    retryBaseMs = 800,
    retryMaxMs = 15000,
    checksum = true,
    onState,
    setTimeoutImpl,
    clearTimeoutImpl,
    cryptoImpl
  } = {}) {
    this.api = api;
    this.store = store;
    this.sessionId = sessionId;
    this.recordingId = recordingId;
    this.maxConcurrent = maxConcurrent;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.checksum = checksum;
    this.onState = onState;
    this.setTimeoutImpl = setTimeoutImpl || globalThis.setTimeout.bind(globalThis);
    this.clearTimeoutImpl = clearTimeoutImpl || globalThis.clearTimeout.bind(globalThis);
    this.cryptoImpl = cryptoImpl;
    this.pending = new Map(); // key -> { record, attempts, inflight, nextAt }
    this.waiters = [];
    this.uploadedChunks = 0;
    this.uploadedBytes = 0;
    this.failed = []; // permanent failures: { key, error }
    this.lastError = "";
    this.timer = null;
    this.closed = false;
  }

  stats() {
    let inflight = 0;
    let queuedBytes = 0;
    for (const entry of this.pending.values()) {
      if (entry.inflight) inflight += 1;
      queuedBytes += entry.record.blob.size;
    }
    return {
      queued: this.pending.size,
      inflight,
      queuedBytes,
      uploadedChunks: this.uploadedChunks,
      uploadedBytes: this.uploadedBytes,
      failed: this.failed.length,
      lastError: this.lastError,
      online: !this.lastError
    };
  }

  _emit() { this.onState?.(this.stats()); }

  // Persist first, upload second: once enqueue() resolves the chunk survives a crash.
  async enqueue({ participantId, trackId, seq, blob }) {
    const record = {
      key: chunkKey({ recordingId: this.recordingId, participantId, trackId, seq }),
      sessionId: this.sessionId,
      recordingId: this.recordingId,
      participantId,
      trackId,
      seq,
      blob,
      queuedAt: Date.now()
    };
    await this.store.put(record);
    this._track(record);
    this._pump();
    this._emit();
  }

  // After a refresh/crash: pick up whatever the previous page left un-acked.
  async resumePending() {
    const rows = await this.store.list(this.recordingId);
    for (const record of rows) this._track(record);
    this._pump();
    this._emit();
    return rows.length;
  }

  _track(record) {
    if (!this.pending.has(record.key)) this.pending.set(record.key, { record, attempts: 0, inflight: false, nextAt: 0 });
  }

  _pump() {
    if (this.closed) return;
    const now = Date.now();
    let inflight = [...this.pending.values()].filter((e) => e.inflight).length;
    let soonest = Infinity;
    for (const entry of this.pending.values()) {
      if (inflight >= this.maxConcurrent) break;
      if (entry.inflight) continue;
      if (entry.nextAt > now) { soonest = Math.min(soonest, entry.nextAt); continue; }
      entry.inflight = true;
      inflight += 1;
      void this._send(entry);
    }
    if (soonest !== Infinity && !this.timer) {
      this.timer = this.setTimeoutImpl(() => { this.timer = null; this._pump(); }, Math.max(0, soonest - now));
    }
  }

  async _send(entry) {
    const { record } = entry;
    try {
      const sha256 = this.checksum ? await sha256Hex(record.blob, this.cryptoImpl) : "";
      await this.api.uploadChunk({
        sessionId: record.sessionId,
        recordingId: record.recordingId,
        participantId: record.participantId,
        trackId: record.trackId,
        seq: record.seq,
        blob: record.blob,
        sha256
      });
      await this.store.delete(record.key);
      this.pending.delete(record.key);
      this.uploadedChunks += 1;
      this.uploadedBytes += record.blob.size;
      this.lastError = "";
    } catch (error) {
      entry.inflight = false;
      if (error?.retryable === false && error?.status !== 409) {
        // Permanent rejection (revoked session, plan cap, unknown track): retrying can never succeed.
        this.pending.delete(record.key);
        this.failed.push({ key: record.key, error: error.message, status: error.status });
        this.lastError = error.message;
      } else if (error?.status === 409) {
        // Same seq already stored (server dedupes identical bytes with a 200; a 409 means this key is
        // already settled or the recording closed). Not retryable either way.
        await this.store.delete(record.key).catch(() => {});
        this.pending.delete(record.key);
        this.failed.push({ key: record.key, error: error.message, status: 409 });
      } else {
        entry.attempts += 1;
        entry.nextAt = Date.now() + Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.min(entry.attempts, 8));
        this.lastError = error?.message || "Upload failed";
      }
    }
    this._emit();
    this._settleWaiters();
    this._pump();
  }

  _settleWaiters() {
    if (this.pending.size) return;
    const waiters = this.waiters.splice(0);
    for (const resolve of waiters) resolve({ ok: this.failed.length === 0, failed: [...this.failed] });
  }

  // Resolves once every queued chunk has been acknowledged (or permanently rejected). Rejects on timeout
  // with the chunks still queued — they remain in the durable store for the next resume.
  flush({ timeoutMs = 120000 } = {}) {
    if (!this.pending.size) return Promise.resolve({ ok: this.failed.length === 0, failed: [...this.failed] });
    this._pump();
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = this.setTimeoutImpl(() => {
        if (settled) return;
        settled = true;
        this.waiters = this.waiters.filter((w) => w !== wrapped);
        reject(Object.assign(new Error(`${this.pending.size} chunk(s) are still waiting to upload.`), { code: "flush-timeout", pending: this.pending.size }));
      }, timeoutMs);
      const wrapped = (result) => {
        if (settled) return;
        settled = true;
        this.clearTimeoutImpl(timeout);
        resolve(result);
      };
      this.waiters.push(wrapped);
    });
  }

  close() {
    this.closed = true;
    if (this.timer) this.clearTimeoutImpl(this.timer);
    this.timer = null;
  }
}

// --- Interrupted-recording pointer -----------------------------------------------------------------------
// A tiny localStorage breadcrumb so a refreshed page knows which recording to finish. The chunks
// themselves live in the durable store and on the server; this only says "recording X was in progress".

const ACTIVE_KEY = "toastyActiveRecording";

export function rememberActiveRecording(pointer, storage = globalThis.localStorage) {
  try { storage?.setItem(ACTIVE_KEY, JSON.stringify(pointer)); } catch { /* storage unavailable */ }
}

export function recallActiveRecording(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(ACTIVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

export function clearActiveRecording(storage = globalThis.localStorage) {
  try { storage?.removeItem(ACTIVE_KEY); } catch { /* storage unavailable */ }
}

// Finish a recording whose page died: send whatever chunks were still queued, then ask the server to
// finalize from what it has. Safe to call when nothing is pending.
export async function recoverInterruptedRecording({ api, store, storage = globalThis.localStorage, flushTimeoutMs = 60000, ...uploaderOptions } = {}) {
  const pointer = recallActiveRecording(storage);
  if (!pointer?.recordingId || !pointer?.sessionId) return null;
  const uploader = new ChunkUploader({ api, store, sessionId: pointer.sessionId, recordingId: pointer.recordingId, ...uploaderOptions });
  await uploader.resumePending();
  let flushed;
  try {
    flushed = await uploader.flush({ timeoutMs: flushTimeoutMs });
  } catch (error) {
    uploader.close();
    return { recovered: false, pending: error.pending ?? uploader.pending.size, pointer, error: error.message };
  }
  uploader.close();
  const completed = await api.complete(pointer.sessionId, pointer.recordingId, { stoppedAt: pointer.lastActivityAt || Date.now() });
  clearActiveRecording(storage);
  return { recovered: true, pointer, flushed, recording: completed.recording };
}
