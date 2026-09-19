// Shared Asset Catalogue — the durable production library.
//
// ProgramAssetCatalog (js/program-asset.js) is the session-scoped store of assets that can go on
// Program (proposed / live / discarded). This file is the reusable library those session rows come
// from: sound effects, stingers, later music, video, B-roll, images, web, articles, uploads.
//
// A catalogue item becomes a ProgramAsset via programAssetFromCatalogueItem(). Playback is NOT this
// module's job — ProgramController PLAY_AUDIO / STOP_AUDIO plus ProgramAudioBus is the audio path.

import {
  ProgramAssetType,
  ProgramAssetStatus,
  createProgramAsset,
  allowlistedCatalogueSrc
} from "./program-asset.js";

export const AssetCategory = Object.freeze({
  SOUND_EFFECT: "sound-effect",
  MUSIC: "music",
  STINGER: "stinger",
  IMAGE: "image",
  VIDEO: "video",
  WEB: "web",
  ARTICLE: "article"
});

const CATEGORY_TO_PROGRAM_TYPE = {
  [AssetCategory.SOUND_EFFECT]: ProgramAssetType.SOUND,
  [AssetCategory.MUSIC]: ProgramAssetType.MUSIC,
  [AssetCategory.STINGER]: ProgramAssetType.STINGER,
  [AssetCategory.IMAGE]: ProgramAssetType.IMAGE,
  [AssetCategory.VIDEO]: ProgramAssetType.VIDEO,
  [AssetCategory.WEB]: ProgramAssetType.WEBSITE,
  [AssetCategory.ARTICLE]: ProgramAssetType.ARTICLE
};

export const DEFAULT_CATALOGUE_URL = "/assets/catalogue/catalogue.json";

export function normalizeAssetCategory(value) {
  return Object.values(AssetCategory).includes(value) ? value : AssetCategory.SOUND_EFFECT;
}

export function catalogueItemMediaSrc(item) {
  return allowlistedCatalogueSrc(item?.src || (item?.filename ? `/assets/catalogue/audio/${item.filename}` : null));
}

export function programAssetFromCatalogueItem(item, extra = {}) {
  if (!item?.id) return null;
  const src = catalogueItemMediaSrc(item);
  const type = extra.type || item.programAssetType || CATEGORY_TO_PROGRAM_TYPE[item.category] || ProgramAssetType.SOUND;
  const isAudio = type === ProgramAssetType.SOUND || type === ProgramAssetType.MUSIC || type === ProgramAssetType.STINGER;
  return createProgramAsset({
    id: extra.id || item.id,
    type,
    title: item.displayName || item.id,
    sourceUrl: item.sourceUrl || "",
    sourceName: item.source || "Toasty Asset Catalogue",
    attribution: item.attribution || item.creator || item.source || "Toasty Asset Catalogue",
    excerpt: item.notes || "",
    createdBy: extra.createdBy || "catalogue",
    status: extra.status || ProgramAssetStatus.APPROVED,
    media: isAudio ? { kind: "audio", src } : extra.media,
    duration: item.duration,
    catalogueId: item.id,
    provenance: {
      sourceUrl: item.sourceUrl || "",
      sourceName: item.source || "Toasty Asset Catalogue",
      domain: "catalogue",
      retrievedAt: extra.retrievedAt || Date.now(),
      assetType: type,
      catalogueId: item.id,
      license: item.license || "",
      licenseUrl: item.licenseUrl || "",
      creator: item.creator || "",
      attributionRequired: Boolean(item.attributionRequired)
    }
  });
}

export class AssetCatalogue {
  constructor(document = null) {
    this.version = document?.version || 0;
    this.standard = document?.standard || null;
    this.items = Array.isArray(document?.items) ? document.items.slice() : [];
    this.loaded = Boolean(document);
    this.url = null;
  }

  static fromDocument(document) {
    return new AssetCatalogue(document);
  }

  async load(url = DEFAULT_CATALOGUE_URL) {
    this.url = url;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`catalogue-load-failed:${response.status}`);
    const document = await response.json();
    this.version = document?.version || 0;
    this.standard = document?.standard || null;
    this.items = Array.isArray(document?.items) ? document.items.slice() : [];
    this.loaded = true;
    return this;
  }

  get(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  byCategory(category) {
    if (!category || category === "all") return this.items.slice();
    return this.items.filter((item) => item.category === category);
  }

  soundboardItems() {
    return this.items.filter((item) => item.category === AssetCategory.SOUND_EFFECT || item.category === AssetCategory.STINGER || item.category === AssetCategory.MUSIC);
  }

  toProgramAsset(id, extra = {}) {
    const item = this.get(id);
    return item ? programAssetFromCatalogueItem(item, extra) : null;
  }
}
