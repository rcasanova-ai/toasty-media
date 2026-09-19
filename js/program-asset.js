// Shared ProgramAsset / MediaSource model.
//
// This is the ONE production-source abstraction for anything Hottie, Producer, or later the Asset
// Catalogue can put on Program. Web/article/image ship in this slice. The type enum already names
// the later catalogue (B-roll, video, Hot Box, sound, music, stinger) so Soundboard real audio files
// join this model instead of growing a second isolated system.
//
// External URLs are provenance, never trusted UI. Program Output renders a Toasty-owned card from
// sanitized fields — never an arbitrary-site iframe, never model-generated HTML/JS.

export const ProgramAssetType = Object.freeze({
  ARTICLE: "article",
  WEBSITE: "website",
  IMAGE: "image",
  CHART: "chart",
  DOCUMENT: "document",
  BROLL: "broll",
  VIDEO: "video",
  SCREENSHOT: "screenshot",
  GENERATED: "generated",
  UPLOAD: "upload",
  HOTBOX: "hotbox",
  SOUND: "sound",
  MUSIC: "music",
  STINGER: "stinger"
});

export const ProgramAssetStatus = Object.freeze({
  DRAFT: "draft",
  PROPOSED: "proposed",
  APPROVED: "approved",
  LIVE: "live",
  DISCARDED: "discarded",
  REMOVED: "removed"
});

const MAX_TITLE = 180;
const MAX_EXCERPT = 280;
const MAX_NAME = 80;
const IMAGE_HOST_ALLOWLIST = new Set([
  "upload.wikimedia.org",
  "commons.wikimedia.org",
  "wikipedia.org",
  "en.wikipedia.org"
]);

let uid = 0;
function nextId() { return `asset-${Date.now().toString(36)}-${(uid++).toString(36)}`; }

export function sanitizeBroadcastText(value, limit = MAX_EXCERPT) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, limit);
}

export function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function allowlistedImageUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return null;
    const host = parsed.hostname.replace(/^www\./, "");
    if (![...IMAGE_HOST_ALLOWLIST].some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function normalizeProgramAssetType(value) {
  return Object.values(ProgramAssetType).includes(value) ? value : ProgramAssetType.ARTICLE;
}

export function createProgramAsset(fields = {}) {
  const sourceUrl = String(fields.sourceUrl || "").trim();
  const sourceName = sanitizeBroadcastText(fields.sourceName || hostnameFromUrl(sourceUrl) || "Source", MAX_NAME);
  const title = sanitizeBroadcastText(fields.title || "Untitled", MAX_TITLE);
  const excerpt = sanitizeBroadcastText(fields.excerpt || fields.preview?.excerpt || "", MAX_EXCERPT);
  const imageUrl = allowlistedImageUrl(fields.imageUrl || fields.preview?.imageUrl || fields.media?.src);
  const type = normalizeProgramAssetType(fields.type);
  const retrievedAt = fields.retrievedAt || fields.provenance?.retrievedAt || Date.now();
  return {
    id: fields.id || nextId(),
    type,
    sourceUrl,
    title,
    sourceName,
    attribution: sanitizeBroadcastText(fields.attribution || sourceName, MAX_NAME),
    excerpt,
    preview: {
      kind: "card",
      title,
      sourceName,
      excerpt,
      imageUrl
    },
    media: {
      kind: imageUrl ? "image" : "card",
      src: imageUrl
    },
    createdAt: fields.createdAt || Date.now(),
    createdBy: fields.createdBy || "hottie",
    status: fields.status || ProgramAssetStatus.DRAFT,
    provenance: {
      sourceUrl,
      sourceName,
      domain: hostnameFromUrl(sourceUrl),
      retrievedAt,
      assetType: type,
      directiveId: fields.directiveId || fields.provenance?.directiveId || null
    }
  };
}

export function serializeProgramAsset(asset) {
  if (!asset) return null;
  return {
    id: asset.id,
    type: asset.type,
    sourceUrl: asset.sourceUrl || "",
    title: asset.title || "",
    sourceName: asset.sourceName || "",
    attribution: asset.attribution || "",
    excerpt: asset.excerpt || "",
    preview: {
      kind: "card",
      title: asset.preview?.title || asset.title || "",
      sourceName: asset.preview?.sourceName || asset.sourceName || "",
      excerpt: asset.preview?.excerpt || asset.excerpt || "",
      imageUrl: allowlistedImageUrl(asset.preview?.imageUrl || asset.media?.src)
    },
    media: {
      kind: asset.media?.kind || "card",
      src: allowlistedImageUrl(asset.media?.src)
    },
    createdAt: asset.createdAt,
    createdBy: asset.createdBy || "hottie",
    status: asset.status,
    provenance: {
      sourceUrl: asset.provenance?.sourceUrl || asset.sourceUrl || "",
      sourceName: asset.provenance?.sourceName || asset.sourceName || "",
      domain: asset.provenance?.domain || hostnameFromUrl(asset.sourceUrl),
      retrievedAt: asset.provenance?.retrievedAt || asset.createdAt,
      assetType: asset.provenance?.assetType || asset.type,
      directiveId: asset.provenance?.directiveId || null
    }
  };
}

export function programAssetFromCandidate(candidate, { createdBy = "hottie", directiveId = null, status = ProgramAssetStatus.PROPOSED } = {}) {
  return createProgramAsset({
    type: candidate?.type || ProgramAssetType.ARTICLE,
    sourceUrl: candidate?.sourceUrl,
    title: candidate?.title,
    sourceName: candidate?.sourceName,
    attribution: candidate?.attribution,
    excerpt: candidate?.excerpt,
    imageUrl: candidate?.imageUrl,
    retrievedAt: candidate?.retrievedAt,
    createdBy,
    status,
    directiveId
  });
}

// Session-scoped catalogue. Later Soundboard files, Hot Box items, and uploads land here as the
// same ProgramAsset records — playback still has to enter the Program audio path; this store does
// not play anything by itself.
export class ProgramAssetCatalog {
  constructor() {
    this.items = [];
  }

  add(asset) {
    const record = createProgramAsset(asset);
    this.items.push(record);
    return record;
  }

  get(id) {
    return this.items.find((item) => item.id === id) || null;
  }

  update(id, patch) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    this.items[index] = { ...this.items[index], ...patch };
    return this.items[index];
  }

  live() {
    return this.items.find((item) => item.status === ProgramAssetStatus.LIVE) || null;
  }

  proposed() {
    return this.items.filter((item) => item.status === ProgramAssetStatus.PROPOSED);
  }

  clear() {
    this.items = [];
  }
}
