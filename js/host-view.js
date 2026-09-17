// No ?v= cache-busting suffix on this file's own reference in director.js on purpose: the root
// .htaccess forces Cache-Control: no-cache on every first-party .js/.css, so a deploy touching this
// file is always visible on next load without anyone remembering to bump a version string. See
// .htaccess.
import { renderFeedEntry } from "./ai-producer.js";
import { PushToTalkCapture } from "./talk-to-producer.js";
import { DEMO_AUDIENCE_PLATFORM_BREAKDOWN, DEMO_AUDIENCE_TOTAL } from "./audience.js";

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
      guestCount: root.querySelector("#lvGuestCount"),
      hostPanelStatus: root.querySelector("#lvHostPanelStatus"),
      guestPanelStatus: root.querySelector("#lvGuestPanelStatus"),
      guestStageEmpty: root.querySelector("#lvGuestStageEmpty"),
      agendaList: root.querySelector("#lvAgendaList"),
      agendaNext: root.querySelector("#lvAgendaNext"),
      agendaAddForm: root.querySelector("#lvAgendaAddForm"),
      agendaAddInput: root.querySelector("#lvAgendaAddInput"),
      audienceList: root.querySelector("#lvAudienceList"),
      audienceCount: root.querySelector("#lvAudienceCount"),
      audienceDemoBreakdown: root.querySelector("#lvAudienceDemoBreakdown"),
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
    const connected = seats.filter(Boolean);
    this.elements.guestPanelStatus.textContent = `${connected.length} connected`;
    this.elements.guestPanelStatus.dataset.state = connected.length > 0 ? "connected" : "idle";
    this.elements.guestStageEmpty.hidden = connected.length > 0;
    this.elements.guestCount.textContent = String(connected.length);

    if (!connected.length) {
      this.elements.guestContext.replaceChildren(placeholder("No guests connected yet."));
      return;
    }

    this.elements.guestContext.replaceChildren(...connected.map((seat) => {
      const row = document.createElement("div");
      row.className = "lv-guest-row";
      row.dataset.status = seat.connectionStatus || "connected";
      const dot = document.createElement("span");
      dot.className = "lv-guest-dot";
      dot.setAttribute("aria-hidden", "true");
      const name = document.createElement("span");
      name.className = "lv-guest-name";
      name.textContent = seat.displayName || seat.label || "Guest";
      row.append(dot, name);
      const role = [seat.title, seat.company].filter(Boolean).join(", ");
      if (role) {
        const roleEl = document.createElement("span");
        roleEl.className = "lv-guest-role";
        roleEl.textContent = `· ${role}`;
        row.appendChild(roleEl);
      }
      return row;
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
    // Demo Mode toggling changes what the count/breakdown MEANS (simulated vs. real), not just whether
    // messages are dripping — see renderAudience's own comment for why this can never render outside an
    // explicit session.demoMode check.
    this.session.on("demo-mode", () => this.renderAudience());
    this.renderAudience();
  }

  // Simulated per-platform viewer counts (see js/audience.js's DEMO_AUDIENCE_PLATFORM_BREAKDOWN) render
  // ONLY while session.demoMode is true, and only ever alongside a visible "DEMO" marker — this is the
  // one explicit gate the whole feature is required to have, so a simulated number can never be mistaken
  // for real production telemetry (see this repair pass's report).
  renderAudience() {
    const messages = this.session.audience.recent(40);
    if (this.session.demoMode) {
      this.elements.audienceCount.textContent = `${DEMO_AUDIENCE_TOTAL} · DEMO`;
      this.elements.audienceDemoBreakdown.hidden = false;
      this.elements.audienceDemoBreakdown.replaceChildren(...DEMO_AUDIENCE_PLATFORM_BREAKDOWN.map((p) => {
        const row = document.createElement("div");
        row.className = "lv-audience-demo-row";
        const label = document.createElement("span");
        label.textContent = p.label;
        const count = document.createElement("span");
        count.textContent = String(p.count);
        row.append(label, count);
        return row;
      }));
    } else {
      this.elements.audienceCount.textContent = String(this.session.audience.messages.length);
      this.elements.audienceDemoBreakdown.hidden = true;
      this.elements.audienceDemoBreakdown.replaceChildren();
    }
    if (!messages.length) {
      this.elements.audienceList.replaceChildren(placeholder("Live chat and questions land here."));
      return;
    }
    this.elements.audienceList.replaceChildren(...messages.slice().reverse().map((message) => {
      const row = document.createElement("div");
      row.className = "lv-audience-item";
      row.dataset.type = message.type;
      if (message.surfaced) row.dataset.surfaced = "true";
      const name = document.createElement("span");
      name.className = "lv-audience-name";
      name.textContent = message.surfaced ? `★ ${message.displayName}` : message.displayName;
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

    // Pointer Events (not mousedown/touchstart+mouseup/touchend/mouseleave) on purpose: the old bindings
    // fired start() from BOTH touchstart and its synthesized mousedown on touch devices, and mouseleave
    // released the hold the instant the cursor drifted off the button — a real failure mode, not a
    // hypothetical one (see this repair pass's report). setPointerCapture keeps this ONE pointer's events
    // routed to the button even if it visually leaves the element's box, and one pointerId is tracked at
    // a time so a second finger/click mid-hold can't start a competing capture.
    const btn = this.elements.talkBtn;
    let activePointerId = null;
    const endHold = (event) => {
      if (event.pointerId !== activePointerId) return;
      activePointerId = null;
      this._capture.stop();
    };
    btn.addEventListener("pointerdown", (event) => {
      if (btn.disabled || activePointerId !== null) return;
      event.preventDefault();
      activePointerId = event.pointerId;
      // Best-effort: capture is what keeps the hold alive if the pointer drifts off the button, but it
      // must never be able to block the hold from starting at all if the browser refuses it for any
      // reason (e.g. no active pointer session for that id) — the capture below always runs regardless.
      try { btn.setPointerCapture(event.pointerId); } catch (_) {}
      this._capture.start();
    });
    btn.addEventListener("pointerup", endHold);
    btn.addEventListener("pointercancel", endHold);
    btn.addEventListener("lostpointercapture", endHold);
    btn.addEventListener("contextmenu", (event) => event.preventDefault());

    this.elements.talkTextForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.elements.talkTextInput.value.trim();
      if (!text) return;
      this.elements.talkTextInput.value = "";
      this.submitInstruction(text);
    });
  }

  // Idle/Held/Released copy is the button's OWN label per this repair pass's UX spec — `note` (used for
  // error text such as "microphone access denied") only ever goes to the small side label below it, never
  // overwriting the button so a transient error can't get stuck looking like the button's permanent text.
  setTalkState(state, note) {
    this.elements.talkBtn.dataset.state = state;
    this.elements.talkBtn.disabled = state === "thinking";
    this.elements.talkBtn.textContent = state === "listening" ? "🔴 LISTENING — release to send" : state === "thinking" ? "Processing…" : "🎙 Talk to Hottie";
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
      onPin: (id) => this.session.aiProducerFeed.togglePin(id),
      onSendToProgram: (id) => this.session.aiProducerService.sendEntryToProgram(id)
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
