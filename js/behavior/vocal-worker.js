// Runs vocal analysis off the main thread so a long recording never freezes the page.
import { analyzeVocal } from "./vocal.js";
let controller = null;
self.onmessage = async (e) => {
  const { type, pcm, sampleRate } = e.data || {};
  if (type === "cancel") { controller?.abort(); return; }
  if (type !== "analyze") return;
  controller = new AbortController();
  try {
    const r = await analyzeVocal(pcm, sampleRate, { signal: controller.signal, onProgress: (p) => self.postMessage({ type: "progress", p }) });
    const { db, f0, active } = r.series;
    self.postMessage({ type: "done", result: { ...r, series: { hop: r.series.hop, db, f0, active } } }, [db.buffer, f0.buffer, active.buffer]);
  } catch (error) { self.postMessage({ type: "error", name: error?.name, message: String(error?.message || error) }); }
};
