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
  lines.push("— REMOTE —");
  const remotes = Array.isArray(safe.remotes) ? safe.remotes : [];
  if (!remotes.length) lines.push("(none)");
  remotes.forEach((remote) => {
    lines.push(`${remote.role || "?"} ${remote.participantId || "?"}`);
    lines.push(`  want ${remote.requestedSourceId || "?"}  mounted ${remote.mounted ? "yes" : "NO"}`);
    lines.push(`  media ${remote.mediaState || "?"} ${remote.error || ""}`.trimEnd());
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
