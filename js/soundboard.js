// Producer Soundboard — tactile triggers into Program Audio.
//
// Pads play real catalogue files through ProgramController PLAY_AUDIO / STOP_AUDIO.
// Local monitor playback is a side effect of that command. There is no WebAudio oscillator
// fallback, no procedural crowd, no MIDI approximation.

import { AssetCategory } from "./asset-catalogue.js";
import { ProductionActionType } from "./production-controller.js";

const TABS = [
  ["all", "All"],
  [AssetCategory.SOUND_EFFECT, "Effects"],
  [AssetCategory.STINGER, "Stingers"],
  [AssetCategory.MUSIC, "Music"]
].map(([id, label]) => ({ id, label }));

let activeSoundboard = null;

function normalize(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function resolveSoundCommand(text, items = []) {
  const input = normalize(text);
  if (!input) return null;
  const commandLike = /\b(play|give me|hit me with|hit the|drop|cue|sound|trigger|run|hottie|stop)\b/.test(input);
  if (!commandLike) return null;
  if (/\bstop\b/.test(input) && /\b(sound|audio|music|sting)/.test(input)) {
    return { id: "__stop__", displayName: "Stop", action: ProductionActionType.STOP_AUDIO };
  }
  const ranked = items
    .flatMap((item) => [item.displayName, item.id, ...(item.aliases || [])].map((alias) => ({ item, alias: normalize(alias) })))
    .filter((row) => row.alias && input.includes(row.alias))
    .sort((a, b) => b.alias.length - a.alias.length);
  return ranked[0]?.item || null;
}

export function triggerSoundFromInstruction(text, session) {
  const items = session?.catalogue?.soundboardItems?.() || activeSoundboard?.items || [];
  const cue = resolveSoundCommand(text, items);
  if (!cue) return null;
  const controller = session?.programController || activeSoundboard?.session?.programController;
  if (!controller) return null;
  if (cue.action === ProductionActionType.STOP_AUDIO || cue.id === "__stop__") {
    return { ...controller.stopAudio({ initiator: "host" }), cue };
  }
  const result = controller.execute({
    type: ProductionActionType.PLAY_AUDIO,
    assetId: cue.id,
    initiator: "host"
  });
  if (result.ok) activeSoundboard?.flash(cue.id, cue.duration);
  return { ...result, cue };
}

export class Soundboard {
  constructor({ container, volumeInput, tabsContainer, searchInput, session, stopButton } = {}) {
    this.container = container;
    this.volumeInput = volumeInput;
    this.tabsContainer = tabsContainer;
    this.searchInput = searchInput;
    this.stopButton = stopButton;
    this.session = session || null;
    this.volume = Number(volumeInput?.value || 0.65);
    this.activeTab = "all";
    this.query = "";
    this.items = [];
    this.error = "";
    activeSoundboard = this;
    this.volumeInput?.addEventListener("input", () => {
      this.volume = Number(this.volumeInput.value);
      this.session?.programAudio?.setVolume(this.volume);
    });
    this.searchInput?.addEventListener("input", () => {
      this.query = normalize(this.searchInput.value);
      this.render();
    });
    this.stopButton?.addEventListener("click", () => this.stop());
    this.session?.on?.("program-audio", () => this.render());
    this.session?.on?.("catalogue", () => {
      this.syncFromSession();
      this.error = "";
      this.renderTabs();
      this.render();
    });
    this.session?.on?.("catalogue-error", () => {
      this.error = "Asset Catalogue failed to load.";
      this.render();
    });
    this.syncFromSession();
    this.renderTabs();
    this.render();
  }

  syncFromSession() {
    this.items = this.session?.catalogue?.soundboardItems?.() || [];
    if (this.session?.programAudio) this.session.programAudio.setVolume(this.volume);
  }

  renderTabs() {
    if (!this.tabsContainer) return;
    const counts = Object.fromEntries(TABS.map((tab) => [tab.id, tab.id === "all" ? this.items.length : this.items.filter((item) => item.category === tab.id).length]));
    this.tabsContainer.replaceChildren(...TABS.filter((tab) => tab.id === "all" || counts[tab.id] > 0).map((tab) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = tab.label;
      button.dataset.tab = tab.id;
      button.setAttribute("aria-pressed", String(tab.id === this.activeTab));
      button.addEventListener("click", () => {
        this.activeTab = tab.id;
        this.tabsContainer.querySelectorAll("button").forEach((other) => other.setAttribute("aria-pressed", String(other.dataset.tab === tab.id)));
        this.render();
      });
      return button;
    }));
  }

  visibleItems() {
    return this.items.filter((item) => {
      const tab = this.activeTab === "all" || item.category === this.activeTab;
      const hay = normalize([item.displayName, item.id, ...(item.aliases || [])].join(" "));
      return tab && (!this.query || hay.includes(this.query));
    });
  }

  currentAudio() {
    return this.session?.program?.audio || null;
  }

  render() {
    if (!this.container) return;
    const current = this.currentAudio();
    const playingId = current?.action === "PLAY_AUDIO" ? current.assetId : null;
    if (this.stopButton) this.stopButton.disabled = !playingId;
    const items = this.visibleItems();
    if (this.error) {
      const empty = document.createElement("p");
      empty.className = "soundboard-empty";
      empty.textContent = this.error;
      this.container.replaceChildren(empty);
      return;
    }
    if (!items.length) {
      const empty = document.createElement("p");
      empty.className = "soundboard-empty";
      empty.textContent = this.items.length ? "No matching sounds." : "Loading catalogue…";
      this.container.replaceChildren(empty);
      return;
    }
    this.container.replaceChildren(...items.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sound-tile";
      button.dataset.cue = item.id;
      button.dataset.category = item.category;
      button.title = item.displayName;
      if (playingId === item.id) button.classList.add("is-playing", "is-active");
      const play = document.createElement("span");
      play.className = "sound-play";
      play.setAttribute("aria-hidden", "true");
      play.textContent = playingId === item.id ? "■" : (item.icon || "▶");
      const wave = document.createElement("span");
      wave.className = "sound-wave";
      wave.setAttribute("aria-hidden", "true");
      wave.innerHTML = `<svg viewBox="0 0 100 30" preserveAspectRatio="none"><path d="${organicWavePath(item.id)}"></path></svg>`;
      const playhead = document.createElement("span");
      playhead.className = "sound-playhead";
      wave.appendChild(playhead);
      const meta = document.createElement("span");
      meta.className = "sound-meta";
      const label = document.createElement("span");
      label.className = "sound-label";
      label.textContent = item.displayName;
      const duration = document.createElement("span");
      duration.className = "sound-duration";
      duration.textContent = `${Number(item.duration || 0).toFixed(1)}s`;
      meta.append(label, duration);
      button.append(play, wave, meta);
      button.style.setProperty("--dur", `${Number(item.duration || 0.5)}s`);
      button.addEventListener("click", () => {
        if (playingId === item.id) this.stop();
        else this.play(item);
      });
      return button;
    }));
  }

  flash(id, duration = 1) {
    const button = this.container?.querySelector(`[data-cue="${CSS.escape(id)}"]`);
    if (!button) return;
    button.style.setProperty("--dur", `${duration}s`);
    button.classList.add("is-active");
  }

  play(item) {
    const controller = this.session?.programController;
    if (!controller || !item?.id) {
      this.error = "Program Audio is not connected.";
      this.render();
      return { ok: false, reason: "no-controller" };
    }
    const result = controller.execute({
      type: ProductionActionType.PLAY_AUDIO,
      assetId: item.id,
      initiator: "producer",
      volume: this.volume
    });
    if (!result.ok) {
      this.error = result.reason === "missing-media" || result.reason === "missing-asset"
        ? `Missing audio file for ${item.displayName}.`
        : `Could not play ${item.displayName}.`;
    } else {
      this.error = "";
    }
    this.render();
    return result;
  }

  stop() {
    const result = this.session?.programController?.stopAudio({ initiator: "producer" }) || { ok: false };
    this.render();
    return result;
  }
}

function organicWavePath(seed) {
  const segments = 16, viewW = 100, viewH = 30, mid = viewH / 2;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  const amplitudeAt = (i) => {
    const x = Math.sin((hash + i * 97) * 12.9898) * 43758.5453;
    const rand = x - Math.floor(x);
    const envelope = Math.sin((Math.PI * i) / segments) * 0.7 + 0.3;
    return (0.2 + rand * 0.8) * envelope;
  };
  const stepX = viewW / segments, top = [], bottom = [];
  for (let i = 0; i <= segments; i++) {
    const a = amplitudeAt(i), x = (i * stepX).toFixed(1);
    top.push(`${x} ${(mid - a * (mid - 1.5)).toFixed(1)}`);
    bottom.unshift(`${x} ${(mid + a * (mid - 1.5)).toFixed(1)}`);
  }
  return `M ${top.join(" L ")} L ${bottom.join(" L ")} Z`;
}
