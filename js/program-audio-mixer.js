// Program Audio Mixer — ONE produced audio truth.
//
//   Participant audio tracks (first-party MediaStreams this page owns)
//     + ProgramAudioBus catalogue/soundboard
//     + future Hottie / media assets
//        → ProgramAudioMixer
//        → Program Master Audio (MediaStream)
//        → Program Output speakers
//        → Master Recording
//        → ProgramDestination sinks
//
// VDO.Ninja remote iframe audio is CROSS-ORIGIN. Parent JS cannot tap those tracks.
// Those voices reach Program Output via the iframe's own autoplay into the tab, not this mixer.
// Do not pretend a first-party mix contains Guest speech unless a MediaStream was actually connected.

import { ProgramAudioBus, serializeProgramAudio } from "./program-audio.js";

export const ProgramAudioSourceKind = Object.freeze({
  PARTICIPANT: "participant",
  BUS: "bus",
  ASSET: "asset",
  HOTTIE: "hottie",
  MEDIA: "media"
});

export function createProgramAudioSource({
  id,
  kind = ProgramAudioSourceKind.PARTICIPANT,
  participantId = null,
  stream = null,
  label = "",
  transportLimited = false,
  reason = ""
} = {}) {
  return {
    id: id || participantId || kind,
    kind,
    participantId,
    stream: stream || null,
    label: label || "",
    connected: Boolean(stream),
    transportLimited: Boolean(transportLimited),
    reason: reason || (stream ? "" : (transportLimited ? "vdo-cross-origin" : "missing-stream"))
  };
}

export function serializeProgramAudioState(mixer) {
  const sources = mixer?.sources ? [...mixer.sources.values()].map((source) => ({
    id: source.id,
    kind: source.kind,
    participantId: source.participantId || null,
    connected: Boolean(source.connected),
    transportLimited: Boolean(source.transportLimited),
    reason: source.reason || ""
  })) : [];
  return {
    masterReady: Boolean(mixer?.masterReady),
    captureAvailable: Boolean(mixer?.captureAvailable),
    busPlayId: mixer?.bus?.current?.playId || null,
    sourceCount: sources.length,
    connectedCount: sources.filter((source) => source.connected).length,
    transportLimitedCount: sources.filter((source) => source.transportLimited).length,
    sources,
    audio: serializeProgramAudio(mixer?.command || null)
  };
}

export class ProgramAudioMixer {
  constructor({ bus = null, role = "program" } = {}) {
    this.bus = bus || new ProgramAudioBus({ role });
    this.role = role;
    this.sources = new Map();
    this.command = null;
    this.masterReady = false;
    this.captureAvailable = false;
  }

  async resume() {
    const ctx = await this.bus.resume();
    this.masterReady = Boolean(ctx);
    this.captureAvailable = Boolean(this.bus.captureDest);
    return ctx;
  }

  masterStream() {
    try {
      const stream = this.bus.captureStream();
      this.captureAvailable = Boolean(stream);
      this.masterReady = Boolean(stream?.getAudioTracks?.().length);
      return stream || null;
    } catch (_) {
      this.masterReady = false;
      this.captureAvailable = false;
      return null;
    }
  }

  addSource(source) {
    const next = createProgramAudioSource(source);
    this.sources.set(next.id, next);
    if (next.stream) {
      const connected = this.bus.connectStream(next.id, next.stream);
      next.connected = Boolean(connected?.ok);
      next.reason = connected?.ok ? "" : (connected?.reason || next.reason);
    }
    return next;
  }

  addParticipant({ participantId, stream, label, transportLimited = false }) {
    if (!stream) {
      return this.addSource({
        id: `voice-${participantId}`,
        kind: ProgramAudioSourceKind.PARTICIPANT,
        participantId,
        label,
        transportLimited: true,
        reason: transportLimited ? "vdo-cross-origin" : "missing-stream"
      });
    }
    return this.addSource({
      id: `voice-${participantId}`,
      kind: ProgramAudioSourceKind.PARTICIPANT,
      participantId,
      stream,
      label
    });
  }

  removeSource(id) {
    this.bus.disconnectStream(id);
    const existed = this.sources.delete(id);
    return { ok: existed, id };
  }

  async applyBusCommand(command) {
    this.command = command;
    return this.bus.applyCommand(command);
  }

  stopBus() {
    this.command = null;
    return this.bus.stop();
  }

  state() {
    return serializeProgramAudioState(this);
  }
}
