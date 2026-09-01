import { LocalIsolatedRecorder } from "./recording.js";
import { getBrandProfile, getBrandProfiles } from "./brand-profile.js";
import { deleteMediaBlob, hydrateMediaUrls, saveMediaBlob } from "./media-store.js";
import { checkProductionConsistency } from "./production-consistency.js";
import { createProductionSpec, createProviderRequests, createScene, estimateDuration, upgradeScene } from "./production-spec.js";
import { buildTimeline, renderProductionMp4, renderReadiness } from "./render-client.js";
import { ToastyConcierge } from "./toasty-concierge.js";

const STAGES = ["source", "script", "record", "scenes", "assets", "assemble", "review", "export"];
const STAGE_LABELS = {
  source: "Idea",
  script: "Script",
  record: "Record",
  scenes: "Scenes",
  assets: "Assets",
  assemble: "Assemble",
  review: "Review",
  export: "Export"
};
const STORAGE_KEY = "toasty-ai-production-poc";
const QUICK_ASSET_KINDS = ["video", "image", "audio"];
const QUICK_FORMATS = {
  original: { platform: "Original", aspectRatio: "original", format: "original" },
  "16:9": { platform: "LinkedIn", aspectRatio: "16:9", format: "landscape video" },
  "9:16": { platform: "YouTube Shorts", aspectRatio: "9:16", format: "vertical short" },
  "1:1": { platform: "Generic", aspectRatio: "1:1", format: "square video" }
};

const providers = {
  avatar: {
    name: "Manual avatar provider",
    attach(file) {
      return file ? fileAsset(file, "avatar") : null;
    }
  },
  visual: {
    name: "Manual visual provider",
    attach(file) {
      return file ? fileAsset(file, "visual") : null;
    }
  },
  caption: {
    name: "Dev caption provider",
    fromScene(scene) {
      return scene.script;
    }
  },
  render: {
    name: "Manifest export provider",
    export(project) {
      return {
        provider: this.name,
        exportedAt: new Date().toISOString(),
        project
      };
    }
  }
};

export class AIProductionController {
  constructor({ root = document, getBrandTheme = () => "toasty", onBrandChange = () => {} } = {}) {
    this.root = root;
    this.getBrandTheme = getBrandTheme;
    this.onBrandChange = onBrandChange;
    this.state = loadProject();
    this.recorder = null;
    this.recordingStartedAt = null;
    this.recordingTimer = null;
    this.audioUrl = null;
    this.renderedVideo = null;
    this.concierge = new ToastyConcierge();
    this.elements = this.getElements();
  }

  async init() {
    this.mountTabs();
    this.bind();
    this.refreshProductionSpec();
    this.state = await hydrateMediaUrls(this.state);
    this.audioUrl = this.state.audio?.localPreviewUrl || null;
    this.render();
    if (!LocalIsolatedRecorder.isSupported()) {
      this.elements.aiRecordingNote.textContent = "Audio recording is unavailable in this browser. Use current Chrome for the recording proof.";
      this.elements.aiRecordToggle.disabled = true;
    }
  }

  getElements() {
    return {
      workbench: this.root.querySelector("#aiProductionWorkbench"),
      masthead: this.root.querySelector("#aiStudioMasthead"),
      shell: this.root.querySelector(".studio-shell"),
      grid: this.root.querySelector(".studio-grid"),
      livePanels: [...this.root.querySelectorAll(".live-studio-panel")],
      modeButtons: [...this.root.querySelectorAll("[data-studio-mode]")],
      railLeft: this.root.querySelector(".rail-left"),
      railRight: this.root.querySelector(".rail-right"),
      tabs: this.root.querySelector("#aiWorkflowTabs"),
      stages: [...this.root.querySelectorAll(".workflow-stage")],
      aiBrandProfile: this.root.querySelector("#aiBrandProfile"),
      topic: this.root.querySelector("#aiTopic"),
      url: this.root.querySelector("#aiUrl"),
      audience: this.root.querySelector("#aiAudience"),
      objective: this.root.querySelector("#aiObjective"),
      platform: this.root.querySelector("#aiPlatform"),
      aspectRatio: this.root.querySelector("#aiAspectRatio"),
      targetDuration: this.root.querySelector("#aiTargetDuration"),
      notes: this.root.querySelector("#aiNotes"),
      sourceText: this.root.querySelector("#aiSourceText"),
      conciergeNote: this.root.querySelector("#conciergeNote"),
      creativeBrief: this.root.querySelector("#creativeBrief"),
      generateAngles: this.root.querySelector("#generateAngles"),
      angleGrid: this.root.querySelector("#angleGrid"),
      generateScript: this.root.querySelector("#generateScript"),
      scriptHook: this.root.querySelector("#scriptHook"),
      scriptBody: this.root.querySelector("#scriptBody"),
      scriptCta: this.root.querySelector("#scriptCta"),
      scriptTitle: this.root.querySelector("#scriptTitle"),
      aiRecordingState: this.root.querySelector("#aiRecordingState"),
      aiRecordingLabel: this.root.querySelector("#aiRecordingLabel"),
      aiRecordingNote: this.root.querySelector("#aiRecordingNote"),
      aiRecordingTimer: this.root.querySelector("#aiRecordingTimer"),
      aiRecordToggle: this.root.querySelector("#aiRecordToggle"),
      aiAudioPlayback: this.root.querySelector("#aiAudioPlayback"),
      downloadAiAudio: this.root.querySelector("#downloadAiAudio"),
      exportNarrationForAvatar: this.root.querySelector("#exportNarrationForAvatar"),
      digitalTwinUpload: this.root.querySelector("#digitalTwinUpload"),
      digitalTwinPreview: this.root.querySelector("#digitalTwinPreview"),
      addScene: this.root.querySelector("#addScene"),
      regenerateScenes: this.root.querySelector("#regenerateScenes"),
      sceneList: this.root.querySelector("#sceneList"),
      avatarUpload: this.root.querySelector("#avatarUpload"),
      visualUpload: this.root.querySelector("#visualUpload"),
      sceneAssetList: this.root.querySelector("#sceneAssetList"),
      timelineList: this.root.querySelector("#timelineList"),
      reviewDuration: this.root.querySelector("#reviewDuration"),
      reviewWarnings: this.root.querySelector("#reviewWarnings"),
      reviewList: this.root.querySelector("#reviewList"),
      exportManifest: this.root.querySelector("#exportManifest"),
      renderVideo: this.root.querySelector("#renderVideo"),
      downloadRenderedMp4: this.root.querySelector("#downloadRenderedMp4"),
      renderStatus: this.root.querySelector("#renderStatus"),
      quickToastScreen: this.root.querySelector("#quickToastScreen"),
      createWorkflow: this.root.querySelector("#createWorkflow"),
      quickDropZone: this.root.querySelector("#quickDropZone"),
      quickMediaUpload: this.root.querySelector("#quickMediaUpload"),
      quickFormat: this.root.querySelector("#quickFormat"),
      quickIntro: this.root.querySelector("#quickIntro"),
      quickOutro: this.root.querySelector("#quickOutro"),
      quickLowerThird: this.root.querySelector("#quickLowerThird"),
      quickWatermark: this.root.querySelector("#quickWatermark"),
      quickCaptions: this.root.querySelector("#quickCaptions"),
      quickNormalizeAudio: this.root.querySelector("#quickNormalizeAudio"),
      quickToastIt: this.root.querySelector("#quickToastIt"),
      startCreateWorkflow: this.root.querySelector("#startCreateWorkflow"),
      backToQuickToast: this.root.querySelector("#backToQuickToast"),
      quickAssetStrip: this.root.querySelector("#quickAssetStrip"),
      quickPreview: this.root.querySelector("#quickPreview"),
      quickPreviewList: this.root.querySelector("#quickPreviewList"),
      quickRenderVideo: this.root.querySelector("#quickRenderVideo"),
      quickDownloadRenderedMp4: this.root.querySelector("#quickDownloadRenderedMp4"),
      quickRenderStatus: this.root.querySelector("#quickRenderStatus")
    };
  }

  bind() {
    this.elements.modeButtons.forEach((button) => {
      button.addEventListener("click", () => this.setMode(button.dataset.studioMode));
    });
    this.elements.aiBrandProfile.addEventListener("change", () => {
      this.onBrandChange(this.elements.aiBrandProfile.value);
      this.refreshProductionSpec();
      this.saveAndRender();
    });
    this.elements.generateAngles.addEventListener("click", () => this.generateAngles());
    this.elements.generateScript.addEventListener("click", () => this.generateScript());
    this.elements.aiRecordToggle.addEventListener("click", () => this.toggleRecording());
    this.elements.downloadAiAudio.addEventListener("click", () => this.downloadAudio());
    this.elements.exportNarrationForAvatar.addEventListener("click", () => this.downloadAudio());
    this.elements.addScene.addEventListener("click", () => this.addScene());
    this.elements.regenerateScenes.addEventListener("click", () => this.regenerateSceneMetadata());
    this.elements.avatarUpload.addEventListener("change", () => this.attachAsset(this.elements.avatarUpload.files[0], "avatar"));
    this.elements.visualUpload.addEventListener("change", () => this.attachAsset(this.elements.visualUpload.files[0], "visual"));
    this.elements.digitalTwinUpload.addEventListener("change", () => this.attachAsset(this.elements.digitalTwinUpload.files[0], "avatar"));
    this.elements.exportManifest.addEventListener("click", () => this.exportManifest());
    this.elements.renderVideo.addEventListener("click", () => this.renderVideo());
    this.elements.downloadRenderedMp4.addEventListener("click", () => this.downloadRenderedMp4());
    this.elements.quickMediaUpload.addEventListener("change", () => this.addQuickFiles(this.elements.quickMediaUpload.files));
    this.elements.quickFormat.addEventListener("change", () => this.updateQuickSettings());
    [this.elements.quickIntro, this.elements.quickOutro, this.elements.quickLowerThird, this.elements.quickWatermark, this.elements.quickCaptions, this.elements.quickNormalizeAudio].forEach((input) => {
      input.addEventListener("change", () => this.updateQuickSettings());
    });
    this.elements.quickToastIt.addEventListener("click", () => this.prepareQuickToast());
    this.elements.quickRenderVideo.addEventListener("click", () => this.renderVideo({ quick: true }));
    this.elements.quickDownloadRenderedMp4.addEventListener("click", () => this.downloadRenderedMp4());
    this.elements.startCreateWorkflow.addEventListener("click", () => {
      this.state.productionEntry = "create";
      this.saveAndRender();
    });
    this.elements.backToQuickToast.addEventListener("click", () => {
      this.state.productionEntry = "quick";
      this.saveAndRender();
    });
    ["dragenter", "dragover"].forEach((eventName) => {
      this.elements.quickDropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        this.elements.quickDropZone.dataset.dragging = "true";
      });
    });
    ["dragleave", "drop"].forEach((eventName) => {
      this.elements.quickDropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        this.elements.quickDropZone.dataset.dragging = "false";
      });
    });
    this.elements.quickDropZone.addEventListener("drop", (event) => this.addQuickFiles(event.dataTransfer.files));
    [this.elements.topic, this.elements.url, this.elements.audience, this.elements.objective, this.elements.platform, this.elements.aspectRatio, this.elements.targetDuration, this.elements.notes, this.elements.sourceText].forEach((input) => {
      input.addEventListener("input", () => this.updateSource());
      input.addEventListener("change", () => this.updateSource());
    });
    [this.elements.scriptHook, this.elements.scriptBody, this.elements.scriptCta, this.elements.scriptTitle].forEach((input) => {
      input.addEventListener("input", () => this.updateScript());
    });
  }

  mountTabs() {
    this.elements.tabs.replaceChildren(
      ...STAGES.map((stage) => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = STAGE_LABELS[stage] || stage;
        button.dataset.stageTarget = stage;
        button.addEventListener("click", () => {
          this.state.currentStage = stage;
          this.saveAndRender();
        });
        return button;
      })
    );
  }

  setMode(mode) {
    this.state.mode = mode;
    this.saveAndRender();
  }

  setStage(stage) {
    this.state.currentStage = stage;
    this.saveAndRender();
  }

  updateSource() {
    this.state.source = {
      topic: this.elements.topic.value.trim(),
      url: this.elements.url.value.trim(),
      audience: this.elements.audience.value.trim(),
      objective: this.elements.objective.value.trim(),
      platform: this.elements.platform.value,
      aspectRatio: this.elements.aspectRatio.value,
      targetDuration: Number(this.elements.targetDuration.value) || 45,
      notes: this.elements.notes.value.trim(),
      sourceText: this.elements.sourceText.value.trim()
    };
    this.refreshProductionSpec();
    saveProject(this.state);
  }

  updateScript() {
    this.state.script = {
      hook: this.elements.scriptHook.value,
      body: this.elements.scriptBody.value,
      cta: this.elements.scriptCta.value,
      title: this.elements.scriptTitle.value
    };
    this.refreshProductionSpec();
    saveProject(this.state);
  }

  generateAngles() {
    this.updateSource();
    this.state.angles = this.concierge.generateAngles({
      source: this.state.source,
      brandProfile: this.brandProfile()
    });
    this.state.selectedAngleId = this.state.angles[0]?.id || null;
    this.refreshProductionSpec();
    this.state.currentStage = "script";
    this.saveAndRender();
  }

  generateScript() {
    this.updateSource();
    const { script, productionSpec, scenes } = this.concierge.generateScript({
      project: this.state,
      brandProfile: this.brandProfile(),
      angle: this.selectedAngle()
    });
    this.state.script = {
      hook: script.hook,
      body: script.body,
      cta: script.cta,
      title: script.title
    };
    this.state.spec = productionSpec;
    this.state.scenes = this.applyConsistency(scenes.map((scene) => ({
      ...scene,
      audioId: this.state.audio?.id || scene.audioId,
      narrationStatus: this.state.audio ? "recorded" : scene.narrationStatus
    })));
    this.refreshProductionSpec();
    this.state.currentStage = "script";
    this.saveAndRender();
  }

  async addQuickFiles(fileList) {
    const files = [...fileList].filter((file) => QUICK_ASSET_KINDS.some((kind) => file.type.startsWith(`${kind}/`)));
    if (!files.length) {
      this.elements.quickRenderStatus.textContent = "Choose video, image, or audio files.";
      return;
    }
    const assets = [];
    for (const file of files) {
      const mediaId = createId();
      const metadata = await mediaMetadata(file);
      await saveMediaBlob({
        id: mediaId,
        blob: file,
        metadata: { kind: "quickContent", projectId: this.state.id, fileName: file.name, mimeType: file.type }
      });
      assets.push({
        id: createId(),
        mediaId,
        kind: "quick-content",
        quickKind: quickKind(file),
        name: file.name,
        mimeType: file.type,
        size: file.size,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        localPreviewUrl: URL.createObjectURL(file),
        attachedAt: new Date().toISOString(),
        provider: "Quick Toast upload"
      });
    }
    this.state.quick.assets.push(...assets);
    this.state.quick.prepared = false;
    this.clearRenderedVideo();
    this.elements.quickMediaUpload.value = "";
    this.refreshProductionSpec();
    this.saveAndRender();
  }

  async removeQuickAsset(assetId) {
    const asset = this.state.quick.assets.find((candidate) => candidate.id === assetId);
    if (asset?.mediaId) await deleteMediaBlob(asset.mediaId);
    if (asset?.localPreviewUrl) URL.revokeObjectURL(asset.localPreviewUrl);
    this.state.quick.assets = this.state.quick.assets.filter((candidate) => candidate.id !== assetId);
    this.state.assets = this.state.assets.filter((candidate) => candidate.id !== assetId);
    this.state.scenes = renumber(this.state.scenes.filter((scene) => scene.visualAssetId !== assetId));
    this.state.quick.prepared = false;
    this.clearRenderedVideo();
    this.refreshProductionSpec();
    this.saveAndRender();
  }

  moveQuickAsset(assetId, direction) {
    const index = this.state.quick.assets.findIndex((asset) => asset.id === assetId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= this.state.quick.assets.length) return;
    const assets = [...this.state.quick.assets];
    [assets[index], assets[nextIndex]] = [assets[nextIndex], assets[index]];
    this.state.quick.assets = assets;
    this.state.quick.prepared = false;
    this.clearRenderedVideo();
    this.saveAndRender();
  }

  updateQuickSettings() {
    this.state.quick.format = this.elements.quickFormat.value;
    this.state.quick.settings = {
      intro: this.elements.quickIntro.checked,
      outro: this.elements.quickOutro.checked,
      lowerThird: this.elements.quickLowerThird.checked,
      watermark: this.elements.quickWatermark.checked,
      captions: this.elements.quickCaptions.checked,
      normalizeAudio: this.elements.quickNormalizeAudio.checked
    };
    this.state.quick.prepared = false;
    this.clearRenderedVideo();
    this.refreshProductionSpec();
    saveProject(this.state);
    this.renderQuickToast();
  }

  prepareQuickToast() {
    this.updateQuickSettings();
    const brandProfile = this.brandProfile();
    const assets = this.state.quick.assets;
    if (!assets.length) {
      this.elements.quickRenderStatus.textContent = "Drop in at least one media file first.";
      return;
    }

    const format = quickFormatFor(this.state.quick.format, assets);
    const title = quickTitle(assets, brandProfile);
    const sourceDescription = assets.map((asset) => `${asset.quickKind}: ${asset.name}`).join("\n");
    this.state.source = {
      ...this.state.source,
      topic: title,
      audience: this.state.source.audience || "the creator's existing audience",
      objective: this.state.source.objective || "turn existing content into a publishable branded video",
      platform: format.platform,
      aspectRatio: format.aspectRatio,
      format: format.format,
      targetDuration: Math.round(quickDuration(assets, this.state.quick.settings)),
      notes: "Quick Toast production prepared from uploaded media.",
      sourceText: sourceDescription
    };
    this.state.script = {
      hook: "",
      body: sourceDescription,
      cta: brandProfile.defaultCTA || brandProfile.ctaStyle || "Follow for more.",
      title
    };
    this.state.assets = mergeQuickAssets(this.state.assets, assets);
    this.state.audio = primaryQuickAudio(assets);
    this.state.scenes = buildQuickScenes({
      assets,
      brandProfile,
      settings: this.state.quick.settings,
      productionSpec: this.state.spec
    });
    this.state.quick.prepared = true;
    this.clearRenderedVideo();
    this.refreshProductionSpec();
    this.saveAndRender();
  }

  async toggleRecording() {
    try {
      if (this.recorder) {
        this.elements.aiRecordToggle.disabled = true;
        const result = await this.recorder.stop();
        this.recorder = null;
        this.stopRecordingTimer();
        await this.captureAudio(result);
        this.elements.aiRecordToggle.disabled = false;
        this.saveAndRender();
        return;
      }

      this.recorder = new LocalIsolatedRecorder({
        role: "creator-voice",
        roomId: this.state.id,
        mode: "audio",
        saveOnStop: false,
        status: (message) => {
          this.elements.aiRecordingNote.textContent = message;
        }
      });
      await this.recorder.start();
      this.recordingStartedAt = Date.now();
      this.recordingTimer = window.setInterval(() => this.updateRecordingTimer(), 1000);
      this.renderRecording();
    } catch (error) {
      this.recorder = null;
      this.stopRecordingTimer();
      this.elements.aiRecordingNote.textContent = `Recording failed: ${humanizeError(error)}`;
      this.elements.aiRecordToggle.disabled = false;
      this.renderRecording();
    }
  }

  async captureAudio({ session, audioBlob }) {
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioUrl = URL.createObjectURL(audioBlob);
    const mediaId = createId();
    await saveMediaBlob({
      id: mediaId,
      blob: audioBlob,
      metadata: { kind: "narrationAudio", projectId: this.state.id, fileName: "creator-voice.webm" }
    });
    this.state.audio = {
      id: createId(),
      mediaId,
      kind: "narrationAudio",
      fileName: "creator-voice.webm",
      mimeType: audioBlob.type || "audio/webm",
      size: audioBlob.size,
      duration: elapsedSeconds(session.startedAt, session.stoppedAt),
      recordedAt: session.stoppedAt,
      localPreviewUrl: this.audioUrl
    };
    this.state.scenes = this.state.scenes.map((scene) => ({
      ...scene,
      audioId: this.state.audio.id,
      narrationStatus: "recorded",
      assetStatus: scene.assetStatus === "Missing voice" ? "Needs visual" : scene.assetStatus
    }));
    this.refreshProductionSpec();
    this.elements.aiAudioPlayback.src = this.audioUrl;
    this.elements.aiAudioPlayback.hidden = false;
    this.elements.downloadAiAudio.disabled = false;
    this.elements.aiRecordingNote.textContent = "Voice recording attached to this production.";
  }

  downloadAudio() {
    if (!this.audioUrl) return;
    const link = document.createElement("a");
    link.href = this.audioUrl;
    link.download = this.state.audio?.fileName || "creator-voice.webm";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  async renderVideo({ quick = false } = {}) {
    if (quick) {
      this.prepareQuickToast();
    } else {
      this.updateSource();
      this.updateScript();
    }
    this.refreshProductionSpec();
    const readiness = renderReadiness({ project: this.state, consistency: this.state.consistency });
    if (!readiness.ready) {
      this.elements.renderStatus.textContent = `Not ready: ${readiness.warnings.slice(0, 3).join(", ")}`;
      this.elements.quickRenderStatus.textContent = `Not ready: ${readiness.warnings.slice(0, 3).join(", ")}`;
      return;
    }
    try {
      this.elements.renderVideo.disabled = true;
      this.elements.quickRenderVideo.disabled = true;
      this.elements.downloadRenderedMp4.disabled = true;
      this.elements.quickDownloadRenderedMp4.disabled = true;
      const result = await renderProductionMp4({
        project: this.state,
        productionSpec: this.state.spec,
        brandProfile: this.brandProfile(),
        onProgress: (message) => {
          this.elements.renderStatus.textContent = message;
          this.elements.quickRenderStatus.textContent = message;
        }
      });
      if (this.renderedVideo?.url) URL.revokeObjectURL(this.renderedVideo.url);
      this.renderedVideo = result;
      this.elements.downloadRenderedMp4.disabled = false;
      this.elements.quickDownloadRenderedMp4.disabled = false;
      this.elements.renderStatus.textContent = "MP4 ready to download.";
      this.elements.quickRenderStatus.textContent = "MP4 ready to download.";
    } catch (error) {
      this.elements.renderStatus.textContent = humanizeRenderError(error);
      this.elements.quickRenderStatus.textContent = humanizeRenderError(error);
    } finally {
      this.elements.renderVideo.disabled = false;
      this.elements.quickRenderVideo.disabled = false;
    }
  }

  downloadRenderedMp4() {
    if (!this.renderedVideo?.url) return;
    const link = document.createElement("a");
    link.href = this.renderedVideo.url;
    link.download = this.renderedVideo.fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  clearRenderedVideo() {
    if (this.renderedVideo?.url) URL.revokeObjectURL(this.renderedVideo.url);
    this.renderedVideo = null;
  }

  addScene() {
    const order = this.state.scenes.length + 1;
    this.refreshProductionSpec();
    this.state.scenes.push(createScene({
      order,
      scriptText: "New scene beat.",
      productionSpec: this.state.spec,
      brandProfile: this.brandProfile(),
      overrides: { audioId: this.state.audio?.id || null, narrationStatus: this.state.audio ? "recorded" : "needs-recording" }
    }));
    this.state.scenes = this.applyConsistency(this.state.scenes);
    this.refreshProductionSpec();
    this.saveAndRender();
  }

  deleteScene(sceneId) {
    this.state.scenes = renumber(this.state.scenes.filter((scene) => scene.id !== sceneId));
    this.refreshProductionSpec();
    this.saveAndRender();
  }

  moveScene(sceneId, direction) {
    const index = this.state.scenes.findIndex((scene) => scene.id === sceneId);
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= this.state.scenes.length) return;
    const scenes = [...this.state.scenes];
    [scenes[index], scenes[nextIndex]] = [scenes[nextIndex], scenes[index]];
    this.state.scenes = renumber(scenes);
    this.refreshProductionSpec();
    this.saveAndRender();
  }

  updateScene(sceneId, field, value) {
    this.state.scenes = this.state.scenes.map((scene) => {
      if (scene.id !== sceneId) return scene;
      const patch = scenePatch(field, value, this.state.spec);
      return {
        ...scene,
        ...patch
      };
    });
    this.state.scenes = this.applyConsistency(this.state.scenes);
    this.refreshProductionSpec();
    saveProject(this.state);
    this.renderScenes();
    this.renderAssembleReview();
    this.renderConcierge();
  }

  regenerateSceneMetadata() {
    this.refreshProductionSpec();
    this.state.scenes = this.state.scenes.map((scene) => ({
      ...scene,
      estimatedDuration: estimateDuration(scene.scriptText || scene.script),
      visualPrompt: this.concierge.suggestVisualDirection({
        scene,
        productionSpec: this.state.spec,
        brandProfile: this.brandProfile()
      }),
      captions: scene.captionText || scene.scriptText || scene.script,
      captionText: scene.captionText || scene.scriptText || scene.script,
      assetStatus: statusFor(scene, this.state)
    }));
    this.state.scenes = this.applyConsistency(this.state.scenes);
    this.refreshProductionSpec();
    this.saveAndRender();
  }

  async attachAsset(file, type) {
    const provider = type === "avatar" ? providers.avatar : providers.visual;
    let asset = provider.attach(file);
    if (!asset) return;
    const mediaId = createId();
    await saveMediaBlob({
      id: mediaId,
      blob: file,
      metadata: { kind: type, projectId: this.state.id, fileName: file.name }
    });
    asset = { ...asset, mediaId };
    this.state.assets.unshift(asset);
    const targetType = type === "avatar" ? "Avatar" : this.visualTypeForFile(file);
    this.state.scenes = this.state.scenes.map((scene) => {
      if (scene.visualAssetId) return scene;
      return {
        ...scene,
        visualType: targetType,
        visualAssetId: asset.id,
        assetStatus: scene.audioId || this.state.audio ? "Ready for review" : "Missing voice"
      };
    });
    this.state.scenes = this.applyConsistency(this.state.scenes);
    this.refreshProductionSpec();
    this.saveAndRender();
  }

  visualTypeForFile(file) {
    if (file.type.startsWith("image/")) return "Image";
    if (file.type.startsWith("video/")) return "B-roll";
    return "B-roll";
  }

  async attachSceneAsset(sceneId, file) {
    const currentScene = this.state.scenes.find((scene) => scene.id === sceneId);
    if (currentScene?.visualAssetId) await this.removeAsset(currentScene.visualAssetId, { render: false });
    let asset = providers.visual.attach(file);
    if (!asset) return;
    const mediaId = createId();
    await saveMediaBlob({
      id: mediaId,
      blob: file,
      metadata: { kind: "visual", projectId: this.state.id, fileName: file.name, sceneId }
    });
    asset = { ...asset, mediaId, sceneId };
    this.state.assets.unshift(asset);
    this.state.scenes = this.state.scenes.map((scene) => {
      if (scene.id !== sceneId) return scene;
      return {
        ...scene,
        visualType: this.visualTypeForFile(file),
        visualAssetId: asset.id,
        assetStatus: this.state.audio ? "Ready for review" : "Missing voice"
      };
    });
    this.state.scenes = this.applyConsistency(this.state.scenes);
    this.refreshProductionSpec();
    this.saveAndRender();
  }

  async clearSceneAsset(sceneId) {
    const scene = this.state.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene?.visualAssetId) return;
    await this.removeAsset(scene.visualAssetId, { render: false });
    this.state.scenes = this.state.scenes.map((candidate) => (
      candidate.id === sceneId
        ? { ...candidate, visualAssetId: null, assetStatus: "Missing visual" }
        : candidate
    ));
    this.state.scenes = this.applyConsistency(this.state.scenes);
    this.refreshProductionSpec();
    this.saveAndRender();
  }

  async removeAsset(assetId, { render = true } = {}) {
    const asset = this.state.assets.find((candidate) => candidate.id === assetId);
    if (asset?.mediaId) await deleteMediaBlob(asset.mediaId);
    if (asset?.localPreviewUrl) URL.revokeObjectURL(asset.localPreviewUrl);
    this.state.assets = this.state.assets.filter((candidate) => candidate.id !== assetId);
    this.state.scenes = this.state.scenes.map((scene) => (
      scene.visualAssetId === assetId ? { ...scene, visualAssetId: null, assetStatus: "Missing visual" } : scene
    ));
    this.state.scenes = this.applyConsistency(this.state.scenes);
    this.refreshProductionSpec();
    if (render) this.saveAndRender();
  }

  avatarAsset() {
    return this.state.assets.find((asset) => asset.kind === "avatar");
  }

  exportManifest() {
    this.updateSource();
    this.updateScript();
    this.state.scenes = this.applyConsistency(this.state.scenes);
    this.refreshProductionSpec();
    const manifest = providers.render.export(toSerializableProject(this.state, this.brandProfile()));
    const name = `${slugify(this.state.script.title || this.state.source.topic || "ai-production")}-manifest.json`;
    downloadJson(manifest, name);
  }

  selectedAngle() {
    return this.state.angles.find((angle) => angle.id === this.state.selectedAngleId) || this.state.angles[0];
  }

  brandProfile() {
    return getBrandProfile(this.getBrandTheme());
  }

  refreshProductionSpec() {
    const brandProfile = this.brandProfile();
    this.state.brandProfileId = brandProfile.id;
    const upgradedScenes = (this.state.scenes || []).map((scene, index) => upgradeScene(scene, {
      productionSpec: this.state.spec,
      brandProfile,
      order: index + 1
    }));
    this.state.spec = createProductionSpec({
      project: { ...this.state, scenes: upgradedScenes },
      brandProfile,
      angle: this.selectedAngle(),
      script: this.state.script,
      scenes: upgradedScenes
    });
    this.state.scenes = this.applyConsistency(upgradedScenes);
    this.state.spec.scenes = this.state.scenes;
  }

  applyConsistency(scenes) {
    const consistency = checkProductionConsistency({
      productionSpec: this.state.spec || createProductionSpec({
        project: this.state,
        brandProfile: this.brandProfile(),
        angle: this.selectedAngle(),
        script: this.state.script,
        scenes
      }),
      brandProfile: this.brandProfile(),
      scenes
    });
    this.state.consistency = consistency;
    return scenes.map((scene) => {
      const result = consistency.sceneResults.find((item) => item.sceneId === scene.id);
      return {
        ...scene,
        consistencyStatus: result?.status || "missing",
        consistencyMessages: result?.messages || []
      };
    });
  }

  render() {
    const aiMode = this.state.mode === "ai";
    this.elements.shell.dataset.productionMode = this.state.mode;
    this.elements.grid.dataset.productionMode = this.state.mode;
    this.elements.masthead.hidden = !aiMode;
    this.elements.workbench.hidden = !aiMode;
    this.elements.railLeft.hidden = aiMode;
    this.elements.railRight.hidden = aiMode;
    this.elements.livePanels.forEach((panel) => {
      panel.hidden = aiMode;
    });
    const quickEntry = this.state.productionEntry !== "create";
    this.elements.quickToastScreen.hidden = !quickEntry;
    this.elements.createWorkflow.hidden = quickEntry;
    this.elements.modeButtons.forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.studioMode === this.state.mode));
    });
    this.elements.stages.forEach((stage) => {
      stage.hidden = stage.dataset.stage !== this.state.currentStage;
    });
    this.elements.tabs.querySelectorAll("button").forEach((button) => {
      const stage = button.dataset.stageTarget;
      button.setAttribute("aria-pressed", String(stage === this.state.currentStage));
      button.dataset.stageState = this.stageState(stage);
    });
    this.renderBrand();
    this.renderConcierge();
    this.renderSource();
    this.renderAngles();
    this.renderScript();
    this.renderCreativeBrief();
    this.renderRecording();
    this.renderScenes();
    this.renderSceneAssets();
    this.renderAssembleReview();
    this.renderQuickToast();
  }

  renderSource() {
    this.elements.topic.value = this.state.source.topic;
    this.elements.url.value = this.state.source.url;
    this.elements.audience.value = this.state.source.audience || "";
    this.elements.objective.value = this.state.source.objective || "";
    this.elements.platform.value = this.state.source.platform || "YouTube Shorts";
    this.elements.aspectRatio.value = this.state.source.aspectRatio || this.state.spec?.aspectRatio || "9:16";
    this.elements.targetDuration.value = this.state.source.targetDuration || 45;
    this.elements.notes.value = this.state.source.notes;
    this.elements.sourceText.value = this.state.source.sourceText;
  }

  renderQuickToast() {
    const quick = this.state.quick;
    this.elements.quickFormat.value = quick.format || "16:9";
    this.elements.quickIntro.checked = Boolean(quick.settings.intro);
    this.elements.quickOutro.checked = Boolean(quick.settings.outro);
    this.elements.quickLowerThird.checked = Boolean(quick.settings.lowerThird);
    this.elements.quickWatermark.checked = Boolean(quick.settings.watermark);
    this.elements.quickCaptions.checked = Boolean(quick.settings.captions);
    this.elements.quickNormalizeAudio.checked = Boolean(quick.settings.normalizeAudio);
    this.elements.quickToastIt.disabled = !quick.assets.length;
    this.elements.quickAssetStrip.replaceChildren(...quick.assets.map((asset, index) => this.quickAssetCard(asset, index)));
    this.elements.quickPreview.hidden = !quick.prepared;
    if (quick.prepared) {
      const checklist = quickChecklist({
        quick,
        brandProfile: this.brandProfile(),
        project: this.state
      });
      this.elements.quickPreviewList.replaceChildren(...checklist.map((item) => {
        const li = document.createElement("li");
        li.dataset.done = String(item.done);
        li.innerHTML = `<span>${item.done ? "✓" : "!"}</span><strong>${escapeHtml(item.label)}</strong><small>${escapeHtml(item.note)}</small>`;
        return li;
      }));
      this.elements.quickRenderStatus.textContent = this.renderedVideo?.url ? "MP4 ready to download." : "Ready to render with the local helper.";
    } else if (!quick.assets.length) {
      this.elements.quickRenderStatus.textContent = "Drop in content to prepare a production.";
    } else {
      this.elements.quickRenderStatus.textContent = "Ready to Toast.";
    }
    this.elements.quickDownloadRenderedMp4.disabled = !this.renderedVideo?.url;
  }

  quickAssetCard(asset, index) {
    const article = document.createElement("article");
    article.className = "quick-asset-card";
    article.dataset.kind = asset.quickKind;
    article.innerHTML = `
      ${assetPreview(asset)}
      <div>
        <strong>${escapeHtml(asset.name)}</strong>
        <span>${escapeHtml(asset.quickKind)} · ${formatBytes(asset.size)}${asset.duration ? ` · ${Math.round(asset.duration)}s` : ""}</span>
      </div>
      <div class="quick-asset-actions">
        <button class="btn btn-ghost btn-small" type="button" data-move="-1" ${index === 0 ? "disabled" : ""}>Up</button>
        <button class="btn btn-ghost btn-small" type="button" data-move="1" ${index === this.state.quick.assets.length - 1 ? "disabled" : ""}>Down</button>
        <button class="btn btn-danger btn-small" type="button" data-remove>Remove</button>
      </div>
    `;
    article.querySelectorAll("[data-move]").forEach((button) => {
      button.addEventListener("click", () => this.moveQuickAsset(asset.id, Number(button.dataset.move)));
    });
    article.querySelector("[data-remove]").addEventListener("click", () => this.removeQuickAsset(asset.id));
    return article;
  }

  renderBrand() {
    this.elements.aiBrandProfile.replaceChildren(
      ...getBrandProfiles().map((profile) => {
        const option = document.createElement("option");
        option.value = profile.id;
        option.textContent = profile.name;
        return option;
      })
    );
    this.elements.aiBrandProfile.value = this.getBrandTheme();
  }

  renderConcierge() {
    this.elements.conciergeNote.textContent = this.concierge.suggestForStage({
      stage: this.state.currentStage,
      project: this.state,
      brandProfile: this.brandProfile(),
      productionSpec: this.state.spec,
      consistency: this.state.consistency || { sceneResults: [], summary: "No scenes to check yet." }
    });
  }

  renderCreativeBrief() {
    if (!this.state.spec?.script && !this.state.script.body) {
      this.elements.creativeBrief.hidden = true;
      this.elements.creativeBrief.replaceChildren();
      return;
    }
    const spec = this.state.spec;
    const items = [
      ["Objective", spec.objective],
      ["Audience", spec.audience],
      ["Format", `${spec.platform} · ${spec.format} · ${spec.aspectRatio}`],
      ["Target", `${spec.targetDuration}s`],
      ["Tone", spec.tone],
      ["Visual", spec.visualDirection],
      ["Captions", spec.captionDirection],
      ["CTA", spec.cta],
      ["Brand", this.brandProfile().name]
    ];
    this.elements.creativeBrief.hidden = false;
    this.elements.creativeBrief.replaceChildren(
      ...items.map(([label, value]) => {
        const item = document.createElement("div");
        item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value || "Pending"))}</strong>`;
        return item;
      })
    );
  }

  stageState(stage) {
    if (stage === this.state.currentStage) return "current";
    if (this.stageNeedsAttention(stage)) return "warning";
    const currentIndex = STAGES.indexOf(this.state.currentStage);
    const stageIndex = STAGES.indexOf(stage);
    if (stageIndex < currentIndex && this.stageIsComplete(stage)) return "complete";
    return stageIndex < currentIndex ? "warning" : "future";
  }

  stageIsComplete(stage) {
    if (stage === "source") return Boolean(this.state.source.topic || this.state.source.url || this.state.source.notes || this.state.source.sourceText);
    if (stage === "script") return Boolean(this.state.script.body);
    if (stage === "record") return Boolean(this.state.audio);
    if (stage === "scenes") return this.state.scenes.length > 0;
    if (stage === "assets") return this.state.scenes.length > 0 && this.state.scenes.every((scene) => scene.visualType === "Text/card" || scene.visualAssetId);
    if (stage === "assemble") return this.state.scenes.length > 0;
    if (stage === "review") return this.state.scenes.length > 0 && this.state.scenes.every((scene) => !missingFor(scene, this.state).length);
    if (stage === "export") return this.state.scenes.length > 0;
    return false;
  }

  stageNeedsAttention(stage) {
    if (stage === "record") return this.state.scenes.length > 0 && !this.state.audio;
    if (stage === "assets") return this.state.scenes.some((scene) => missingFor(scene, this.state).includes("visual"));
    if (stage === "review") return this.state.scenes.some((scene) => missingFor(scene, this.state).length);
    return false;
  }

  renderAngles() {
    if (!this.state.angles.length) {
      this.elements.angleGrid.replaceChildren(emptyMessage("Generate angles from the Source stage to start."));
      return;
    }
    this.elements.angleGrid.replaceChildren(
      ...this.state.angles.map((angle) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "angle-card";
        button.setAttribute("aria-pressed", String(angle.id === this.state.selectedAngleId));
      button.innerHTML = `<strong>${escapeHtml(angle.hook)}</strong><span>${escapeHtml(angle.promise)}</span><small>${escapeHtml(angle.brandFit || angle.audience)}</small>`;
        button.addEventListener("click", () => {
          this.state.selectedAngleId = angle.id;
          this.saveAndRender();
        });
        return button;
      })
    );
  }

  renderScript() {
    this.elements.scriptHook.value = this.state.script.hook;
    this.elements.scriptBody.value = this.state.script.body;
    this.elements.scriptCta.value = this.state.script.cta;
    this.elements.scriptTitle.value = this.state.script.title;
  }

  renderRecording() {
    const active = Boolean(this.recorder);
    this.elements.aiRecordingState.dataset.active = String(active);
    this.elements.aiRecordToggle.setAttribute("aria-pressed", String(active));
    this.elements.aiRecordToggle.textContent = active ? "Stop recording" : this.state.audio ? "Re-record" : "Start recording";
    this.elements.aiRecordingLabel.textContent = active
      ? "Recording creator voice locally."
      : this.state.audio
        ? `Voice attached: ${formatBytes(this.state.audio.size)}`
        : "Record creator voice for the selected production.";
    this.updateRecordingTimer();
    this.elements.exportNarrationForAvatar.disabled = !this.audioUrl;
    this.elements.downloadAiAudio.disabled = !this.audioUrl;
    if (this.audioUrl) {
      this.elements.aiAudioPlayback.src = this.audioUrl;
      this.elements.aiAudioPlayback.hidden = false;
    }
    if (!active && this.state.audio && !this.audioUrl) {
      this.elements.aiAudioPlayback.hidden = true;
      this.elements.downloadAiAudio.disabled = true;
    }
    this.renderDigitalTwin();
  }

  renderDigitalTwin() {
    const avatar = this.avatarAsset();
    if (!avatar) {
      this.elements.digitalTwinPreview.dataset.empty = "No digital-twin video imported yet";
      this.elements.digitalTwinPreview.replaceChildren();
      return;
    }
    this.elements.digitalTwinPreview.removeAttribute("data-empty");
    const video = document.createElement("video");
    video.src = avatar.localPreviewUrl || "";
    video.controls = true;
    video.playsInline = true;
    const meta = document.createElement("p");
    meta.textContent = `${avatar.name} · ${formatBytes(avatar.size)}${avatar.duration ? ` · ${Math.round(avatar.duration)}s` : ""}`;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn btn-ghost btn-small";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => this.removeAsset(avatar.id));
    this.elements.digitalTwinPreview.replaceChildren(video, meta, remove);
  }

  renderScenes() {
    if (!this.state.scenes.length) {
      this.elements.sceneList.replaceChildren(emptyMessage("Generate a script or add a scene manually."));
      return;
    }
    this.elements.sceneList.replaceChildren(
      ...this.state.scenes.map((scene) => this.sceneRow(scene))
    );
  }

  renderSceneAssets() {
    if (!this.state.scenes.length) {
      this.elements.sceneAssetList.replaceChildren(emptyMessage("Scene asset slots appear after the script is generated."));
      return;
    }
    this.elements.sceneAssetList.replaceChildren(...this.state.scenes.map((scene) => this.sceneAssetRow(scene)));
  }

  sceneAssetRow(scene) {
    const asset = this.state.assets.find((candidate) => candidate.id === scene.visualAssetId);
    const row = document.createElement("article");
    row.className = "scene-asset-row";
    row.innerHTML = `
      <div>
        <strong>Scene ${scene.order || scene.number}</strong>
        <span>${escapeHtml(scene.visualType || "Missing visual")}</span>
      </div>
      ${assetPreview(asset)}
      <label class="file-button">Upload / Replace<input type="file" accept="image/*,video/*"></label>
      <button class="btn btn-ghost btn-small" type="button" ${asset ? "" : "disabled"}>Remove</button>
    `;
    const input = row.querySelector("input");
    input.addEventListener("change", async () => {
      const file = input.files[0];
      if (!file) return;
      await this.attachSceneAsset(scene.id, file);
    });
    row.querySelector("button").addEventListener("click", () => this.clearSceneAsset(scene.id));
    return row;
  }

  sceneRow(scene) {
    const article = document.createElement("article");
    article.className = "scene-row";
    article.innerHTML = `
      <div class="scene-row-head">
        <strong>Scene ${scene.order || scene.number}</strong>
        <span data-consistency="${scene.consistencyStatus || "missing"}">${escapeHtml(consistencyLabel(scene))}</span>
      </div>
      <label>Script text<textarea rows="4" data-scene-field="scriptText">${escapeHtml(scene.scriptText || scene.script)}</textarea></label>
      <div class="scene-controls">
        <label>Duration<input type="number" min="1" step="1" value="${scene.estimatedDuration}" data-scene-field="estimatedDuration"></label>
        <label>Visual
          <select data-scene-field="visualType">
            ${["Avatar", "B-roll", "Image", "Screen capture", "Text/card"].map((type) => `<option value="${type}" ${type === scene.visualType ? "selected" : ""}>${type}</option>`).join("")}
          </select>
        </label>
        <label>Composition
          <select data-scene-field="composition">
            ${[
              ["avatar-full", "Avatar full frame"],
              ["broll-full", "B-roll full frame"],
              ["avatar-pip", "Avatar over B-roll"],
              ["image-full", "Image full frame"],
              ["text-card", "Text card"]
            ].map(([value, label]) => `<option value="${value}" ${value === (scene.composition || compositionForScene(scene)) ? "selected" : ""}>${label}</option>`).join("")}
          </select>
        </label>
        <label class="style-lock"><input type="checkbox" ${scene.useProductionStyle ? "checked" : ""} data-scene-field="useProductionStyle"> Use production style</label>
        <button class="btn btn-ghost btn-small" type="button" data-move="-1">Up</button>
        <button class="btn btn-ghost btn-small" type="button" data-move="1">Down</button>
        <button class="btn btn-danger btn-small" type="button" data-delete>Delete</button>
      </div>
      <div class="scene-direction-grid" ${scene.useProductionStyle ? "hidden" : ""}>
        <label>Visual direction<textarea rows="2" data-scene-field="visualDirection">${escapeHtml(scene.visualDirection || "")}</textarea></label>
        <label>Caption direction<textarea rows="2" data-scene-field="captionDirection">${escapeHtml(scene.captionDirection || "")}</textarea></label>
        <label>Camera direction<textarea rows="2" data-scene-field="cameraDirection">${escapeHtml(scene.cameraDirection || "")}</textarea></label>
      </div>
      <p class="scene-prompt">${escapeHtml(scene.visualPrompt || "")}</p>
    `;
    article.querySelectorAll("[data-scene-field]").forEach((input) => {
      const readValue = () => input.type === "checkbox" ? input.checked : input.value;
      input.addEventListener("input", () => this.updateScene(scene.id, input.dataset.sceneField, readValue()));
      input.addEventListener("change", () => this.updateScene(scene.id, input.dataset.sceneField, readValue()));
    });
    article.querySelectorAll("[data-move]").forEach((button) => {
      button.addEventListener("click", () => this.moveScene(scene.id, Number(button.dataset.move)));
    });
    article.querySelector("[data-delete]").addEventListener("click", () => this.deleteScene(scene.id));
    return article;
  }

  renderAssembleReview() {
    const scenes = this.state.scenes;
    if (!scenes.length) {
      this.elements.timelineList.replaceChildren(emptyMessage("Scenes will appear here once the script is broken down."));
      this.elements.reviewList.replaceChildren(emptyMessage("No review items yet."));
      this.elements.reviewDuration.textContent = "0s";
      this.elements.reviewWarnings.textContent = "No scenes yet";
      return;
    }

    const timeline = buildTimeline({ project: this.state, productionSpec: this.state.spec, brandProfile: this.brandProfile() });
    this.elements.timelineList.replaceChildren(
      ...timeline.map((segment) => {
        const scene = scenes.find((candidate) => candidate.id === segment.sceneId);
        const item = document.createElement("article");
        item.className = "timeline-item";
        item.innerHTML = `<strong>${segment.order}. ${escapeHtml(segment.composition)}</strong><span>${segment.startTime}s → ${round(segment.startTime + segment.duration)}s</span><p>${escapeHtml(segment.caption)}</p>`;
        return item;
      })
    );

    const warnings = this.state.consistency?.warnings || scenes.flatMap((scene) => missingFor(scene, this.state).map((warning) => `Scene ${scene.order || scene.number}: ${warning}`));
    const readiness = renderReadiness({ project: this.state, consistency: this.state.consistency });
    this.elements.reviewDuration.textContent = `${timeline.reduce((sum, segment) => sum + segment.duration, 0).toFixed(1)}s · ${this.state.spec.aspectRatio}`;
    this.elements.reviewWarnings.textContent = readiness.ready ? "READY TO RENDER" : `${readiness.warnings.length} render issue${readiness.warnings.length === 1 ? "" : "s"}`;
    this.elements.reviewList.replaceChildren(
      ...scenes.map((scene) => {
        const item = document.createElement("article");
        item.className = "review-item";
        const missing = missingFor(scene, this.state);
        const asset = this.state.assets.find((candidate) => candidate.id === scene.visualAssetId);
        item.dataset.complete = String(scene.consistencyStatus === "aligned" && !missing.length);
        item.innerHTML = `
          ${assetPreview(asset)}
          <div>
            <strong>Scene ${scene.order || scene.number}</strong>
            <p>${escapeHtml(scene.scriptText || scene.script)}</p>
            <span data-consistency="${scene.consistencyStatus || "missing"}">${escapeHtml(scene.consistencyMessages?.length ? scene.consistencyMessages.join(", ") : "On brand")}</span>
          </div>
        `;
        return item;
      })
    );
  }

  updateRecordingTimer() {
    if (!this.recordingStartedAt) {
      this.elements.aiRecordingTimer.textContent = "00:00:00";
      return;
    }
    const elapsed = Math.floor((Date.now() - this.recordingStartedAt) / 1000);
    this.elements.aiRecordingTimer.textContent = formatTime(elapsed);
  }

  stopRecordingTimer() {
    if (this.recordingTimer) {
      window.clearInterval(this.recordingTimer);
      this.recordingTimer = null;
    }
    this.recordingStartedAt = null;
  }

  saveAndRender() {
    saveProject(this.state);
    this.render();
  }
}

function defaultProject() {
  return {
    id: `aip-${Date.now().toString(36)}`,
    mode: "live",
    productionEntry: "quick",
    currentStage: "source",
    quick: {
      format: "16:9",
      prepared: false,
      assets: [],
      settings: {
        intro: true,
        outro: true,
        lowerThird: true,
        watermark: true,
        captions: false,
        normalizeAudio: true
      }
    },
    source: {
      topic: "",
      url: "",
      audience: "",
      objective: "",
      platform: "YouTube Shorts",
      aspectRatio: "9:16",
      targetDuration: 45,
      notes: "",
      sourceText: ""
    },
    angles: [],
    selectedAngleId: null,
    script: { hook: "", body: "", cta: "", title: "" },
    spec: null,
    scenes: [],
    audio: null,
    assets: [],
    consistency: null
  };
}

function loadProject() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return {
      ...defaultProject(),
      ...saved,
      quick: {
        ...defaultProject().quick,
        ...(saved.quick || {}),
        settings: { ...defaultProject().quick.settings, ...(saved.quick?.settings || {}) },
        assets: saved.quick?.assets || []
      },
      source: { ...defaultProject().source, ...(saved.source || {}) },
      script: { ...defaultProject().script, ...(saved.script || {}) },
      scenes: saved.scenes || [],
      assets: saved.assets || []
    };
  } catch {
    return defaultProject();
  }
}

function saveProject(project) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(toSerializableProject(project)));
}

function toSerializableProject(project, brandProfile = getBrandProfile()) {
  const spec = project.spec || createProductionSpec({
    project,
    brandProfile,
    angle: project.angles.find((angle) => angle.id === project.selectedAngleId) || project.angles[0],
    script: project.script,
    scenes: project.scenes
  });
  const timeline = buildTimeline({ project, productionSpec: spec, brandProfile });
  return {
    ...project,
    quick: {
      ...project.quick,
      assets: project.quick.assets.map(({ localPreviewUrl, ...asset }) => asset)
    },
    audio: project.audio ? stripPreviewUrl(project.audio) : null,
    assets: project.assets.map(({ localPreviewUrl, ...asset }) => asset),
    brandProfile,
    productionSpec: spec,
    orchestration: {
      narrationAudio: project.audio,
      sceneOrder: timeline.map((segment) => segment.sceneId),
      timeline,
      providerRequests: project.scenes.map((scene) => ({
        sceneId: scene.id,
        ...createProviderRequests({ productionSpec: spec, brandProfile, scene })
      })),
      consistency: project.consistency,
      renderContract: {
        aspectRatio: spec.aspectRatio,
        platform: spec.platform,
        format: spec.format,
        targetDuration: spec.targetDuration,
        brandOverlays: spec.brandOverlays,
        introStyle: spec.brandOverlays.introStyle,
        outroStyle: spec.brandOverlays.outroStyle,
        cta: spec.cta
      }
    },
    providers: {
      concierge: "ToastyConcierge",
      avatar: providers.avatar.name,
      image: providers.visual.name,
      video: providers.visual.name,
      caption: providers.caption.name,
      render: providers.render.name
    }
  };
}

function buildQuickScenes({ assets, brandProfile, settings, productionSpec }) {
  const scenes = [];
  let order = 1;
  if (settings.intro) {
    scenes.push(createScene({
      order: order++,
      scriptText: introText(brandProfile),
      productionSpec,
      brandProfile,
      overrides: {
        visualType: "Text/card",
        composition: "intro-card",
        estimatedDuration: Number(brandProfile.introDuration) || 1.6,
        narrationStatus: "not-needed",
        assetStatus: "Generated intro",
        captions: "",
        captionText: "",
        quickRole: "intro",
        lowerThird: null,
        watermark: settings.watermark
      }
    }));
  }
  assets.forEach((asset, index) => {
    if (asset.quickKind === "audio") return;
    const isVideo = asset.quickKind === "video";
    const duration = isVideo
      ? Math.max(1, Math.round(asset.duration || 8))
      : Math.max(1, Number(asset.duration) || 4);
    scenes.push(createScene({
      order: order++,
      scriptText: settings.captions ? "" : "",
      productionSpec,
      brandProfile,
      overrides: {
        visualType: isVideo ? "B-roll" : "Image",
        composition: isVideo ? "quick-video" : "quick-image",
        estimatedDuration: duration,
        narrationStatus: "source-audio",
        audioId: null,
        visualAssetId: asset.id,
        assetStatus: "Ready for review",
        captions: "",
        captionText: "",
        quickRole: "content",
        lowerThird: settings.lowerThird && index === firstVisualIndex(assets) ? lowerThirdFor(brandProfile) : null,
        watermark: settings.watermark,
        audioSourceAssetId: isVideo ? asset.id : null
      }
    }));
  });
  if (settings.outro) {
    scenes.push(createScene({
      order: order++,
      scriptText: outroText(brandProfile),
      productionSpec,
      brandProfile,
      overrides: {
        visualType: "Text/card",
        composition: "outro-card",
        estimatedDuration: Number(brandProfile.outroDuration) || 2.4,
        narrationStatus: "not-needed",
        assetStatus: "Generated outro",
        captions: "",
        captionText: "",
        quickRole: "outro",
        lowerThird: null,
        watermark: settings.watermark
      }
    }));
  }
  return renumber(scenes);
}

function mergeQuickAssets(existingAssets, quickAssets) {
  const nonQuickAssets = existingAssets.filter((asset) => asset.kind !== "quick-content");
  return [...quickAssets, ...nonQuickAssets];
}

function primaryQuickAudio(assets) {
  const audio = assets.find((asset) => asset.quickKind === "audio");
  if (!audio) return null;
  return {
    id: audio.id,
    mediaId: audio.mediaId,
    kind: "quickNarrationAudio",
    fileName: audio.name,
    mimeType: audio.mimeType,
    size: audio.size,
    duration: audio.duration || 0,
    recordedAt: audio.attachedAt,
    localPreviewUrl: audio.localPreviewUrl
  };
}

function quickChecklist({ quick, brandProfile, project }) {
  const hasLogo = Boolean(brandProfile.logos?.[0]);
  const hasVideo = quick.assets.some((asset) => asset.quickKind === "video");
  const hasImage = quick.assets.some((asset) => asset.quickKind === "image");
  const hasAudio = quick.assets.some((asset) => asset.quickKind === "audio");
  return [
    { label: "Intro", done: quick.settings.intro, note: quick.settings.intro ? "Generated from the selected brand." : "Skipped." },
    { label: "Lower third", done: quick.settings.lowerThird, note: quick.settings.lowerThird ? lowerThirdFor(brandProfile) : "Skipped." },
    { label: "Main content", done: hasVideo || hasImage, note: `${quick.assets.length} asset${quick.assets.length === 1 ? "" : "s"} prepared.` },
    { label: "Watermark", done: quick.settings.watermark && hasLogo, note: hasLogo ? "Logo applied subtly." : "No logo configured for this brand." },
    { label: "Outro", done: quick.settings.outro, note: quick.settings.outro ? (brandProfile.defaultCTA || brandProfile.ctaStyle || "CTA card generated.") : "Skipped." },
    { label: "Audio", done: hasVideo || hasAudio, note: hasAudio ? "Audio file used as narration." : hasVideo ? "Video speech is preserved where the file includes audio." : "Silent photo sequence." },
    { label: "Captions", done: false, note: quick.settings.captions ? "Transcription is required before captions can be created." : "Off for this render." },
    { label: "Format", done: true, note: project.spec?.aspectRatio || "16:9" }
  ];
}

function quickTitle(assets, brandProfile) {
  const first = assets[0]?.name?.replace(/\.[^.]+$/, "") || "Quick Toast";
  return `${brandProfile.name} - ${first}`;
}

function quickDuration(assets, settings) {
  const contentDuration = assets.reduce((sum, asset) => {
    if (asset.quickKind === "audio") return sum;
    if (asset.quickKind === "image") return sum + 4;
    return sum + Math.max(1, Number(asset.duration) || 8);
  }, 0);
  return contentDuration + (settings.intro ? 1.6 : 0) + (settings.outro ? 2.4 : 0);
}

function quickFormatFor(formatId, assets) {
  if (formatId !== "original") return QUICK_FORMATS[formatId] || QUICK_FORMATS["16:9"];
  const firstVisual = assets.find((asset) => asset.quickKind === "video" || asset.quickKind === "image");
  const inferred = aspectRatioFromDimensions(firstVisual?.width, firstVisual?.height);
  return {
    ...QUICK_FORMATS.original,
    aspectRatio: inferred,
    format: `${inferred} from source`
  };
}

function aspectRatioFromDimensions(width, height) {
  if (!width || !height) return "16:9";
  const ratio = width / height;
  if (ratio < 0.8) return "9:16";
  if (ratio > 0.8 && ratio < 1.25) return "1:1";
  return "16:9";
}

function firstVisualIndex(assets) {
  return assets.findIndex((asset) => asset.quickKind !== "audio");
}

function lowerThirdFor(brandProfile) {
  if (brandProfile.lowerThird) return brandProfile.lowerThird;
  return [brandProfile.creatorName || brandProfile.name, brandProfile.creatorTitle || ""].filter(Boolean).join(" · ");
}

function introText(brandProfile) {
  return brandProfile.tagline || brandProfile.creatorName || brandProfile.name;
}

function outroText(brandProfile) {
  const cta = brandProfile.defaultCTA || brandProfile.ctaStyle || "Follow for more.";
  const destination = brandProfile.website || brandProfile.creatorHandle || "";
  return [cta, destination].filter(Boolean).join(" ");
}

function quickKind(file) {
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("audio/")) return "audio";
  return "file";
}

function mediaMetadata(file) {
  if (!file.type.startsWith("video/") && !file.type.startsWith("audio/") && !file.type.startsWith("image/")) {
    return Promise.resolve({});
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    if (file.type.startsWith("image/")) {
      const image = new Image();
      image.addEventListener("load", () => {
        URL.revokeObjectURL(url);
        resolve({ width: image.naturalWidth, height: image.naturalHeight });
      }, { once: true });
      image.addEventListener("error", () => {
        URL.revokeObjectURL(url);
        resolve({});
      }, { once: true });
      image.src = url;
      return;
    }
    const media = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    media.preload = "metadata";
    media.addEventListener("loadedmetadata", () => {
      const metadata = {
        duration: Number.isFinite(media.duration) ? media.duration : 0,
        width: media.videoWidth || 0,
        height: media.videoHeight || 0
      };
      URL.revokeObjectURL(url);
      resolve(metadata);
    }, { once: true });
    media.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      resolve({});
    }, { once: true });
    media.src = url;
  });
}

function renumber(scenes) {
  return scenes.map((scene, index) => ({ ...scene, order: index + 1, number: index + 1 }));
}

function statusFor(scene, project) {
  const missing = missingFor(scene, project);
  return missing.length ? missing.join(", ") : "Ready for review";
}

function missingFor(scene, project) {
  const missing = [];
  const quickScene = Boolean(scene.quickRole);
  if (!quickScene && !(scene.scriptText || scene.script || "").trim()) missing.push("script");
  if (!quickScene && !scene.audioId && !project.audio) missing.push("voice");
  if (!scene.visualAssetId && scene.visualType !== "Text/card") missing.push("visual");
  return missing;
}

function scenePatch(field, value, productionSpec) {
  if (field === "estimatedDuration") return { estimatedDuration: Number(value) || 0 };
  if (field === "useProductionStyle") {
    const patch = { useProductionStyle: Boolean(value) };
    if (value && productionSpec) {
      patch.visualDirection = productionSpec.visualDirection;
      patch.captionDirection = productionSpec.captionDirection;
      patch.cameraDirection = productionSpec.cameraDirection;
      patch.avatarDirection = productionSpec.avatarDirection;
    }
    return patch;
  }
  if (field === "scriptText") {
    return {
      scriptText: value,
      script: value,
      captionText: value,
      captions: value,
      estimatedDuration: estimateDuration(value)
    };
  }
  if (field === "captionDirection") return { captionDirection: value };
  if (field === "visualDirection") return { visualDirection: value };
  if (field === "cameraDirection") return { cameraDirection: value };
  if (field === "visualType") return { visualType: value };
  if (field === "composition") return { composition: value };
  return { [field]: value };
}

function compositionForScene(scene) {
  if (scene.visualType === "Avatar") return "avatar-full";
  if (scene.visualType === "Image") return "image-full";
  if (scene.visualType === "Text/card") return "text-card";
  return "broll-full";
}

function stripPreviewUrl(value) {
  const { localPreviewUrl, ...rest } = value;
  return rest;
}

function consistencyLabel(scene) {
  if (scene.consistencyStatus === "aligned") return "Brand aligned";
  if (scene.consistencyStatus === "warning") return scene.consistencyMessages?.[0] || "Needs review";
  return scene.consistencyMessages?.[0] || "Missing direction";
}

function fileAsset(file, kind) {
  return {
    id: createId(),
    kind,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    localPreviewUrl: URL.createObjectURL(file),
    attachedAt: new Date().toISOString(),
    provider: kind === "avatar" ? providers.avatar.name : providers.visual.name
  };
}

function summarize(value) {
  return value.trim().split(/\s+/).slice(0, 12).join(" ") || "short-form audience";
}

function elapsedSeconds(start, stop) {
  const ms = new Date(stop).getTime() - new Date(start).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
}

function formatTime(totalSeconds) {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function emptyMessage(text) {
  const p = document.createElement("p");
  p.className = "empty-production";
  p.textContent = text;
  return p;
}

function downloadJson(value, name) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slugify(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 72) || "ai-production";
}

function createId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const random = crypto.getRandomValues(new Uint32Array(2));
  return `id-${Date.now().toString(36)}-${[...random].map((part) => part.toString(36)).join("")}`;
}

function assetPreview(asset) {
  if (!asset?.localPreviewUrl) return '<div class="asset-preview" data-empty="true">No visual</div>';
  if (asset.mimeType.startsWith("image/")) {
    return `<div class="asset-preview"><img src="${asset.localPreviewUrl}" alt="${escapeHtml(asset.name)}"></div>`;
  }
  if (asset.mimeType.startsWith("video/")) {
    return `<div class="asset-preview"><video src="${asset.localPreviewUrl}" muted playsinline controls></video></div>`;
  }
  return '<div class="asset-preview" data-empty="true">Asset</div>';
}

function escapeHtml(value = "") {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function humanizeError(error) {
  if (error?.name === "NotAllowedError") return "microphone permission was denied.";
  if (error?.name === "NotFoundError") return "no microphone device was found.";
  if (error?.name === "NotReadableError") return "microphone is already in use or unavailable.";
  return error?.message || "unknown browser recording error.";
}
