import { Soundboard } from "./soundboard.js";
import { renderFeedEntry } from "./ai-producer.js";
import { attachFocusGroupToSession, buildFocusGroupInsightArtifact } from "./focus-group-studio.js";
import { buildSessionDeliverables, buildWeeklyUpdatePackage, formatDeliverableMarkdown } from "./post-production.js";
import { sanitizeEndCard, readImageFileAsDataUrl } from "./end-card.js";
import { PROGRAM_OUTPUT_PICKER_INSTRUCTION } from "./program-recording.js";

// ProducerView: the dense control surface for making the show. Same LiveSession as HostView — this
// file only adds DOM bindings for producer-only actions (per-guest control, layout, graphics, show
// lifecycle, recording, audio). It never creates its own VideoEngine/guest list/program state.
export class ProducerView {
  constructor({ session, root = document }) {
    this.session = session;
    this.root = root;
    this.elements = {
      guestRows: root.querySelector("#lvGuestRows"),
      hostSourceStatus: root.querySelector("#lvSourceHostStatus"),
      layoutGroup: root.querySelector("#lvLayoutGroup"),
      layoutModeChip: root.querySelector("#lvLayoutModeChip"),
      shareGroup: root.querySelector("#lvShareGroup"),
      shareModeChip: root.querySelector("#lvShareModeChip"),
      hottieStatus: root.querySelector("#lvMoxieStatus"),
      hottieProposal: root.querySelector("#lvMoxieProposal"),
      moxieCurrentSpeaker: root.querySelector("#lvMoxieCurrentSpeaker"),
      moxieCurrentTopic: root.querySelector("#lvMoxieCurrentTopic"),
      moxieRunOfShowPosition: root.querySelector("#lvMoxieRunOfShowPosition"),
      moxieRecentHeard: root.querySelector("#lvMoxieRecentHeard"),
      moxieAudienceSignals: root.querySelector("#lvMoxieAudienceSignals"),
      programPreview: root.querySelector("#lvProgramPreviewStage"),
      poTopic: root.querySelector("#lvPoTopic"),
      poSceneGroup: root.querySelector("#lvPoSceneGroup"),
      poSceneRejected: root.querySelector("#lvPoSceneRejected"),
      poTickerEnabled: root.querySelector("#lvPoTickerEnabled"),
      poTickerText: root.querySelector("#lvPoTickerText"),
      poTickerShow: root.querySelector("#lvPoTickerShow"),
      poTickerHide: root.querySelector("#lvPoTickerHide"),
      poTickerClear: root.querySelector("#lvPoTickerClear"),
      poTickerSpeed: root.querySelector("#lvPoTickerSpeed"),
      poConnection: root.querySelector("#lvPoConnection"),
      poFeeds: root.querySelector("#lvPoFeeds"),
      poAudioState: root.querySelector("#lvPoAudioState"),
      poReadyState: root.querySelector("#lvPoReadyState"),
      poVideoFlag: root.querySelector("#lvPoVideoFlag"),
      poAudioFlag: root.querySelector("#lvPoAudioFlag"),
      recordToggle: root.querySelector("#lvRecordToggle"),
      recordNote: root.querySelector("#lvRecordNote"),
      recordTimer: root.querySelector("#lvRecordTimer"),
      recordStatus: root.querySelector("#lvRecordStatus"),
      recordMarker: root.querySelector("#lvRecordMarker"),
      masterPlayback: root.querySelector("#lvMasterPlayback"),
      masterVideo: root.querySelector("#lvMasterVideo"),
      masterDownload: root.querySelector("#lvMasterDownload"),
      masterDownloadWebm: root.querySelector("#lvMasterDownloadWebm"),
      masterPlay: root.querySelector("#lvMasterPlay"),
      masterManifest: root.querySelector("#lvMasterManifest"),
      masterManifestNote: root.querySelector("#lvMasterManifestNote"),
      soundboard: root.querySelector("#lvSoundboard"),
      soundboardVolume: root.querySelector("#lvSoundboardVolume"),
      soundboardTabs: root.querySelector("#lvSoundboardTabs"),
      soundboardSearch: root.querySelector("#lvSoundboardSearch"),
      soundboardStop: root.querySelector("#lvSoundboardStop"),
      openProgramOutput: root.querySelector("#lvOpenProgramOutput"),
      endShow: root.querySelector("#lvEndShow"),
      feedListProducer: root.querySelector("#lvFeedListProducer"),
      demoModeToggle: root.querySelector("#lvDemoModeToggle"),
      demoModeNote: root.querySelector("#lvDemoModeNote"),
      resetDemo: root.querySelector("#lvResetDemo"),
      aiDiagRequests: root.querySelector("#lvAiDiagRequests"),
      aiDiagTokens: root.querySelector("#lvAiDiagTokens"),
      aiDiagCost: root.querySelector("#lvAiDiagCost"),
      aiDiagProvider: root.querySelector("#lvAiDiagProvider"),
      postWeekly: root.querySelector("#lvGenerateWeeklyPackage"),
      postSession: root.querySelector("#lvGeneratePostPack"),
      postFocus: root.querySelector("#lvGenerateFocusInsights"),
      postOutput: root.querySelector("#lvPostProductionOutput"),
      focusIntelligence: root.querySelector("#lvFocusIntelligence"),
      focusRefreshInsights: root.querySelector("#lvFocusRefreshInsights"),
      focusInsightPack: root.querySelector("#lvFocusInsightPack"),
      focusInsightPackOutput: root.querySelector("#lvFocusInsightPackOutput"),
      focusProject: root.querySelector("#lvFocusProject"),
      focusObjective: root.querySelector("#lvFocusObjective"),
      focusProfile: root.querySelector("#lvFocusProfile"),
      focusDesired: root.querySelector("#lvFocusDesired"),
      focusMinimum: root.querySelector("#lvFocusMinimum"),
      focusDuration: root.querySelector("#lvFocusDuration"),
      focusTopics: root.querySelector("#lvFocusTopics"),
      focusQuestions: root.querySelector("#lvFocusQuestions"),
      focusStatus: root.querySelector("#lvFocusStatus"),
      focusTarget: root.querySelector("#lvFocusTarget"),
      focusMatched: root.querySelector("#lvFocusMatched"),
      focusConfirmed: root.querySelector("#lvFocusConfirmed"),
      focusFallback: root.querySelector("#lvFocusFallback"),
      focusClientApproval: root.querySelector("#lvFocusClientApproval"),
      focusApply: root.querySelector("#lvApplyFocusBrief"),
      focusSummary: root.querySelector("#lvFocusSummary"),
      focusRecruitmentStatus: root.querySelector("#lvFocusRecruitmentStatus"),
      endCardHeadline: root.querySelector("#lvEndCardHeadline"),
      endCardMessage: root.querySelector("#lvEndCardMessage"),
      endCardWebsite: root.querySelector("#lvEndCardWebsite"),
      endCardSocialX: root.querySelector("#lvEndCardSocialX"),
      endCardSocialLinkedin: root.querySelector("#lvEndCardSocialLinkedin"),
      endCardSocialYoutube: root.querySelector("#lvEndCardSocialYoutube"),
      endCardSocialInstagram: root.querySelector("#lvEndCardSocialInstagram"),
      endCardSocialTiktok: root.querySelector("#lvEndCardSocialTiktok"),
      endCardSocialGithub: root.querySelector("#lvEndCardSocialGithub"),
      endCardSocialTelegram: root.querySelector("#lvEndCardSocialTelegram"),
      endCardShowQr: root.querySelector("#lvEndCardShowQr"),
      endCardQrUpload: root.querySelector("#lvEndCardQrUpload"),
      endCardQrPreview: root.querySelector("#lvEndCardQrPreview"),
      endCardQrPreviewImage: root.querySelector("#lvEndCardQrPreviewImage"),
      endCardUseProfileDefault: root.querySelector("#lvEndCardUseProfileDefault"),
      endCardSaveProfileDefault: root.querySelector("#lvEndCardSaveProfileDefault"),
      endCardSaveSession: root.querySelector("#lvEndCardSaveSession"),
      endCardStatus: root.querySelector("#lvEndCardStatus")
    };
  }

  init() {
    new Soundboard({
      container: this.elements.soundboard,
      volumeInput: this.elements.soundboardVolume,
      tabsContainer: this.elements.soundboardTabs,
      searchInput: this.elements.soundboardSearch,
      stopButton: this.elements.soundboardStop,
      session: this.session
    });

    this.elements.layoutGroup.querySelectorAll("[data-layout]").forEach((button) => {
      button.addEventListener("click", () => this.session.setLayout(button.dataset.layout, { manual: true }));
    });
    this.elements.shareGroup?.querySelectorAll("[data-share]").forEach((button) => {
      button.addEventListener("click", () => this.session.setShareLayout(button.dataset.share));
    });
    this.elements.programPreview?.addEventListener("click", (event) => {
      const tile = event.target.closest(".po-tile[data-participant-id]");
      if (!tile) return;
      const role = tile.dataset.role;
      if (role === "screen" || role === "asset") return;
      this.session.setSpotlight(tile.dataset.participantId);
    });
    this.session.on("hottie", (status) => this.renderMoxie(status));

    this.elements.poTopic.addEventListener("input", () => this.session.setTopic(this.elements.poTopic.value));
    this.elements.poTickerEnabled.addEventListener("change", () => {
      this.elements.poTickerText.disabled = !this.elements.poTickerEnabled.checked;
      this.session.setTicker({ enabled: this.elements.poTickerEnabled.checked });
    });
    this.elements.poTickerText.addEventListener("input", () => this.session.setTicker({ text: this.elements.poTickerText.value }));
    this.elements.poTickerShow?.addEventListener("click", () => this.session.setTicker({ enabled: true, text: this.elements.poTickerText.value || this.session.program.tickerText }));
    this.elements.poTickerHide?.addEventListener("click", () => this.session.setTicker({ enabled: false }));
    this.elements.poTickerClear?.addEventListener("click", () => {
      this.elements.poTickerText.value = "";
      this.session.setTicker({ enabled: false, text: "" });
    });
    this.elements.poTickerSpeed?.addEventListener("input", () => this.session.setTicker({ speed: Number(this.elements.poTickerSpeed.value) }));
    // No optimistic aria-pressed update here on purpose: setScene() emits "program" synchronously with
    // its own locally-set scene, which already flows into renderProgram() below and updates aria-pressed
    // from program.scene — through the SAME path used to reconcile against the server-confirmed scene on
    // every heartbeat (see LiveSession._applyControlBundle). A second, parallel "just believe the click"
    // update here would be exactly what it looks like: a fake success state a failed/corrupted publish
    // could leave stuck, with nothing to ever correct it back to what the server actually has.
    this.elements.poSceneGroup.querySelectorAll(".po-swatch").forEach((button) => {
      button.addEventListener("click", () => this.session.setScene(button.dataset.scene));
    });

    this.elements.recordToggle.addEventListener("click", () => this.toggleRecording());
    this.elements.recordMarker?.addEventListener("click", () => {
      const marker = this.session.addMarker();
      this.elements.recordNote.textContent = `Marked ${formatClock(Math.floor((marker.timestamp - (this.session.recording.startedAt || marker.timestamp)) / 1000))} · ${marker.label}`;
    });
    this.elements.masterPlay?.addEventListener("click", () => this.playMaster());
    this.elements.masterDownload?.addEventListener("click", () => this.downloadMaster());
    this.elements.masterDownloadWebm?.addEventListener("click", () => this.downloadSourceWebm());
    this.elements.masterManifest?.addEventListener("click", () => this.downloadManifest());
    this.elements.openProgramOutput.addEventListener("click", () => {
      this.session.noteProgramOutputOpening?.();
      window.open(this.session.inviteUrls().listener, "toasty-program-output");
    });
    this.elements.endShow.addEventListener("click", () => {
      if (window.confirm("End the show for everyone? This ends the broadcast and disconnects guests.")) {
        this.session.endShow();
      }
    });
    this.elements.demoModeToggle.addEventListener("change", () => this.session.setDemoMode(this.elements.demoModeToggle.checked));
    // Kept in sync with Host View's own Demo toggle (see host-view.js) — either one can turn it on/off,
    // both should visually agree, since this is the SAME session.demoMode either way.
    this.session.on("demo-mode", (enabled) => { this.elements.demoModeToggle.checked = enabled; });
    this.elements.resetDemo.addEventListener("click", () => {
      this.session.resetDemo();
      this.elements.demoModeToggle.checked = false;
    });
    this.elements.postWeekly?.addEventListener("click", () => this.renderPostOutput(buildWeeklyUpdatePackage(this.session)));
    this.elements.postSession?.addEventListener("click", () => this.renderPostOutput(buildSessionDeliverables(this.session)));
    this.elements.postFocus?.addEventListener("click", () => this.renderPostOutput(buildFocusGroupInsightArtifact(this.session)?.payload || { note: "No focus group transcript available yet." }));
    this.elements.focusApply?.addEventListener("click", () => this.applyFocusBrief());
    this.elements.focusRefreshInsights?.addEventListener("click", () => this.renderFocusIntelligence());
    this.elements.focusInsightPack?.addEventListener("click", () => {
      const pack = buildFocusGroupInsightArtifact(this.session)?.payload;
      if (this.elements.focusInsightPackOutput) {
        this.elements.focusInsightPackOutput.value = pack ? formatDeliverableMarkdown(pack) : "No focus group transcript available yet.";
      }
    });
    // Transcription events can fire several times a second while someone is talking — debounce the
    // (re)analysis instead of recomputing analyzeFocusGroupTranscript over the whole transcript on every
    // partial update.
    this.session.on("transcription", () => {
      clearTimeout(this._focusIntelligenceDebounce);
      this._focusIntelligenceDebounce = setTimeout(() => this.renderFocusIntelligence(), 1500);
      clearTimeout(this._moxieContextDebounce);
      this._moxieContextDebounce = setTimeout(() => this.renderMoxieLiveContext(), 1500);
    });
    [this.elements.focusStatus, this.elements.focusTarget, this.elements.focusMatched, this.elements.focusConfirmed].forEach((el) => {
      el?.addEventListener("input", () => this.renderFocusRecruitment());
      el?.addEventListener("change", () => this.renderFocusRecruitment());
    });

    this.elements.endCardQrUpload?.addEventListener("change", () => this.uploadEndCardQr());
    this.elements.endCardUseProfileDefault?.addEventListener("click", () => this.populateEndCardForm(this.session.profileEndCard));
    this.elements.endCardSaveProfileDefault?.addEventListener("click", () => this.saveEndCard("profile"));
    this.elements.endCardSaveSession?.addEventListener("click", () => this.saveEndCard("session"));
    this.session.on("end-card", () => this.populateEndCardForm(this.session.sessionEndCard));
    this.populateEndCardForm(this.session.sessionEndCard);

    this.session.on("guests", () => this.renderGuests());
    this.session.on("av", () => this.renderGuests());
    this.session.on("program", (program) => { this.renderProgram(program); this.renderMoxieLiveContext(); });
    this.session.on("session-control-rejected", (rejection) => this.renderSessionControlRejected(rejection));
    if (this.session.sessionControlRejected) this.renderSessionControlRejected(this.session.sessionControlRejected);
    this.session.on("recording", (recording) => this.renderRecording(recording));
    this.session.on("recording-status", (message) => { this.elements.recordNote.textContent = message; this.elements.recordNote.dataset.error = "false"; });
    this.session.on("policy", () => this.renderRecordingGate());
    this.session.on("program-output", () => {
      this.elements.recordNote.dataset.error = "false";
      this.renderProgramOutputStatus();
      this.renderRecordingGate();
    });
    this.session.aiProducerFeed.on(() => this.renderFeedMirror());
    this.session.on("transcription", (state) => this.renderTranscriptionStatus(state));
    this.session.aiProducerService.on((totals) => this.renderAiDiagnostics(totals));

    this.renderGuests();
    this.renderProgram(this.session.program);
    this.renderMoxie(this.session.hottieStatus);
    this.renderMoxieLiveContext();
    this.renderRecording(this.session.recording);
    this.renderProgramOutputStatus();
    this.renderRecordingGate();
    this.renderFeedMirror();
    this.renderAiDiagnostics(this.session.aiProducerService.sessionTotals());
    this.renderFocusRecruitment();
    this.renderFocusIntelligence();
  }

  renderPostOutput(pack) {
    if (!this.elements.postOutput) return;
    this.elements.postOutput.value = formatDeliverableMarkdown(pack);
  }

  // ---- End Card (Program Output outro CTA) ----

  populateEndCardForm(endCard) {
    const card = sanitizeEndCard(endCard || {});
    if (this.elements.endCardHeadline) this.elements.endCardHeadline.value = card.headline;
    if (this.elements.endCardMessage) this.elements.endCardMessage.value = card.message;
    if (this.elements.endCardWebsite) this.elements.endCardWebsite.value = card.website;
    if (this.elements.endCardSocialX) this.elements.endCardSocialX.value = card.socials.x || "";
    if (this.elements.endCardSocialLinkedin) this.elements.endCardSocialLinkedin.value = card.socials.linkedin || "";
    if (this.elements.endCardSocialYoutube) this.elements.endCardSocialYoutube.value = card.socials.youtube || "";
    if (this.elements.endCardSocialInstagram) this.elements.endCardSocialInstagram.value = card.socials.instagram || "";
    if (this.elements.endCardSocialTiktok) this.elements.endCardSocialTiktok.value = card.socials.tiktok || "";
    if (this.elements.endCardSocialGithub) this.elements.endCardSocialGithub.value = card.socials.github || "";
    if (this.elements.endCardSocialTelegram) this.elements.endCardSocialTelegram.value = card.socials.telegram || "";
    if (this.elements.endCardShowQr) this.elements.endCardShowQr.checked = card.showQr;
    this._endCardQrImage = card.qrImage || "";
    this.renderEndCardQrPreview();
  }

  renderEndCardQrPreview() {
    if (!this.elements.endCardQrPreview || !this.elements.endCardQrPreviewImage) return;
    const hasImage = Boolean(this._endCardQrImage);
    this.elements.endCardQrPreview.hidden = !hasImage;
    this.elements.endCardQrPreviewImage.src = hasImage ? this._endCardQrImage : "";
  }

  async uploadEndCardQr() {
    const file = this.elements.endCardQrUpload?.files?.[0];
    if (!file) return;
    try {
      this._endCardQrImage = await readImageFileAsDataUrl(file);
      this.renderEndCardQrPreview();
      if (this.elements.endCardStatus) this.elements.endCardStatus.textContent = "QR image loaded — click Save to publish it.";
    } catch (error) {
      if (this.elements.endCardStatus) this.elements.endCardStatus.textContent = String(error?.message || error);
    }
  }

  collectEndCardFromForm() {
    return sanitizeEndCard({
      headline: this.elements.endCardHeadline?.value,
      message: this.elements.endCardMessage?.value,
      website: this.elements.endCardWebsite?.value,
      socials: {
        x: this.elements.endCardSocialX?.value,
        linkedin: this.elements.endCardSocialLinkedin?.value,
        youtube: this.elements.endCardSocialYoutube?.value,
        instagram: this.elements.endCardSocialInstagram?.value,
        tiktok: this.elements.endCardSocialTiktok?.value,
        github: this.elements.endCardSocialGithub?.value,
        telegram: this.elements.endCardSocialTelegram?.value
      },
      showQr: Boolean(this.elements.endCardShowQr?.checked),
      qrImage: this._endCardQrImage || "",
      qrTarget: this.elements.endCardWebsite?.value || ""
    });
  }

  async saveEndCard(target) {
    const endCard = this.collectEndCardFromForm();
    if (this.elements.endCardStatus) this.elements.endCardStatus.textContent = "Saving…";
    try {
      if (target === "profile") await this.session.setProfileEndCard(endCard);
      else await this.session.setSessionEndCard(endCard);
      if (this.elements.endCardStatus) {
        this.elements.endCardStatus.textContent = target === "profile"
          ? "Saved as your profile default."
          : "Saved for this session.";
      }
    } catch (error) {
      if (this.elements.endCardStatus) this.elements.endCardStatus.textContent = String(error?.message || error);
    }
  }

  applyFocusBrief() {
    const questions = splitLines(this.elements.focusQuestions?.value);
    const topics = splitLines(this.elements.focusTopics?.value);
    const context = attachFocusGroupToSession(this.session, {
      title: this.elements.focusProject?.value || "Focus Group",
      objective: this.elements.focusObjective?.value || "",
      researchQuestions: questions,
      cohort: {
        targetProfile: this.elements.focusProfile?.value || "",
        desiredCount: Number(this.elements.focusDesired?.value || 0),
        minimumCount: Number(this.elements.focusMinimum?.value || 0),
        recruitment: this.focusRecruitmentState(),
        fallback: {
          option: this.elements.focusFallback?.value || "",
          clientApproved: Boolean(this.elements.focusClientApproval?.checked)
        }
      },
      concepts: topics,
      clientNotes: `Duration: ${this.elements.focusDuration?.value || 45} minutes`
    });
    this.session.runOfShow.load((context.agenda || []).map((item) => ({
      title: item.title,
      notes: item.preparedQuestions?.join("\n") || "",
      preparedQuestions: item.preparedQuestions || [],
      estimatedMinutes: item.estimatedMinutes
    })));
    this.renderFocusRecruitment();
  }

  focusRecruitmentState() {
    const target = Number(this.elements.focusTarget?.value || this.elements.focusDesired?.value || 0);
    const matched = Number(this.elements.focusMatched?.value || 0);
    const confirmed = Number(this.elements.focusConfirmed?.value || 0);
    return {
      status: this.elements.focusStatus?.value || "NEEDS PARTICIPANTS",
      target,
      matched,
      confirmed,
      remaining: Math.max(0, target - confirmed)
    };
  }

  renderFocusRecruitment() {
    const state = this.focusRecruitmentState();
    if (this.elements.focusRecruitmentStatus) this.elements.focusRecruitmentStatus.textContent = state.status;
    if (this.elements.focusSummary) {
      this.elements.focusSummary.textContent = `Target ${state.target} · matched ${state.matched} · confirmed ${state.confirmed} · remaining ${state.remaining}`;
    }
  }

  // Live "Session Intelligence" — themes/quotes/contradictions/follow-ups pulled from the SAME
  // deterministic transcript analysis the post-session Insight Pack uses (buildFocusGroupInsightArtifact
  // -> js/focus-group.js's analyzeFocusGroupTranscript/buildFocusGroupDeliveryPack), just rendered live
  // instead of only at the end. Never invents anything: with no transcript yet it says so, matching
  // scripts/focus-group-honesty-test.mjs's "no transcript -> no fabricated findings" contract.
  renderFocusIntelligence() {
    const host = this.elements.focusIntelligence;
    if (!host) return;
    const pack = buildFocusGroupInsightArtifact(this.session)?.payload?.pack;
    host.replaceChildren();
    if (!pack || !pack.transcriptAvailable) {
      const placeholder = document.createElement("p");
      placeholder.className = "lv-placeholder";
      placeholder.textContent = "No transcript yet — themes, quotes, and follow-up questions will appear here once the discussion starts.";
      host.appendChild(placeholder);
      return;
    }
    const themesGroup = document.createElement("div");
    themesGroup.className = "lv-focus-intel-group";
    const themesHead = document.createElement("h5");
    themesHead.textContent = "Themes";
    themesGroup.appendChild(themesHead);
    if (pack.majorThemes?.length) {
      const chips = document.createElement("div");
      chips.className = "lv-focus-theme-chips";
      pack.majorThemes.slice(0, 8).forEach((theme) => {
        const chip = document.createElement("span");
        chip.className = "lv-chip";
        chip.textContent = `${theme.theme} · ${theme.count}`;
        chips.appendChild(chip);
      });
      themesGroup.appendChild(chips);
    } else {
      themesGroup.appendChild(focusIntelEmpty("No themes detected yet."));
    }
    host.appendChild(themesGroup);

    host.appendChild(focusIntelList("Notable Quotes", pack.evidence, (item) => `${item.speaker}: “${item.quote}”`, "No quotes captured yet."));
    host.appendChild(focusIntelList("Points of Disagreement", pack.pointsOfDisagreement, (item) => `${item.speaker}: “${item.text}”`, "No disagreement detected yet."));
    const followUps = pack.moderatorPrompts?.length ? pack.moderatorPrompts.map((p) => p.text) : pack.recommendedFollowUpResearch || [];
    host.appendChild(focusIntelList("Follow-up Questions", followUps, (item) => item, "Nothing to follow up on yet."));
  }

  // Producer-only, deliberately: cost/token telemetry is exactly the "debug information" that must
  // never reach Host View (HostView has no equivalent binding and never subscribes to this event).
  renderAiDiagnostics(totals) {
    this.elements.aiDiagRequests.textContent = `${totals.requests} request${totals.requests === 1 ? "" : "s"}`;
    const totalTokens = totals.promptTokens + totals.completionTokens;
    this.elements.aiDiagTokens.textContent = `${totalTokens.toLocaleString()} tokens`;
    this.elements.aiDiagCost.textContent = totals.costKnown ? `$${totals.costUsd.toFixed(4)}` : `$${totals.costUsd.toFixed(4)}+ (partial)`;
    // Visual only — the actual enforcement (silently routing to heuristic past HARD_CUTOFF_USD) lives
    // in AIProducerService.handleInstruction, not here. This just tells the Producer what's happening.
    this.elements.aiDiagCost.dataset.level = totals.hardCutoff ? "cutoff" : totals.softWarning ? "warning" : "ok";
    this.elements.aiDiagProvider.textContent = totals.hardCutoff ? "cost cutoff — heuristic only" : totals.lastProvider ? `via ${totals.lastProvider}` : "";
  }

  // The Demo Mode checkbox reflects intent ("I want this on"), not live state — a policy change to
  // Jam mid-demo genuinely stops transcription underneath it (see LiveSession._enforcePolicy) without
  // touching the checkbox, so this note is what actually tells the truth about whether it's running.
  renderTranscriptionStatus(state) {
    if (!this.elements.demoModeToggle.checked) return;
    this.elements.demoModeNote.textContent = state.active
      ? "Drips a seeded audience feed and transcript so AI Producer can be demoed without live mic/chat."
      : "Audience feed is still dripping, but transcript capture is blocked by this session's capture policy.";
  }

  // Read-only mirror of the SAME ProducerFeed HostView renders — no dismiss/pin here, no separate AI
  // state. The human Producer sees exactly what the host asked and what AI Producer said back. The one
  // exception is "Send to Program": that's a production decision, not a private-feed curation one, so
  // Producer (who owns broadcast/Program Output per the Host-vs-Producer split) can confirm it here too.
  renderFeedMirror() {
    const entries = this.session.aiProducerFeed.visible();
    if (!entries.length) {
      const p = document.createElement("p");
      p.className = "lv-placeholder";
      p.textContent = "Host requests will appear here.";
      this.elements.feedListProducer.replaceChildren(p);
      return;
    }
    this.elements.feedListProducer.replaceChildren(...entries.map((entry) => renderFeedEntry(entry, {
      onSendToProgram: (id) => this.session.aiProducerService.sendEntryToProgram(id),
      onTakeLive: (id) => this.session.liveProducer.takeProposalLive(id),
      onFindAnother: (id) => this.session.liveProducer.findAnother(id),
      onDiscardProposal: (id) => this.session.liveProducer.discardProposal(id),
      onRetryResearch: (id) => this.session.liveProducer.retryResearch(id),
      onRemoveAsset: (id) => this.session.liveProducer.removeLiveAsset(id),
      onApproveMoxieProposal: (id) => this.session.liveProducer.approveMoxieProposal(id),
      onDismissMoxieProposal: (id) => this.session.liveProducer.dismissMoxieProposal(id)
    })));
  }

  renderGuests() {
    const av = this.session.av;
    this.elements.hostSourceStatus.textContent = `${av.micMuted ? "Muted" : "Mic on"} · ${av.cameraOff ? "Camera off" : "Camera on"}`;

    this.elements.guestRows.replaceChildren(...this.session.guestSeats.map((seat, index) => {
      const row = document.createElement("div");
      row.className = "lv-source-row";
      if (!seat) {
        row.innerHTML = `<span class="lv-source-name">Guest ${index + 1}</span><span class="lv-source-status">Open</span>`;
        return row;
      }
      row.dataset.guestId = seat.id;
      const name = seat.displayName || seat.label || `Guest ${index + 1}`;
      const micPending = Boolean(seat.micPending);
      const cameraPending = Boolean(seat.cameraPending);
      const micLabel = micPending ? (seat.micPending.wantEnabled ? "Unmute requested" : "Muting…") : "Mic";
      const cameraLabel = cameraPending ? (seat.cameraPending.wantEnabled ? "Camera requested" : "Camera off…") : "Cam";
      row.innerHTML = `
        <span class="lv-source-name">${escapeHtml(name)}</span>
        <button type="button" class="lv-mini-btn" data-action="mic" data-pending="${String(micPending)}" aria-pressed="${String(!seat.mic)}" aria-busy="${String(micPending)}">${escapeHtml(micLabel)}</button>
        <button type="button" class="lv-mini-btn" data-action="camera" data-pending="${String(cameraPending)}" aria-pressed="${String(!seat.camera)}" aria-busy="${String(cameraPending)}">${escapeHtml(cameraLabel)}</button>
        <input type="range" class="lv-mini-slider" data-action="volume" min="0" max="1" step="0.05" value="${seat.volume ?? 1}">
        <button type="button" class="lv-mini-btn lv-mini-btn--program" data-action="onProgram" aria-pressed="${String(!seat.onProgram)}">${seat.onProgram ? "On Program" : "Off Program"}</button>
        <button type="button" class="lv-mini-btn lv-mini-btn--danger" data-action="kick">Kick</button>
      `;
      row.querySelector('[data-action="mic"]').addEventListener("click", () => this.session.setGuestMic(seat.id, !seat.mic));
      row.querySelector('[data-action="camera"]').addEventListener("click", () => this.session.setGuestCamera(seat.id, !seat.camera));
      row.querySelector('[data-action="volume"]').addEventListener("input", (event) => this.session.setGuestVolume(seat.id, Number(event.target.value)));
      row.querySelector('[data-action="onProgram"]').addEventListener("click", () => this.session.setGuestOnProgram(seat.id, !seat.onProgram));
      // Real removal (VDO disconnect command + durable server-side block — see LiveSession.kickGuest),
      // not a UI-only hide, so this asks for confirmation like End Session does.
      row.querySelector('[data-action="kick"]').addEventListener("click", () => {
        if (!window.confirm(`Remove ${seat.label || "this guest"} from the session?`)) return;
        this.session.kickGuest(seat.id);
      });
      return row;
    }));
  }

  // The actual production regression: a host publishing scene changes into an ENDED session got zero
  // feedback — every announce was rejected server-side, Program Output correctly never moved, but the
  // scene buttons kept responding to clicks as if everything worked (see LiveSession's own comment on
  // _handleHostPresenceRejected). Disables the scene controls specifically (not the whole Producer view —
  // recording/ticker/etc are a separate concern) and shows exactly why, using the same .control-note
  // pattern already used elsewhere in this panel.
  renderSessionControlRejected(rejection) {
    if (!this.elements.poSceneRejected) return;
    this.elements.poSceneRejected.hidden = false;
    this.elements.poSceneRejected.textContent = rejection.message;
    this.elements.poSceneGroup.querySelectorAll(".po-swatch").forEach((button) => { button.disabled = true; });
  }

  renderProgram(program) {
    this.elements.poTopic.value = program.topic;
    this.elements.poTickerEnabled.checked = program.tickerEnabled;
    this.elements.poTickerText.value = program.tickerText;
    this.elements.poTickerText.disabled = !program.tickerEnabled;
    if (this.elements.poTickerSpeed) this.elements.poTickerSpeed.value = String(program.tickerSpeed || 16);
    this.elements.poSceneGroup.querySelectorAll(".po-swatch").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.scene === program.scene));
    });
    const layout = program.compositionMode || (program.layout === "grid" ? "balanced" : program.layout) || "balanced";
    const layoutLabel = layout === "active-speaker" ? "Active Speaker" : layout === "spotlight" ? "Spotlight" : "Balanced";
    this.elements.layoutModeChip.textContent = layoutLabel;
    this.elements.layoutGroup.querySelectorAll("[data-layout]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.layout === layout || (layout === "balanced" && button.dataset.layout === "grid")));
    });
    const share = program.shareLayout || "screen-speaker";
    const shareLabel = share === "screen-only" ? "Full" : share === "screen-strip" ? "Strip" : "Speaker";
    if (this.elements.shareModeChip) this.elements.shareModeChip.textContent = shareLabel;
    this.elements.shareGroup?.querySelectorAll("[data-share]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.share === share));
    });
  }

  renderMoxie(status = this.session.hottieStatus || {}) {
    const state = status.state || "listening";
    if (this.elements.hottieStatus) {
      this.elements.hottieStatus.dataset.state = state;
      this.elements.hottieStatus.textContent = String(state).replace("-", " ").toUpperCase();
    }
    if (this.elements.hottieProposal) {
      const proposal = status.proposal;
      this.elements.hottieProposal.textContent = proposal?.label
        ? [proposal.label, proposal.query || proposal.title].filter(Boolean).join(" · ")
        : "Waiting for a Host production cue.";
    }
  }

  // Moxie's "Live Context" — what it's actually seeing right now, pulled from state that already exists
  // elsewhere in the session (Run of Show, program spotlight, transcript, audience feed) rather than any
  // new tracking of its own. Every field degrades to an em dash / "Nothing yet." instead of guessing.
  renderMoxieLiveContext() {
    if (this.elements.moxieCurrentTopic) {
      const current = this.session.runOfShow?.current?.();
      this.elements.moxieCurrentTopic.textContent = current?.title || "—";
    }
    if (this.elements.moxieRunOfShowPosition) {
      const items = this.session.runOfShow?.items || [];
      const index = items.findIndex((item) => item.status === "current");
      this.elements.moxieRunOfShowPosition.textContent = items.length
        ? `${index >= 0 ? index + 1 : "—"} of ${items.length}`
        : "—";
    }
    if (this.elements.moxieCurrentSpeaker) {
      const spotlightId = this.session.program?.spotlightParticipantId;
      let name = "—";
      if (spotlightId === "host") name = this.session.hostProfile?.displayName || "Host";
      else if (spotlightId) name = this.session.participants?.list?.().find((p) => p.participantId === spotlightId)?.displayName || spotlightId;
      this.elements.moxieCurrentSpeaker.textContent = name;
    }
    if (this.elements.moxieRecentHeard) {
      const recent = (this.session.transcript?.lines || []).slice(-3);
      this.elements.moxieRecentHeard.textContent = recent.length
        ? recent.map((line) => `${line.speaker}: ${line.text}`).join(" · ")
        : "Nothing yet.";
    }
    if (this.elements.moxieAudienceSignals) {
      const recent = (this.session.audience?.recent?.(3) || []).filter((m) => m?.text);
      this.elements.moxieAudienceSignals.textContent = recent.length
        ? recent.map((m) => `${m.author ? `${m.author}: ` : ""}${m.text}`).join(" · ")
        : "Nothing yet.";
    }
  }

  renderProgramOutputStatus() {
    const output = this.session.programOutput || {};
    const connection = output.connection || (output.connected ? "connected" : "disconnected");
    const expected = Number(output.expectedFeeds) || 0;
    const playing = Number(output.playingFeeds) || 0;
    const bound = Number(output.boundFeeds) || 0;
    if (this.elements.poConnection) {
      this.elements.poConnection.textContent = connection === "connected"
        ? "Connected"
        : connection === "connecting" ? "Connecting" : "Not connected";
    }
    if (this.elements.poFeeds) {
      if (connection === "disconnected") this.elements.poFeeds.textContent = "0 participant feeds";
      else if (expected) this.elements.poFeeds.textContent = `${expected} participant feed${expected === 1 ? "" : "s"} (${playing} playing, ${bound} bound)`;
      else this.elements.poFeeds.textContent = "0 participant feeds";
    }
    if (this.elements.poAudioState) {
      this.elements.poAudioState.textContent = output.audioError
        ? `Audio failed: ${output.audioError}`
        : output.audioReady ? "Audio enabled" : "Audio off";
    }
    if (this.elements.poReadyState) {
      const reason = !output.readyToRecord ? (this.session.recordingBlockReason?.() || "Not ready to record") : null;
      this.elements.poReadyState.textContent = output.readyToRecord ? "Ready to record" : (reason || "Not ready to record");
    }
    if (this.elements.poVideoFlag) {
      this.elements.poVideoFlag.textContent = output.videoReady ? "VIDEO READY" : "VIDEO —";
      this.elements.poVideoFlag.dataset.ready = String(Boolean(output.videoReady));
    }
    if (this.elements.poAudioFlag) {
      this.elements.poAudioFlag.textContent = output.audioReady ? "AUDIO READY" : "AUDIO —";
      this.elements.poAudioFlag.dataset.ready = String(Boolean(output.audioReady));
    }
  }

  renderRecording(recording) {
    const active = Boolean(recording.active);
    const saving = recording.status === "saving";
    const processing = !active && !saving && recording.last?.finalizationStatus === "pending-finalization";
    this.elements.recordToggle.setAttribute("aria-pressed", String(active && !saving));
    this.elements.recordToggle.textContent = saving ? "SAVING RECORDING..." : active ? "STOP RECORDING" : "RECORD PROGRAM";
    this.elements.recordTimer.hidden = !active && !saving;
    if (this.elements.recordStatus) {
      if (saving) this.elements.recordStatus.textContent = "Saving recording...";
      else if (processing) this.elements.recordStatus.textContent = "Recording saved · Preparing MP4...";
      else if (active && recording.startedAt) {
        const elapsed = Math.floor((Date.now() - recording.startedAt) / 1000);
        this.elements.recordStatus.textContent = `RECORDING · ${formatClock(elapsed)}`;
      } else if (recording.last?.finalizationStatus === "finalized") this.elements.recordStatus.textContent = "Recording ready";
      else if (recording.last?.finalizationStatus === "failed") this.elements.recordStatus.textContent = "Recording saved";
      else if (recording.last?.finalizationStatus === "local-only") this.elements.recordStatus.textContent = "Recording saved in this tab only";
      else if (recording.last) this.elements.recordStatus.textContent = "Recording saved";
      else this.elements.recordStatus.textContent = "Idle";
    }
    if (this.elements.recordMarker) this.elements.recordMarker.hidden = !active || saving;
    this.elements.recordToggle.closest(".lv-record")?.setAttribute("data-active", String(active));
    if (active && recording.startedAt) {
      const elapsed = Math.floor((Date.now() - recording.startedAt) / 1000);
      this.elements.recordTimer.textContent = formatClock(elapsed);
    } else if (!saving) {
      this.elements.recordTimer.textContent = "00:00";
    }
    this.renderMasterPlayback(recording.last);
    this.renderRecordingGate();
  }

  renderMasterPlayback(last) {
    if (!this.elements.masterPlayback) return;
    // ROOT CAUSE (MP4 finalization incident follow-up): last.sourceBlob is retained regardless of MP4
    // finalization outcome (see live-session.js's post-stop state and its finalization-failure catch,
    // which only ever adds fields, never clears sourceBlob) — but this method used to gate EVERY button,
    // including a WebM download, on last.blob/.objectUrl (the MP4-or-webm-fallback pair), so a producer
    // whose MP4 failed had no visible, dedicated way to get the WebM Toasty already saved for them. This
    // button is gated on sourceBlob alone, independent of MP4 status, in both branches below.
    if (this.elements.masterDownloadWebm) this.elements.masterDownloadWebm.disabled = !last?.sourceBlob;
    if (!last?.blob || !last?.objectUrl) {
      this.elements.masterPlayback.hidden = !last;
      if (this.elements.masterVideo) this.elements.masterVideo.removeAttribute("src");
      if (this.elements.masterDownload) this.elements.masterDownload.disabled = true;
      if (this.elements.masterPlay) this.elements.masterPlay.disabled = true;
      if (this.elements.masterManifest) this.elements.masterManifest.disabled = !last?.manifest;
      if (this.elements.masterManifestNote && last?.finalizationStatus === "pending-finalization") {
        this.elements.masterManifestNote.textContent = "Recording saved · Preparing MP4...";
      } else if (this.elements.masterManifestNote && last?.finalizationStatus === "failed") {
        this.elements.masterManifestNote.textContent = "Recording saved. MP4 processing failed and can be retried.";
      } else if (this.elements.masterManifestNote && last?.finalizationStatus === "local-only") {
        this.elements.masterManifestNote.textContent = "Recording is only available in this tab. Keep this page open and download details before leaving.";
      }
      return;
    }
    this.elements.masterPlayback.hidden = false;
    if (this.elements.masterDownload) this.elements.masterDownload.disabled = false;
    if (this.elements.masterPlay) this.elements.masterPlay.disabled = false;
    if (this.elements.masterManifest) this.elements.masterManifest.disabled = !last?.manifest;
    if (this.elements.masterVideo && this.elements.masterVideo.src !== last.objectUrl) {
      this.elements.masterVideo.src = last.objectUrl;
    }
    if (this.elements.masterManifestNote) {
      const duration = formatClock(Math.round(last.durationSeconds || 0));
      this.elements.masterManifestNote.textContent = `${duration}. MP4 recording. Play to confirm Host, Guest, lower thirds, TAKE LIVE, speech, and soundboard.`;
    }
  }

  playMaster() {
    const video = this.elements.masterVideo;
    if (!video?.src) return;
    video.play?.().catch(() => {});
  }

  downloadMaster() {
  const last = this.session.recording.last;
  if (!last?.blob) return;

  const isMp4 = Boolean(last.masterBlob);
  const extension = isMp4 ? "mp4" : "webm";

  downloadFile(last.blob, `${last.recordingId}.${extension}`);
}

  // Explicit, dedicated WebM download — always the original tab-capture source, never the MP4, and
  // available whether or not MP4 finalization ever succeeded. Distinct from downloadMaster() above,
  // which downloads whichever of the two is currently "the" recording depending on finalization state.
  downloadSourceWebm() {
    const last = this.session.recording.last;
    if (!last?.sourceBlob) return;
    downloadFile(last.sourceBlob, `${last.recordingId}-source.webm`);
  }

  downloadManifest() {
    const last = this.session.recording.last;
    if (!last?.manifest) return;
    downloadFile(new Blob([JSON.stringify(last.manifest, null, 2)], { type: "application/json" }), `${last.recordingId}-manifest.json`);
  }

  renderRecordingGate() {
    const active = Boolean(this.session.recording.active);
    const saving = this.session.recording.status === "saving";
    const allowed = this.session.canRecord();
    this.elements.recordToggle.disabled = saving || (!allowed && !active);
    if (active || saving) return;
    if (this.elements.recordNote.dataset.error === "true") return;
    const blocked = this.session.recordingBlockReason?.();
    if (blocked) {
      this.elements.recordNote.textContent = blocked;
      return;
    }
    this.elements.recordNote.textContent = "Program Output is ready. Click RECORD PROGRAM, select the Program Output tab, and turn Share tab audio ON.";
  }

  // ROOT CAUSE of "recording only starts when Share tab audio enabled" landing as a confusing,
  // easy-to-miss failure: startRecording() used to fire getDisplayMedia's native browser picker
  // almost immediately after emitting the instruction text — that text lands in #lvRecordNote, but
  // the OS-level picker dialog steals focus before most people read it, and "Share tab audio" is
  // OFF by default in Chrome's own picker. There is no way to pre-check that box from JS — it is a
  // deliberate, non-scriptable browser security control — so the only lever here is making sure the
  // instruction is actually read and acknowledged before the picker ever appears, and making a
  // failed attempt obviously retryable rather than a silent/confusing dead end.
  async toggleRecording() {
    if (!this.session.recording.active) {
      const proceed = window.confirm(
        `${PROGRAM_OUTPUT_PICKER_INSTRUCTION}\n\nClick OK, then in the browser's share dialog pick "Toasty Studio — Program Output" and turn Share tab audio ON before confirming.`
      );
      if (!proceed) {
        this.elements.recordNote.textContent = "Recording canceled. Click RECORD PROGRAM when you're ready to select Program Output with Share tab audio ON.";
        this.elements.recordNote.dataset.error = "false";
        return;
      }
    }
    try {
      this.elements.recordToggle.disabled = true;
      this.elements.recordNote.dataset.error = "false";
      if (this.session.recording.active) {
        await this.session.stopRecording();
      } else {
        await this.session.startRecording();
      }
    } catch (error) {
      this.elements.recordNote.textContent = `${humanizeError(error)} Click RECORD PROGRAM to try again.`;
      this.elements.recordNote.dataset.error = "true";
    } finally {
      this.elements.recordToggle.disabled = this.session.recording.status === "saving" || (!this.session.canRecord() && !this.session.recording.active);
      this.renderRecording(this.session.recording);
    }
  }
}

function formatClock(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remain = seconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`;
  }
  return `${String(minutes).padStart(2, "0")}:${String(remain).padStart(2, "0")}`;
}

function humanizeError(error) {
  if (error?.userMessage) return error.userMessage;
  if (error?.reason === "missing-audio" || error?.reason === "audio-not-live") {
    return "Recording needs Program Output audio. Select the Toasty Program Output tab and enable Share tab audio.";
  }
  if (error?.reason === "missing-video" || error?.reason === "video-not-live") {
    return "Program Output video capture is unavailable.";
  }
  if (error?.reason === "invalid-recorder-state" || error?.name === "InvalidStateError" || /invalid state|state is invalid/i.test(error?.message || "")) {
    return "Program Output capture could not start. Select “Toasty Studio — Program Output” and turn Share tab audio ON.";
  }
  if (error?.name === "NotAllowedError") return "Program Output tab share was cancelled. Select that tab and enable Share tab audio.";
  if (error?.name === "NotFoundError") return "No shareable tab was found.";
  if (error?.name === "NotReadableError") return "The selected tab could not be captured.";
  const message = String(error?.message || "").trim();
  if (message && !/invalid state/i.test(message)) return message;
  return "Program Output capture could not start. Open Program Output, enable audio, and try again.";
}

function downloadFile(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function splitLines(value = "") {
  return String(value || "").split(/\n/g).map((line) => line.trim()).filter(Boolean);
}

function focusIntelEmpty(text) {
  const p = document.createElement("p");
  p.className = "lv-placeholder";
  p.textContent = text;
  return p;
}

function focusIntelList(label, items, formatItem, emptyText) {
  const group = document.createElement("div");
  group.className = "lv-focus-intel-group";
  const head = document.createElement("h5");
  head.textContent = label;
  group.appendChild(head);
  if (!items?.length) {
    group.appendChild(focusIntelEmpty(emptyText));
    return group;
  }
  const list = document.createElement("ul");
  items.slice(0, 6).forEach((item) => {
    const li = document.createElement("li");
    li.textContent = formatItem(item);
    list.appendChild(li);
  });
  group.appendChild(list);
  return group;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
