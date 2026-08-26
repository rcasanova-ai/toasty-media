const CUES = [
  { id: "intro", label: "Intro", notes: [261.63, 329.63, 392.0], duration: 0.62, category: "popular" },
  { id: "outro", label: "Outro", notes: [392.0, 329.63, 261.63], duration: 0.7, category: "popular" },
  { id: "stinger", label: "Stinger", notes: [523.25, 659.25], duration: 0.28, category: "trending" },
  { id: "applause", label: "Applause", noise: true, duration: 0.9, category: "trending" },
  { id: "custom", label: "Custom slot", notes: [220.0], duration: 0.45, placeholder: true, category: "custom" }
];

const TABS = [
  { id: "all", label: "All" },
  { id: "popular", label: "Popular" },
  { id: "trending", label: "Trending" },
  { id: "categories", label: "Categories" },
  { id: "regional", label: "Regional" },
  { id: "custom", label: "Custom" }
];

export class Soundboard {
  constructor({ container, volumeInput, tabsContainer, searchInput }) {
    this.container = container;
    this.volumeInput = volumeInput;
    this.tabsContainer = tabsContainer;
    this.searchInput = searchInput;
    this.audioContext = null;
    this.volume = Number(volumeInput?.value || 0.65);
    this.activeTab = "all";
    this.query = "";

    this.renderTabs();
    this.render();

    this.volumeInput?.addEventListener("input", () => {
      this.volume = Number(this.volumeInput.value);
    });
    this.searchInput?.addEventListener("input", () => {
      this.query = this.searchInput.value.trim().toLowerCase();
      this.render();
    });
  }

  renderTabs() {
    if (!this.tabsContainer) return;
    this.tabsContainer.replaceChildren(
      ...TABS.map((tab) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = tab.label;
        button.dataset.tab = tab.id;
        button.setAttribute("aria-pressed", String(tab.id === this.activeTab));
        button.addEventListener("click", () => {
          this.activeTab = tab.id;
          this.tabsContainer.querySelectorAll("button").forEach((other) => {
            other.setAttribute("aria-pressed", String(other.dataset.tab === tab.id));
          });
          this.render();
        });
        return button;
      })
    );
  }

  visibleCues() {
    return CUES.filter((cue) => {
      const matchesTab = this.activeTab === "all" || cue.category === this.activeTab;
      const matchesQuery = !this.query || cue.label.toLowerCase().includes(this.query);
      return matchesTab && matchesQuery;
    });
  }

  render() {
    const cues = this.visibleCues();
    if (!cues.length) {
      const empty = document.createElement("p");
      empty.className = "soundboard-empty";
      empty.textContent = "No sounds yet in this category.";
      this.container.replaceChildren(empty);
      return;
    }

    this.container.replaceChildren(
      ...cues.map((cue) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sound-tile";
        button.dataset.cue = cue.id;
        button.dataset.category = cue.category;

        const play = document.createElement("span");
        play.className = "sound-play";
        play.setAttribute("aria-hidden", "true");
        play.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"></polygon></svg>';

        const wave = document.createElement("span");
        wave.className = "sound-wave";
        wave.setAttribute("aria-hidden", "true");
        barHeights(cue.id).forEach((height) => {
          const bar = document.createElement("span");
          bar.style.height = `${height}%`;
          wave.appendChild(bar);
        });

        const meta = document.createElement("span");
        meta.className = "sound-meta";
        const label = document.createElement("span");
        label.className = "sound-label";
        label.textContent = cue.label;
        const duration = document.createElement("span");
        duration.className = "sound-duration";
        duration.textContent = `${cue.duration.toFixed(1)}s`;
        meta.append(label, duration);

        button.append(play, wave, meta);
        button.addEventListener("click", () => {
          this.play(cue);
          button.classList.add("is-active");
          window.setTimeout(() => button.classList.remove("is-active"), Math.max(cue.duration * 1000, 220));
        });
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

function barHeights(seed) {
  const bars = 14;
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  const heights = [];
  for (let i = 0; i < bars; i += 1) {
    heights.push(20 + ((hash >> i % 24) & 0xff) % 70);
  }
  return heights;
}
