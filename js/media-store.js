const DB_NAME = "toasty-production-media";
const DB_VERSION = 1;
const STORE_NAME = "media";

export async function saveMediaBlob({ id, blob, metadata = {} }) {
  const db = await openMediaDb();
  try {
    // Resolve only when the transaction has COMMITTED. A request-level success is not durability: a large recording
    // (a 30-minute 6 Mbps file is ~1.4GB) can still abort at commit when the browser's storage quota is exceeded,
    // and the caller must find out rather than believe the recording is safely stored.
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error("Browser storage rejected the recording (quota or disk full)."));
      tx.onerror = () => reject(tx.error || new Error("Browser storage error."));
      tx.objectStore(STORE_NAME).put({ id, blob, metadata, updatedAt: new Date().toISOString() });
    });
  } finally {
    db.close();
  }
  return { id, ...metadata };
}

export async function getMediaBlob(id) {
  if (!id) return null;
  const db = await openMediaDb();
  const record = await requestToPromise(db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(id));
  db.close();
  return record?.blob || null;
}

// Everything stored (metadata only; blobs stay on disk until fetched with getMediaBlob). Optionally filtered by metadata.kind.
export async function listMediaRecords({ kind = null } = {}) {
  const db = await openMediaDb();
  try {
    return await new Promise((resolve, reject) => {
      const out = [];
      const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out);
        const v = cursor.value;
        if (!kind || v.metadata?.kind === kind) out.push({ id: v.id, metadata: v.metadata || {}, updatedAt: v.updatedAt || null, size: v.blob?.size ?? null, type: v.blob?.type || "" });
        cursor.continue();
      };
      req.onerror = () => reject(req.error || new Error("Browser media storage failed."));
    });
  } finally { db.close(); }
}

export async function deleteMediaBlob(id) {
  if (!id) return;
  const db = await openMediaDb();
  await requestToPromise(db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).delete(id));
  db.close();
}

export async function hydrateMediaUrls(project) {
  const mediaIds = new Set([
    project.audio?.mediaId,
    ...project.assets.map((asset) => asset.mediaId),
    ...(project.quick?.assets || []).map((asset) => asset.mediaId)
  ].filter(Boolean));
  const urls = new Map();
  await Promise.all([...mediaIds].map(async (mediaId) => {
    const blob = await getMediaBlob(mediaId);
    if (blob) urls.set(mediaId, URL.createObjectURL(blob));
  }));
  return {
    ...project,
    audio: project.audio?.mediaId ? { ...project.audio, localPreviewUrl: urls.get(project.audio.mediaId) || null } : project.audio,
    assets: project.assets.map((asset) => ({
      ...asset,
      localPreviewUrl: asset.mediaId ? urls.get(asset.mediaId) || null : asset.localPreviewUrl
    })),
    quick: project.quick ? {
      ...project.quick,
      assets: project.quick.assets.map((asset) => ({
        ...asset,
        localPreviewUrl: asset.mediaId ? urls.get(asset.mediaId) || null : asset.localPreviewUrl
      }))
    } : project.quick
  };
}

export async function collectRenderMedia(project) {
  const files = [];
  if (project.audio?.mediaId) {
    const blob = await getMediaBlob(project.audio.mediaId);
    if (blob) files.push({ fieldName: "media", id: project.audio.mediaId, fileName: project.audio.fileName, blob });
  }
  for (const asset of project.assets) {
    if (!asset.mediaId) continue;
    const blob = await getMediaBlob(asset.mediaId);
    if (blob) files.push({ fieldName: "media", id: asset.mediaId, fileName: asset.name, blob });
  }
  return files;
}

export function mediaReferenceForAsset(asset) {
  if (!asset?.mediaAssetId && !asset?.mediaReference?.id) return null;
  return {
    id: asset.mediaAssetId || asset.mediaReference.id,
    provider: asset.providerKey || asset.mediaReference?.provider || asset.provider || "google_drive",
    providerFileId: asset.providerFileId || asset.mediaReference?.providerFileId || null
  };
}

function openMediaDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME, { keyPath: "id" });
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error || new Error("Could not open browser media storage.")));
  });
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error || new Error("Browser media storage failed.")));
  });
}
