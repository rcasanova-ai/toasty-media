import { collectRenderMedia } from "./media-store.js";

const LOCAL_RENDER_ENDPOINT = "http://127.0.0.1:4174/render";
const PRODUCTION_RENDER_ENDPOINT = "https://render.toasty.media/render";
const PRODUCTION_RENDER_TOKEN = "357586a404673f0d3dd2a33f84d643ccbdd3b6f7d1c93dd218c245a2766a6596";

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
        lowerThirdStyle: brandProfile.lowerThirdStyle
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
    assets: project.assets,
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
  const headers = getRenderHeaders();
  const response = await fetch(renderEndpoint, { method: "POST", headers, body: form });
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

function getRenderEndpoint() {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "") {
    return LOCAL_RENDER_ENDPOINT;
  }
  return PRODUCTION_RENDER_ENDPOINT;
}

function getRenderHeaders() {
  const host = window.location.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "") return {};
  return { "X-Toasty-Render-Token": PRODUCTION_RENDER_TOKEN };
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
