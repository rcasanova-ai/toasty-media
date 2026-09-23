// Toasty-native Host prejoin — the same idea as studio/guest.html's own check-in screen, so the host
// gets a branded Name/Title/Company + device-picker + live preview experience instead of ever seeing
// VDO.Ninja's own "Join Room with Camera" setup UI (green START button, its own device dropdowns,
// bitrate/branding). VDO.Ninja only ever mounts, via session.joinAsHost(), once this form is submitted —
// see js/video-engine.js's mountDirectorFrame and js/live-session.js's joinAsHost.
//
// Drives session.hostState (see js/host-state.js) through PREJOIN_LOADING -> PREJOIN_READY -> JOINING;
// LiveSession.joinAsHost confirms IN_STUDIO. Every control that should only exist once the Host has
// actually joined (Leave Studio, Talk to Moxie — see js/host-view.js's renderHostState) reads THAT
// state, not whether this class happens to exist or whether the page has loaded.
import { startDevicePreview } from "./device-picker.js";
import { HostState } from "./host-state.js";

function log(...args) { console.debug("[HostPrejoin]", ...args); }

export class HostPrejoin {
  constructor({ session, root = document }) {
    this.session = session;
    this.root = root;
    this.elements = {
      card: root.querySelector("#lvHostPrejoin"),
      preview: root.querySelector("#lvHostPrejoinPreview"),
      name: root.querySelector("#lvHostPrejoinName"),
      title: root.querySelector("#lvHostPrejoinTitle"),
      company: root.querySelector("#lvHostPrejoinCompany"),
      camera: root.querySelector("#lvHostPrejoinCamera"),
      mic: root.querySelector("#lvHostPrejoinMic"),
      status: root.querySelector("#lvHostPrejoinStatus"),
      join: root.querySelector("#lvHostPrejoinJoin")
    };
    for (const [key, el] of Object.entries(this.elements)) {
      if (!el) log("MISSING element for key:", key, "— a stale/mismatched director.html would explain a silent init failure");
    }
    this._previewStream = null;
  }

  async init() {
    log("init() starting");
    this.elements.camera.addEventListener("change", () => this.startPreview());
    this.elements.mic.addEventListener("change", () => this.startPreview());
    this.elements.join.addEventListener("click", () => this.join());
    await this.startPreview();
    log("init() finished, hostState:", this.session.hostState);
  }

  // Re-entrant on purpose: called on first load, on every camera/mic dropdown change, AND after Leave
  // Studio (see resume() below) — always the SAME single getUserMedia lifecycle, never a second concurrent
  // one, since startDevicePreview() itself stops `previousStream` before requesting a new one.
  async startPreview() {
    this.session.setHostState(HostState.PREJOIN_LOADING);
    this.elements.join.disabled = true;
    this.elements.status.textContent = "Requesting camera preview…";
    log("requesting camera/mic preview…");
    try {
      this._previewStream = await startDevicePreview({
        videoEl: this.elements.preview,
        cameraSelect: this.elements.camera,
        microphoneSelect: this.elements.mic,
        previousStream: this._previewStream
      });
      log("preview stream acquired:", this._previewStream.getTracks().map((t) => ({ kind: t.kind, label: t.label, readyState: t.readyState })));
      try {
        await this.elements.preview.play();
        log("preview <video>.play() resolved — paused:", this.elements.preview.paused, "videoWidth:", this.elements.preview.videoWidth);
      } catch (playError) {
        // autoplay policy or similar — the stream is still valid and usable for Join even if the local
        // <video> element itself didn't start painting; log it rather than silently proceeding as if
        // nothing happened.
        log("preview <video>.play() REJECTED (stream is still valid):", playError?.name, playError?.message);
      }
      this.elements.status.textContent = "Preview ready. Set your details, then join.";
      this.elements.join.disabled = false;
      this.session.setHostState(HostState.PREJOIN_READY);
    } catch (error) {
      log("getUserMedia FAILED", error?.name, error?.message, error?.stack);
      const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
      this.elements.status.textContent = denied
        ? `Camera or microphone permission is needed before joining. (${error?.name}: ${error?.message})`
        : `Couldn't start the camera/microphone: ${error?.name}: ${error?.message}`;
      // Deliberately stays in PREJOIN_LOADING (per the Host state machine, that's the "not ready yet"
      // state) rather than inventing a separate error state — Join stays disabled either way.
    }
  }

  join() {
    log("join() clicked, hostState was:", this.session.hostState);
    this.session.setHostState(HostState.JOINING);
    // Pass the device's LABEL, not its .value (a MediaDevices deviceId) — see video-engine.js's
    // mountDirectorFrame comment for why a deviceId read here on toasty.media's origin can't reliably
    // resolve inside VDO.Ninja's cross-origin iframe, but the plain device name can.
    const videoDeviceLabel = this.elements.camera.selectedOptions[0]?.textContent;
    const audioDeviceLabel = this.elements.mic.selectedOptions[0]?.textContent;
    // Deliberately NOT stopped here — this is the same working native preview stream, and the fix for
    // "camera goes black on Join" is carrying it forward into the joined Host tile (see LiveSession
    // .joinAsHost/_showHostNativeVideo) instead of destroying it and replacing it with VDO's iframe. No
    // second getUserMedia call happens anywhere in this method.
    const previewStream = this._previewStream;
    this._previewStream = null;
    this.elements.preview.srcObject = null;
    this.session.joinAsHost({
      displayName: this.elements.name.value,
      title: this.elements.title.value,
      company: this.elements.company.value,
      videoDeviceLabel,
      audioDeviceLabel,
      previewStream
    });
    this.elements.card.hidden = true;
    log("join() done, hostState now:", this.session.hostState);
  }

  // Called by js/director.js when it sees the Host transition to HostState.LEAVING (Leave Studio) — Leave
  // Studio's teardown (LiveSession.leaveStudio) genuinely stops the previous stream's tracks, so a fresh
  // getUserMedia call here is a real re-acquisition triggered by that explicit user action, not a
  // duplicate of the prejoin->join handoff.
  async resume() {
    log("resume() after Leave Studio");
    this.elements.card.hidden = false;
    this.elements.preview.srcObject = null;
    await this.startPreview();
  }
}
