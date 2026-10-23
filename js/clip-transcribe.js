// Optional in-browser transcription with an open Whisper model (whisper-tiny.en via transformers.js). The first use downloads
// the library and a ~40 MB model from public CDNs and caches them in the browser; after that it runs on this computer's CPU.
// The recording itself is never uploaded: only the model files are downloaded. Segment-level timing, no speaker labels.
const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";
const MODEL = "Xenova/whisper-tiny.en";
let asrPromise = null;

export async function loadTranscriber(onStatus) {
  if (!asrPromise) {
    asrPromise = (async () => {
      onStatus?.("Downloading the open speech model (about 40 MB, once)…");
      const { pipeline } = await import(LIB);
      return pipeline("automatic-speech-recognition", MODEL, { progress_callback: (p) => { if (p.status === "progress" && p.total) onStatus?.(`Downloading the speech model… ${Math.round((p.loaded / p.total) * 100)}%`); } });
    })().catch((error) => { asrPromise = null; throw error; });
  }
  return asrPromise;
}

// pcm: Float32Array at 16 kHz. Returns timed lines [{ t, end, speaker: "", text }].
export async function transcribePcm(pcm, { onProgress, onStatus, windowSeconds = 30, signal } = {}) {
  const asr = await loadTranscriber(onStatus);
  const SR = 16000, step = windowSeconds * SR, lines = [];
  const windows = Math.max(1, Math.ceil(pcm.length / step));
  for (let w = 0; w < windows; w++) {
    if (signal?.aborted) throw new DOMException("Transcription cancelled", "AbortError");
    const slice = pcm.subarray(w * step, Math.min(pcm.length, (w + 1) * step + SR * 2));
    if (slice.length < SR * 0.5) break;
    const offset = w * windowSeconds;
    const r = await asr(slice, { return_timestamps: true, chunk_length_s: windowSeconds });
    for (const c of r.chunks || []) {
      const text = String(c.text || "").trim();
      if (!text || /^\[.*\]$|^\(.*\)$/.test(text)) continue;
      const a = offset + (c.timestamp?.[0] ?? 0), b = offset + (c.timestamp?.[1] ?? (c.timestamp?.[0] ?? 0) + 3);
      if (a >= (w + 1) * windowSeconds) continue;
      lines.push({ t: a, end: b, speaker: "", text });
    }
    onProgress?.((w + 1) / windows);
  }
  return lines;
}
