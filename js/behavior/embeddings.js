// Semantic embedder. The first choice is an open sentence-embedding model (all-MiniLM-L6-v2, quantized, about 23 MB) run
// locally through transformers.js, lazily loaded and cached by the browser. If it cannot load (offline, blocked, unsupported)
// the engine falls back to a lexical embedder and SAYS SO: the result carries semantic.kind = "lexical" and a note.
import { lexicalEmbedder } from "./text.js";

export const LIB = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";
export const MODEL = "Xenova/all-MiniLM-L6-v2";
let modelPromise = null;

async function loadModel(onStatus, importer) {
  if (!modelPromise) {
    modelPromise = (async () => {
      onStatus?.("Loading the language model (about 23 MB, once)…");
      const lib = await (importer ? importer(LIB) : import(/* @vite-ignore */ LIB));
      return lib.pipeline("feature-extraction", MODEL, {
        dtype: "q8",
        progress_callback: (p) => { if (p.status === "progress" && p.total) onStatus?.(`Downloading the language model… ${Math.round((p.loaded / p.total) * 100)}%`); }
      });
    })().catch((error) => { modelPromise = null; throw error; });
  }
  return modelPromise;
}
export function resetModelCache() { modelPromise = null; }

// Returns { kind: "minilm" | "lexical", note, embed(texts, {signal, onProgress}) }.
// options.loader: test hook returning a function (texts) => Float32Array[]; options.disableModel: skip the download.
export async function createEmbedder(corpus, { onStatus, signal, loader, disableModel = false, importer } = {}) {
  if (!disableModel) {
    try {
      const extractor = loader ? await loader() : await loadModel(onStatus, importer);
      return {
        kind: "minilm",
        note: "",
        async embed(texts, { onProgress } = {}) {
          const out = [], batch = 16;
          for (let i = 0; i < texts.length; i += batch) {
            if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
            const part = texts.slice(i, i + batch);
            if (loader) out.push(...await extractor(part));
            else {
              const r = await extractor(part, { pooling: "mean", normalize: true });
              const dim = r.dims[1];
              for (let k = 0; k < part.length; k++) out.push(Float32Array.from(r.data.subarray(k * dim, (k + 1) * dim)));
            }
            onProgress?.(Math.min(1, (i + batch) / texts.length));
            await new Promise((r2) => setTimeout(r2, 0));
          }
          return out;
        }
      };
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      const fallback = lexicalEmbedder(corpus);
      return { ...fallback, note: `The language model could not be loaded (${String(error?.message || error).slice(0, 120)}), so topic changes were found from shared vocabulary only and meaning-level matching was skipped.` };
    }
  }
  return { ...lexicalEmbedder(corpus), note: "Language model not used: topic changes come from shared vocabulary only." };
}
