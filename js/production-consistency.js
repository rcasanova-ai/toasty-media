export function checkProductionConsistency({ productionSpec, brandProfile, scenes }) {
  const sceneResults = scenes.map((scene) => checkSceneConsistency({ scene, productionSpec, brandProfile }));
  const warnings = sceneResults.flatMap((result) => result.messages.map((message) => `Scene ${result.order}: ${message}`));
  return {
    status: sceneResults.some((result) => result.status === "missing")
      ? "missing"
      : sceneResults.some((result) => result.status === "warning")
        ? "warning"
        : "aligned",
    sceneResults,
    warnings,
    summary: summaryFor(warnings.length, sceneResults.length)
  };
}

export function checkSceneConsistency({ scene, productionSpec, brandProfile }) {
  const messages = [];
  const visualDirection = scene.useProductionStyle ? productionSpec.visualDirection : scene.visualDirection;
  const captionDirection = scene.useProductionStyle ? productionSpec.captionDirection : scene.captionDirection;
  const cameraDirection = scene.useProductionStyle ? productionSpec.cameraDirection : scene.cameraDirection;
  const avatarDirection = scene.useProductionStyle ? productionSpec.avatarDirection : scene.avatarDirection;

  if (!scene.scriptText?.trim()) messages.push("missing script");
  if (!visualDirection?.trim()) messages.push("missing visual direction");
  if (!captionDirection?.trim()) messages.push("missing caption direction");
  if (!scene.captionText?.trim()) messages.push("missing caption text");
  if ((scene.captionText || "").length > 118) messages.push("caption is too long");
  if (scene.visualType === "Avatar" && !avatarDirection?.trim()) messages.push("missing avatar direction");
  if (scene.visualType === "Screen capture" && /cinematic|firelight|organic/i.test(productionSpec.visualDirection || "")) {
    messages.push("screen capture may need a stronger brand treatment");
  }
  if (scene.visualType !== "Text/card" && !scene.visualAssetId) messages.push("missing visual asset");
  if (!scene.audioId && !productionSpec.narrationAudio) messages.push("missing real narration");

  const avoidPhrase = (brandProfile.avoidPhrases || []).find((phrase) => phrase && new RegExp(escapeRegExp(phrase), "i").test(scene.scriptText || ""));
  if (avoidPhrase) messages.push(`uses avoided phrase "${avoidPhrase}"`);

  const finalScene = scene.order === productionSpec.scenes.length;
  if (finalScene && productionSpec.cta && !new RegExp(keywordFor(productionSpec.cta), "i").test(scene.scriptText || "")) {
    messages.push("final scene may be missing CTA");
  }

  return {
    sceneId: scene.id,
    order: scene.order,
    status: messages.some((message) => /^missing/.test(message)) ? "missing" : messages.length ? "warning" : "aligned",
    messages
  };
}

function summaryFor(warningCount, sceneCount) {
  if (!sceneCount) return "No scenes to check yet.";
  if (!warningCount) return "Everything is on-brand and ready for review.";
  return `${warningCount} brand or production issue${warningCount === 1 ? "" : "s"} need attention.`;
}

function keywordFor(value) {
  return escapeRegExp(value.split(/\s+/).filter((word) => word.length > 3)[0] || value.split(/\s+/)[0] || "");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
