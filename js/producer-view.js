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
      recordToggle: root.querySelector("#lvRecordToggle"),
      recordNote: root.querySelector("#lvRecordNote"),
      recordTimer: root.querySelector("#lvRecordTimer"),
      soundboard: root.querySelector("#lvSoundboard"),
      soundboardVolume: root.querySelector("#lvSoundboardVolume"),
      soundboardTabs: root.querySelector("#lvSoundboardTabs"),
      soundboardSearch: root.querySelector("#lvSoundboardSearch"),
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
      searchInput: this.elements.soundboardSearch
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
    this.session.on("recording-status", (message) => { this.elements.recordNote.textContent = message; });
    this.session.on("policy", () => this.renderRecordingGate());
    this.session.aiProducerFeed.on(() => this.renderFeedMirror());
    this.session.on("transcription", (state) => this.renderTranscriptionStatus(state));
    this.session.aiProducerService.on((totals) => this.renderAiDiagnostics(totals));

    this.renderGuests();
    this.renderProgram(this.session.program);
    this.renderRecording(this.session.recording);
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
      onSendToProgram: (id) => this.session.aiProducerService.sendEntryToProgram(id)
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
      `;
      row.querySelector('[data-action="mic"]').addEventListener("click", () => this.session.setGuestMic(seat.id, !seat.mic));
      row.querySelector('[data-action="camera"]').addEventListener("click", () => this.session.setGuestCamera(seat.id, !seat.camera));
      row.querySelector('[data-action="volume"]').addEventListener("input", (event) => this.session.setGuestVolume(seat.id, Number(event.target.value)));
      row.querySelector('[data-action="onProgram"]').addEventListener("click", () => this.session.setGuestOnProgram(seat.id, !seat.onProgram));
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

  renderRecording(recording) {
    this.elements.recordToggle.setAttribute("aria-pressed", String(recording.active));
    this.elements.recordToggle.textContent = recording.active ? "Stop recording" : "Start recording";
    this.elements.recordTimer.hidden = !recording.active;
    if (recording.active && recording.startedAt) {
      const elapsed = Math.floor((Date.now() - recording.startedAt) / 1000);
      this.elements.recordTimer.textContent = formatTimer(elapsed);
    } else {
      this.elements.recordTimer.textContent = "00:00:00";
    }
  }

  renderRecordingGate() {
    const allowed = this.session.canRecord();
    this.elements.recordToggle.disabled = !allowed;
    if (!allowed) {
      this.elements.recordNote.textContent = this.session.policy.canRecord()
        ? "Recording is unavailable in this browser. Use current Chrome for the recording proof."
        : "Recording is disabled by this session's capture policy.";
    } else if (!this.session.recording.active) {
      this.elements.recordNote.textContent = "Host track only here. Guest tracks are captured from the guest page.";
    }
  }

  async toggleRecording() {
    try {
      this.elements.recordToggle.disabled = true;
      if (this.session.recording.active) {
        await this.session.stopRecording();
      } else {
        await this.session.startRecording();
      }
    } catch (error) {
      this.elements.recordNote.textContent = `Recording failed: ${humanizeError(error)}`;
    } finally {
      this.elements.recordToggle.disabled = !this.session.canRecord();
    }
  }
}

function formatTimer(totalSeconds) {
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function humanizeError(error) {
  if (error?.name === "NotAllowedError") return "camera or microphone permission was denied.";
  if (error?.name === "NotFoundError") return "no camera or microphone device was found.";
  if (error?.name === "NotReadableError") return "camera or microphone is already in use or unavailable.";
  return error?.message || "unknown browser recording error.";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
