const CUES = [
  { id: "intro", label: "Intro", notes: [261.63, 329.63, 392.0], duration: 0.62 },
  { id: "outro", label: "Outro", notes: [392.0, 329.63, 261.63], duration: 0.7 },
  { id: "stinger", label: "Stinger", notes: [523.25, 659.25], duration: 0.28 },
  { id: "applause", label: "Applause", noise: true, duration: 0.9 },
  { id: "custom", label: "Custom slot", notes: [220.0], duration: 0.45, placeholder: true }
];

export class Soundboard {
  constructor({ container, volumeInput }) {
    this.container = container;
    this.volumeInput = volumeInput;
    this.audioContext = null;
    this.volume = Number(volumeInput?.value || 0.65);
    this.render();
    this.volumeInput?.addEventListener("input", () => {
      this.volume = Number(this.volumeInput.value);
    });
  }

  render() {
    this.container.replaceChildren(
      ...CUES.map((cue) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = cue.label;
        button.dataset.cue = cue.id;
        button.addEventListener("click", () => this.play(cue));
        return button;
      })
    );
  }

  ensureContext() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }
    return this.audioContext;
  }

  play(cue) {
    const context = this.ensureContext();
    if (cue.noise) {
      this.playNoise(context, cue.duration);
      return;
    }

    cue.notes.forEach((frequency, index) => {
      const start = context.currentTime + index * 0.12;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = cue.placeholder ? "triangle" : "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(Math.max(this.volume, 0.001), start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + cue.duration);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + cue.duration + 0.05);
    });
  }

  playNoise(context, duration) {
    const sampleRate = context.sampleRate;
    const buffer = context.createBuffer(1, sampleRate * duration, sampleRate);
    const output = buffer.getChannelData(0);
    for (let i = 0; i < output.length; i += 1) {
      output[i] = (Math.random() * 2 - 1) * (1 - i / output.length);
    }
    const source = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    filter.type = "bandpass";
    filter.frequency.value = 1800;
    gain.gain.value = this.volume * 0.55;
    source.buffer = buffer;
    source.connect(filter).connect(gain).connect(context.destination);
    source.start();
  }
}
