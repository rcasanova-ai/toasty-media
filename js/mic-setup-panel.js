// Pre-join microphone setup: processing preset (speakers / headphones / raw studio) and a live input-level
// monitor with a clipping warning. Shared by the Host pre-join card and the Guest check-in so both sides choose
// the same way and the choice is applied to the voice that is actually published (see vdoMicProcessingParams).
import {
  MIC_PROCESSING_PRESETS,
  classifyMicLevel,
  createMicMeter,
  readMicProcessing,
  writeMicProcessing
} from "./microphone-capture.js";

const PRESET_LABELS = {
  speakers: "Speakers: echo cancellation + noise suppression",
  headphones: "Headphones: noise suppression only",
  studio: "Studio mic: no processing"
};

const STATE_WORDS = { silent: "No signal", quiet: "Quiet", good: "Good level", hot: "Loud", clipping: "Clipping" };

// One compact line (label, level meter, state word) that stays visible; the processing preset and the longer advice sit
// behind the disclosure so the pre-join card does not grow and push the Join button off small screens.
export function mountMicSetup(container, { onProcessingChange } = {}) {
  if (!container) return { attachStream() {}, stop() {} };
  const options = Object.keys(MIC_PROCESSING_PRESETS)
    .map((name) => `<option value="${name}">${PRESET_LABELS[name]}</option>`).join("");
  container.classList.add("mic-setup");
  container.innerHTML = `
    <details class="mic-setup-details">
      <summary>
        <span class="mic-setup-title">Mic level ▾</span>
        <span class="mic-level" role="meter" aria-label="Microphone input level" aria-valuemin="-60" aria-valuemax="0" data-mic-meter><span class="mic-level-fill" data-mic-fill></span></span>
        <span class="mic-setup-state" data-mic-state aria-live="polite">Checking…</span>
      </summary>
      <label><span>Audio setup</span><select data-mic-preset>${options}</select></label>
      <p class="control-note" data-mic-note>Waiting for the microphone…</p>
    </details>`;
  const details = container.querySelector(".mic-setup-details");
  const select = container.querySelector("[data-mic-preset]");
  const meterEl = container.querySelector("[data-mic-meter]");
  const fill = container.querySelector("[data-mic-fill]");
  const note = container.querySelector("[data-mic-note]");
  const stateWord = container.querySelector("[data-mic-state]");
  const current = readMicProcessing();
  select.value = MIC_PROCESSING_PRESETS[current.preset] ? current.preset : "speakers";
  select.addEventListener("change", () => {
    const next = writeMicProcessing(select.value);
    onProcessingChange?.(next);
  });

  let meter = null;
  const render = (sample) => {
    const peak = Number.isFinite(sample?.peakDbfs) ? sample.peakDbfs : -60;
    const pct = Math.max(0, Math.min(100, ((peak + 60) / 60) * 100));
    const level = classifyMicLevel(sample);
    fill.style.width = `${pct}%`;
    meterEl.dataset.state = level.state;
    meterEl.setAttribute("aria-valuenow", String(Math.round(peak)));
    stateWord.textContent = STATE_WORDS[level.state] || level.state;
    stateWord.dataset.state = level.state;
    note.textContent = level.message;
  };
  return {
    attachStream(stream) {
      meter?.stop?.();
      meter = createMicMeter(stream, { label: "setup-meter", intervalMs: 100, onSample: render });
      if (!meter.supported) { stateWord.textContent = "Unavailable"; note.textContent = "Level monitor is not available in this browser."; }
    },
    stop() { meter?.stop?.(); meter = null; },
    open() { details.open = true; }
  };
}
