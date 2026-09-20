// Default-off real-device diagnostics for the three-device presence/publish split and the
// front-camera framing bug. Activated ONLY by ?debugMedia=1 (never by localStorage, never in
// production UI otherwise). Phone consoles are impractical, so this paints a compact overlay
// on the page itself. Deliberately omits credentials, cookies, tokens, deviceIds, and names
// that aren't already on the presence roster the product shows anyway.

const SECRET_KEY = /token|secret|password|cookie|authorization|credential|deviceid/i;

export function isDebugMediaEnabled(search = window.location.search) {
  return new URLSearchParams(search).get("debugMedia") === "1";
}

export function trackSnapshot(stream, kind) {
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
}

export function videoElementSnapshot(videoEl) {
  if (!videoEl) return null;
  let objectFit = "";
  let objectPosition = "";
  try {
    const style = window.getComputedStyle(videoEl);
    objectFit = style.objectFit || "";
    objectPosition = style.objectPosition || "";
  } catch (_) {}
  return {
    videoWidth: videoEl.videoWidth || 0,
    videoHeight: videoEl.videoHeight || 0,
    clientWidth: Math.round(videoEl.clientWidth || 0),
    clientHeight: Math.round(videoEl.clientHeight || 0),
    objectFit,
    objectPosition
  };
}

function seenAtMs(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function heartbeatLabel(lastSeenAt, now = Date.now()) {
  const seen = seenAtMs(lastSeenAt);
  if (!seen) return "NO-HB";
  const age = Math.max(0, now - seen);
  const secs = (age / 1000).toFixed(1);
  if (age <= 4000) return `LIVE ${secs}s`;
  if (age <= 8000) return `STALE ${secs}s`;
  return `DEAD ${secs}s`;
}

function decorateLocalHeartbeat(entry, snapshot) {
  const selfId = snapshot.self?.participantId || snapshot.presence?.participantId;
  const selfLast = snapshot.self?.lastAnnounceAt || snapshot.presence?.lastAnnounceAt || snapshot.lastAnnounceAt;
  const id = entry.participantId || entry.outputId;
  if (!selfLast || !selfId || id !== selfId) return entry;
  return {
    ...entry,
    lastSeenAt: entry.lastSeenAt || entry.updatedAt || selfLast,
    lastAnnounceAt: entry.lastAnnounceAt || selfLast
  };
}

export function formatPresenceBoard(snapshot = {}, now = Date.now()) {
  const sessionId = snapshot.sessionId || snapshot.presence?.sessionId || "none";
  const roomId = snapshot.roomId || snapshot.presence?.roomId || "none";
  const roster = (snapshot.presence?.roster || snapshot.roster || []).map((entry) => decorateLocalHeartbeat(entry, snapshot));
  const outputs = (snapshot.presence?.outputs || snapshot.outputs || []).map((entry) => decorateLocalHeartbeat(entry, snapshot));
  const hosts = roster.filter((entry) => entry.role === "host");
  const guests = roster.filter((entry) => entry.role === "guest");
  const outs = outputs.length ? outputs : roster.filter((entry) => entry.role === "output");
  const lines = ["— PRESENCE —", `session ${sessionId}`, `room ${roomId}`];
  if (!hosts.length) lines.push("host MISSING");
  else {
    hosts.forEach((entry) => {
      lines.push(`host ${entry.participantId || "?"} hb ${heartbeatLabel(entry.lastSeenAt || entry.lastAnnounceAt, now)}`);
    });
  }
  if (!guests.length) lines.push("guest MISSING");
  else {
    guests.forEach((entry) => {
      lines.push(`guest ${entry.participantId || "?"} hb ${heartbeatLabel(entry.lastSeenAt || entry.lastAnnounceAt, now)}`);
    });
  }
  if (!outs.length) lines.push("output MISSING");
  else {
    outs.forEach((entry) => {
      const id = entry.outputId || entry.participantId || "?";
      const connection = entry.connection || "connected";
      lines.push(`output ${id} ${connection} hb ${heartbeatLabel(entry.lastSeenAt || entry.updatedAt || entry.lastAnnounceAt, now)}`);
    });
  }
  const rooms = [...hosts, ...guests, ...outs]
    .map((entry) => entry.roomId)
    .filter(Boolean);
  if (rooms.length && rooms.some((id) => id !== roomId)) lines.push("ROOM MISMATCH");
  const sessions = [...hosts, ...guests, ...outs]
    .map((entry) => entry.sessionId)
    .filter(Boolean);
  if (sessions.length && sessions.some((id) => id !== sessionId)) lines.push("SESSION MISMATCH");
  return lines.join("\n");
}

export function sanitizeDiagnostics(value, depth = 0) {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((entry) => sanitizeDiagnostics(entry, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) continue;
    out[key] = sanitizeDiagnostics(entry, depth + 1);
  }
  return out;
}

export function formatDiagnostics(snapshot) {
  const safe = sanitizeDiagnostics(snapshot) || {};
  const lines = [];
  lines.push(`BUILD ${safe.buildId || "?"}  role=${safe.role || "?"}`);
  lines.push(`room=${safe.roomId || "?"}  life=${safe.lifecycle || "?"}`);
  lines.push(formatPresenceBoard(safe));
  const self = safe.self || {};
  lines.push("— SELF —");
  lines.push(`pid ${self.participantId || "?"}`);
  lines.push(`presence ${self.presenceState || "?"}  hb ${self.heartbeatStatus || "?"}  http ${self.lastHttpStatus ?? "—"}`);
  lines.push(`rosterHasSelf ${self.rosterContainsSelf === true ? "yes" : self.rosterContainsSelf === false ? "NO" : "?"}`);
  lines.push(`src ${self.transportSourceId || "none"}`);
  lines.push(`pub ${self.publisherSourceId || "none"}`);
  const video = self.videoTrack || {};
  const audio = self.audioTrack || {};
  lines.push(`v ${video.readyState || "?"} ${video.width || "?"}x${video.height || "?"} ar=${video.aspectRatio ?? "?"} face=${video.facingMode || "?"}`);
  lines.push(`a ${audio.readyState || "?"}  transport ${self.transportState || "?"}`);
  if (self.audioLevel != null) lines.push(`audioLevel ${Number(self.audioLevel).toFixed(2)} speaking ${self.speaking ? "YES" : "NO"}`);
  if (self.screenShare?.active) {
    lines.push(`share ${self.screenShare.ownerParticipantId || self.screenShare.participantId || "?"} source ${self.screenShare.transportSourceId || "none"} ${self.screenShare.state || "?"}`);
  }
  if (self.requested) {
    lines.push(`requested ${self.requested.video || "?"}`);
  }
  if (self.nativePreview) {
    const preview = self.nativePreview;
    lines.push(`preview ${preview.videoWidth}x${preview.videoHeight} in ${preview.clientWidth}x${preview.clientHeight} fit=${preview.objectFit || "?"}`);
  }
  if (self.publisherReason) lines.push(`pubReason ${self.publisherReason}`);
  if (self.ice || self.signaling) lines.push(`ice ${self.ice || "?"}  signaling ${self.signaling || "?"}`);
  if (self.vdoAr) lines.push(`vdo ar=${self.vdoAr}`);
  if (safe.server) {
    const server = safe.server;
    lines.push("— SERVER —");
    lines.push(`connected ${server.connected ? "yes" : "NO"} revision ${server.programRevision ?? "?"}`);
    lines.push(`scene ${server.scene || "?"} source ${server.programSource || "?"}`);
    lines.push(`last ${server.lastUpdateAt || "none"}${server.lastError ? ` error ${server.lastError}` : ""}`);
    lines.push(`hostSource ${server.hostSourceId || "none"}`);
    const guestSources = (server.guestSourceIds || []).map((entry) => `${entry.participantId}:${entry.transportSourceId || "none"}`).join(",");
    lines.push(`guestSources ${guestSources || "none"}`);
    lines.push(`screenSource ${server.screenSourceId || "none"}`);
  }
  lines.push("— REMOTE —");
  const remotes = Array.isArray(safe.remotes) ? safe.remotes : [];
  if (!remotes.length) lines.push("(none)");
  remotes.forEach((remote) => {
    lines.push(`${remote.role || "?"} ${remote.participantId || "?"}`);
    lines.push(`  want ${remote.requestedSourceId || "?"}  mounted ${remote.mounted ? "yes" : "NO"}`);
    lines.push(`  media ${remote.mediaState || "?"} ${remote.error || ""}`.trimEnd());
    if (remote.audioLevel != null) lines.push(`  audioLevel ${Number(remote.audioLevel).toFixed(2)} speaking ${remote.speaking ? "YES" : "NO"}`);
  });
  if (safe.host) {
    lines.push("— HOST COUNTS —");
    lines.push(`vdoList ${safe.host.vdoGuestCount ?? "?"}  presenceGuests ${safe.host.presenceGuestCount ?? "?"}  ui ${safe.host.uiGuestCount ?? "?"}`);
    const vdoIds = (safe.host.vdoGuestIds || []).join(",") || "—";
    const presenceIds = (safe.host.presenceIds || []).join(",") || "—";
    lines.push(`vdo [${vdoIds}]`);
    lines.push(`presence [${presenceIds}]`);
    const missing = safe.host.presenceNotInVdo || [];
    if (missing.length) lines.push(`presence∉vdo ${missing.join(",")}`);
  }
  if (safe.screenShare) {
    lines.push("— SHARE —");
    lines.push(`share ${safe.screenShare.ownerParticipantId || safe.screenShare.participantId || "?"} source ${safe.screenShare.transportSourceId || "none"} ${safe.screenHealth || safe.screenShare.state || "?"}`);
  }
  if (Array.isArray(safe.activity) && safe.activity.length) {
    lines.push("— ACTIVITY —");
    safe.activity.forEach((entry) => {
      const name = entry.displayName || entry.participantId;
      lines.push(`${name} audioLevel ${Number(entry.audioLevel || 0).toFixed(2)} speaking ${entry.speaking ? "YES" : "NO"}`);
    });
  }
  if (safe.programAudio) {
    lines.push("— PROGRAM AUDIO —");
    lines.push(`completeness ${safe.programAudio.completeness || "?"} master ${safe.programAudio.masterReady ? "available" : "missing"} bus ${safe.programAudio.captureAvailable ? "available" : "missing"}`);
    (safe.programAudio.sources || []).forEach((source) => {
      const label = source.participantId ? `${source.participantId} voice` : source.id;
      const state = source.connected ? "available" : (source.transportLimited ? "transport-limited" : "missing");
      lines.push(`${label}: ${state}${source.reason ? ` (${source.reason})` : ""}`);
    });
  }
  return lines.join("\n");
}

export function mountMediaDiagnostics(getSnapshot) {
  if (!isDebugMediaEnabled()) return { stop() {}, overlay: null };
  const overlay = document.createElement("aside");
  overlay.id = "toastyMediaDiagnostics";
  overlay.setAttribute("aria-label", "Media diagnostics");
  overlay.innerHTML = `<pre></pre><button type="button">Copy</button>`;
  const pre = overlay.querySelector("pre");
  const button = overlay.querySelector("button");
  const render = () => {
    try {
      pre.textContent = formatDiagnostics(getSnapshot() || {});
    } catch (error) {
      pre.textContent = `diagnostics error: ${error?.message || error}`;
    }
  };
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.textContent || "");
      button.textContent = "Copied";
      window.setTimeout(() => { button.textContent = "Copy"; }, 1200);
    } catch (_) {
      button.textContent = "Copy failed";
    }
  });
  document.body.appendChild(overlay);
  render();
  const timerId = window.setInterval(render, 1000);
  return {
    overlay,
    stop() {
      window.clearInterval(timerId);
      overlay.remove();
    }
  };
}

// Fail-open wrapper. Guest Join / Host Studio must keep working if the overlay cannot mount
// (missing DOM, thrown snapshot, unexpected runtime). Diagnostics disappear; session continues.
export function startMediaDiagnostics(getSnapshot) {
  try {
    if (!isDebugMediaEnabled()) return { stop() {}, overlay: null };
    return mountMediaDiagnostics(getSnapshot);
  } catch (error) {
    console.error("[debugMedia] failed open; app continues", error);
    return { stop() {}, overlay: null };
  }
}
