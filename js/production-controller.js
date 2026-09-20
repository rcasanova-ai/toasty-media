// Deterministic production actions. Hottie proposes; this controller executes.
//
// No model-generated JavaScript, selectors, or DOM instructions. TAKE LIVE is the only path that
// can place a visual ProgramAsset onto ProgramComposition / Program Renderer.
//
// PLAY_AUDIO / STOP_AUDIO are the Program Audio path: they publish a catalogue file onto the
// Program Audio bus (audience Program Output). PLAY_ASSET is the same execute as PLAY_AUDIO so a
// future Hottie [ PLAY ] button can fire a structured action without touching the audio DOM.

import { ProgramAssetStatus, serializeProgramAsset } from "./program-asset.js";
import { CompositionMode, ProgramLayout, ShareLayout } from "./program-composition.js";
import { programAssetFromCatalogueItem } from "./asset-catalogue.js";
import { buildPlayAudioCommand, buildStopAudioCommand, serializeProgramAudio } from "./program-audio.js";

export const ProductionActionType = Object.freeze({
  RESEARCH_REQUEST: "RESEARCH_REQUEST",
  ASSET_PROPOSAL: "PROGRAM_ASSET_PROPOSAL",
  SELECT_CANDIDATE: "SELECT_CANDIDATE",
  DISCARD: "DISCARD",
  TAKE_ASSET: "TAKE_ASSET",
  REMOVE_ASSET: "REMOVE_ASSET",
  TAKE: "TAKE",
  REMOVE: "REMOVE",
  LAYOUT: "LAYOUT",
  LOWER_THIRD: "LOWER_THIRD",
  TICKER: "TICKER",
  CHAT_MESSAGE: "CHAT_MESSAGE",
  PLAY_AUDIO: "PLAY_AUDIO",
  PLAY_ASSET: "PLAY_ASSET",
  STOP_AUDIO: "STOP_AUDIO",
  PLAY_VIDEO: "PLAY_VIDEO",
  MARKER: "MARKER",
  SET_LAYOUT: "SET_LAYOUT",
  SET_SPOTLIGHT: "SET_SPOTLIGHT",
  CLEAR_SPOTLIGHT: "CLEAR_SPOTLIGHT",
  SET_ACTIVE_SPEAKER_MODE: "SET_ACTIVE_SPEAKER_MODE",
  SET_SHARE_LAYOUT: "SET_SHARE_LAYOUT",
  STOP_SHARE: "STOP_SHARE"
});

const EXECUTABLE = new Set([
  ProductionActionType.TAKE_ASSET,
  ProductionActionType.REMOVE_ASSET,
  ProductionActionType.PLAY_AUDIO,
  ProductionActionType.PLAY_ASSET,
  ProductionActionType.STOP_AUDIO,
  ProductionActionType.SET_LAYOUT,
  ProductionActionType.SET_SPOTLIGHT,
  ProductionActionType.CLEAR_SPOTLIGHT,
  ProductionActionType.SET_ACTIVE_SPEAKER_MODE,
  ProductionActionType.SET_SHARE_LAYOUT,
  ProductionActionType.STOP_SHARE
]);

const ASSET_LAYOUTS = new Set([
  ProgramLayout.ASSET_FULL,
  ProgramLayout.ASSET_SPEAKER,
  ProgramLayout.ASSET_SPEAKER_PIP
]);

export class ProductionActionLog {
  constructor() {
    this.items = [];
  }

  record(type, payload = {}) {
    const entry = {
      id: `act-${Date.now().toString(36)}-${this.items.length.toString(36)}`,
      type,
      timestamp: Date.now(),
      ...payload
    };
    this.items.push(entry);
    return entry;
  }

  recent(limit = 40) {
    return this.items.slice(-limit);
  }

  clear() {
    this.items = [];
  }
}

export class ProgramController {
  constructor(session) {
    this.session = session;
  }

  liveAsset() {
    return this.session.assets?.live() || null;
  }

  execute(action = {}) {
    const type = action.type;
    if (!EXECUTABLE.has(type)) {
      this.session.productionLog?.record("UNSUPPORTED", { requested: type });
      return { ok: false, reason: "unsupported" };
    }
    if (type === ProductionActionType.TAKE_ASSET) return this.takeAsset(action);
    if (type === ProductionActionType.REMOVE_ASSET) return this.removeAsset(action);
    if (type === ProductionActionType.PLAY_AUDIO || type === ProductionActionType.PLAY_ASSET) return this.playAudio(action);
    if (type === ProductionActionType.STOP_AUDIO) return this.stopAudio(action);
    if (type === ProductionActionType.SET_LAYOUT) return this.setLayout(action);
    if (type === ProductionActionType.SET_SPOTLIGHT) return this.setSpotlight(action);
    if (type === ProductionActionType.CLEAR_SPOTLIGHT) return this.clearSpotlight(action);
    if (type === ProductionActionType.SET_ACTIVE_SPEAKER_MODE) return this.setActiveSpeakerMode(action);
    if (type === ProductionActionType.SET_SHARE_LAYOUT) return this.setShareLayout(action);
    if (type === ProductionActionType.STOP_SHARE) return this.stopShare(action);
    return { ok: false, reason: "unsupported" };
  }

  ensureCatalogueAsset(item) {
    const existing = this.session.assets?.get(item.id);
    if (existing) return existing;
    const asset = programAssetFromCatalogueItem(item, { createdBy: "catalogue", status: ProgramAssetStatus.APPROVED });
    return this.session.assets.add(asset) || asset;
  }

  playAudio({ assetId, initiator = "producer", volume } = {}) {
    const item = this.session.catalogue?.get(assetId);
    if (!item || item.missing) return { ok: false, reason: "missing-asset" };
    const command = buildPlayAudioCommand(item, {
      initiator,
      volume: volume ?? this.session.programAudio?.volume ?? 0.65
    });
    if (!command) return { ok: false, reason: "missing-media" };
    const asset = this.ensureCatalogueAsset(item);
    this.session.program.audio = command;
    this.session.productionLog?.record(ProductionActionType.PLAY_AUDIO, {
      assetId: item.id,
      playId: command.playId,
      initiator,
      duration: command.duration,
      src: command.src
    });
    this.session.noteProductionMarker?.("play-audio", item.displayName || item.id, initiator);
    this.session.emit?.("program-audio", command);
    this.session._publishControlNow?.() ?? this.session.publishProgramState?.();
    // Producer monitor is a parallel play of the same command. Program Audio is Program Output.
    if (this.session.programAudio) {
      this.session.programAudio.applyCommand(command).then((played) => {
        if (!played?.ok) this.session.emit?.("program-audio-error", played);
      }).catch((error) => {
        this.session.emit?.("program-audio-error", { ok: false, reason: "decode-failed", error: String(error?.message || error) });
      });
    }
    return { ok: true, command: serializeProgramAudio(command), asset: serializeProgramAsset(asset) };
  }

  stopAudio({ initiator = "producer" } = {}) {
    const command = buildStopAudioCommand(this.session.program?.audio, { initiator });
    this.session.program.audio = command;
    this.session.productionLog?.record(ProductionActionType.STOP_AUDIO, {
      assetId: command.assetId,
      playId: command.playId,
      initiator,
      duration: command.duration,
      src: command.src
    });
    this.session.noteProductionMarker?.("stop-audio", command.displayName || command.assetId || "audio", initiator);
    this.session.emit?.("program-audio", command);
    this.session._publishControlNow?.() ?? this.session.publishProgramState?.();
    this.session.programAudio?.stop();
    return { ok: true, command: serializeProgramAudio(command) };
  }

  takeAsset({ assetId, layout } = {}) {
    const asset = this.session.assets?.get(assetId);
    if (!asset) return { ok: false, reason: "missing-asset" };
    if (asset.status === ProgramAssetStatus.DISCARDED) return { ok: false, reason: "discarded" };

    const previous = this.liveAsset();
    if (previous && previous.id !== asset.id) {
      this.session.assets.update(previous.id, { status: ProgramAssetStatus.REMOVED });
    }

    const nextLayout = ASSET_LAYOUTS.has(layout) ? layout : ProgramLayout.ASSET_SPEAKER;
    this.session.assets.update(asset.id, { status: ProgramAssetStatus.LIVE });
    this.session.program.assetLayout = nextLayout;
    this.session.productionLog?.record(ProductionActionType.TAKE_ASSET, {
      assetId: asset.id,
      layout: nextLayout,
      sourceUrl: asset.sourceUrl
    });
    this.session.noteProductionMarker?.("take-live", asset.title || asset.id, "producer");
    this.session.emit?.("program-asset", this.liveAsset());
    this.session._syncProgramPreview?.();
    this.session._publishControlNow?.() ?? this.session.publishProgramState?.();
    return { ok: true, asset: serializeProgramAsset(this.liveAsset()), layout: nextLayout };
  }

  removeAsset({ assetId } = {}) {
    const live = this.liveAsset();
    const targetId = assetId || live?.id;
    if (!targetId || !live || live.id !== targetId) return { ok: false, reason: "not-live" };
    this.session.assets.update(targetId, { status: ProgramAssetStatus.REMOVED });
    this.session.program.assetLayout = null;
    this.session.productionLog?.record(ProductionActionType.REMOVE_ASSET, { assetId: targetId });
    this.session.noteProductionMarker?.("remove-asset", live.title || targetId, "producer");
    this.session.emit?.("program-asset", null);
    this.session._syncProgramPreview?.();
    this.session._publishControlNow?.() ?? this.session.publishProgramState?.();
    return { ok: true };
  }

  setLayout({ mode, layout, initiator = "producer" } = {}) {
    const next = mode || layout || CompositionMode.BALANCED;
    this.session.setCompositionMode?.(next);
    this.session.productionLog?.record(ProductionActionType.SET_LAYOUT, { mode: next, initiator });
    return { ok: true, mode: next };
  }

  setSpotlight({ participantId, initiator = "producer" } = {}) {
    if (!participantId) return this.clearSpotlight({ initiator });
    this.session.setSpotlight?.(participantId);
    this.session.productionLog?.record(ProductionActionType.SET_SPOTLIGHT, { participantId, initiator });
    return { ok: true, participantId };
  }

  clearSpotlight({ initiator = "producer" } = {}) {
    this.session.clearSpotlight?.();
    this.session.productionLog?.record(ProductionActionType.CLEAR_SPOTLIGHT, { initiator });
    return { ok: true };
  }

  setActiveSpeakerMode({ initiator = "producer" } = {}) {
    this.session.setCompositionMode?.(CompositionMode.ACTIVE_SPEAKER);
    this.session.productionLog?.record(ProductionActionType.SET_ACTIVE_SPEAKER_MODE, { initiator });
    return { ok: true, mode: CompositionMode.ACTIVE_SPEAKER };
  }

  setShareLayout({ shareLayout, initiator = "producer" } = {}) {
    const next = Object.values(ShareLayout).includes(shareLayout) ? shareLayout : ShareLayout.SCREEN_SPEAKER;
    if (!this.session.screenShare?.active) {
      const started = this.session.startScreenShare?.();
      if (started && typeof started.then === "function") {
        return started.then((share) => {
          if (!share) return { ok: false, reason: "share-unavailable" };
          this.session.setShareLayout?.(next);
          this.session.productionLog?.record(ProductionActionType.SET_SHARE_LAYOUT, { shareLayout: next, initiator });
          return { ok: true, shareLayout: next };
        });
      }
      if (!started) return { ok: false, reason: "share-unavailable" };
    }
    this.session.setShareLayout?.(next);
    this.session.productionLog?.record(ProductionActionType.SET_SHARE_LAYOUT, { shareLayout: next, initiator });
    return { ok: true, shareLayout: next };
  }

  stopShare({ initiator = "producer" } = {}) {
    this.session.stopScreenShare?.();
    this.session.productionLog?.record(ProductionActionType.STOP_SHARE, { initiator });
    return { ok: true };
  }
}
