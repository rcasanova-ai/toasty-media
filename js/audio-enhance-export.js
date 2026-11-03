// Browser-side "Download enhanced audio". Decodes the recording locally, applies the optional enhancement chain
// (js/audio-enhance.js), and returns a 16-bit WAV. The recording itself is never modified or re-encoded; this makes a
// separate file. Nothing is uploaded. Decoding holds the whole programme in memory, so very long recordings are
// refused with a clear message and pointed at the streaming command-line tool instead of crashing the tab.
import { enhanceChannels } from "./audio-enhance.js";

export const ENHANCE_MAX_BYTES = 350 * 1024 * 1024;
export const ENHANCE_MAX_SECONDS = 45 * 60;

export function encodeWav16(channels, sampleRate) {
  const frames = channels[0].length, n = channels.length, bytes = frames * n * 2;
  const buffer = new ArrayBuffer(44 + bytes), view = new DataView(buffer);
  const text = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, 36 + bytes, true); text(8, "WAVE"); text(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, n, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * n * 2, true); view.setUint16(32, n * 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, bytes, true);
  let o = 44;
  for (let i = 0; i < frames; i++) for (let c = 0; c < n; c++) {
    const s = Math.max(-1, Math.min(1, channels[c][i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    o += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export async function enhanceRecordingBlob(blob, options = {}, { AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext, onProgress } = {}) {
  if (!AudioContextImpl) throw new Error("This browser cannot decode audio for enhancement.");
  if (blob.size > ENHANCE_MAX_BYTES) {
    const error = new Error("This recording is too large to enhance in the browser. Use the original file, or run scripts/audio-enhance.mjs on your computer.");
    error.code = "too-large";
    throw error;
  }
  onProgress?.("Reading the recording…");
  const bytes = await blob.arrayBuffer();
  const ctx = new AudioContextImpl();
  try {
    onProgress?.("Decoding audio…");
    const decoded = await ctx.decodeAudioData(bytes);
    if (decoded.duration > ENHANCE_MAX_SECONDS) {
      const error = new Error("This recording is too long to enhance in the browser. Use the original file, or run scripts/audio-enhance.mjs on your computer.");
      error.code = "too-long";
      throw error;
    }
    const channels = Array.from({ length: Math.min(decoded.numberOfChannels, 2) }, (_, c) => decoded.getChannelData(c).slice());
    onProgress?.("Enhancing…");
    // Yield so the status text can paint before the synchronous DSP runs.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = enhanceChannels(channels, decoded.sampleRate, options);
    return { blob: encodeWav16(result.channels, decoded.sampleRate), report: result.report, sampleRate: decoded.sampleRate, durationSec: decoded.duration };
  } finally {
    try { await ctx.close?.(); } catch (_) {}
  }
}
