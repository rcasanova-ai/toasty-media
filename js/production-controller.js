// Deterministic production actions. Hottie proposes; this controller executes.
//
// No model-generated JavaScript, selectors, or DOM instructions. TAKE LIVE is the only path that
// can place a ProgramAsset onto ProgramComposition / Program Renderer.

import { ProgramAssetStatus, serializeProgramAsset } from "./program-asset.js";
import { ProgramLayout } from "./program-composition.js";

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
  PLAY_VIDEO: "PLAY_VIDEO"
});

const EXECUTABLE = new Set([
  ProductionActionType.TAKE_ASSET,
  ProductionActionType.REMOVE_ASSET
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
    return { ok: false, reason: "unsupported" };
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
    this.session.emit?.("program-asset", this.liveAsset());
    this.session._syncProgramPreview?.();
    this.session.publishProgramState?.();
    return { ok: true, asset: serializeProgramAsset(this.liveAsset()), layout: nextLayout };
  }

  removeAsset({ assetId } = {}) {
    const live = this.liveAsset();
    const targetId = assetId || live?.id;
    if (!targetId || !live || live.id !== targetId) return { ok: false, reason: "not-live" };
    this.session.assets.update(targetId, { status: ProgramAssetStatus.REMOVED });
    this.session.program.assetLayout = null;
    this.session.productionLog?.record(ProductionActionType.REMOVE_ASSET, { assetId: targetId });
    this.session.emit?.("program-asset", null);
    this.session._syncProgramPreview?.();
    this.session.publishProgramState?.();
    return { ok: true };
  }
}
