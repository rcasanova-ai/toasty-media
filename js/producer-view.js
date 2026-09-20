import { Soundboard } from "./soundboard.js";
import { renderFeedEntry } from "./ai-producer.js";

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
      poTopic: root.querySelector("#lvPoTopic"),
      poSceneGroup: root.querySelector("#lvPoSceneGroup"),
      poTickerEnabled: root.querySelector("#lvPoTickerEnabled"),
      poTickerText: root.querySelector("#lvPoTickerText"),
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
      aiDiagProvider: root.querySelector("#lvAiDiagProvider")
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

    this.elements.poTopic.addEventListener("input", () => this.session.setTopic(this.elements.poTopic.value));
    this.elements.poTickerEnabled.addEventListener("change", () => {
      this.elements.poTickerText.disabled = !this.elements.poTickerEnabled.checked;
      this.session.setTicker({ enabled: this.elements.poTickerEnabled.checked });
    });
    this.elements.poTickerText.addEventListener("input", () => this.session.setTicker({ text: this.elements.poTickerText.value }));
    this.elements.poSceneGroup.querySelectorAll(".po-swatch").forEach((button) => {
      button.addEventListener("click", () => {
        this.session.setScene(button.dataset.scene);
        this.session.setLive(button.dataset.scene === "live");
        this.elements.poSceneGroup.querySelectorAll(".po-swatch").forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
      });
    });

    this.elements.recordToggle.addEventListener("click", () => this.toggleRecording());
    this.elements.recordMarker?.addEventListener("click", () => {
      const marker = this.session.addMarker();
      this.elements.recordNote.textContent = `Marked ${formatClock(Math.floor((marker.timestamp - (this.session.recording.startedAt || marker.timestamp)) / 1000))} · ${marker.label}`;
    });
    this.elements.masterPlay?.addEventListener("click", () => this.playMaster());
    this.elements.masterDownload?.addEventListener("click", () => this.downloadMaster());
    this.elements.masterManifest?.addEventListener("click", () => this.downloadManifest());
    this.elements.openProgramOutput.addEventListener("click", () => {
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

    this.session.on("guests", () => this.renderGuests());
    this.session.on("av", () => this.renderGuests());
    this.session.on("program", (program) => this.renderProgram(program));
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
    this.renderRecording(this.session.recording);
    this.renderProgramOutputStatus();
    this.renderRecordingGate();
    this.renderFeedMirror();
    this.renderAiDiagnostics(this.session.aiProducerService.sessionTotals());
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
      onRemoveAsset: (id) => this.session.liveProducer.removeLiveAsset(id)
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
      row.innerHTML = `
        <span class="lv-source-name">${escapeHtml(seat.label || `Guest ${index + 1}`)}</span>
        <button type="button" class="lv-mini-btn" data-action="mic" aria-pressed="${String(!seat.mic)}">Mic</button>
        <button type="button" class="lv-mini-btn" data-action="camera" aria-pressed="${String(!seat.camera)}">Cam</button>
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

  renderProgram(program) {
    this.elements.poTopic.value = program.topic;
    this.elements.poTickerEnabled.checked = program.tickerEnabled;
    this.elements.poTickerText.value = program.tickerText;
    this.elements.poTickerText.disabled = !program.tickerEnabled;
    this.elements.poSceneGroup.querySelectorAll(".po-swatch").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.scene === program.scene));
    });
    this.elements.layoutModeChip.textContent = program.layout === "screen-dominant" ? "Screen Dominant" : "Grid";
    this.elements.layoutGroup.querySelectorAll("[data-layout]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.layout === program.layout));
    });
  }

  renderProgramOutputStatus() {
    const output = this.session.programOutput || {};
    const feeds = Number(output.boundFeeds) || 0;
    const expected = Number(output.expectedFeeds) || 0;
    if (this.elements.poConnection) {
      this.elements.poConnection.textContent = output.connected ? "Connected" : "Not connected";
    }
    if (this.elements.poFeeds) {
      this.elements.poFeeds.textContent = output.connected
        ? `${feeds} participant feed${feeds === 1 ? "" : "s"}${expected ? ` bound (${feeds}/${expected})` : ""}`
        : "0 participant feeds";
    }
    if (this.elements.poAudioState) {
      this.elements.poAudioState.textContent = output.audioReady ? "Audio enabled" : "Audio off";
    }
    if (this.elements.poReadyState) {
      this.elements.poReadyState.textContent = output.readyToRecord ? "Ready to record" : "Not ready to record";
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
    this.elements.recordToggle.setAttribute("aria-pressed", String(active && !saving));
    this.elements.recordToggle.textContent = saving ? "SAVING RECORDING…" : active ? "STOP RECORDING" : "START RECORDING";
    this.elements.recordTimer.hidden = !active && !saving;
    if (this.elements.recordStatus) {
      if (saving) this.elements.recordStatus.textContent = "SAVING RECORDING…";
      else if (active && recording.startedAt) {
        const elapsed = Math.floor((Date.now() - recording.startedAt) / 1000);
        this.elements.recordStatus.textContent = `RECORDING · ${formatClock(elapsed)}`;
      } else if (recording.last) this.elements.recordStatus.textContent = "RECORDING SAVED";
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
    if (!last?.objectUrl) {
      this.elements.masterPlayback.hidden = true;
      return;
    }
    this.elements.masterPlayback.hidden = false;
    if (this.elements.masterVideo && this.elements.masterVideo.src !== last.objectUrl) {
      this.elements.masterVideo.src = last.objectUrl;
    }
    if (this.elements.masterManifestNote) {
      const duration = formatClock(Math.round(last.durationSeconds || 0));
      this.elements.masterManifestNote.textContent = `${duration}. Play to confirm Host, Guest, lower thirds, TAKE LIVE, speech, and soundboard.`;
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
    downloadFile(last.blob, `${last.recordingId}.webm`);
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
    this.elements.recordNote.textContent = "Program Output is ready. Click START RECORDING, then select that tab and turn Share tab audio ON.";
  }

  async toggleRecording() {
    try {
      this.elements.recordToggle.disabled = true;
      this.elements.recordNote.dataset.error = "false";
      if (this.session.recording.active) {
        await this.session.stopRecording();
      } else {
        await this.session.startRecording();
      }
    } catch (error) {
      this.elements.recordNote.textContent = humanizeError(error);
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
    return "Program Output audio was not shared. Start again and enable Share tab audio.";
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
