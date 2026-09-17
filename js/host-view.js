import { renderFeedEntry } from "./ai-producer.js";
import { PushToTalkCapture } from "./talk-to-producer.js";

// HostView: a thin control surface over LiveSession for running the conversation. It owns no state of
// its own beyond DOM bindings — everything it shows comes from session.* and its events. Keep this file
// small on purpose (see Phase 1 instruction to protect Host View from feature creep): if a control feels
// like production configuration rather than "talk, see who's up, glance at notes," it belongs in
// ProducerView instead, not here because there happened to be empty space.
export class HostView {
  constructor({ session, root = document }) {
    this.session = session;
    this.root = root;
    this.elements = {
      toggleMic: root.querySelector("#lvToggleMic"),
      toggleCamera: root.querySelector("#lvToggleCamera"),
      toggleScreen: root.querySelector("#lvToggleScreen"),
      leaveStudio: root.querySelector("#lvLeaveStudio"),
      guestContext: root.querySelector("#lvGuestContext"),
      hostPanelStatus: root.querySelector("#lvHostPanelStatus"),
      guestPanelStatus: root.querySelector("#lvGuestPanelStatus"),
      guestStageEmpty: root.querySelector("#lvGuestStageEmpty"),
      agendaList: root.querySelector("#lvAgendaList"),
      agendaNext: root.querySelector("#lvAgendaNext"),
      agendaAddForm: root.querySelector("#lvAgendaAddForm"),
      agendaAddInput: root.querySelector("#lvAgendaAddInput"),
      audienceList: root.querySelector("#lvAudienceList"),
      audienceCount: root.querySelector("#lvAudienceCount"),
      feedList: root.querySelector("#lvFeedListHost"),
      talkBtn: root.querySelector("#lvTalkBtn"),
      talkState: root.querySelector("#lvTalkState"),
      talkLive: root.querySelector("#lvTalkLive"),
      talkTextForm: root.querySelector("#lvTalkTextForm"),
      talkTextInput: root.querySelector("#lvTalkTextInput")
    };
    this._agendaTimerId = null;
  }

  init() {
    this.elements.toggleMic.addEventListener("click", () => this.session.toggleMic());
    this.elements.toggleCamera.addEventListener("click", () => this.session.toggleCamera());
    this.elements.toggleScreen.addEventListener("click", () => this.session.toggleScreenShare());
    this.elements.leaveStudio.addEventListener("click", () => this.session.leaveStudio());

    this.session.on("av", (av) => this.renderAv(av));
    this.session.on("screenshare", (s) => this.renderScreenShare(s));
    this.session.on("guests", () => this.renderGuestContext());
    this.session.on("connection", (c) => this.renderConnection(c));

    this.renderAv(this.session.av);
    this.renderScreenShare(this.session.screenShare);
    this.renderGuestContext();
    this.renderConnection(this.session.connection);

    this.initRunOfShow();
    this.initAudience();
    this.initAiProducer();
  }

  renderAv(av) {
    updatePressed(this.elements.toggleMic, av.micMuted, "Mute mic", "Unmute mic");
    updatePressed(this.elements.toggleCamera, av.cameraOff, "Camera off", "Camera on");
  }

  renderScreenShare(screenShare) {
    updatePressed(this.elements.toggleScreen, Boolean(screenShare?.active), "Share screen", "Stop sharing");
  }

  renderConnection(connection) {
    this.elements.hostPanelStatus.textContent = connection.status === "connected" ? "Live" : connection.label;
    this.elements.hostPanelStatus.dataset.state = connection.status;
  }

  renderGuestContext() {
    const seats = this.session.guestSeats;
    const count = seats.filter(Boolean).length;
    this.elements.guestPanelStatus.textContent = `${count} connected`;
    this.elements.guestPanelStatus.dataset.state = count > 0 ? "connected" : "idle";
    this.elements.guestStageEmpty.hidden = count > 0;

    this.elements.guestContext.replaceChildren(...seats.map((seat, index) => {
      const pill = document.createElement("span");
      pill.className = "lv-guest-pill";
      pill.dataset.state = seat ? "active" : "idle";
      pill.textContent = seat ? (seat.label || `Guest ${index + 1}`) : `Guest ${index + 1} · Open`;
      return pill;
    }));
  }

  // ---- Run of Show ----

  initRunOfShow() {
    this.session.runOfShow.on(() => this.renderAgenda());
    this.elements.agendaNext.addEventListener("click", () => this.session.runOfShow.moveNext());
    this.elements.agendaAddForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const title = this.elements.agendaAddInput.value.trim();
      if (!title) return;
      this.session.runOfShow.addTopic({ title });
      this.elements.agendaAddInput.value = "";
    });
    this.renderAgenda();
    // Redraw every 15s so the current topic's elapsed timer keeps moving without a full re-render loop.
    this._agendaTimerId = window.setInterval(() => this.renderAgenda(), 15000);
  }

  renderAgenda() {
    const items = this.session.runOfShow.items;
    this.elements.agendaList.replaceChildren(...items.map((item, index) => {
      const li = document.createElement("li");
      li.className = "lv-agenda-item";
      li.dataset.status = item.status;

      const statusBtn = document.createElement("button");
      statusBtn.type = "button";
      statusBtn.className = "lv-agenda-status";
      statusBtn.title = item.status === "current" ? "Mark complete" : item.status === "upcoming" ? "Mark current" : "Completed";
      statusBtn.textContent = item.status === "completed" ? "✓" : item.status === "current" ? "→" : "○";
      statusBtn.addEventListener("click", () => {
        if (item.status === "upcoming") this.session.runOfShow.markCurrent(item.id);
        else if (item.status === "current") this.session.runOfShow.complete(item.id);
      });
      li.appendChild(statusBtn);

      const title = document.createElement("span");
      title.className = "lv-agenda-title";
      title.textContent = item.title;
      li.appendChild(title);

      if (item.status === "current") {
        const timer = document.createElement("span");
        timer.className = "lv-agenda-timer";
        timer.textContent = formatElapsed(this.session.runOfShow.currentElapsedMs());
        li.appendChild(timer);
      }

      const actions = document.createElement("span");
      actions.className = "lv-agenda-row-actions";
      actions.appendChild(rowActionButton("↑", "Move up", () => this.session.runOfShow.reorder(item.id, index - 1)));
      actions.appendChild(rowActionButton("↓", "Move down", () => this.session.runOfShow.reorder(item.id, index + 1)));
      actions.appendChild(rowActionButton("✎", "Edit", () => {
        const nextTitle = window.prompt("Topic title", item.title);
        if (nextTitle?.trim()) this.session.runOfShow.editTopic(item.id, { title: nextTitle.trim() });
      }));
      actions.appendChild(rowActionButton("×", "Remove", () => this.session.runOfShow.removeTopic(item.id)));
      li.appendChild(actions);

      return li;
    }));
  }

  // ---- Audience ----

  initAudience() {
    this.session.audience.on(() => this.renderAudience());
    this.renderAudience();
  }

  renderAudience() {
    const messages = this.session.audience.recent(40);
    this.elements.audienceCount.textContent = String(this.session.audience.messages.length);
    if (!messages.length) {
      this.elements.audienceList.replaceChildren(placeholder("Live chat and questions land here."));
      return;
    }
    this.elements.audienceList.replaceChildren(...messages.slice().reverse().map((message) => {
      const row = document.createElement("div");
      row.className = "lv-audience-item";
      row.dataset.type = message.type;
      const name = document.createElement("span");
      name.className = "lv-audience-name";
      name.textContent = message.displayName;
      const text = document.createElement("span");
      text.className = "lv-audience-message";
      text.textContent = message.message;
      row.append(name, text);
      return row;
    }));
  }

  // ---- AI Producer ----
  // States: READY -> LISTENING (live interim text under the button) -> THINKING (instruction retained,
  // visible on the pending feed entry) -> RESULT (new entry flashes in, nothing else on the page moves).

  initAiProducer() {
    this._lastRenderedSignature = null;
    this.session.aiProducerFeed.on(() => this.renderFeed());
    this.renderFeed();

    this._capture = new PushToTalkCapture({
      onListening: () => {
        this.setTalkState("listening");
        this.elements.talkLive.hidden = false;
        this.elements.talkLive.textContent = "";
      },
      onInterim: (text) => { this.elements.talkLive.textContent = text; },
      onResult: (text) => { this.elements.talkLive.hidden = true; this.submitInstruction(text); },
      onError: (error) => {
        this.elements.talkLive.hidden = true;
        this.setTalkState("ready", error.message);
      }
    });

    const start = () => this.elements.talkBtn.disabled ? null : this._capture.start();
    const stop = () => this._capture.stop();
    this.elements.talkBtn.addEventListener("mousedown", start);
    this.elements.talkBtn.addEventListener("touchstart", start, { passive: true });
    this.elements.talkBtn.addEventListener("mouseup", stop);
    this.elements.talkBtn.addEventListener("mouseleave", stop);
    this.elements.talkBtn.addEventListener("touchend", stop);

    this.elements.talkTextForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.elements.talkTextInput.value.trim();
      if (!text) return;
      this.elements.talkTextInput.value = "";
      this.submitInstruction(text);
    });
  }

  setTalkState(state, note) {
    this.elements.talkBtn.dataset.state = state;
    this.elements.talkBtn.disabled = state === "thinking";
    this.elements.talkState.textContent = note || (state === "listening" ? "Listening…" : state === "thinking" ? "Thinking…" : "Ready");
  }

  async submitInstruction(text) {
    const instructionReadyAt = performance.now();
    this.setTalkState("thinking");
    try {
      await this.session.sendToProducer(text, { instructionReadyAt });
    } catch (_) {
      // Feed already shows the error entry — nothing else to do here.
    } finally {
      this.setTalkState("ready");
    }
  }

  renderFeed() {
    const entries = this.session.aiProducerFeed.visible();
    if (!entries.length) {
      this.elements.feedList.replaceChildren(placeholder("Following conversation…"), placeholder("No producer requests yet.", "lv-placeholder-sub"));
      this._lastRenderedSignature = null;
      return;
    }
    // Keyed on id+type, not just id: ProducerFeed.replace() keeps the SAME id when a "working" entry
    // becomes its result, so an id-only check would never see that transition as "new" and the flash
    // would silently never fire (caught by actually running this against the backend, not just reading
    // the code).
    const signature = `${entries[0].id}:${entries[0].type}`;
    const isFreshResult = signature !== this._lastRenderedSignature && entries[0].type !== "working";
    this.elements.feedList.replaceChildren(...entries.map((entry) => renderFeedEntry(entry, {
      onDismiss: (id) => this.session.aiProducerFeed.dismiss(id),
      onPin: (id) => this.session.aiProducerFeed.togglePin(id)
    })));
    if (isFreshResult) {
      const newestEl = this.elements.feedList.firstElementChild;
      newestEl?.classList.add("lv-feed-entry--flash");
      window.setTimeout(() => newestEl?.classList.remove("lv-feed-entry--flash"), 1200);
    }
    this._lastRenderedSignature = signature;
  }
}

function updatePressed(button, pressed, offLabel, onLabel) {
  const label = pressed ? onLabel : offLabel;
  button.setAttribute("aria-pressed", String(pressed));
  button.setAttribute("title", label);
  const labelEl = button.querySelector(".lv-icon-label");
  if (labelEl) labelEl.textContent = label;
}

function rowActionButton(glyph, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = glyph;
  button.title = title;
  button.dataset.action = title;
  button.addEventListener("click", onClick);
  return button;
}

function placeholder(text, extraClass) {
  const p = document.createElement("p");
  p.className = extraClass ? `lv-placeholder ${extraClass}` : "lv-placeholder";
  p.textContent = text;
  return p;
}

function formatElapsed(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}
