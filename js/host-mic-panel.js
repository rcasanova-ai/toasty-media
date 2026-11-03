// Host microphone setup inside the Studio: choose the microphone while joined (or recording), watch the input level,
// and see which processing the session is using. Switching goes through LiveSession.switchHostMicrophone, which keeps
// an active recording continuous and moves the published (VDO) microphone too.
import { classifyMicLevel, createMicMeter, readMicProcessing } from "./microphone-capture.js";

const PRESET_NOTES = {
  speakers: "Speakers: echo cancellation and noise suppression are on.",
  headphones: "Headphones: noise suppression is on, echo cancellation is off.",
  studio: "Studio mic: no processing.",
  custom: "Custom processing."
};

export class HostMicPanel {
  constructor({ session, root = document }) {
    this.session = session;
    this.button = root.querySelector("#lvTopMic");
    this.panel = root.querySelector("#lvMicPanel");
    this.select = root.querySelector("#lvLiveMicSelect");
    this.meterEl = root.querySelector("#lvMicPanel [data-mic-meter]");
    this.fill = root.querySelector("#lvMicPanel [data-mic-fill]");
    this.note = root.querySelector("#lvMicPanel [data-mic-note]");
    this.processing = root.querySelector("#lvMicProcessingNote");
    this.meter = null;
  }

  init() {
    if (!this.button || !this.panel) return;
    this.button.addEventListener("click", () => this.toggle());
    this.select?.addEventListener("change", () => this.switchTo(this.select.value));
    this.session.on?.("mic-device", () => { this.attachMeter(); this.refreshDevices(); });
    this.session.on?.("mic-lost", () => { if (!this.panel.hidden) this.refreshDevices(); });
    document.addEventListener("click", (event) => {
      if (!this.panel.hidden && !this.panel.contains(event.target) && event.target !== this.button) this.close();
    });
  }

  async toggle() {
    if (this.panel.hidden) await this.open(); else this.close();
  }

  async open() {
    this.panel.hidden = false;
    this.button.setAttribute("aria-expanded", "true");
    if (this.processing) this.processing.textContent = PRESET_NOTES[readMicProcessing().preset] || PRESET_NOTES.custom;
    await this.refreshDevices();
    this.attachMeter();
  }

  close() {
    this.panel.hidden = true;
    this.button.setAttribute("aria-expanded", "false");
    this.meter?.stop?.();
    this.meter = null;
  }

  async refreshDevices() {
    if (!this.select || !navigator.mediaDevices?.enumerateDevices) return;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
    const currentId = this.session._hostPreviewStream?.getAudioTracks?.()[0]?.getSettings?.().deviceId || "";
    this.select.replaceChildren(...devices.map((d, i) => {
      const option = document.createElement("option");
      option.value = d.deviceId;
      option.textContent = d.label || `Microphone ${i + 1}`;
      return option;
    }));
    if (currentId && devices.some((d) => d.deviceId === currentId)) this.select.value = currentId;
  }

  attachMeter() {
    this.meter?.stop?.();
    const stream = this.session._hostPreviewStream;
    if (!stream?.getAudioTracks?.().length) { if (this.note) this.note.textContent = "Join the Studio to monitor your microphone."; return; }
    this.meter = createMicMeter(stream, { label: "host-live-meter", intervalMs: 100, onSample: (sample) => this.render(sample) });
  }

  render(sample) {
    const peak = Number.isFinite(sample?.peakDbfs) ? sample.peakDbfs : -60;
    const level = classifyMicLevel(sample);
    if (this.fill) this.fill.style.width = `${Math.max(0, Math.min(100, ((peak + 60) / 60) * 100))}%`;
    if (this.meterEl) { this.meterEl.dataset.state = level.state; this.meterEl.setAttribute("aria-valuenow", String(Math.round(peak))); }
    if (this.note) this.note.textContent = level.message;
  }

  async switchTo(deviceId) {
    if (!deviceId) return;
    this.select.disabled = true;
    try {
      await this.session.switchHostMicrophone({ deviceId });
    } catch (error) {
      if (this.note) this.note.textContent = `Could not switch microphone: ${error?.message || error}`;
      await this.refreshDevices();
    } finally {
      this.select.disabled = false;
    }
  }
}
