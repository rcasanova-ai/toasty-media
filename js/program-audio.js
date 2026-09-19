// Program Audio Bus — one produced audio truth for catalogue playback.
//
// Architecture (this slice):
//
//   Producer / Host PLAY_AUDIO
//     → ProgramController (deterministic action + production log)
//     → ProgramSync.audio { playId, assetId, src, startedAt, duration }
//     → Program Output (listener.js) ProgramAudioBus plays the SAME local catalogue file
//         ├→ AudioContext destination  = Toasty audience + tab-capture stream audio
//         └→ MediaStreamDestination    = captureStream() for future master recording
//
// Producer-local playback is a MONITOR of the same command. It is not Program Audio.
// `new Audio(file).play()` on the Producer machine is not the program path.
//
// Browser limit (temporary, not abandoned):
//   AudioContext cannot be shared across tabs. Director and Program Output each decode the same
//   catalogue file against the same playId/startedAt. Tab-capture of Program Output with tab audio
//   enabled is the current stream destination. Guest VDO headphones do not receive this mix yet.
//
// Next engineering steps (not this slice):
//   1. Master recording: MediaRecorder(program video captureStream + programAudio.captureStream()).
//      LocalIsolatedRecorder is still host-mic-only and cannot hear this bus.
//   2. Server-side program mix (FFmpeg/GStreamer): participant tracks + catalogue files from the
//      PLAY_AUDIO/STOP_AUDIO timeline, producing one Program Audio file for all destinations.
//   3. Inject that mix into guest IFB / VDO so participants hear soundboard too.

import { allowlistedCatalogueSrc } from "./program-asset.js";

const PLAY_AUDIO = "PLAY_AUDIO";
const STOP_AUDIO = "STOP_AUDIO";

let playSeq = 0;
export function nextPlayId() {
  playSeq += 1;
  return `play-${Date.now().toString(36)}-${playSeq.toString(36)}`;
}

export function serializeProgramAudio(command) {
  if (!command) return null;
  const src = allowlistedCatalogueSrc(command.src);
  if (command.action === PLAY_AUDIO && !src) return null;
  return {
    playId: command.playId || null,
    assetId: command.assetId || null,
    src,
    action: command.action === STOP_AUDIO ? STOP_AUDIO : PLAY_AUDIO,
    startedAt: command.startedAt || null,
    duration: Number(command.duration) || 0,
    initiator: command.initiator || "producer",
    volume: clampVolume(command.volume),
    displayName: command.displayName || "",
    category: command.category || ""
  };
}

export function buildPlayAudioCommand(item, { initiator = "producer", volume = 0.65, now = Date.now(), playId } = {}) {
  const src = allowlistedCatalogueSrc(item?.src);
  if (!item?.id || !src) return null;
  return {
    playId: playId || nextPlayId(),
    assetId: item.id,
    src,
    action: PLAY_AUDIO,
    startedAt: now,
    duration: Number(item.duration) || 0,
    initiator,
    volume: clampVolume(volume),
    displayName: item.displayName || item.id,
    category: item.category || ""
  };
}

export function buildStopAudioCommand(current, { initiator = "producer", now = Date.now() } = {}) {
  return {
    playId: current?.playId || null,
    assetId: current?.assetId || null,
    src: allowlistedCatalogueSrc(current?.src),
    action: STOP_AUDIO,
    startedAt: now,
    duration: Number(current?.duration) || 0,
    initiator,
    volume: clampVolume(current?.volume),
    displayName: current?.displayName || "",
    category: current?.category || ""
  };
}

function clampVolume(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.65;
  return Math.min(1, Math.max(0, n));
}

export class ProgramAudioBus {
  constructor({ role = "program", volume = 0.65 } = {}) {
    this.role = role;
    this.volume = clampVolume(volume);
    this.ctx = null;
    this.programGain = null;
    this.monitorGain = null;
    this.captureDest = null;
    this.current = null;
    this.buffers = new Map();
  }

  // Mix output for future master Program recording / non-tab-capture streams.
  // Not yet wired to LocalIsolatedRecorder (that recorder is still host-mic-only).
  captureStream() {
    this.ensure();
    return this.captureDest.stream;
  }

  setVolume(value) {
    this.volume = clampVolume(value);
    if (this.monitorGain) this.monitorGain.gain.value = this.volume;
  }

  async resume() {
    const ctx = this.ensure();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    return ctx;
  }

  ensure() {
    if (this.ctx) return this.ctx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error("audio-context-unavailable");
    this.ctx = new Ctx();
    this.programGain = this.ctx.createGain();
    this.programGain.gain.value = 1;
    this.monitorGain = this.ctx.createGain();
    this.monitorGain.gain.value = this.volume;
    this.captureDest = this.ctx.createMediaStreamDestination();
    // Program mix fans out to:
    //   destination     → audience speakers / Producer monitor / tab-capture audio
    //   captureDest     → future MediaRecorder master Program Audio
    this.programGain.connect(this.monitorGain);
    this.monitorGain.connect(this.ctx.destination);
    this.programGain.connect(this.captureDest);
    return this.ctx;
  }

  async applyCommand(command) {
    const serialized = serializeProgramAudio(command);
    if (!serialized) return { ok: false, reason: "invalid-command" };
    if (serialized.action === STOP_AUDIO) {
      this.stop();
      return { ok: true, action: STOP_AUDIO };
    }
    if (this.current?.playId === serialized.playId) return { ok: true, already: true, playId: serialized.playId };
    return this.play(serialized);
  }

  async play(command) {
    const src = allowlistedCatalogueSrc(command?.src);
    if (!src) return { ok: false, reason: "missing-media" };
    const ctx = this.ensure();
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    let buffer;
    try {
      buffer = await this.load(src);
    } catch (error) {
      return { ok: false, reason: "decode-failed", error: String(error?.message || error) };
    }
    this.stopInternal();
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    source.connect(gain).connect(this.programGain);
    const elapsed = Math.max(0, (Date.now() - (command.startedAt || Date.now())) / 1000);
    if (elapsed >= buffer.duration) return { ok: false, reason: "elapsed" };
    source.start(0, elapsed);
    const playId = command.playId || nextPlayId();
    this.current = { playId, assetId: command.assetId, src, source, startedAt: command.startedAt || Date.now() };
    source.onended = () => {
      if (this.current?.playId === playId) this.current = null;
    };
    return { ok: true, playId, duration: buffer.duration, src, role: this.role };
  }

  stop() {
    this.stopInternal();
    return { ok: true, action: STOP_AUDIO };
  }

  stopInternal() {
    const current = this.current;
    this.current = null;
    try { current?.source?.stop(); } catch (_) {}
    try { current?.source?.disconnect(); } catch (_) {}
  }

  async load(src) {
    if (this.buffers.has(src)) return this.buffers.get(src);
    const ctx = this.ensure();
    const response = await fetch(src, { cache: "force-cache" });
    if (!response.ok) throw new Error(`missing-file:${response.status}`);
    const bytes = await response.arrayBuffer();
    if (!bytes.byteLength) throw new Error("empty-file");
    const buffer = await ctx.decodeAudioData(bytes.slice(0));
    this.buffers.set(src, buffer);
    return buffer;
  }
}
