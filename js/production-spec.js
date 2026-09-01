const DEFAULT_PLATFORM = "YouTube Shorts";
const DEFAULT_FORMATS = Object.freeze({
  LinkedIn: { format: "feed video", aspectRatio: "4:5", targetDuration: 60 },
  YouTube: { format: "standard video", aspectRatio: "16:9", targetDuration: 120 },
  "YouTube Shorts": { format: "short vertical", aspectRatio: "9:16", targetDuration: 45 },
  "Instagram Reels": { format: "short vertical", aspectRatio: "9:16", targetDuration: 35 },
  TikTok: { format: "short vertical", aspectRatio: "9:16", targetDuration: 30 },
  Generic: { format: "short-form video", aspectRatio: "9:16", targetDuration: 45 }
});

export const PLATFORMS = Object.freeze(Object.keys(DEFAULT_FORMATS));

export function createProductionSpec({ project, brandProfile, angle, script, scenes }) {
  const now = new Date().toISOString();
  const platform = project.source.platform || DEFAULT_PLATFORM;
  const defaults = targetDefaults(platform, brandProfile);
  const topic = project.source.topic || "Untitled idea";
  return {
    id: project.spec?.id || createId("spec"),
    projectId: project.id,
    brandProfileId: brandProfile.id,
    topic,
    sourceUrl: project.source.url || "",
    sourceText: project.source.sourceText || project.source.notes || "",
    audience: project.source.audience || "creators and operators who need the idea to land quickly",
    objective: project.source.objective || "turn the idea into a clear, useful short video",
    platform,
    format: project.source.format || defaults.format,
    aspectRatio: project.source.aspectRatio || defaults.aspectRatio,
    targetDuration: Number(project.source.targetDuration) || defaults.targetDuration,
    selectedAngle: angle || null,
    hook: script?.hook || project.script?.hook || angle?.hook || "",
    title: script?.title || project.script?.title || `${topic} in ${defaults.targetDuration} seconds`,
    script: script?.body || project.script?.body || "",
    cta: script?.cta || project.script?.cta || brandProfile.ctaStyle,
    tone: brandProfile.toneOfVoice,
    visualDirection: brandProfile.visualStyle,
    captionDirection: brandProfile.captionStyle,
    musicDirection: brandProfile.musicDirection,
    avatarDirection: brandProfile.avatarPreference,
    cameraDirection: brandProfile.cameraDirection,
    sceneStyleRules: {
      useProductionStyleDefault: true,
      pacing: defaults.pacing || "tight and useful",
      forbiddenStyles: brandProfile.forbiddenStyles,
      preferredPhrases: brandProfile.preferredPhrases,
      avoidPhrases: brandProfile.avoidPhrases
    },
    globalStyleNotes: [
      brandProfile.backgroundPreference,
      brandProfile.fontDirection,
      brandProfile.thumbnailDirection,
      brandProfile.notes
    ].filter(Boolean).join(" "),
    scenes: scenes || [],
    narrationAudio: project.audio || null,
    brandOverlays: {
      logos: brandProfile.logos,
      creatorName: brandProfile.creatorName || brandProfile.name,
      creatorTitle: brandProfile.creatorTitle || "",
      creatorHandle: brandProfile.creatorHandle || "",
      website: brandProfile.website || "",
      defaultCTA: brandProfile.defaultCTA || brandProfile.ctaStyle,
      lowerThirdStyle: brandProfile.lowerThirdStyle,
      introStyle: brandProfile.introStyle,
      outroStyle: brandProfile.outroStyle,
      primaryColor: brandProfile.primaryColor,
      secondaryColor: brandProfile.secondaryColor,
      accentColor: brandProfile.accentColor
    },
    createdAt: project.spec?.createdAt || now,
    updatedAt: now
  };
}

export function createScene({ order, scriptText, productionSpec, brandProfile, overrides = {} }) {
  const visualType = overrides.visualType || (order === 1 ? "Avatar" : "B-roll");
  const inheritedVisualDirection = productionSpec?.visualDirection || brandProfile.visualStyle;
  const inheritedCaptionDirection = productionSpec?.captionDirection || brandProfile.captionStyle;
  const scene = {
    id: overrides.id || createId("scene"),
    order,
    number: order,
    scriptText,
    script: scriptText,
    estimatedDuration: overrides.estimatedDuration || estimateDuration(scriptText),
    narrationStatus: overrides.narrationStatus || "needs-recording",
    audioId: overrides.audioId || null,
    visualType,
    visualAssetId: overrides.visualAssetId || null,
    useProductionStyle: overrides.useProductionStyle ?? true,
    visualPrompt: overrides.visualPrompt || buildVisualPrompt(scriptText, inheritedVisualDirection, brandProfile),
    visualDirection: overrides.visualDirection || inheritedVisualDirection,
    cameraDirection: overrides.cameraDirection || productionSpec?.cameraDirection || brandProfile.cameraDirection,
    avatarDirection: overrides.avatarDirection || productionSpec?.avatarDirection || brandProfile.avatarPreference,
    captionText: overrides.captionText || scriptText,
    captions: overrides.captionText || scriptText,
    captionDirection: overrides.captionDirection || inheritedCaptionDirection,
    assetStatus: overrides.assetStatus || "Missing voice",
    consistencyStatus: overrides.consistencyStatus || "missing",
    quickRole: overrides.quickRole || null,
    lowerThird: overrides.lowerThird || null,
    watermark: overrides.watermark ?? true,
    audioSourceAssetId: overrides.audioSourceAssetId || null,
    notes: overrides.notes || ""
  };
  return scene;
}

export function upgradeScene(scene, { productionSpec, brandProfile, order = scene.order || scene.number || 1 }) {
  const scriptText = scene.scriptText || scene.script || "";
  return createScene({
    order,
    scriptText,
    productionSpec,
    brandProfile,
    overrides: {
      ...scene,
      estimatedDuration: scene.estimatedDuration,
      narrationStatus: scene.narrationStatus,
      audioId: scene.audioId,
      visualType: scene.visualType,
      visualAssetId: scene.visualAssetId,
      useProductionStyle: scene.useProductionStyle,
      visualPrompt: scene.visualPrompt,
      visualDirection: scene.visualDirection,
      cameraDirection: scene.cameraDirection,
      avatarDirection: scene.avatarDirection,
      captionText: scene.captionText || scene.captions,
      captionDirection: scene.captionDirection,
      assetStatus: scene.assetStatus,
      consistencyStatus: scene.consistencyStatus,
      quickRole: scene.quickRole,
      lowerThird: scene.lowerThird,
      watermark: scene.watermark,
      audioSourceAssetId: scene.audioSourceAssetId,
      notes: scene.notes
    }
  });
}

export function createProviderRequests({ productionSpec, brandProfile, scene }) {
  return {
    avatarGenerationRequest: createAvatarGenerationRequest({ productionSpec, brandProfile, scene }),
    imageGenerationRequest: createImageGenerationRequest({ productionSpec, brandProfile, scene }),
    videoGenerationRequest: createVideoGenerationRequest({ productionSpec, brandProfile, scene })
  };
}

export function createAvatarGenerationRequest({ productionSpec, brandProfile, scene }) {
  return {
    ...providerRequestBase({ productionSpec, brandProfile, scene }),
    kind: "AvatarGenerationRequest",
    sourceAvatarOrTwin: brandProfile.avatarPreference,
    audioFile: productionSpec.narrationAudio,
    scriptText: scene.scriptText
  };
}

export function createImageGenerationRequest({ productionSpec, brandProfile, scene }) {
  return {
    ...providerRequestBase({ productionSpec, brandProfile, scene }),
    kind: "ImageGenerationRequest",
    prompt: scene.visualPrompt
  };
}

export function createVideoGenerationRequest({ productionSpec, brandProfile, scene }) {
  return {
    ...providerRequestBase({ productionSpec, brandProfile, scene }),
    kind: "VideoGenerationRequest",
    prompt: scene.visualPrompt,
    motionDirection: scene.cameraDirection
  };
}

function providerRequestBase({ productionSpec, brandProfile, scene }) {
  return {
    productionId: productionSpec.id,
    sceneId: scene.id,
    scriptAudioReference: productionSpec.narrationAudio,
    brandProfile,
    productionStyle: {
      tone: productionSpec.tone,
      visualDirection: productionSpec.visualDirection,
      captionDirection: productionSpec.captionDirection,
      cameraDirection: productionSpec.cameraDirection,
      musicDirection: productionSpec.musicDirection,
      avatarDirection: productionSpec.avatarDirection,
      globalStyleNotes: productionSpec.globalStyleNotes
    },
    sceneDirection: {
      visualType: scene.visualType,
      visualPrompt: scene.visualPrompt,
      visualDirection: scene.useProductionStyle ? productionSpec.visualDirection : scene.visualDirection,
      cameraDirection: scene.useProductionStyle ? productionSpec.cameraDirection : scene.cameraDirection,
      captionDirection: scene.useProductionStyle ? productionSpec.captionDirection : scene.captionDirection,
      avatarDirection: scene.useProductionStyle ? productionSpec.avatarDirection : scene.avatarDirection,
      notes: scene.notes
    },
    target: {
      duration: scene.estimatedDuration,
      aspectRatio: productionSpec.aspectRatio,
      platform: productionSpec.platform,
      format: productionSpec.format
    }
  };
}

export function targetDefaults(platform, brandProfile) {
  return {
    ...DEFAULT_FORMATS[DEFAULT_PLATFORM],
    ...(DEFAULT_FORMATS[platform] || {}),
    ...(brandProfile.platformPreferences?.[platform] || {})
  };
}

export function estimateDuration(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(3, Math.ceil(words / 2.4));
}

function buildVisualPrompt(scriptText, visualDirection, brandProfile) {
  const phrase = scriptText.split(/\s+/).slice(0, 12).join(" ");
  return `${brandProfile.name} style: ${visualDirection}. Visualize "${phrase}" with ${brandProfile.backgroundPreference}.`;
}

function createId(prefix) {
  if (crypto.randomUUID) return crypto.randomUUID();
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}-${Date.now().toString(36)}-${[...random].map((part) => part.toString(36)).join("")}`;
}
