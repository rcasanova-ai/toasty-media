const DEFAULT_ENDPOINT = window.TOASTY_BROADCAST_ENDPOINT || "https://broadcast.toasty.media";
const DEFAULT_TOKEN = window.TOASTY_BROADCAST_TOKEN || "";

export class ToastyBroadcastController {
  constructor({ getProgramUrl } = {}) {
    this.getProgramUrl = getProgramUrl;
    this.endpoint = localStorage.getItem("toasty.broadcast.endpoint") || DEFAULT_ENDPOINT;
    this.serviceToken = sessionStorage.getItem("toasty.broadcast.token") || DEFAULT_TOKEN;
    this.broadcastId = null;
    this.abortController = null;
    this.captureStream = null;
    this.recorder = null;
    this.writer = null;
    this.startedAt = null;
    this.timer = null;
    this.elements = {};
  }

  init() {
    this.injectStyles();
    this.mountPanel();
    this.bind();
    this.updateUi("offline");
    return this;
  }

  mountPanel() {
    const panel = document.createElement("section");
    panel.className = "broadcast-panel";
    panel.id = "broadcastPanel";
    panel.innerHTML = `
      <div class="broadcast-head">
        <div>
          <p class="rail-eyebrow">Broadcast</p>
          <h3>Stream Toasty live</h3>
        </div>
        <span id="broadcastBadge" class="broadcast-badge" data-state="offline">OFFLINE</span>
      </div>
      <button id="openProgramOutput" class="btn btn-ghost broadcast-wide" type="button">Open Program Output</button>
      <label>Broadcast service
        <input id="broadcastEndpoint" type="url" value="${escapeHtml(this.endpoint)}" placeholder="https://broadcast.toasty.media">
      </label>
      <label>Service token
        <input id="broadcastServiceToken" type="password" autocomplete="off" value="${escapeHtml(this.serviceToken)}" placeholder="Paste Toasty broadcast token">
      </label>
      <label>Destination
        <select id="broadcastDestination">
          <option value="x">X Live</option>
          <option value="youtube">YouTube</option>
          <option value="twitch">Twitch</option>
          <option value="custom" selected>Custom RTMP</option>
        </select>
      </label>
      <label>RTMP / RTMPS URL
        <input id="broadcastStreamUrl" type="url" placeholder="rtmps://...">
      </label>
      <label>Stream key
        <input id="broadcastStreamKey" type="password" autocomplete="off" placeholder="Paste stream key">
      </label>
      <div class="broadcast-settings">
        <label>Resolution
          <select id="broadcastResolution">
            <option value="1280x720">720p</option>
            <option value="1920x1080" selected>1080p</option>
          </select>
        </label>
        <label>Bitrate
          <select id="broadcastBitrate">
            <option value="3500">3.5 Mbps</option>
            <option value="6000" selected>6 Mbps</option>
            <option value="8000">8 Mbps</option>
          </select>
        </label>
      </div>
      <p id="broadcastHelp" class="broadcast-help">Open Program Output first. When you go live, select that browser tab and enable tab audio.</p>
      <div class="broadcast-actions">
        <button id="testBroadcast" class="btn btn-ghost" type="button">Test service</button>
        <button id="toggleBroadcast" class="btn btn-primary" type="button">Go Live</button>
      </div>
      <div class="broadcast-metrics" id="broadcastMetrics" hidden>
        <span id="broadcastDuration">00:00:00</span>
        <span id="broadcastStateText">Connecting</span>
      </div>
    `;

    const rightRail = document.querySelector(".rail-right") || document.querySelector(".rail-left") || document.body;
    rightRail.appendChild(panel);

    [
      "broadcastBadge", "openProgramOutput", "broadcastEndpoint", "broadcastServiceToken", "broadcastDestination",
      "broadcastStreamUrl", "broadcastStreamKey", "broadcastResolution", "broadcastBitrate",
      "broadcastHelp", "testBroadcast", "toggleBroadcast", "broadcastMetrics",
      "broadcastDuration", "broadcastStateText"
    ].forEach((id) => { this.elements[id] = document.getElementById(id); });
  }

  bind() {
    this.elements.openProgramOutput.addEventListener("click", () => this.openProgramOutput());
    this.elements.testBroadcast.addEventListener("click", () => this.testService());
    this.elements.toggleBroadcast.addEventListener("click", () => {
      if (this.broadcastId) this.stop(); else this.start();
    });
    this.elements.broadcastEndpoint.addEventListener("change", () => {
      this.endpoint = this.elements.broadcastEndpoint.value.trim().replace(/\/+$/, "");
      localStorage.setItem("toasty.broadcast.endpoint", this.endpoint);
    });
    this.elements.broadcastServiceToken.addEventListener("change", () => {
      this.serviceToken = this.elements.broadcastServiceToken.value.trim();
      if (this.serviceToken) sessionStorage.setItem("toasty.broadcast.token", this.serviceToken);
      else sessionStorage.removeItem("toasty.broadcast.token");
    });
    window.addEventListener("beforeunload", () => this.stop({ quiet: true }));
  }

  openProgramOutput() {
    const url = this.getProgramUrl?.();
    if (!url) return this.setHelp("Program Output URL is unavailable.", true);
    window.open(url, "toasty-program-output");
    this.setHelp("Program Output opened. Keep it open, then click Go Live and select that tab with tab audio enabled.");
  }

  async testService() {
    try {
      const response = await this.request("/health", { method: "GET" });
      this.setHelp(`Broadcast service online. ${response.activeBroadcasts || 0} active broadcast(s).`);
    } catch (error) {
      this.setHelp(`Broadcast service unavailable: ${error.message}`, true);
    }
  }

  async start() {
    const streamUrl = this.elements.broadcastStreamUrl.value.trim();
    const streamKey = this.elements.broadcastStreamKey.value.trim();
    if (!/^rtmps?:\/\//i.test(streamUrl)) return this.setHelp("Enter a valid RTMP or RTMPS URL.", true);
    if (!streamKey) return this.setHelp("Enter the destination stream key.", true);
    if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) {
      return this.setHelp("Live broadcast requires a current Chromium browser with tab capture support.", true);
    }

    this.updateUi("connecting");
    try {
      const capture = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: true,
        preferCurrentTab: false,
        selfBrowserSurface: "exclude",
        surfaceSwitching: "include",
        systemAudio: "include"
      });
      const videoTrack = capture.getVideoTracks()[0];
      if (!videoTrack) throw new Error("No video source was selected.");
      this.captureStream = capture;
      videoTrack.addEventListener("ended", () => this.stop());

      const [width, height] = this.elements.broadcastResolution.value.split("x").map(Number);
      const start = await this.request("/broadcast/start", {
        method: "POST",
        body: JSON.stringify({
          destination: this.elements.broadcastDestination.value,
          streamUrl,
          streamKey,
          width,
          height,
          fps: 30,
          bitrateKbps: Number(this.elements.broadcastBitrate.value)
        })
      });
      this.broadcastId = start.id;
      this.elements.broadcastStreamKey.value = "";
      await this.beginIngest(start.ingestPath);
      this.startedAt = Date.now();
      this.timer = window.setInterval(() => this.updateDuration(), 1000);
      this.updateUi("live");
    } catch (error) {
      await this.stop({ quiet: true });
      this.setHelp(`Could not start broadcast: ${error.message}`, true);
      this.updateUi("offline");
    }
  }

  async beginIngest(ingestPath) {
    const mimeType = pickMimeType();
    if (!mimeType) throw new Error("This browser cannot encode a WebM program feed.");

    const stream = new TransformStream();
    this.writer = stream.writable.getWriter();
    this.abortController = new AbortController();
    this.recorder = new MediaRecorder(this.captureStream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
      audioBitsPerSecond: 160_000
    });

    this.recorder.addEventListener("dataavailable", async (event) => {
      if (!event.data?.size || !this.writer) return;
      try {
        await this.writer.write(new Uint8Array(await event.data.arrayBuffer()));
      } catch (_) {}
    });
    this.recorder.addEventListener("stop", async () => {
      try { await this.writer?.close(); } catch (_) {}
      this.writer = null;
    });

    const ingestPromise = fetch(`${this.endpoint}${ingestPath}`, {
      method: "POST",
      headers: this.headers(),
      body: stream.readable,
      duplex: "half",
      signal: this.abortController.signal
    }).then(async (response) => {
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Broadcast ingest failed (${response.status}).`);
      }
      return response;
    }).catch((error) => {
      if (error.name !== "AbortError" && this.broadcastId) {
        this.setHelp(`Broadcast ingest stopped: ${error.message}`, true);
        this.stop({ quiet: true });
      }
    });

    this.recorder.start(500);
    this.ingestPromise = ingestPromise;
  }

  async stop({ quiet = false } = {}) {
    const id = this.broadcastId;
    this.broadcastId = null;
    if (this.timer) window.clearInterval(this.timer);
    this.timer = null;
    this.startedAt = null;

    try {
      if (this.recorder?.state && this.recorder.state !== "inactive") this.recorder.stop();
    } catch (_) {}
    this.recorder = null;

    this.captureStream?.getTracks().forEach((track) => track.stop());
    this.captureStream = null;

    try { await this.writer?.close(); } catch (_) {}
    this.writer = null;
    this.abortController?.abort();
    this.abortController = null;

    if (id) {
      try { await this.request(`/broadcast/${id}/stop`, { method: "POST", body: "{}" }); } catch (_) {}
    }
    this.updateUi("offline");
    if (!quiet) this.setHelp("Broadcast ended.");
  }

  async request(path, options = {}) {
    this.endpoint = this.elements.broadcastEndpoint?.value.trim().replace(/\/+$/, "") || this.endpoint;
    this.serviceToken = this.elements.broadcastServiceToken?.value.trim() || this.serviceToken;
    localStorage.setItem("toasty.broadcast.endpoint", this.endpoint);
    if (this.serviceToken) sessionStorage.setItem("toasty.broadcast.token", this.serviceToken);
    const response = await fetch(`${this.endpoint}${path}`, {
      ...options,
      headers: { ...this.headers(), ...(options.headers || {}) }
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
    return body;
  }

  headers() {
    const headers = { "Content-Type": "application/json" };
    const token = this.serviceToken || DEFAULT_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;
    return headers;
  }

  updateUi(state) {
    const live = state === "live";
    const connecting = state === "connecting";
    this.elements.broadcastBadge.dataset.state = state;
    this.elements.broadcastBadge.textContent = live ? "LIVE" : connecting ? "CONNECTING" : "OFFLINE";
    this.elements.toggleBroadcast.textContent = live ? "End Broadcast" : connecting ? "Connecting…" : "Go Live";
    this.elements.toggleBroadcast.disabled = connecting;
    this.elements.broadcastMetrics.hidden = !live;
    this.elements.broadcastStateText.textContent = live ? "Streaming" : connecting ? "Connecting" : "Offline";
    [
      this.elements.broadcastEndpoint, this.elements.broadcastServiceToken, this.elements.broadcastDestination,
      this.elements.broadcastStreamUrl, this.elements.broadcastStreamKey,
      this.elements.broadcastResolution, this.elements.broadcastBitrate
    ].forEach((element) => { element.disabled = live || connecting; });
    if (!live) this.elements.broadcastDuration.textContent = "00:00:00";
  }

  updateDuration() {
    if (!this.startedAt) return;
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    const h = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const m = String(Math.floor((seconds % 3600) / 60)).padStart(2, "0");
    const s = String(seconds % 60).padStart(2, "0");
    this.elements.broadcastDuration.textContent = `${h}:${m}:${s}`;
  }

  setHelp(message, error = false) {
    this.elements.broadcastHelp.textContent = message;
    this.elements.broadcastHelp.dataset.error = String(error);
  }

  injectStyles() {
    if (document.getElementById("toastyBroadcastStyles")) return;
    const style = document.createElement("style");
    style.id = "toastyBroadcastStyles";
    style.textContent = `
      .broadcast-panel{margin-top:18px;padding:16px;border:1px solid rgba(255,255,255,.12);border-radius:18px;background:rgba(10,10,12,.72);display:grid;gap:12px}
      .broadcast-head{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}.broadcast-head h3{margin:2px 0 0;font-size:16px}
      .broadcast-badge{font-size:10px;font-weight:800;letter-spacing:.09em;padding:6px 8px;border-radius:999px;background:rgba(255,255,255,.08)}
      .broadcast-badge[data-state="live"]{background:#ff3b30;color:#fff}.broadcast-badge[data-state="connecting"]{background:#f5a623;color:#111}
      .broadcast-panel label{display:grid;gap:6px;font-size:11px;font-weight:700;color:rgba(255,255,255,.72)}
      .broadcast-panel input,.broadcast-panel select{width:100%;box-sizing:border-box;border:1px solid rgba(255,255,255,.13);border-radius:10px;background:#111216;color:#fff;padding:10px;font:inherit}
      .broadcast-settings{display:grid;grid-template-columns:1fr 1fr;gap:10px}.broadcast-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px}.broadcast-wide{width:100%}
      .broadcast-help{margin:0;font-size:11px;line-height:1.45;color:rgba(255,255,255,.58)}.broadcast-help[data-error="true"]{color:#ff8d86}
      .broadcast-metrics{display:flex;justify-content:space-between;font-variant-numeric:tabular-nums;font-size:11px;color:rgba(255,255,255,.72)}
    `;
    document.head.appendChild(style);
  }
}

function pickMimeType() {
  return [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm"
  ].find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>'\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[char]));
}
