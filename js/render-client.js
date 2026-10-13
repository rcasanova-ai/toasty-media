import { collectRenderMedia, mediaReferenceForAsset } from "./media-store.js";

const LOCAL_RENDER_ENDPOINT = "http://127.0.0.1:4174/render";
const PRODUCTION_RENDER_ENDPOINT = "https://render.toasty.media/render";
const LOCAL_RECORDING_FINALIZE_ENDPOINT = "http://127.0.0.1:4174/api/recordings/finalize";
const PRODUCTION_RECORDING_FINALIZE_ENDPOINT = "https://render.toasty.media/api/recordings/finalize";

export function buildTimeline({ project, productionSpec, brandProfile }) {
  const narrationDuration = project.audio?.duration || 0;
  const scenes = distributeSceneDurations(project.scenes, narrationDuration);
  let cursor = 0;
  return scenes.map((scene) => {
    const segment = {
      sceneId: scene.id,
      order: scene.order || scene.number,
      startTime: round(cursor),
      duration: scene.renderDuration || scene.estimatedDuration,
      composition: scene.composition || compositionForVisualType(scene.visualType),
      primaryVisualAssetId: primaryAssetForScene(scene, project),
      avatarAssetId: project.assets.find((asset) => asset.kind === "avatar")?.id || null,
      brollAssetId: scene.visualAssetId || project.assets.find((asset) => asset.kind === "visual")?.id || null,
      audioSourceAssetId: scene.audioSourceAssetId || null,
      narrationAudioId: project.audio?.id || null,
      narrationMediaId: project.audio?.mediaId || null,
      caption: scene.captionText || scene.captions || scene.scriptText || scene.script || "",
      quickRole: scene.quickRole || null,
      lowerThird: scene.lowerThird || null,
      watermark: scene.watermark !== false,
      overlay: {
        brandProfileId: brandProfile.id,
        logo: brandProfile.logos?.[0] || null,
        primaryColor: brandProfile.primaryColor,
        accentColor: brandProfile.accentColor,
        creatorName: brandProfile.creatorName || brandProfile.name,
        creatorTitle: brandProfile.creatorTitle || "",
        creatorHandle: brandProfile.creatorHandle || "",
        website: brandProfile.website || "",
        defaultCTA: brandProfile.defaultCTA || brandProfile.ctaStyle,
        lowerThirdStyle: brandProfile.lowerThirdStyle,
        logoTreatment: brandProfile.logoTreatment || "",
        lowerThirdTreatment: brandProfile.lowerThirdTreatment || "",
        titleCardTreatment: brandProfile.titleCardTreatment || "",
        introTreatment: brandProfile.introTreatment || "",
        outroTreatment: brandProfile.outroTreatment || "",
        backgroundWatermark: brandProfile.backgroundWatermark || "",
        backgroundSilhouette: brandProfile.backgroundSilhouette || ""
      }
    };
    cursor += segment.duration;
    return segment;
  });
}

export async function renderProductionMp4({ project, productionSpec, brandProfile, onProgress = () => {} }) {
  onProgress("Preparing media...");
  const timeline = buildTimeline({ project, productionSpec, brandProfile });
  const manifest = {
    productionId: productionSpec.id,
    title: productionSpec.title,
    platform: productionSpec.platform,
    aspectRatio: productionSpec.aspectRatio,
    format: productionSpec.format,
    targetDuration: productionSpec.targetDuration,
    narrationAudio: project.audio,
    brandProfile,
    productionSpec,
    assets: project.assets.map((asset) => ({
      ...asset,
      mediaReference: mediaReferenceForAsset(asset)
    })),
    output: {
      saveToGoogleDrive: Boolean(project.output?.saveToGoogleDrive)
    },
    timeline
  };

  const files = await collectRenderMedia(project);
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  files.forEach((file) => {
    form.append(file.fieldName, file.blob, `${file.id}__${file.fileName || "media"}`);
  });

  onProgress("Rendering MP4...");
  const renderEndpoint = getRenderEndpoint();
  const response = await fetch(renderEndpoint, {
    method: "POST",
    headers: { "X-Toasty-CSRF": "1" },
    credentials: "include",
    body: form
  });
  if (!response.ok) {
    let message = "Render failed. Start the local render helper and try again.";
    try {
      const payload = await response.json();
      if (payload?.error) message = payload.error;
    } catch {
      // Keep creator-facing error short.
    }
    throw new Error(message);
  }

  const blob = await response.blob();
  onProgress("Render complete.");
  return {
    blob,
    url: URL.createObjectURL(blob),
    fileName: `${slugify(productionSpec.title || "toasty-production")}.mp4`,
    timeline,
    manifest
  };
}

// MP4 finalization runs as a server-side JOB: the raw source WebM is streamed up, converted on a queue, and the
// MP4 is streamed back — no request has to outlive the transcode, nothing is held in server memory, and the
// browser keeps the source WebM until it has the MP4, so any failure is retryable and loses nothing.
const FINALIZE_POLL_MS = 2000;
const FINALIZE_MAX_WAIT_MS = 90 * 60 * 1000;

export async function finalizeMasterRecordingMp4({ sourceBlob, manifest, onProgress = () => {}, fetchImpl = (...a) => fetch(...a), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!sourceBlob?.size) throw new Error("Source WebM recording is missing.");
  if (!manifest?.recordingId) throw new Error("Recording manifest is missing.");
  const base = getRecordingFinalizeEndpoint().replace(/\/finalize$/, "/jobs");
  const meta = { recordingId: manifest.recordingId, sessionId: manifest.sessionId || null, durationSeconds: manifest.durationSeconds || 0 };
  onProgress("Uploading recording...");
  let created;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      created = await fetchImpl(base, {
        method: "POST",
        headers: { "X-Toasty-CSRF": "1", "X-Toasty-Recording": btoa(JSON.stringify(meta)), "Content-Type": "video/webm" },
        credentials: "include",
        body: sourceBlob
      });
      break;
    } catch (error) {
      // A dropped connection before any response (wifi blip, stale keep-alive socket): the Blob is re-sendable.
      if (attempt === 2) throw new Error("MP4 upload failed — check your connection. Your source WebM is saved; Retry MP4.");
      await sleep(1000 * (attempt + 1));
    }
  }
  const job = await readJsonError(created, "MP4 upload failed. Your source WebM is saved.");
  const startedAt = Date.now();
  let status = job;
  let transient = 0;
  while (status.status !== "done") {
    if (status.status === "failed") throw new Error(status.error || "MP4 conversion failed. Your source WebM is saved.");
    if (Date.now() - startedAt > FINALIZE_MAX_WAIT_MS) throw new Error("MP4 conversion is taking too long. Your source WebM is saved — Retry MP4.");
    onProgress(status.status === "queued" && status.position > 1 ? `Waiting for ${status.position - 1} other recording(s)...` : "Converting to MP4...");
    await sleep(FINALIZE_POLL_MS);
    try {
      const poll = await fetchImpl(`${base}/${job.id}`, { credentials: "include" });
      if (poll.status === 404) throw new Error("The conversion job expired on the server. Retry MP4 — your source WebM is saved.");
      status = await readJsonError(poll, "Could not check MP4 progress.");
      transient = 0;
    } catch (error) {
      // A dropped poll (wifi blip, laptop sleep) must not abandon a conversion that is still running.
      if (/expired|failed|too long/i.test(error.message) || ++transient > 8) throw error;
    }
  }
  onProgress("Downloading MP4...");
  const download = await fetchImpl(`${base}/${job.id}/mp4`, { credentials: "include" });
  if (!download.ok) throw new Error("The MP4 could not be downloaded. Retry MP4 — your source WebM is saved.");
  const blob = await download.blob();
  if (status.outputBytes && blob.size !== status.outputBytes) throw new Error("The MP4 download was incomplete. Retry MP4 — your source WebM is saved.");
  fetchImpl(`${base}/${job.id}/discard`, { method: "POST", headers: { "X-Toasty-CSRF": "1" }, credentials: "include", body: "{}" }).catch(() => {});
  onProgress("MP4 master ready.");
  return { blob, fileName: `${manifest.recordingId}.mp4`, mimeType: blob.type || "video/mp4", bytes: blob.size };
}

async function readJsonError(response, fallback) {
  let payload = {};
  try { payload = await response.json(); } catch { /* keep fallback */ }
  if (!response.ok) throw new Error(payload?.error || fallback);
  return payload;
}

function getRenderEndpoint() {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "") {
    return LOCAL_RENDER_ENDPOINT;
  }
  return PRODUCTION_RENDER_ENDPOINT;
}

function getRecordingFinalizeEndpoint() {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "") {
    return LOCAL_RECORDING_FINALIZE_ENDPOINT;
  }
  return PRODUCTION_RECORDING_FINALIZE_ENDPOINT;
}

export function renderReadiness({ project, consistency }) {
  const warnings = [];
  const isQuickToast = project.quick?.prepared;
  const hasPlayableQuickAudio = project.assets.some((asset) => asset.kind === "quick-content" && asset.quickKind === "video")
    || Boolean(project.audio?.mediaId);
  if (!isQuickToast && !project.audio?.mediaId) warnings.push("missing narration");
  if (isQuickToast && !hasPlayableQuickAudio && project.scenes.every((scene) => scene.visualType !== "Image" && scene.visualType !== "Text/card")) {
    warnings.push("missing usable content");
  }
  project.scenes.forEach((scene) => {
    if (scene.visualType !== "Text/card" && !primaryAssetForScene(scene, project)) {
      warnings.push(`scene ${scene.order || scene.number} missing visual`);
    }
  });
  return {
    ready: warnings.length === 0,
    warnings,
    brandWarnings: consistency?.warnings || []
  };
}

function distributeSceneDurations(scenes, narrationDuration) {
  if (!scenes.length) return [];
  const manualTotal = scenes.reduce((sum, scene) => sum + (Number(scene.estimatedDuration) || 0), 0);
  if (!narrationDuration || manualTotal <= 0) {
    return scenes.map((scene) => ({ ...scene, renderDuration: Number(scene.estimatedDuration) || 3 }));
  }
  return scenes.map((scene, index) => {
    const proportional = Math.max(1, narrationDuration * ((Number(scene.estimatedDuration) || 1) / manualTotal));
    const rounded = index === scenes.length - 1
      ? Math.max(1, narrationDuration - scenes.slice(0, -1).reduce((sum, item) => sum + Math.max(1, narrationDuration * ((Number(item.estimatedDuration) || 1) / manualTotal)), 0))
      : proportional;
    return { ...scene, renderDuration: round(rounded) };
  });
}

function primaryAssetForScene(scene, project) {
  if (scene.visualType === "Text/card") return null;
  if (scene.visualType === "Avatar" || scene.composition === "avatar-full") {
    return project.assets.find((asset) => asset.kind === "avatar")?.id || scene.visualAssetId || null;
  }
  return scene.visualAssetId || project.assets.find((asset) => asset.kind === "visual")?.id || null;
}

function compositionForVisualType(visualType) {
  if (visualType === "Avatar") return "avatar-full";
  if (visualType === "Image") return "image-full";
  if (visualType === "Text/card") return "text-card";
  return "broll-full";
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "toasty-production";
}
