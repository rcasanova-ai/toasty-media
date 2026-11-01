// Eloquence Protocol: opt-in local English neural voice previews.
// Model inference occurs on the listener's device. No speech text is posted to Toasty servers.
const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICES = Object.freeze([
  ["af_heart", "Heart", "American · feminine"],
  ["af_bella", "Bella", "American · feminine"],
  ["af_sarah", "Sarah", "American · feminine"],
  ["am_michael", "Michael", "American · masculine"],
  ["am_adam", "Adam", "American · masculine"],
  ["bf_emma", "Emma", "British · feminine"],
  ["bf_isabella", "Isabella", "British · feminine"],
  ["bm_george", "George", "British · masculine"],
  ["bm_lewis", "Lewis", "British · masculine"]
]);
const $ = id => document.getElementById(id);
let modelPromise = null, currentUrl = null, busy = false;
const notice = msg => { $("voiceStatus").textContent = msg; };
function releaseAudio() { $("voiceAudio").pause(); if (currentUrl) URL.revokeObjectURL(currentUrl); currentUrl = null; $("voiceAudio").removeAttribute("src"); $("voiceAudio").load(); }
async function loadModel() {
  if (modelPromise) return modelPromise;
  notice("Downloading voice model for local playback. First use can take several minutes.");
  modelPromise = (async () => {
    // Dynamic import defers the dependency and model download until the visitor explicitly opts in.
    const { KokoroTTS } = await import("https://esm.sh/kokoro-js@1.2.1");
    const adapter = await navigator.gpu?.requestAdapter?.().catch(() => null);
    if (adapter) {
      try { return await KokoroTTS.from_pretrained(MODEL, { dtype: "fp32", device: "webgpu" }); }
      catch (err) { console.warn("Kokoro WebGPU unavailable, falling back to WASM:", err); }
    }
    return KokoroTTS.from_pretrained(MODEL, { dtype: "q8", device: "wasm" });
  })().catch(e => { modelPromise = null; throw e; });
  return modelPromise;
}
function voiceOptions() {
  if (!$("voiceSelect").options.length) for (const [id, name, descriptor] of VOICES) {
    const option = document.createElement("option");
    option.value = id; option.textContent = name + " (" + descriptor + ")";
    $("voiceSelect").append(option);
  }
  try {
    const stored = localStorage.getItem("eloquence.voice");
    if (stored && VOICES.some(v => v[0] === stored)) $("voiceSelect").value = stored;
    $("voiceSpeed").value = localStorage.getItem("eloquence.speed") || "1";
  } catch (_) { /* blocked storage must not break voice controls */ }
}
async function speak() {
  if (busy) return;
  const text = $("voiceText").value.trim();
  if (!text || text.length > 350) { notice("Enter between 1 and 350 characters."); return; }
  const voice = $("voiceSelect").value;
  if (!VOICES.some(v => v[0] === voice)) { notice("Choose a supported voice."); return; }
  busy = true; $("voiceSpeak").disabled = true; releaseAudio();
  try {
    const tts = await loadModel();
    notice("Generating speech locally…");
    const audio = await tts.generate(text, { voice, speed: Number($("voiceSpeed").value) });
    const blob = await audio.toBlob();
    currentUrl = URL.createObjectURL(blob);
    $("voiceAudio").src = currentUrl;
    $("voiceAudio").hidden = false;
    try { localStorage.setItem("eloquence.voice", voice); localStorage.setItem("eloquence.speed", $("voiceSpeed").value); } catch (_) {}
    notice("Ready. Speech generated on this device.");
    await $("voiceAudio").play().catch(() => notice("Ready. Tap play to listen."));
  } catch (error) {
    console.error("Eloquence voice failed:", error);
    notice("Voice model could not load. Check your connection, available device memory and browser, then try again.");
  } finally { busy = false; $("voiceSpeak").disabled = false; }
}
voiceOptions();
$("voiceSpeak").addEventListener("click", speak);
$("voiceStop").addEventListener("click", () => { releaseAudio(); notice("Stopped."); });
window.addEventListener("pagehide", releaseAudio);
