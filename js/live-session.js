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
} from "./brand-themes.js";
import { LocalIsolatedRecorder } from "./recording.js";
import { ProgramSync } from "./program-sync.js";
import { SessionPolicy } from "./session-policy.js";
import { RunOfShow } from "./run-of-show.js";
import { AudienceStore, DemoAudienceFeed } from "./audience.js";
import { TranscriptStore, ShowContextMemory } from "./show-context.js";
import { createTranscriptionProvider } from "./transcription.js";
import { HostDirectiveLog } from "./host-directive.js";
import { LiveProducerController, ingestAttributedTranscript } from "./live-producer.js";
import { ProgramAssetCatalog, serializeProgramAsset } from "./program-asset.js";
import { ProgramController, ProductionActionLog } from "./production-controller.js";
import { AssetCatalogue } from "./asset-catalogue.js";
import { ProgramAudioBus, serializeProgramAudio } from "./program-audio.js";
import { createResearchProvider } from "./hottie-research.js";
import { ParticipantRegistry, createParticipant, ParticipantRole, ConnectionStatus, SourceKind } from "./participant-registry.js";
import { HostState } from "./host-state.js";
import { RoomPresence } from "./room-presence.js";
import { RemoteMediaState } from "./remote-media-state.js";
import { ProducerFeed, AIProducerService, createAIProducerProvider } from "./ai-producer.js";
import { studioRequest } from "./studio-api.js";
import { syncParticipantStage, clearParticipantStage } from "./participant-stage.js";
import { syncProgramRenderer, clearProgramRenderer, serializeProgramParticipant } from "./program-renderer.js";
import {
  DEFAULT_HOST_RELATIONSHIP_MODE,
  DEFAULT_SHOW_TONE,
  DEFAULT_PRODUCER_AUTONOMY,
  normalizeRelationshipMode,
  normalizeShowTone,
  normalizeAutonomy
} from "./producer-persona.js";

const USE_BACKEND_STORAGE_KEY = "toasty.ai-producer.use-backend";
const HOST_RELATIONSHIP_STORAGE_KEY = "toasty.ai-producer.host-relationship";
const SHOW_TONE_STORAGE_KEY = "toasty.ai-producer.show-tone";
const PRODUCER_AUTONOMY_STORAGE_KEY = "toasty.ai-producer.autonomy";

function loadPersonaSetting(key, normalize, fallback) {
  try { const v = localStorage.getItem(key); return v === null ? fallback : normalize(v); } catch (_) { return fallback; }
}
function savePersonaSetting(key, value) { try { localStorage.setItem(key, value); } catch (_) {} }
// Defaults ON: DeepSeek is now the configured, cheap, real backend (see AIProducerService's
// SOFT_WARNING_USD/HARD_CUTOFF_USD guardrail, which is what actually caps runaway spend — not this
// flag). "Force offline / heuristic mode" in Advanced is the opt-OUT, not an opt-in to try the backend;
// normal operation is DeepSeek with automatic heuristic fallback on any failure.
function loadUseBackendPreference() { try { const v = localStorage.getItem(USE_BACKEND_STORAGE_KEY); return v === null ? true : v === "1"; } catch (_) { return true; } }
function saveUseBackendPreference(useBackend) { try { localStorage.setItem(USE_BACKEND_STORAGE_KEY, useBackend ? "1" : "0"); } catch (_) {} }

// guest.js formats the single VDO.Ninja label field as "Name · Title, Company" (see joinStudio()) since
// that field is the only channel that round-trips through VDO.Ninja's own guest-list query back to the
// director — there's no separate metadata side-channel. This unpacks that same convention back into
// structured fields for Program Output / lower-third consumption, without changing what guests transmit.
function parseGuestLabel(label) {
  const raw = String(label || "").trim();
  const [namePart, rolePart] = raw.split(" · ");
  const [title = "", company = ""] = (rolePart || "").split(", ").map((part) => part.trim());
  return {
    displayName: (namePart || raw || "Guest").trim(),
    title: rolePart ? title : "",
    company: rolePart ? company : ""
  };
}

const GUEST_SEAT_COUNT = 3;

// _checkDurableSessionStatus's own cadence — deliberately its OWN interval, NOT the 4s guest-seat poll.
// Proven production root cause (commit 4d7e33c real-device retest): GET /api/sessions/:id sits behind
// nginx's toasty_render rate-limit zone (6 requests/minute, burst=8 — see
// scripts/nginx-render.conf.example's own comment, "sized for infrequent human-triggered calls"). Calling
// it every 4s (worse: also on every VDO push-connection/view-connection event via _handleVdoMessage,
// unbounded) sustains ~15+ req/min against a 6 req/min budget, so nginx's limiter starts rejecting most of
// them with a 503 that carries NO CORS headers (limit_req's own rejection never reaches the location
// block's add_header/Node — confirmed live: a rate-limited request returns bare "503 Service Temporarily
// Unavailable" with zero Access-Control-* headers, while every non-rate-limited response, even a 401, has
// them). A browser cross-origin fetch() that gets a CORS-headerless response doesn't see a 503 at all — it
// throws TypeError: Failed to fetch, indistinguishable from a real outage. That chronic exhaustion is what
// made a normal Producer refresh's OWN session-resolve/gate calls land in the same starved bucket and fail
// the same way. 20s keeps this well under budget (3 req/min) with headroom for genuine gate/list calls.
const SESSION_STATUS_POLL_MS = 20000;

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
    // Optional client-private research brief used by focus groups / research interviews / panels.
    // Hottie reads this through buildShowContext(); it is session-scoped and is never a participant Dub.
    this.researchContext = null;

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
      layoutManualOverride: false,
      assetLayout: null,
      audio: null
    };

    // Seat -> {id,label,mic,camera,onProgram} — stable across join/leave order noise, backfilled only
    // from the room's real guest-list API (see refreshGuestSeats). mic/camera/onProgram reflect what the
    // producer last asked for, not a confirmed device state: VDO.Ninja does not echo per-guest mute
    // confirmation back to the director, so this is optimistic local UI state layered on a best-effort
    // remote command (see VideoEngine.sendToGuest's caveat).
    this.guestSeats = new Array(GUEST_SEAT_COUNT).fill(null);
    // Set once js/host-prejoin.js calls joinAsHost() — see that method for why this uses the same
    // {displayName,title,company} shape as a guest seat instead of a separate host-profile model.
    this.hostProfile = null;
    this._hostDevices = {};
    // The native getUserMedia MediaStream carried over from js/host-prejoin.js's preview — this is what
    // actually renders in the visible Host tile now (see _showHostNativeVideo). VDO's director frame is
    // mounted separately, into a hidden transport-only container, and never shown to the product.
    this._hostPreviewStream = null;
    // Canonical participant/source model — see js/participant-registry.js. Populated for the Host below;
    // guest entries are deliberate follow-up work, not part of this pass.
    this.participants = new ParticipantRegistry();
    // Toasty session presence — see js/room-presence.js. Created once joinAsHost knows a real identity to
    // announce; null until then, same lifecycle as hostProfile.
    this.presence = null;
    // Explicit Host lifecycle state — see js/host-state.js. js/host-prejoin.js drives PREJOIN_LOADING/
    // PREJOIN_READY/JOINING; joinAsHost below confirms IN_STUDIO; leaveStudio drives LEAVING. Every
    // control that should only appear once the Host has actually joined (Leave Studio, Talk to Hottie)
    // reads this, not incidental DOM/session existence — see js/host-view.js's renderHostState.
    this.hostState = HostState.PREJOIN_LOADING;

    // The durable LiveSession record (see scripts/toasty-auth-db.py's live_sessions table) this room is
    // backing, if any — set by js/session-manager.js's gate BEFORE joinAsHost ever runs (see
    // applyDurableSession). Distinct from this.roomId (the VDO transport room, which durableSession.roomId
    // matches once applied) and from presence (ephemeral "who's here"): this is "what session record am I,
    // so End/Kick/reopen can act on the right row." Sessions created before this pass has no durable
    // record and simply won't have one — end/kick/capacity-by-session simply don't apply to those rooms.
    this.durableSession = null;
    this._sessionEndedTimerId = null;

    this._programSync = null;
    this._guestListTimerId = null;
    this._sessionStatusTimerId = null;
    this._recordingTimerId = null;
    this._recorder = null;
    this._containers = null;
    this._listeners = new Map();
    this._startedAt = Date.now();
    this._lastVdoGuestList = [];

    // Run of Show + Audience + AI Producer — see run-of-show.js/audience.js/ai-producer.js. These are
    // sub-modules with their OWN emitters; HostView/ProducerView subscribe to them directly rather than
    // everything funneling through LiveSession's emit, same as guestSeats/program above but split out
    // because each has real internal behavior (clustering, drip-feeding, etc.) that doesn't belong here.
    this.runOfShow = new RunOfShow();
    this.audience = new AudienceStore();
    this.transcript = new TranscriptStore();
    this.showMemory = new ShowContextMemory();
    this.hostDirectives = new HostDirectiveLog();
    this.aiProducerFeed = new ProducerFeed();
    this.aiUseBackend = loadUseBackendPreference();
    // Producer Persona layer (see js/producer-persona.js) — Toasty CONFIGURATION, never something a
    // provider call hardcodes. Default relationship is FRIENDLY per spec; a given show can be set to
    // FAMILIAR (e.g. for a Ricardo demo) via setHostRelationship, same mechanism either way.
    this.hostRelationship = loadPersonaSetting(HOST_RELATIONSHIP_STORAGE_KEY, normalizeRelationshipMode, DEFAULT_HOST_RELATIONSHIP_MODE);
    this.showTone = loadPersonaSetting(SHOW_TONE_STORAGE_KEY, normalizeShowTone, DEFAULT_SHOW_TONE);
    this.producerAutonomy = loadPersonaSetting(PRODUCER_AUTONOMY_STORAGE_KEY, normalizeAutonomy, DEFAULT_PRODUCER_AUTONOMY);
    this.aiProducerService = new AIProducerService({
      session: this,
      feed: this.aiProducerFeed,
      provider: createAIProducerProvider({ useBackend: this.aiUseBackend })
    });
    this._demoAudienceFeed = new DemoAudienceFeed(this.audience);
    this._transcriptionProvider = null;
    this.demoMode = false;
    this.assets = new ProgramAssetCatalog();
    this.catalogue = new AssetCatalogue();
    this.programAudio = new ProgramAudioBus({ role: "producer-monitor" });
    this.productionLog = new ProductionActionLog();
    this.programController = new ProgramController(this);
    this.researchProvider = createResearchProvider({ preferSeeded: false });
    this.liveProducer = new LiveProducerController(this);
    this.runOfShow.on(() => this.liveProducer.onShowAgendaChanged());

    // See js/remote-media-state.js and _setRemoteMediaState below.
    this.remoteMediaState = RemoteMediaState.WAITING_FOR_PARTICIPANT;
    // js/participant-stage.js's syncParticipantStage's persistent state — participantId -> {tile, frameId,
    // transportSourceId} for every currently-mounted Guest tile on Host's participant stage.
    this._mountedGuestTiles = new Map();
    this._mountedProgramTiles = new Map();

    this.engine.onMessage((message) => this._handleVdoMessage(message));
    window.setInterval(() => this.engine.requestDetailedState(), 5000);
  }

  elapsedMs() { return Date.now() - this._startedAt; }

  async loadAssetCatalogue(url) {
    await this.catalogue.load(url);
    this.emit("catalogue", this.catalogue);
    return this.catalogue;
  }

  // Swaps the AI Producer's provider (backend-with-fallback <-> heuristic-only) without touching
  // feed/history state. "Force heuristic" is a deliberate demo-resilience switch, not a config leak of
  // any credential — the backend holds its own key server-side regardless of this setting.
  setAiUseBackend(useBackend) {
    this.aiUseBackend = useBackend;
    saveUseBackendPreference(useBackend);
    this.aiProducerService.provider = createAIProducerProvider({ useBackend });
    this.emit("ai-provider", useBackend);
  }

  // ---- Producer Persona (see js/producer-persona.js) ----
  // These three settings are the ONLY inputs that shape Toasty Producer's voice — no provider call
  // hardcodes personality. Changing them takes effect on the very next instruction; nothing about an
  // in-flight request or past feed entries is rewritten.

  setHostRelationship(mode, customFields = null) {
    this.hostRelationship = normalizeRelationshipMode(mode);
    this.hostRelationshipCustomFields = this.hostRelationship === "custom" ? (customFields || {}) : null;
    savePersonaSetting(HOST_RELATIONSHIP_STORAGE_KEY, this.hostRelationship);
    this.emit("persona", this.persona());
  }

  setShowTone(tone) {
    this.showTone = normalizeShowTone(tone);
    savePersonaSetting(SHOW_TONE_STORAGE_KEY, this.showTone);
    this.emit("persona", this.persona());
  }

  setProducerAutonomy(autonomy) {
    this.producerAutonomy = normalizeAutonomy(autonomy);
    savePersonaSetting(PRODUCER_AUTONOMY_STORAGE_KEY, this.producerAutonomy);
    this.emit("persona", this.persona());
  }

  // The one object every provider call is built from — see AIProducerService.handleInstruction.
  persona() {
    return {
      relationship: this.hostRelationship,
      customRelationshipFields: this.hostRelationshipCustomFields || null,
      tone: this.showTone,
      autonomy: this.producerAutonomy
    };
  }

  sendToProducer(instructionText, options) {
    return this.aiProducerService.handleInstruction(instructionText, options);
  }

  // ---- Transcription (policy-gated) ----
  // See transcription.js: createTranscriptionProvider itself refuses (returns null) when the policy
  // forbids capture, so this can't accidentally start transcribing under a policy that says not to.

  startTranscription({ demo = false, script } = {}) {
    this.stopTranscription();
    this._transcriptionProvider = createTranscriptionProvider({
      policy: this.policy,
      preferDemo: demo,
      script,
      speaker: this.hostProfile?.displayName || "Host",
      participantId: "host",
      role: "host"
    });
    if (!this._transcriptionProvider) {
      this.emit("transcription", { active: false, blocked: true });
      return false;
    }
    this._transcriptionProvider.onTranscript((line) => ingestAttributedTranscript(this, line));
    try {
      this._transcriptionProvider.start();
    } catch (error) {
      console.error("[LiveSession] transcription start failed open", error);
      this.stopTranscription();
      this.emit("transcription", { active: false, error: String(error?.message || error) });
      return false;
    }
    this.emit("transcription", { active: true, demo });
    return true;
  }

  ingestTranscriptLine(line) {
    return ingestAttributedTranscript(this, line);
  }

  _startLiveTranscription() {
    if (this.demoMode) return;
    this.startTranscription({ demo: false });
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
    this.researchProvider = createResearchProvider({ preferSeeded: enabled });
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
    this.showMemory.clear();
    this.hostDirectives.clear();
    this.liveProducer.resetNotices();
    this.assets.clear();
    this.productionLog.clear();
    this.program.assetLayout = null;
    this.program.audio = null;
    this.programAudio?.stop();
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

  // Does NOT mount the host's own camera frame — that only happens once js/host-prejoin.js calls
  // joinAsHost() below with a name/title/company and chosen devices, same as a guest only ever gets
  // mounted after their own native prejoin. Room preview and the hidden control frame don't need a
  // person's identity to exist, so they still mount immediately.
  start(containers) {
    this._containers = containers; // {host, hostTransport, roomPreview, control, programPreview}
    // roomPreview (the guest stage) is deliberately NOT mounted here — see _syncGuestVideoTile, which
    // mounts a clean per-participant &view=<id> tile per connected Guest only once actually detected, and
    // tears each down again on disconnect. No VDO frame here at all beats mounting one that shows nobody.
    clearParticipantStage({ engine: this.engine, mounted: this._mountedGuestTiles });
    this._teardownProgramPreview();
    this.engine.mountDirectorControlFrame(containers.control, { roomId: this.roomId });
    this.guestSeats = new Array(GUEST_SEAT_COUNT).fill(null);
    this._restartProgramSync();
    this._restartGuestListPolling();
    this._updateInviteAndHistory();
    this.publishProgramState();
    this.emit("room", { roomId: this.roomId });
  }

  // ---- Host identity ----
  // Same field shape as a guest seat's structured metadata (see parseGuestLabel/js/show-context.js) —
  // deliberately NOT a separate host-profile model, so lower thirds/Program Output/AI Producer context/
  // recordings/Dub can all treat "who is this person" identically whether they're the host or a guest.

  // previewStream is the SAME MediaStream js/host-prejoin.js was already showing before Join — the fix
  // for "camera goes black on Join" is that we keep rendering THIS stream in a Toasty-owned <video>
  // (_showHostNativeVideo) instead of ever putting VDO's iframe in the visible tile. mountDirectorFrame
  // still runs, but only into this._containers.hostTransport, a permanently off-screen container (see
  // css .lv-hidden-transport) — it exists purely so VDO.Ninja has a push/publish connection for guests
  // and Program Output to consume, and independently re-acquires the same device for that purpose. VDO
  // gets zero visible product pixels; if it cannot ingest this exact MediaStream and must open its own
  // capture of the same device, that duplicate acquisition is the accepted tradeoff, not a bug.
  joinAsHost({ displayName, title = "", company = "", videoDeviceLabel, audioDeviceLabel, previewStream } = {}) {
    const name = (displayName || "").trim() || "Host";
    this.hostProfile = { displayName: name, title: title.trim(), company: company.trim() };
    const role = [this.hostProfile.title, this.hostProfile.company].filter(Boolean).join(", ");
    const label = role ? `${name} · ${role}` : name;
    const transportSourceId = `${this.roomId}h`;
    this._hostDevices = { videoDeviceLabel, audioDeviceLabel };
    if (previewStream) this._hostPreviewStream = previewStream;
    this._showHostNativeVideo();
    this.engine.mountDirectorFrame(this._containers.hostTransport, { roomId: this.roomId, label, videoDeviceLabel, audioDeviceLabel });
    this.participants.upsert(createParticipant({
      participantId: "host",
      role: ParticipantRole.HOST,
      displayName: name,
      title: this.hostProfile.title,
      company: this.hostProfile.company,
      connectionStatus: ConnectionStatus.CONNECTED,
      videoSource: { kind: SourceKind.NATIVE_MEDIA_STREAM, stream: this._hostPreviewStream },
      audioSource: { kind: SourceKind.NATIVE_MEDIA_STREAM, stream: this._hostPreviewStream },
      transportSourceId
    }));
    // Toasty session presence (js/room-presence.js) — announces the Host's own identity + real
    // transportSourceId (unchanged value, still roomId+"h" — that part was never wrong, it's a real,
    // valid VDO push id; what was wrong was a GUEST guessing it blind instead of being told it). See
    // _refreshGuestSeats below for the other half: cross-referencing a guest's VDO-confirmed connection
    // against this same roster to source identity from Presence instead of VDO's &label.
    this.presence = new RoomPresence({ roomId: this.roomId, participantId: "host", role: "host", displayName: name, title: this.hostProfile.title, company: this.hostProfile.company });
    this.presence.start(transportSourceId);
    this.setHostState(HostState.IN_STUDIO);
    this.emit("host-profile", this.hostProfile);
    this.publishProgramState();
    this._syncProgramPreview();
    this._startLiveTranscription();
  }

  setHostState(state) {
    this.hostState = state;
    this.emit("host-state", state);
  }

  // Creates (once) and (always) refreshes the Toasty-owned <video> that IS the visible Host tile — never
  // VDO's iframe. Reused as-is across createNewRoom() since the same physical MediaStream survives a
  // room-id change (no camera re-acquisition, so no flicker/black-frame on "New Room").
  _showHostNativeVideo() {
    const container = this._containers?.host;
    if (!container || !this._hostPreviewStream) return;
    let video = container.querySelector("video.lv-host-live-video");
    if (!video) {
      video = document.createElement("video");
      video.className = "lv-host-live-video";
      video.autoplay = true;
      video.muted = true; // local tile — never play the host's own mic back to themselves
      video.playsInline = true;
      container.replaceChildren(video);
      container.removeAttribute("data-empty");
    }
    if (video.srcObject !== this._hostPreviewStream) video.srcObject = this._hostPreviewStream;
  }

  // A fresh room id means a fresh push stream id, so the host's camera frame always has to remount here
  // — but re-running the whole prejoin UI for a device choice that hasn't changed would be a step
  // backwards, so this replays the same identity/devices joinAsHost already collected instead of asking
  // js/host-prejoin.js to show its form again.
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
    if (this.hostProfile) this.joinAsHost({ ...this.hostProfile, ...this._hostDevices, previewStream: this._hostPreviewStream });
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

  // Visual state only — never touches VDO, the participant registry, or any media track. Local
  // application (this.brandTheme/saveBrandTheme/publishProgramState/emit) is unchanged and stays
  // synchronous so THIS browser (Host + any same-browser Program Output tab, via ProgramSync's
  // BroadcastChannel) updates instantly regardless of the network. The durable-session persist below is
  // what reaches OTHER devices: BroadcastChannel is same-browser-only, so it can never reach a phone
  // Guest — see scripts/render-production-server.mjs's new /api/sessions/:id/brand and
  // js/room-presence.js's brandId, which is what Guests actually pick this up from, on their own existing
  // 5s heartbeat (no new poll, no reconnect). Best-effort/fire-and-forget like endDurableSession/kickGuest
  // — a Guest whose heartbeat catches this a few seconds later than the Host's own local update is the
  // worst case, not a broken feature.
  changeBrandTheme(brandTheme) {
    this.brandTheme = normalizeBrandTheme(brandTheme);
    saveBrandTheme(this.brandTheme);
    this._updateInviteAndHistory();
    this.publishProgramState();
    this.emit("brand", this.brandTheme);
    if (this.durableSession && this.durableSession.status !== "ENDED") {
      studioRequest(`/api/sessions/${this.durableSession.id}/brand`, {
        method: "POST",
        body: JSON.stringify({ brandId: this.brandTheme })
      }).catch((error) => console.error("[LiveSession] persisting brand theme failed", error));
    }
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
    // Own interval, own (much slower) cadence — see SESSION_STATUS_POLL_MS's comment for why this was
    // split off the 4s guest-list poll rather than piggybacking on it.
    if (this._sessionStatusTimerId) window.clearInterval(this._sessionStatusTimerId);
    this._checkDurableSessionStatus();
    this._sessionStatusTimerId = window.setInterval(() => this._checkDurableSessionStatus(), SESSION_STATUS_POLL_MS);
  }

  _stopGuestListPolling() {
    if (this._guestListTimerId) { window.clearInterval(this._guestListTimerId); this._guestListTimerId = null; }
    if (this._sessionStatusTimerId) { window.clearInterval(this._sessionStatusTimerId); this._sessionStatusTimerId = null; }
  }

  // Detects the session having been ended from elsewhere (another Producer tab/device, or this same tab's
  // own endDurableSession already having flipped the local record) and tears this browser down the same
  // way Leave Studio does. A no-op for a session with no durableSession (rooms created before that schema
  // existed) or one this poll already reacted to (avoid double-teardown).
  async _checkDurableSessionStatus() {
    if (!this.durableSession || this.durableSession.status === "ENDED" || this.hostState !== HostState.IN_STUDIO) return;
    try {
      const result = await studioRequest(`/api/sessions/${this.durableSession.id}`, { method: "GET" });
      if (result.session?.status === "ENDED") {
        this.durableSession = result.session;
        this.emit("session-ended");
        this.endShow();
        this.leaveStudio();
      }
    } catch (error) {
      // A transient fetch failure shouldn't tear down an otherwise-healthy session.
      console.error("[LiveSession] session status check failed", error);
    }
  }

  async _refreshGuestSeats() {
    const hostStreamId = `${this.roomId}h`;
    const guestsAll = await this.engine.requestGuestList();
    const guests = guestsAll.filter((entry) => entry.id !== hostStreamId);
    this._lastVdoGuestList = guests;
    const stillPresent = new Set(guests.map((guest) => guest.id));

    // Keep existing seat holders steady so counts/controls don't flicker or reset on a repeat poll;
    // only backfill empty seats, and only drop a seat once its id is genuinely gone from the room.
    this.guestSeats = this.guestSeats.map((seat) => (seat && stillPresent.has(seat.id) ? seat : null));
    guests.forEach((guest) => {
      if (this.guestSeats.some((seat) => seat?.id === guest.id)) return;
      const emptyIndex = this.guestSeats.findIndex((seat) => seat === null);
      if (emptyIndex !== -1) {
        this.guestSeats[emptyIndex] = {
          id: guest.id,
          label: guest.label,
          // parseGuestLabel(guest.label) is the fallback ONLY — see the presence overlay right below,
          // which replaces displayName/title/company with Toasty's own presence roster the moment a
          // matching entry exists. Kept as the initial value so a seat still shows SOMETHING in the one
          // poll tick before this guest's own presence announce has necessarily landed.
          ...parseGuestLabel(guest.label),
          logoUrl: null,
          connectionStatus: "connected",
          mic: true,
          camera: true,
          onProgram: true,
          volume: 1,
          // Stamped once, here, at genuine first discovery — never touched again by the repeat-upsert
          // below. The ONE stable-ordering key js/program-composition.js's stableOrder sorts everyone but
          // Host by, so recomposition on a later join/leave never reshuffles someone already positioned.
          joinedAt: Date.now()
        };
      }
    });

    // Toasty session presence overlay (js/room-presence.js) — the fix for "sidebar says Guest": VDO.Ninja's
    // own &label never reliably round-tripped a custom name back to Director on real hardware (confirmed
    // this pass — the mechanism js/guest.js used to set it was fine, but VDO itself never surfaced it
    // here). This cross-references each VDO-confirmed connection (seat.id, from requestGuestList above —
    // that detection is untouched, it already works) against Presence by transportSourceId, and overrides
    // identity only, never connection/count. A seat with no matching presence entry yet keeps its
    // VDO-label-derived fallback from above rather than showing nothing.
    const presenceRoster = this.presence?.roster || [];
    this.guestSeats.filter(Boolean).forEach((seat) => {
      const match = presenceRoster.find((entry) => entry.transportSourceId === seat.id);
      if (!match) return;
      seat.displayName = match.displayName || seat.displayName;
      seat.title = match.title || "";
      seat.company = match.company || "";
    });

    // Canonical participant model (see js/participant-registry.js) — this was previously seeded ONLY for
    // the Host, with guest migration marked as deliberate follow-up work. That follow-up is this: every
    // connected seat gets a real registry entry so Program Preview/lower-thirds/AI Producer context can
    // all read "who is this person" from one place instead of guestSeats' older ad-hoc shape. videoSource
    // is VDO_PARTICIPANT_VIEW, not a MediaStream we hold directly — the actual pixels come from the
    // &view=<id> iframe _syncGuestVideoTile mounts below, never a getUserMedia stream Toasty owns (that
    // distinction is the whole reason SourceKind has two variants — see its own comment).
    const presentIds = new Set(this.guestSeats.filter(Boolean).map((seat) => seat.id));
    this.participants.list()
      .filter((p) => p.role === ParticipantRole.GUEST && !presentIds.has(p.participantId))
      .forEach((p) => this.participants.remove(p.participantId));
    this.guestSeats.filter(Boolean).forEach((seat) => {
      this.participants.upsert(createParticipant({
        participantId: seat.id,
        role: ParticipantRole.GUEST,
        displayName: seat.displayName,
        title: seat.title,
        company: seat.company,
        connectionStatus: ConnectionStatus.CONNECTED,
        videoSource: { kind: SourceKind.VDO_PARTICIPANT_VIEW, streamId: seat.id },
        audioSource: { kind: SourceKind.VDO_PARTICIPANT_VIEW, streamId: seat.id },
        transportSourceId: seat.id,
        joinedAt: seat.joinedAt,
        onProgram: seat.onProgram
      }));
    });

    this._syncGuestVideoTile();
    this._syncProgramPreview();
    this.emit("guests", this.guestCount());
    this.publishProgramState();
  }

  // Mounts/tears down one tile per connected Guest (up to 3) on Host's participant stage — see
  // js/participant-stage.js's syncParticipantStage, the SAME reconciler js/guest.js uses for its own
  // mirror-image stage, and js/program-composition.js's composeParticipantView for the ordering/layout
  // rules both share. Replaces the old single-seat _mountedGuestViewId tracking (guestSeats[0] only) —
  // this._mountedGuestTiles (a Map, see the constructor) is syncParticipantStage's persistent state instead.
  _syncGuestVideoTile() {
    const container = this._containers?.roomPreview;
    if (!container) return;
    const hostAsParticipant = { participantId: "host", role: ParticipantRole.HOST, connectionStatus: ConnectionStatus.CONNECTED, joinedAt: 0 };
    const allParticipants = [hostAsParticipant, ...this.participants.list().filter((p) => p.role === ParticipantRole.GUEST)];
    const composition = syncParticipantStage({
      stage: container,
      engine: this.engine,
      roomId: this.roomId,
      participants: allParticipants,
      selfParticipantId: "host",
      mounted: this._mountedGuestTiles,
      frameIdPrefix: "guestview"
    });
    this._setRemoteMediaState(composition.others.length === 0 ? RemoteMediaState.WAITING_FOR_PARTICIPANT : RemoteMediaState.REMOTE_MEDIA_LIVE);
  }

  // Producer Program Preview — SAME Program Renderer Preview Live Stream uses. Muted here so the
  // Host does not hear guests a second time on top of the participant stage.
  _syncProgramPreview() {
    const stage = this._containers?.programPreview;
    if (!stage) return;
    syncProgramRenderer({
      stage,
      engine: this.engine,
      roomId: this.roomId,
      participants: this.participants.list(),
      mounted: this._mountedProgramTiles,
      frameIdPrefix: "program-preview",
      muted: true,
      asset: this.programController.liveAsset(),
      assetLayout: this.program.assetLayout
    });
  }

  _teardownProgramPreview() {
    clearProgramRenderer({
      engine: this.engine,
      mounted: this._mountedProgramTiles,
      stage: this._containers?.programPreview
    });
  }

  // Presence confirming a guest is a DIFFERENT fact from their video actually being visible — see
  // js/remote-media-state.js. With multiple simultaneous tiles, this is now a summary (any others at all
  // vs none), not a per-tile confirmed-visible state — the per-tile getDetailedState polling that used to
  // drive REMOTE_MEDIA_ERROR was diagnostic machinery for the black-video investigation, root-caused and
  // removed once that was fixed (see the cleanup pass); a stuck individual tile is now a real product bug
  // to fix directly; not something to detect and retry around here.
  _setRemoteMediaState(next) {
    if (this.remoteMediaState === next) return;
    this.remoteMediaState = next;
    this.emit("remote-media-state", next);
  }

  guestCount() {
    return this.guestSeats.filter(Boolean).length;
  }

  // Compact non-secret snapshot for ?debugMedia=1 (js/media-diagnostics.js). Surfaces the two
  // independently-true layers the three-device bug split: Toasty presence roster vs VDO guest-list
  // (what Mac's Guests chip actually counts). Local helper — this module must not statically import
  // media-diagnostics.js, or a missing diagnostic file takes down Host/Producer with Guest Join.
  diagnosticsSnapshot() {
    try {
      return this._diagnosticsSnapshot();
    } catch (error) {
      console.error("[LiveSession] debugMedia snapshot failed", error);
      return { role: "host", error: String(error?.message || error) };
    }
  }

  _hostTrackSnapshot(stream, kind) {
    try {
      const track = stream?.getTracks?.().find((entry) => entry.kind === kind) || null;
      if (!track) return { readyState: "missing" };
      const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
      const width = settings.width || null;
      const height = settings.height || null;
      return {
        readyState: track.readyState,
        enabled: track.enabled,
        muted: track.muted,
        width,
        height,
        aspectRatio: settings.aspectRatio || (width && height ? Number((width / height).toFixed(4)) : null),
        facingMode: settings.facingMode || null
      };
    } catch (_) {
      return { readyState: "error" };
    }
  }

  _diagnosticsSnapshot() {
    const presence = this.presence?.snapshot() || { roster: [], presenceState: "idle", heartbeatStatus: "idle" };
    const presenceGuests = (presence.roster || []).filter((entry) => entry.role === "guest");
    const vdoIds = (this._lastVdoGuestList || []).map((entry) => entry.id).filter(Boolean);
    const presenceIds = presenceGuests.map((entry) => entry.participantId);
    const presenceSources = presenceGuests.map((entry) => entry.transportSourceId).filter(Boolean);
    const remotes = presenceGuests.map((entry) => {
      const inVdo = vdoIds.includes(entry.transportSourceId);
      const seated = this.guestSeats.some((seat) => seat?.id === entry.transportSourceId);
      return {
        participantId: entry.participantId,
        role: entry.role,
        requestedSourceId: entry.transportSourceId,
        mounted: Boolean(this._mountedGuestTiles?.get(entry.transportSourceId) || seated),
        mediaState: inVdo ? "in-vdo-guest-list" : "presence-only",
        error: inVdo ? "" : "not-in-vdo-guest-list"
      };
    });
    (this._lastVdoGuestList || []).forEach((entry) => {
      if (presenceSources.includes(entry.id)) return;
      remotes.push({
        participantId: entry.id,
        role: "guest",
        requestedSourceId: entry.id,
        mounted: this.guestSeats.some((seat) => seat?.id === entry.id),
        mediaState: "vdo-only",
        error: "not-in-presence-roster"
      });
    });
    return {
      role: "host",
      roomId: this.roomId,
      lifecycle: this.hostState,
      self: {
        participantId: "host",
        presenceState: presence.presenceState || "idle",
        heartbeatStatus: presence.heartbeatStatus || "idle",
        lastHttpStatus: presence.lastHttpStatus,
        rosterContainsSelf: presence.rosterContainsSelf === true,
        transportSourceId: `${this.roomId}h`,
        publisherSourceId: `${this.roomId}h`,
        videoTrack: this._hostTrackSnapshot(this._hostPreviewStream, "video"),
        audioTrack: this._hostTrackSnapshot(this._hostPreviewStream, "audio"),
        transportState: this.engine.frames.has("host") ? "publisher-iframe-mounted" : "none",
        nativePreview: null
      },
      remotes,
      host: {
        vdoGuestCount: vdoIds.length,
        presenceGuestCount: presenceGuests.length,
        uiGuestCount: this.guestCount(),
        vdoGuestIds: vdoIds,
        presenceIds,
        presenceNotInVdo: presenceSources.filter((id) => !vdoIds.includes(id))
      }
    };
  }

  // ---- LiveSession (durable) ----
  // See scripts/toasty-auth-db.py's live_sessions table and js/session-manager.js, which is what calls
  // this — BEFORE joinAsHost runs, so mountDirectorFrame/presence all target the durable session's real
  // roomId from the start rather than whatever getOrCreateRoomId() picked as a fallback default.
  applyDurableSession(record) {
    this.durableSession = record;
    this.roomId = record.roomId;
    this.emit("durable-session", record);
  }

  // Producer-initiated, authoritative: marks the backend record ENDED (blocking every future join/
  // heartbeat against this room — see handlePresenceAnnounce), then tears this browser down exactly like
  // leaveStudio. Other connected clients (guests, preview tabs) learn the session ended from their own
  // next presence/session poll — see _restartGuestListPolling's session-status check below and
  // js/guest.js's mirror-image handling of a 410 from presence/announce.
  async endDurableSession() {
    if (!this.durableSession) return;
    try {
      await studioRequest(`/api/sessions/${this.durableSession.id}/end`, { method: "POST", body: "{}" });
    } catch (error) {
      console.error("[LiveSession] endDurableSession request failed", error);
    }
    this.durableSession = { ...this.durableSession, status: "ENDED" };
    this.emit("session-ended");
    this.endShow();
    this.leaveStudio();
  }

  // Real removal, not a UI-only hide: a best-effort VDO disconnect command (see VideoEngine.sendToGuest's
  // own caveat — not guaranteed delivered) PLUS a durable server-side block (session_kicks — see
  // scripts/toasty-auth-db.py) that refuses this exact participant_id's next heartbeat regardless of
  // whether the VDO command landed. Removes the seat locally right away rather than waiting up to 4s for
  // the next guest-list poll to notice.
  async kickGuest(guestId) {
    const seat = this.guestSeats.find((s) => s?.id === guestId);
    if (!seat) return;
    this.engine.forceGuestHangup(guestId);
    if (this.durableSession) {
      try {
        await studioRequest(`/api/sessions/${this.durableSession.id}/kick`, {
          method: "POST",
          body: JSON.stringify({ participantId: guestId })
        });
      } catch (error) {
        console.error("[LiveSession] kickGuest request failed", error);
      }
    }
    const index = this.guestSeats.findIndex((s) => s?.id === guestId);
    if (index !== -1) this.guestSeats[index] = null;
    this.participants.remove(guestId);
    this.emit("guests", this.guestCount());
    this._syncGuestVideoTile();
    this._syncProgramPreview();
    this.publishProgramState();
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
      hostStarted: this.engine.frames.has("host"),
      guestCount: this.guestCount(),
      participants: this.participants.list().map(serializeProgramParticipant),
      asset: serializeProgramAsset(this.programController.liveAsset()),
      assetLayout: this.program.assetLayout,
      audio: serializeProgramAudio(this.program.audio)
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
    // Do not remount VDO scene=0 onto #lvGuestFrame — that container is the Host participant
    // stage (per-person &view= tiles). Program layout now comes from composeProgram via the
    // Program Renderer, not a mixer iframe.
    this.publishProgramState();
    this.emit("program", this.program);
    this._syncProgramPreview();
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

  // Off Program drops the seat from composeProgram (onProgram: false) so Program Renderer no longer
  // shows them. Also mutes their mic/camera remotely so they go silent in transport while staying
  // connected. Host/Producer can take them back on Program without a reconnect.
  setGuestOnProgram(guestId, onProgram) {
    const seat = this.guestSeats.find((s) => s?.id === guestId);
    if (!seat) return;
    seat.onProgram = onProgram;
    const existing = this.participants.get(guestId);
    if (existing) this.participants.upsert({ ...existing, onProgram });
    this.engine.setGuestRemoteMicrophone(guestId, onProgram);
    this.engine.setGuestRemoteCamera(guestId, onProgram);
    this.emit("guests", this.guestCount());
    this._syncProgramPreview();
    this.publishProgramState();
  }

  // ---- Session policy (Jam foundation) ----

  setSessionType(sessionType) {
    this.policy.setSessionType(sessionType);
    this.emit("policy", this.policy);
    this._enforcePolicy();
  }

  setResearchContext(context) {
    this.researchContext = context ? { ...context } : null;
    this.emit("research-context", this.researchContext);
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
  // STATE 5 (LEAVING) per the Host state machine: stop the native tracks, destroy the hidden VDO
  // transport, remove the Host's own registry entry, then hand control back to js/director.js (listening
  // for HostState.LEAVING) to re-show prejoin and request a fresh preview — a real, user-triggered
  // getUserMedia call, not a leftover one, since the previous stream's tracks are genuinely stopped here.
  leaveStudio() {
    this.setHostState(HostState.LEAVING);
    this.engine.disconnectLocalFrames();
    if (this._containers?.hostTransport) this.engine.unmountFrame(this._containers.hostTransport, "host", "");
    // Neither timer was ever being cleared here before this fix — a Host who left Studio (or a tab that
    // just sat open past a session ending elsewhere) kept polling both the 4s guest-list check AND
    // /api/sessions/:id forever, which is exactly what chronically exhausted the toasty_render rate-limit
    // bucket (see SESSION_STATUS_POLL_MS's comment) and made a later, genuinely human-triggered refresh
    // fail with "Failed to fetch".
    this._stopGuestListPolling();
    this._stopRecordingTimer();
    this.stopTranscription();
    this._teardownProgramPreview();
    this._hostPreviewStream?.getTracks().forEach((track) => track.stop());
    this._hostPreviewStream = null;
    this.participants.remove("host");
    this.presence?.leave();
    this.presence = null;
    this.connection = { status: "idle", label: "Left Studio" };
    this.emit("connection", this.connection);
    this.publishProgramState();
    this.setHostState(HostState.PREJOIN_LOADING);
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
    this.stopTranscription();
    // VDO's own iframe teardown (disconnectAll above) never touches this — it's a plain getUserMedia
    // stream Toasty owns directly for the native tile, so nothing else will turn the camera light off.
    this._hostPreviewStream?.getTracks().forEach((track) => track.stop());
    this._hostPreviewStream = null;
    this.participants.remove("host");
    this.presence?.leave();
    this.presence = null;
    this._teardownProgramPreview();
    this.connection = { status: "idle", label: "Show ended" };
    this.emit("connection", this.connection);
    this.publishProgramState();
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
