// Toasty session presence — the source of truth for WHO is in a room, WHAT ROLE they have, and WHICH
// VDO.Ninja transportSourceId carries their media. Replaces two things a real two-device test proved don't
// hold up: guessing the Host's stream id as roomId+"h" (a Guest has no way to discover any OTHER
// participant that way, and it can't scale past one specific, hardcoded host), and reading identity off
// VDO.Ninja's own &label (js/live-session.js's old parseGuestLabel — the mechanism it depended on to relay
// a custom label back to the Director never reliably showed a real name on real hardware; Director kept
// showing "Guest"). VDO.Ninja stays pure media transport; this module is what "Toasty owns identity" means
// concretely. Used identically by js/guest.js (Guest) and js/live-session.js (Host) — one shared client for
// one shared concept, not two independently-drifting implementations.
//
// Backend: scripts/render-production-server.mjs's /api/presence/* routes, scripts/toasty-auth-db.py's
// room_presence table (SQLite, TTL-pruned). Deliberately unauthenticated (a Guest has no Toasty account —
// see studio/guest.html's own "No account required" copy) and poll/heartbeat-based rather than
// push/WebSocket: this repo has no real-time transport of any kind today (audited before writing this), so
// a short-interval poll matches the one existing precedent (js/live-session.js's own 4s VDO guest-list
// poll) instead of inventing new infrastructure just for this.

import { studioApiEndpoint } from "./studio-api.js";

const HEARTBEAT_MS = 2000;

export class RoomPresence {
  constructor({ roomId, participantId, role, displayName = "", title = "", company = "" }) {
    this.roomId = roomId;
    this.participantId = participantId;
    this.role = role;
    this.displayName = displayName;
    this.title = title;
    this.company = company;
    this.transportSourceId = null;
    this.roster = [];
    this.outputs = [];
    this.program = null;
    this.commands = [];
    this.micEnabled = null;
    this.cameraEnabled = null;
    this.outputStatus = null;
    this.screenShare = { active: false, participantId: this.participantId, transportSourceId: null };
    this._pendingCommands = [];
    this._ackCommandIds = [];
    this._programPublisher = null;
    // The live session's CURRENT brand, straight from the same 5s heartbeat that already refreshes the
    // roster — see scripts/render-production-server.mjs's handlePresenceAnnounce, which rides this on its
    // existing session_get_by_room call. null until the first successful poll. No separate event: callers
    // read this.brandId inside their own onRosterChange callback (already fires every successful poll),
    // rather than this module inventing a second notification channel for one more field.
    this.brandId = null;
    this._timerId = null;
    this._listeners = new Set();
    this._controlListeners = new Set();
    this._rejectionListeners = new Set();
    // Compact, non-secret status for ?debugMedia=1 — see js/media-diagnostics.js. presenceState is
    // the admission lifecycle (idle until the first announce, then admitted/rejected/error);
    // heartbeatStatus is the most recent announce HTTP outcome, including the in-flight tick.
    this.presenceState = "idle";
    this.heartbeatStatus = "idle";
    this.lastHttpStatus = null;
    this.lastAnnounceError = "";
    this._lastAnnounceAt = null;
  }

  onRosterChange(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  onControlChange(callback) {
    this._controlListeners.add(callback);
    return () => this._controlListeners.delete(callback);
  }

  setProgramPublisher(callback) {
    this._programPublisher = typeof callback === "function" ? callback : null;
  }

  setMediaState({ micEnabled, cameraEnabled } = {}) {
    if (typeof micEnabled === "boolean") this.micEnabled = micEnabled;
    if (typeof cameraEnabled === "boolean") this.cameraEnabled = cameraEnabled;
  }

  setOutputStatus(status) {
    this.outputStatus = status || null;
  }

  setScreenShare(share = {}) {
    this.screenShare = {
      active: Boolean(share.active),
      participantId: share.participantId || this.participantId,
      transportSourceId: share.transportSourceId || null
    };
  }

  enqueueCommands(commands = []) {
    for (const command of commands || []) {
      if (command) this._pendingCommands.push(command);
    }
  }

  ackCommands(ids = []) {
    for (const id of ids || []) {
      if (id) this._ackCommandIds.push(id);
    }
  }

  async publishNow() {
    return this._announce({ retryOnFailure: true });
  }

  // Fires when the backend refuses this participant's own announce/heartbeat — the three cases that
  // mean "you specifically are no longer welcome here", distinct from a plain network hiccup (which
  // _announce already treats as silently-retry-next-tick): 403 = kicked (see scripts/toasty-auth-db.py's
  // session_kicks), 409 = session at MAX_GUESTS_PER_ROOM, 410 = the LiveSession was ENDED. Callers (guest.js,
  // live-session.js) use this to show a real terminal state instead of quietly retrying forever.
  onRejected(callback) {
    this._rejectionListeners.add(callback);
    return () => this._rejectionListeners.delete(callback);
  }

  // Every OTHER participant in the room, in join order — exactly what a Participant View main stage
  // renders (self never appears here; self is always the caller's own native/local PiP, never a remote
  // source — see this pass's report's "PARTICIPANT VIEW LAYOUT CORRECTION").
  others() {
    return this.roster.filter((entry) => entry.participantId !== this.participantId);
  }

  rosterContainsSelf() {
    if (this.role === "output") {
      return this.outputs.some((entry) => (entry.outputId || entry.participantId) === this.participantId);
    }
    return this.roster.some((entry) => entry.participantId === this.participantId);
  }

  snapshot() {
    return {
      participantId: this.participantId,
      role: this.role,
      roomId: this.roomId,
      sessionId: this.program?.sessionId || this.roomId,
      transportSourceId: this.transportSourceId,
      presenceState: this.presenceState,
      heartbeatStatus: this.heartbeatStatus,
      lastHttpStatus: this.lastHttpStatus,
      lastAnnounceError: this.lastAnnounceError,
      lastAnnounceAt: this._lastAnnounceAt || null,
      rosterContainsSelf: this.rosterContainsSelf(),
      programScene: this.program?.scene || null,
      roster: this.roster.map((entry) => {
        const isSelf = entry.participantId === this.participantId;
        return {
          participantId: entry.participantId,
          role: entry.role,
          transportSourceId: entry.transportSourceId || null,
          lastSeenAt: isSelf ? (this._lastAnnounceAt || entry.lastSeenAt || null) : (entry.lastSeenAt || null),
          sessionId: this.program?.sessionId || this.roomId,
          roomId: entry.roomId || this.roomId,
          micEnabled: entry.micEnabled ?? null,
          cameraEnabled: entry.cameraEnabled ?? null
        };
      }),
      outputs: (this.outputs || []).map((entry) => {
        const id = entry.outputId || entry.participantId || null;
        const isSelf = id === this.participantId;
        return {
          outputId: id,
          participantId: id,
          role: "output",
          connection: entry.connection || null,
          lastSeenAt: isSelf ? (this._lastAnnounceAt || entry.updatedAt || entry.lastSeenAt || null) : (entry.updatedAt || entry.lastSeenAt || null),
          updatedAt: entry.updatedAt || entry.lastSeenAt || null,
          scene: entry.scene || null,
          audioEnabled: Boolean(entry.audioEnabled || entry.audioReady),
          sessionId: entry.sessionId || this.program?.sessionId || this.roomId,
          roomId: entry.roomId || this.roomId
        };
      })
    };
  }

  // Admission-only announce — does NOT start the 5s heartbeat and does NOT mount any VDO transport.
  // js/guest.js calls this BEFORE mountGuestFrame so a rejected/failed presence announce cannot leave
  // the guest as a receive-only VDO participant. Returns true only when this participant is actually
  // on the returned roster.
  async admit(transportSourceId) {
    this.transportSourceId = transportSourceId;
    this.stop();
    this.presenceState = "announcing";
    const ok = await this._announce({ retryOnFailure: false });
    if (ok) this.presenceState = "admitted";
    return ok;
  }

  startHeartbeat() {
    this.stop();
    this._timerId = window.setInterval(() => this._announce(), HEARTBEAT_MS);
  }

  // Called once the real VDO push id is known. Host still uses this combined form (joinAsHost); Guest
  // now splits admit() → mountGuestFrame → startHeartbeat() so transport cannot start before Toasty
  // presence admission succeeds. Re-callable if transportSourceId ever changes (e.g. a future
  // reconnect) without needing a whole new RoomPresence instance.
  async start(transportSourceId) {
    const ok = await this.admit(transportSourceId);
    if (ok) this.startHeartbeat();
    return ok;
  }

  stop() {
    if (this._timerId) {
      window.clearInterval(this._timerId);
      this._timerId = null;
    }
  }

  async leave() {
    this.stop();
    try {
      await fetch(`${studioApiEndpoint()}/api/presence/leave`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: this.roomId, participantId: this.participantId })
      });
    } catch (_) {
      // Best-effort — server-side TTL (see toasty-auth-db.py's PRESENCE_TTL_SECONDS) removes this row
      // regardless within 20s even if this specific request never lands (tab closed, network gone, etc),
      // so a failed leave call is a delay for other participants, never a permanent stuck entry.
    }
  }

  async _announce({ retryOnFailure = true } = {}) {
    this.heartbeatStatus = "pending";
    try {
      const response = await fetch(`${studioApiEndpoint()}/api/presence/announce`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roomId: this.roomId,
          participantId: this.participantId,
          role: this.role,
          displayName: this.displayName,
          title: this.title,
          company: this.company,
          transportSourceId: this.transportSourceId,
          micEnabled: this.micEnabled,
          cameraEnabled: this.cameraEnabled,
          screenShare: this.role === "output" ? undefined : this.screenShare,
          program: this.role === "host" && this._programPublisher ? this._programPublisher() : undefined,
          commands: this.role === "host" && this._pendingCommands.length ? this._pendingCommands.slice(0, 12) : undefined,
          ackCommandIds: this._ackCommandIds.length ? this._ackCommandIds.slice(0, 20) : undefined,
          outputStatus: this.role === "output" ? this.outputStatus : undefined
        })
      });
      this.lastHttpStatus = response.status;
      if (!response.ok) {
        let body = {};
        try { body = await response.json(); } catch (_) {}
        this.lastAnnounceError = body.error || `http_${response.status}`;
        if (response.status === 403 || response.status === 409 || response.status === 410) {
          this.presenceState = "rejected";
          this.heartbeatStatus = "rejected";
          this.stop();
          this._rejectionListeners.forEach((callback) => callback(response.status, body.error || ""));
        } else {
          this.heartbeatStatus = "error";
          if (!retryOnFailure && this.presenceState !== "admitted") this.presenceState = "error";
        }
        return false;
      }
      const data = await response.json();
      this.roster = data.roster || [];
      this.outputs = data.outputs || [];
      this.program = data.program || null;
      this.commands = data.commands || [];
      this._pendingCommands = [];
      this._ackCommandIds = [];
      if (data.brandId !== undefined) this.brandId = data.brandId;
      this.lastAnnounceError = "";
      this._lastAnnounceAt = Date.now();
      this.heartbeatStatus = this.rosterContainsSelf() ? "ok" : "error";
      if (this.heartbeatStatus === "ok") this.presenceState = "admitted";
      this._listeners.forEach((callback) => callback(this.roster));
      this._controlListeners.forEach((callback) => callback({
        roster: this.roster,
        outputs: this.outputs,
        program: this.program,
        commands: this.commands
      }));
      return this.heartbeatStatus === "ok";
    } catch (_) {
      // Network hiccup or the presence backend being briefly unreachable — heartbeat ticks retry;
      // admit() does not, so a guest cannot enter transport after a failed first announce.
      this.lastHttpStatus = 0;
      this.lastAnnounceError = "network";
      this.heartbeatStatus = "error";
      if (!retryOnFailure && this.presenceState !== "admitted") this.presenceState = "error";
      return false;
    }
  }
}
