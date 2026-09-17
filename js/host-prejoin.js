// Toasty-native Host prejoin — the same idea as studio/guest.html's own check-in screen, so the host
// gets a branded Name/Title/Company + device-picker + live preview experience instead of ever seeing
// VDO.Ninja's own "Join Room with Camera" setup UI (green START button, its own device dropdowns,
// bitrate/branding). VDO.Ninja only ever mounts, via session.joinAsHost(), once this form is submitted —
// see js/video-engine.js's mountDirectorFrame and js/live-session.js's joinAsHost.
import { startDevicePreview } from "./device-picker.js";

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
    this._previewStream = null;
  }

  async init() {
    this.elements.camera.addEventListener("change", () => this.startPreview());
    this.elements.mic.addEventListener("change", () => this.startPreview());
    this.elements.join.addEventListener("click", () => this.join());
    await this.startPreview();
  }

  async startPreview() {
    try {
      this._previewStream = await startDevicePreview({
        videoEl: this.elements.preview,
        cameraSelect: this.elements.camera,
        microphoneSelect: this.elements.mic,
        previousStream: this._previewStream
      });
      this.elements.status.textContent = "Preview ready. Set your details, then join.";
      this.elements.join.disabled = false;
    } catch (error) {
      this.elements.status.textContent = "Camera or microphone permission is needed before joining.";
    }
  }

  join() {
    const videoDeviceId = this.elements.camera.value;
    const audioDeviceId = this.elements.mic.value;
    this._previewStream?.getTracks().forEach((track) => track.stop());
    this.elements.preview.srcObject = null;
    this.session.joinAsHost({
      displayName: this.elements.name.value,
      title: this.elements.title.value,
      company: this.elements.company.value,
      videoDeviceId,
      audioDeviceId
    });
    this.elements.card.hidden = true;
  }
}
