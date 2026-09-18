// TEMPORARY real-device diagnostics for the Host prejoin camera path. Added because three consecutive
// real-hardware tests failed before prejoin ever became usable, and console-only logging couldn't be
// checked without a laptop plugged into devtools mid-test — everything here renders directly in the page
// so Ricardo can read it off the screen and report it back verbatim. Delete this file and its wiring in
// js/host-prejoin.js / studio/director.html once real camera acquisition is confirmed working.
//
// Two independent things live here:
//   1. logStep()/renderEnvironment(): visible instrumentation of the REAL prejoin path (still
//      js/device-picker.js's startDevicePreview, unchanged) — never swallows an exception, always shows
//      the exact name/message.
//   2. runTestCamera(): the smallest possible isolated getUserMedia call, completely independent of
//      startDevicePreview/DevicePicker/LiveSession/VDO — to answer one question only: does THIS browser,
//      on THIS device, in THIS frame, grant camera/mic access at all, with zero application code in the
//      way. If this works and the real prejoin still doesn't, the bug is in the application path, not the
//      browser/hardware/permission boundary. If this also fails, the exact error it shows is authoritative.
export class PrejoinDiagnostics {
  constructor({ root = document, envEl, logEl, testCameraBtn, testCameraVideo, testCameraStatus }) {
    this.root = root;
    this.envEl = envEl;
    this.logEl = logEl;
    this.testCameraBtn = testCameraBtn;
    this.testCameraVideo = testCameraVideo;
    this.testCameraStatus = testCameraStatus;
    this._testStream = null;
  }

  init() {
    this.renderEnvironment();
    this.testCameraBtn?.addEventListener("click", () => this.runTestCamera());
  }

  logStep(message) {
    const line = `${new Date().toISOString().slice(11, 23)}  ${message}`;
    console.debug("[PrejoinDiag]", message);
    if (!this.logEl) return;
    const row = document.createElement("div");
    row.textContent = line;
    this.logEl.appendChild(row);
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }

  async renderEnvironment() {
    if (!this.envEl) return;
    const facts = [];
    facts.push(["Page URL", window.location.href]);
    facts.push(["window.top === window (top-level, not framed)", String(window.top === window)]);
    let frameId = "(none — not in an iframe, or cross-origin and unreadable)";
    let frameAllow = "(n/a)";
    try {
      frameId = window.frameElement?.id ?? "(window.frameElement is null — top-level or cross-origin)";
      frameAllow = window.frameElement?.getAttribute("allow") ?? "(no allow attribute found)";
    } catch (error) {
      frameId = `(threw reading frameElement: ${error?.name}: ${error?.message})`;
    }
    facts.push(["window.frameElement?.id", frameId]);
    facts.push(["window.frameElement?.getAttribute(\"allow\")", frameAllow]);
    facts.push(["window.isSecureContext", String(window.isSecureContext)]);
    facts.push(["navigator.mediaDevices exists", String(Boolean(navigator.mediaDevices))]);
    facts.push(["navigator.mediaDevices.getUserMedia exists", String(Boolean(navigator.mediaDevices?.getUserMedia))]);
    facts.push(["document.visibilityState", document.visibilityState]);

    for (const name of ["camera", "microphone"]) {
      try {
        if (!navigator.permissions?.query) {
          facts.push([`Permissions API: ${name}`, "navigator.permissions.query unavailable in this browser"]);
          continue;
        }
        const status = await navigator.permissions.query({ name });
        facts.push([`Permissions API: ${name}`, status.state]);
      } catch (error) {
        facts.push([`Permissions API: ${name}`, `threw: ${error?.name}: ${error?.message}`]);
      }
    }

    this.envEl.replaceChildren(...facts.map(([label, value]) => {
      const row = document.createElement("div");
      const labelEl = document.createElement("span");
      labelEl.textContent = `${label}: `;
      labelEl.style.opacity = "0.7";
      const valueEl = document.createElement("span");
      valueEl.textContent = value;
      row.append(labelEl, valueEl);
      return row;
    }));
    facts.forEach(([label, value]) => this.logStep(`ENV — ${label}: ${value}`));
  }

  // Deliberately bypasses every layer of the real app: no device enumeration, no constraints beyond
  // {video:true, audio:true}, no DevicePicker, no LiveSession, no VDO. Whatever happens here is the raw
  // browser/hardware/permission answer with nothing else able to have broken it.
  async runTestCamera() {
    this.testCameraBtn.disabled = true;
    this.testCameraStatus.textContent = "Requesting…";
    this.logStep("TEST CAMERA: calling navigator.mediaDevices.getUserMedia({video:true,audio:true}) directly");
    try {
      this._testStream?.getTracks().forEach((track) => track.stop());
      this._testStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      const videoTracks = this._testStream.getVideoTracks();
      const audioTracks = this._testStream.getAudioTracks();
      this.logStep(`TEST CAMERA: getUserMedia RESOLVED — stream id ${this._testStream.id}, ${videoTracks.length} video track(s), ${audioTracks.length} audio track(s)`);
      if (videoTracks[0]) this.logStep(`TEST CAMERA: video track label "${videoTracks[0].label}", readyState ${videoTracks[0].readyState}`);
      this.testCameraVideo.srcObject = this._testStream;
      this.testCameraVideo.hidden = false;
      try {
        await this.testCameraVideo.play();
        this.logStep(`TEST CAMERA: video.play() RESOLVED — videoWidth ${this.testCameraVideo.videoWidth}, videoHeight ${this.testCameraVideo.videoHeight}`);
        this.testCameraStatus.textContent = `Camera working — ${this.testCameraVideo.videoWidth}x${this.testCameraVideo.videoHeight}.`;
      } catch (playError) {
        this.logStep(`TEST CAMERA: video.play() REJECTED — ${playError?.name}: ${playError?.message}`);
        this.testCameraStatus.textContent = `Stream acquired but playback failed: ${playError?.name}: ${playError?.message}`;
      }
    } catch (error) {
      this.logStep(`TEST CAMERA: getUserMedia REJECTED — name="${error?.name}" message="${error?.message}"`);
      this.testCameraStatus.textContent = `FAILED — ${error?.name}: ${error?.message}`;
    } finally {
      this.testCameraBtn.disabled = false;
    }
  }
}
