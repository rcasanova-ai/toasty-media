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

const HEARTBEAT_MS = 5000;

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
    this._timerId = null;
    this._listeners = new Set();
  }

  onRosterChange(callback) {
    this._listeners.add(callback);
    return () => this._listeners.delete(callback);
  }

  // Every OTHER participant in the room, in join order — exactly what a Participant View main stage
  // renders (self never appears here; self is always the caller's own native/local PiP, never a remote
  // source — see this pass's report's "PARTICIPANT VIEW LAYOUT CORRECTION").
  others() {
    return this.roster.filter((entry) => entry.participantId !== this.participantId);
  }

  // Called once the real VDO push id is known — the SAME point Host (joinAsHost) and Guest (joinStudio)
  // already mount their hidden transport today; this doesn't move that point, just adds an announce right
  // after it. Announces immediately (so the very first roster read after Join already includes yourself)
  // and starts the heartbeat/poll loop. Re-callable if transportSourceId ever changes (e.g. a future
  // reconnect) without needing a whole new RoomPresence instance.
  async start(transportSourceId) {
    this.transportSourceId = transportSourceId;
    this.stop();
    await this._announce();
    this._timerId = window.setInterval(() => this._announce(), HEARTBEAT_MS);
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

  async _announce() {
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
          transportSourceId: this.transportSourceId
        })
      });
      if (!response.ok) return;
      const data = await response.json();
      this.roster = data.roster || [];
      this._listeners.forEach((callback) => callback(this.roster));
    } catch (_) {
      // Network hiccup or the presence backend being briefly unreachable — deliberately non-fatal: the
      // next heartbeat (HEARTBEAT_MS away) retries, and until then callers keep whatever roster they
      // already had rather than the whole page breaking on one dropped request.
    }
  }
}
