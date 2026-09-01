import { checkProductionConsistency } from "./production-consistency.js";
import { createProductionSpec, createScene, targetDefaults } from "./production-spec.js";

export class ToastyConcierge {
  constructor({ provider = devCreativeProvider } = {}) {
    this.provider = provider;
  }

  generateAngles({ source, brandProfile }) {
    return this.provider.generateAngles({ source, brandProfile });
  }

  generateProductionSpec({ project, brandProfile, angle }) {
    return createProductionSpec({
      project,
      brandProfile,
      angle,
      script: project.script,
      scenes: project.scenes
    });
  }

  generateScript({ project, brandProfile, angle }) {
    const script = this.provider.generateScript({ source: project.source, brandProfile, angle });
    const productionSpec = createProductionSpec({
      project,
      brandProfile,
      angle,
      script
    });
    return {
      script,
      productionSpec,
      scenes: this.generateScenePlan({ script: script.body, productionSpec, brandProfile })
    };
  }

  generateScenePlan({ script, productionSpec, brandProfile }) {
    return script
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 7)
      .map((line, index) => createScene({
        order: index + 1,
        scriptText: line,
        productionSpec,
        brandProfile
      }));
  }

  rewriteScene({ scene, instruction, productionSpec, brandProfile }) {
    const rewritten = `${scene.scriptText} ${instruction || brandProfile.preferredPhrases?.[0] || ""}`.trim();
    return {
      ...scene,
      scriptText: rewritten,
      script: rewritten,
      captionText: rewritten,
      captions: rewritten,
      visualPrompt: this.suggestVisualDirection({ scene: { ...scene, scriptText: rewritten }, productionSpec, brandProfile })
    };
  }

  suggestVisualDirection({ scene, productionSpec, brandProfile }) {
    const direction = scene.useProductionStyle ? productionSpec.visualDirection : scene.visualDirection;
    return `${brandProfile.name} visual: ${direction}. Keep it ${brandProfile.toneOfVoice}. Beat: ${scene.scriptText}`;
  }

  checkBrandConsistency({ productionSpec, brandProfile, scenes }) {
    return checkProductionConsistency({ productionSpec, brandProfile, scenes });
  }

  suggestCTA({ productionSpec, brandProfile }) {
    return `${brandProfile.ctaStyle}: ${productionSpec.objective}`;
  }

  suggestForStage({ stage, project, brandProfile, productionSpec, consistency }) {
    if (stage === "source") return `Toasty suggests: keep the idea tied to ${brandProfile.toneOfVoice} and one visible proof.`;
    if (stage === "script" && project.angles.length) {
      const selectedIndex = Math.max(0, project.angles.findIndex((angle) => angle.id === project.selectedAngleId));
      return `Toasty suggests: angle ${selectedIndex + 1} best fits ${brandProfile.name} when the hook stays punchy.`;
    }
    if (stage === "script") return "Toasty suggests: generate angles before polishing the script.";
    if (stage === "record") return "Toasty suggests: use your real narration as the master track for avatar, captions, and render timing.";
    if (stage === "scenes") {
      const warning = consistency.sceneResults.find((result) => result.status !== "aligned");
      return warning ? `Toasty suggests: scene ${warning.order} needs ${warning.messages[0]}.` : "Toasty suggests: the scene plan is carrying the production style.";
    }
    if (stage === "assets") {
      const missing = consistency.sceneResults.filter((result) => result.messages.includes("missing visual asset"));
      return missing.length ? `Toasty suggests: scenes ${missing.map((item) => item.order).join(", ")} need matching visuals.` : "Toasty suggests: visuals are mapped to the current brand direction.";
    }
    if (stage === "review") return `Toasty suggests: ${consistency.summary}`;
    if (stage === "export") return "Toasty suggests: export the manifest when voice, visuals, captions, and brand direction are aligned.";
    return `Toasty suggests: keep the production ${productionSpec?.format || "short"} and unmistakably ${brandProfile.name}.`;
  }
}

const devCreativeProvider = {
  generateAngles({ source, brandProfile }) {
    const topic = source.topic || "this idea";
    const audience = source.audience || source.notes || source.sourceText || "busy viewers";
    return [
      {
        id: createId(),
        hook: `Make ${topic} worth watching in the first five seconds`,
        promise: `A ${brandProfile.toneOfVoice} opener with ${brandProfile.visualStyle}.`,
        audience: summarize(audience),
        brandFit: `Uses ${brandProfile.captionStyle} and avoids ${brandProfile.forbiddenStyles[0] || "off-brand styles"}.`
      },
      {
        id: createId(),
        hook: `The proof that turns ${topic} from idea into production`,
        promise: `A practical story with ${brandProfile.writingStyle}.`,
        audience: summarize(audience),
        brandFit: `Built around ${brandProfile.ctaStyle}.`
      },
      {
        id: createId(),
        hook: `Stop explaining ${topic}. Show the moment it changes something.`,
        promise: `A visual-first angle paced for ${source.platform || "short-form"}.`,
        audience: summarize(audience),
        brandFit: `Leans into ${brandProfile.backgroundPreference}.`
      }
    ];
  },

  generateScript({ source, brandProfile, angle }) {
    const platform = source.platform || "YouTube Shorts";
    const defaults = targetDefaults(platform, brandProfile);
    const topic = source.topic || "the idea";
    const hook = angle?.hook || `Make ${topic} worth watching.`;
    const body = [
      hook,
      `Here is the ${brandProfile.name} way to frame it: start with the proof, then make the human point.`,
      `For ${platform}, keep the pacing ${defaults.pacing || "tight"} and the visuals ${brandProfile.visualStyle}.`,
      `Use the creator's real voice as the trust signal. The avatar and B-roll are supporting layers, not the performance.`,
      `The move is simple: ${brandProfile.ctaStyle}.`
    ].join("\n");
    return {
      hook,
      body,
      cta: `${brandProfile.ctaStyle}: pick the one scene that proves the point.`,
      title: `${topic}: ${brandProfile.preferredPhrases?.[0] || "production proof"}`,
      tone: brandProfile.toneOfVoice,
      visualDirection: brandProfile.visualStyle,
      captionDirection: brandProfile.captionStyle
    };
  }
};

function summarize(value) {
  return value.trim().split(/\s+/).slice(0, 12).join(" ") || "short-form audience";
}

function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `concierge-${Date.now().toString(36)}-${[...random].map((part) => part.toString(36)).join("")}`;
}
