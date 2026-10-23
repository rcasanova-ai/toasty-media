// Vocal analysis in a Web Worker when the browser allows it, otherwise on the main thread (yielding between blocks).
import { analyzeVocal } from "./vocal.js";

export async function analyzeVocalInWorker(pcm, sampleRate, { signal, onProgress, workerUrl = new URL("./vocal-worker.js", import.meta.url) } = {}) {
  if (typeof Worker === "undefined") return analyzeVocal(pcm, sampleRate, { signal, onProgress });
  let worker;
  try { worker = new Worker(workerUrl, { type: "module" }); } catch (_) { return analyzeVocal(pcm, sampleRate, { signal, onProgress }); }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; signal?.removeEventListener("abort", onAbort); worker.terminate(); fn(v); };
    const onAbort = () => { worker.postMessage({ type: "cancel" }); finish(reject, new DOMException("Analysis cancelled", "AbortError")); };
    signal?.addEventListener("abort", onAbort);
    worker.onmessage = (e) => { const m = e.data; if (m.type === "progress") onProgress?.(m.p); else if (m.type === "done") finish(resolve, m.result); else if (m.type === "error") finish(reject, m.name === "AbortError" ? new DOMException(m.message, "AbortError") : new Error(m.message)); };
    // If the worker cannot start (blocked, unsupported modules), fall back rather than failing the whole analysis.
    worker.onerror = () => { if (settled) return; settled = true; signal?.removeEventListener("abort", onAbort); worker.terminate(); analyzeVocal(pcm, sampleRate, { signal, onProgress }).then(resolve, reject); };
    const copy = pcm.slice(); // the caller keeps its samples (Whisper needs them)
    worker.postMessage({ type: "analyze", pcm: copy, sampleRate }, [copy.buffer]);
  });
}
