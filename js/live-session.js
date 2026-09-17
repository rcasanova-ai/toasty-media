import {
  VideoEngine,
  createDisposableRoomId,
  getOrCreateRoomId,
  getGuestInviteUrl,
  getListenerInviteUrl,
} from "./video-engine.js";
import {
  applyBrandTheme,
  getInitialBrandTheme,
  normalizeBrandTheme,
  saveBrandTheme,
} from "./brand-themes.js?v=brand-20260916b";
import { LocalIsolatedRecorder } from "./recording.js";
import { ProgramSync } from "./program-sync.js";
import { SessionPolicy } from "./session-policy.js";
import { RunOfShow } from "./run-of-show.js";
import { AudienceStore, DemoAudienceFeed } from "./audience.js";
import { TranscriptStore } from "./show-context.js";
import { createTranscriptionProvider } from "./transcription.js";
import { ProducerFeed, AIProducerService, createAIProducerProvider } from "./ai-producer.js";

const USE_BACKEND_STORAGE_KEY = "toasty.ai-producer.use-backend";
// Defaults OFF: no budget for paid API usage right now, so a fresh browser must never silently start
// spending money the moment the backend happens to get a real key deployed. Trying the backend is an
// explicit opt-in (Advanced drawer), not an opt-out from it — the heuristic provider is free and stays
// the default demo path regardless of backend availability.
function loadUseBackendPreference() { try { const v = localStorage.getItem(USE_BACKEND_STORAGE_KEY); return v === "1"; } catch (_) { return false; } }
function saveUseBackendPreference(useBackend) { try { localStorage.setItem(USE_BACKEND_STORAGE_KEY, useBackend ? "1" : "0"); } catch (_) {} }

const GUEST_SEAT_COUNT = 3;

// LiveSession is the single shared production core behind Host View and Producer View. Both views are
// thin control surfaces: they read this state and call these actions, and re-render on the events this
// emits. Neither view owns its own VideoEngine, guest list, program state, or ProgramSync — there is
// exactly one of each, here, so Host/Producer can never drift out of sync with each other or with what
// Program Output is actually showing.
export class LiveSession {
  constructor() {
    this.roomId = getOrCreateRoomId();
    this.brandTheme = normalizeBrandTheme(getInitialBrandTheme());
    this.engine = new VideoEngine();
    this.policy = new SessionPolicy();

    this.av = { micMuted: false, cameraOff: false };
    this.recording = { active: false, startedAt: null };
    this.connection = { status: "idle", label: "Ready" };

    this.program = {
      scene: "holding",
      topic: "",
      tickerEnabled: false,
      tickerText: "",
      live: false,
      // "grid" = today's always-on uniform 4-slot cropped grid. "screen-dominant" is applied
      // automatically while the host is sharing their screen (see toggleScreenShare) and lets
      // VDO.Ninja's own speaker+thumbnails auto-layout take over instead. layoutManualOverride, once
      // set by the producer, stops the automatic screen-share behavior from fighting their choice until
      // the next time screen share toggles off (see toggleScreenShare).
      layout: "grid",
      layoutManualOverride: false
    };

    // Seat -> {id,label,mic,camera,onProgram} — stable across join/leave order noise, backfilled only
    // from the room's real guest-list API (see refreshGuestSeats). mic/camera/onProgram reflect what the
    // producer last asked for, not a confirmed device state: VDO.Ninja does not echo per-guest mute
    // confirmation back to the director, so this is optimistic local UI state layered on a best-effort
    // remote command (see VideoEngine.sendToGuest's caveat).
    this.guestSeats = new Array(GUEST_SEAT_COUNT).fill(null);

    this._programSync = null;
    this._guestListTimerId = null;
    this._recordingTimerId = null;
    this._recorder = null;
    this._containers = null;
    this._listeners = new Map();
    this._startedAt = Date.now();

    // Run of Show + Audience + AI Producer — see run-of-show.js/audience.js/ai-producer.js. These are
    // sub-modules with their OWN emitters; HostView/ProducerView subscribe to them directly rather than
    // everything funneling through LiveSession's emit, same as guestSeats/program above but split out
    // because each has real internal behavior (clustering, drip-feeding, etc.) that doesn't belong here.
    this.runOfShow = new RunOfShow();
    this.audience = new AudienceStore();
    this.transcript = new TranscriptStore();
    this.aiProducerFeed = new ProducerFeed();
    this.aiUseBackend = loadUseBackendPreference();
    this.aiProducerService = new AIProducerService({
      session: this,
      feed: this.aiProducerFeed,
      provider: createAIProducerProvider({ useBackend: this.aiUseBackend })
    });
    this._demoAudienceFeed = new DemoAudienceFeed(this.audience);
    this._transcriptionProvider = null;
    this.demoMode = false;

    this.engine.onMessage((message) => this._handleVdoMessage(message));
    window.setInterval(() => this.engine.requestDetailedState(), 5000);
  }

  elapsedMs() { return Date.now() - this._startedAt; }

  // Swaps the AI Producer's provider (backend-with-fallback <-> heuristic-only) without touching
  // feed/history state. "Force heuristic" is a deliberate demo-resilience switch, not a config leak of
  // any credential — the backend holds its own key server-side regardless of this setting.
  setAiUseBackend(useBackend) {
    this.aiUseBackend = useBackend;
    saveUseBackendPreference(useBackend);
    this.aiProducerService.provider = createAIProducerProvider({ useBackend });
    this.emit("ai-provider", useBackend);
  }

  sendToProducer(instructionText, options) {
    return this.aiProducerService.handleInstruction(instructionText, options);
  }

  // ---- Transcription (policy-gated) ----
  // See transcription.js: createTranscriptionProvider itself refuses (returns null) when the policy
  // forbids capture, so this can't accidentally start transcribing under a policy that says not to.

  startTranscription({ demo = false } = {}) {
    this.stopTranscription();
    this._transcriptionProvider = createTranscriptionProvider({ policy: this.policy, preferDemo: demo });
    if (!this._transcriptionProvider) {
      this.emit("transcription", { active: false, blocked: true });
      return false;
    }
    this._transcriptionProvider.onTranscript((line) => this.transcript.append(line));
    this._transcriptionProvider.start();
    this.emit("transcription", { active: true, demo });
    return true;
  }

  stopTranscription() {
    this._transcriptionProvider?.stop();
    this._transcriptionProvider = null;
    this.emit("transcription", { active: false });
  }

  // ---- Demo Mode ----
  // Seeds INPUTS (audience messages, transcript lines), never outputs — AIProducerService still has to
  // genuinely process whatever Demo Mode drips in. See audience.js/transcription.js for the scripts.

  setDemoMode(enabled) {
    this.demoMode = enabled;
    if (enabled) {
      this._demoAudienceFeed.start();
      this.startTranscription({ demo: true });
    } else {
      this._demoAudienceFeed.stop();
      this.stopTranscription();
    }
    this.emit("demo-mode", enabled);
  }

  // One click back to a known starting state for reliable repeat demos: Opening/Canada/Thailand(current)
  // /Vietnam/Closing, empty audience/transcript/producer feed, timers restarted. Dev/demo tool — does
  // not touch AV, guests, program scene, or policy.
  resetDemo() {
    this.setDemoMode(false);
    this.runOfShow.reset();
    this.audience.clear();
    this.transcript.clear();
    this.aiProducerFeed.clear();
    this.aiProducerService.resetSessionTotals();
    this._startedAt = Date.now();
    this.emit("demo-reset", null);
  }

  on(event, callback) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(callback);
    return () => this._listeners.get(event)?.delete(callback);
  }

  emit(event, payload) {
    this._listeners.get(event)?.forEach((callback) => callback(payload));
  }

  // ---- Room lifecycle ----

  start(containers) {
    this._containers = containers; // {host, roomPreview, control} — kept so layout changes can remount
    this.engine.mountDirectorFrame(containers.host, { roomId: this.roomId, label: "Toasty Host" });
    this.engine.mountRoomFrame(containers.roomPreview, { roomId: this.roomId, layout: this.program.layout });
    this.engine.mountDirectorControlFrame(containers.control, { roomId: this.roomId });
    this.guestSeats = new Array(GUEST_SEAT_COUNT).fill(null);
    this._restartProgramSync();
    this._restartGuestListPolling();
    this._updateInviteAndHistory();
    this.publishProgramState();
    this.emit("room", { roomId: this.roomId });
  }

  createNewRoom() {
    this.roomId = createDisposableRoomId();
    this._stopRecordingTimer();
    this.av = { micMuted: false, cameraOff: false };
    this.recording = { active: false, startedAt: null };
    this.connection = { status: "idle", label: "Ready" };
    this.emit("av", this.av);
    this.emit("recording", this.recording);
    this.emit("connection", this.connection);
    this.start(this._containers);
  }

  inviteUrls() {
    return {
      guest: getGuestInviteUrl(this.roomId, this.brandTheme),
      listener: getListenerInviteUrl(this.roomId, this.brandTheme)
    };
  }

  _updateInviteAndHistory() {
    const url = new URL(window.location.href);
    url.searchParams.set("room", this.roomId);
    url.searchParams.set("brand", this.brandTheme);
    history.replaceState({}, "", url);
  }

  changeBrandTheme(brandTheme) {
    this.brandTheme = normalizeBrandTheme(brandTheme);
    saveBrandTheme(this.brandTheme);
    this._updateInviteAndHistory();
    this.publishProgramState();
    this.emit("brand", this.brandTheme);
  }

  applyBrand(elements) {
    applyBrandTheme(this.brandTheme, elements);
  }

  // ---- Guest presence ----
  // Sole source of truth for guest presence. Generic VDO.Ninja frame lifecycle events (push-connection,
  // getDetailedState, etc. — see _handleVdoMessage) are NEVER trusted to mean "a guest joined": they fire
  // for our own host/control/room frames too. Only an id from the room's real guest-list API, with the
  // host's own stream id excluded, counts as a guest.

  _restartGuestListPolling() {
    if (this._guestListTimerId) window.clearInterval(this._guestListTimerId);
    this._refreshGuestSeats();
    this._guestListTimerId = window.setInterval(() => this._refreshGuestSeats(), 4000);
  }

  async _refreshGuestSeats() {
    const hostStreamId = `${this.roomId}h`;
    const guests = (await this.engine.requestGuestList()).filter((entry) => entry.id !== hostStreamId);
    const stillPresent = new Set(guests.map((guest) => guest.id));

    // Keep existing seat holders steady so counts/controls don't flicker or reset on a repeat poll;
    // only backfill empty seats, and only drop a seat once its id is genuinely gone from the room.
    this.guestSeats = this.guestSeats.map((seat) => (seat && stillPresent.has(seat.id) ? seat : null));
    guests.forEach((guest) => {
      if (this.guestSeats.some((seat) => seat?.id === guest.id)) return;
      const emptyIndex = this.guestSeats.findIndex((seat) => seat === null);
      if (emptyIndex !== -1) {
        this.guestSeats[emptyIndex] = { id: guest.id, label: guest.label, mic: true, camera: true, onProgram: true, volume: 1 };
      }
    });

    this.emit("guests", this.guestCount());
    this.publishProgramState();
  }

  guestCount() {
    return this.guestSeats.filter(Boolean).length;
  }

  // ---- Program Output sync ----

  _restartProgramSync() {
    this._programSync?.close();
    this._programSync = new ProgramSync(this.roomId);
    this._programSync.onMessage((message) => {
      if (message?.type === "request-state") this.publishProgramState();
    });
  }

  publishProgramState() {
    this._programSync?.publishState({
      roomId: this.roomId,
      brandTheme: this.brandTheme,
      scene: this.program.scene,
      topic: this.program.topic,
      ticker: { enabled: this.program.tickerEnabled, text: this.program.tickerText },
      live: this.program.live,
      layout: this.program.layout,
      // Lets Program Output tell "room is genuinely empty" apart from "video hasn't loaded yet".
      hostStarted: this.engine.frames.has("host"),
      guestCount: this.guestCount()
    });
  }

  setLive(live) {
    this.program.live = live;
    this.publishProgramState();
    this.emit("program", this.program);
  }

  setTopic(topic) {
    this.program.topic = topic;
    this.publishProgramState();
    this.emit("program", this.program);
  }

  setScene(scene) {
    this.program.scene = scene;
    this.publishProgramState();
    this.emit("program", this.program);
  }

  setTicker({ enabled, text }) {
    if (enabled !== undefined) this.program.tickerEnabled = enabled;
    if (text !== undefined) this.program.tickerText = text;
    this.publishProgramState();
    this.emit("program", this.program);
  }

  // manual=true marks this as the producer's own choice, which stops toggleScreenShare's automatic
  // layout switching from overriding it again until screen share next toggles off.
  setLayout(layout, { manual = true } = {}) {
    this.program.layout = layout;
    if (manual) this.program.layoutManualOverride = true;
    if (this._containers) this.engine.mountRoomFrame(this._containers.roomPreview, { roomId: this.roomId, layout });
    this.publishProgramState();
    this.emit("program", this.program);
  }

  // ---- Host's own AV ----

  toggleMic() {
    this.av.micMuted = !this.av.micMuted;
    this.engine.setMicrophone(!this.av.micMuted);
    this.emit("av", this.av);
  }

  toggleCamera() {
    this.av.cameraOff = !this.av.cameraOff;
    this.engine.setCamera(!this.av.cameraOff);
    this.emit("av", this.av);
  }

  // Screen share start: remembers the layout in effect right now, then switches Program to
  // screen-dominant so the shared content is readable instead of squeezed among camera tiles. Screen
  // share end: restores whatever layout was in effect before, unless the producer manually picked a
  // layout while sharing (layoutManualOverride) — in that case their choice sticks.
  toggleScreenShare() {
    const next = !this.screenShare?.active;
    this.screenShare = { active: next };
    this.engine.setScreenShare(next);
    if (next) {
      this._preScreenShareLayout = this.program.layout;
      this.setLayout("screen-dominant", { manual: false });
    } else {
      const restoreTo = this.program.layoutManualOverride ? this.program.layout : (this._preScreenShareLayout || "grid");
      this.program.layoutManualOverride = false;
      this.setLayout(restoreTo, { manual: false });
    }
    this.emit("screenshare", this.screenShare);
  }

  // ---- Guests (producer actions) ----
  // See VideoEngine.sendToGuest for the caveat: these target VDO.Ninja's director-command channel by
  // participant id, not a per-guest iframe, and have not been verified live against a second browser in
  // this environment.

  setGuestMic(guestId, enabled) {
    const seat = this.guestSeats.find((s) => s?.id === guestId);
    if (!seat) return;
    seat.mic = enabled;
    this.engine.setGuestRemoteMicrophone(guestId, enabled);
    this.emit("guests", this.guestCount());
  }

  setGuestCamera(guestId, enabled) {
    const seat = this.guestSeats.find((s) => s?.id === guestId);
    if (!seat) return;
    seat.camera = enabled;
    this.engine.setGuestRemoteCamera(guestId, enabled);
    this.emit("guests", this.guestCount());
  }

  setGuestVolume(guestId, volume0to1) {
    const seat = this.guestSeats.find((s) => s?.id === guestId);
    if (!seat) return;
    seat.volume = volume0to1;
    this.engine.setGuestRemoteVolume(guestId, volume0to1);
    this.emit("guests", this.guestCount());
  }

  // "Off Program" doesn't remove a guest from VDO.Ninja's merged scene=0 mix — Program Output has no
  // concept of an individually-addressed tile to drop (see mountProgramFrame's comment). What IS real:
  // muting their mic and camera remotely, so they go silent/black in the mix while staying connected.
  // That's what this does, and the UI should say exactly that rather than implying a true seat cut.
  setGuestOnProgram(guestId, onProgram) {
    const seat = this.guestSeats.find((s) => s?.id === guestId);
    if (!seat) return;
    seat.onProgram = onProgram;
    this.engine.setGuestRemoteMicrophone(guestId, onProgram);
    this.engine.setGuestRemoteCamera(guestId, onProgram);
    this.emit("guests", this.guestCount());
  }

  // ---- Session policy (Jam foundation) ----

  setSessionType(sessionType) {
    this.policy.setSessionType(sessionType);
    this.emit("policy", this.policy);
    this._enforcePolicy();
  }

  setPolicy(patch) {
    this.policy.set(patch);
    this.emit("policy", this.policy);
    this._enforcePolicy();
  }

  // A policy change must actually stop anything already running that it now forbids — not just block
  // new starts. Otherwise switching to Jam mid-transcription would leave the old transcription running
  // on the old (permissive) policy until it happened to be toggled off some other way.
  _enforcePolicy() {
    if (!this.policy.canTranscribe() && this._transcriptionProvider) this.stopTranscription();
    if (!this.policy.canRecord() && this.recording.active) this.stopRecording().catch(() => {});
  }

  // ---- Recording (policy-gated) ----

  canRecord() {
    return this.policy.canRecord() && LocalIsolatedRecorder.isSupported();
  }

  async startRecording() {
    if (!this.policy.canRecord()) throw new Error("Recording is disabled by this session's capture policy.");
    this._recorder = new LocalIsolatedRecorder({
      role: "host",
      roomId: this.roomId,
      status: (message) => this.emit("recording-status", message)
    });
    await this._recorder.start();
    this.recording = { active: true, startedAt: Date.now() };
    this._recordingTimerId = window.setInterval(() => this.emit("recording", this.recording), 1000);
    this.emit("recording", this.recording);
  }

  async stopRecording() {
    await this._recorder?.stop();
    this.recording = { active: false, startedAt: null };
    this._stopRecordingTimer();
    this.emit("recording", this.recording);
  }

  _stopRecordingTimer() {
    if (this._recordingTimerId) {
      window.clearInterval(this._recordingTimerId);
      this._recordingTimerId = null;
    }
  }

  // ---- Ending things: two distinct, deliberately non-interchangeable actions ----

  // HOST "Leave Studio": disconnects only THIS browser's own frames. Guests keep talking, the show stays
  // live, Program Output is untouched. Equivalent to hanging up a personal call, not ending the show.
  leaveStudio() {
    this.engine.disconnectLocalFrames();
    this._stopRecordingTimer();
    this.connection = { status: "idle", label: "Left Studio" };
    this.emit("connection", this.connection);
  }

  // PRODUCER "End Show": ends the production for everyone. Flips Program Output to the Ending scene
  // (guaranteed — that's just our own ProgramSync state) and best-effort hangs up every known guest
  // (not guaranteed — see VideoEngine.disconnectAll/sendToGuest). Callers must confirm destructively
  // before calling this; LiveSession does not prompt.
  endShow() {
    const guestIds = this.guestSeats.filter(Boolean).map((seat) => seat.id);
    this.setScene("ending");
    this.setLive(false);
    this.engine.disconnectAll(guestIds);
    this._stopRecordingTimer();
    this.connection = { status: "idle", label: "Show ended" };
    this.emit("connection", this.connection);
  }

  _handleVdoMessage(message) {
    if (!message) return;
    // push-connection/view-connection fire for ANY of our frames, not just real guests — only used here
    // as a hint to re-poll the authoritative guest-list API. Guest count/seats never come from this.
    if (message.action === "push-connection" || message.action === "view-connection") {
      this._refreshGuestSeats();
    } else if (message.action || message.getDetailedState) {
      this.connection = { status: "connected", label: "Live" };
      this.emit("connection", this.connection);
    }
  }
}
