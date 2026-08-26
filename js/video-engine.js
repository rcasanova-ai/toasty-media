const VDO_ORIGIN = "https://vdo.ninja";
const IFRAME_ALLOW =
  "camera; microphone; display-capture; autoplay; fullscreen; picture-in-picture; web-share";

const DEFAULT_PARAMS = {
  cleanoutput: "1",
  transparent: "1",
  autostart: "1",
  api: "1"
};

export const BackgroundMode = Object.freeze({
  NONE: "none",
  BLUR: "blur",
  NEWSROOM: "newsroom",
  LIBRARY: "library",
  STAGE: "stage"
});

export function createDisposableRoomId() {
  const random = crypto.getRandomValues(new Uint32Array(3));
  return `toasty-${Date.now().toString(36)}-${Array.from(random, (part) =>
    part.toString(36)
  ).join("")}`;
}

export function getRoomIdFromUrl(search = window.location.search) {
  return new URLSearchParams(search).get("room");
}

export function getGuestInviteUrl(roomId) {
  const url = new URL("../studio/guest.html", window.location.href);
  url.searchParams.set("room", roomId);
  return url.toString();
}

export class VideoEngine {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || VDO_ORIGIN;
    this.frames = new Map();
    this.listeners = new Set();
    window.addEventListener("message", (event) => this.handleMessage(event));
  }

  mountDirectorFrame(container, { roomId, label = "Host" }) {
    const streamId = `${roomId}-host`;
    return this.mountFrame(container, "director", {
      director: roomId,
      push: streamId,
      label,
      webcam: "1",
      cleandirector: "1",
      cleanoutput: "1",
      showlabels: "1"
    });
  }

  mountRoomFrame(container, { roomId }) {
    return this.mountFrame(container, "room", {
      room: roomId,
      scene: "1",
      cleanoutput: "1",
      transparent: "1",
      showlabels: "1"
    });
  }

  mountGuestFrame(container, { roomId, guestName, backgroundMode }) {
    const streamId = `${roomId}-${slugify(guestName || "guest")}-${Date.now().toString(36)}`;
    return this.mountFrame(container, "guest", {
      room: roomId,
      push: streamId,
      label: guestName || "Guest",
      webcam: "1",
      showlabels: "1",
      effects: effectForBackground(backgroundMode)
    });
  }

  mountFrame(container, frameId, params) {
    const iframe = document.createElement("iframe");
    iframe.allow = IFRAME_ALLOW;
    iframe.allowFullscreen = true;
    iframe.src = this.buildUrl(params);
    iframe.title = `Toasty Studio ${frameId}`;
    container.replaceChildren(iframe);
    container.removeAttribute("data-empty");
    this.frames.set(frameId, iframe);
    return iframe;
  }

  buildUrl(params) {
    const url = new URL("/", this.baseUrl);
    const merged = { ...DEFAULT_PARAMS, ...params };
    Object.entries(merged).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== false && value !== "") {
        url.searchParams.set(key, value);
      }
    });
    return url.toString();
  }

  send(frameId, command) {
    const iframe = this.frames.get(frameId);
    if (!iframe?.contentWindow) return false;
    iframe.contentWindow.postMessage(command, this.baseUrl);
    return true;
  }

  setMicrophone(enabled) {
    return this.send("director", { mic: enabled });
  }

  setCamera(enabled) {
    return this.send("director", { camera: enabled });
  }

  setScreenShare(enabled) {
    return this.send("director", { screenshare: enabled, share: enabled });
  }

  requestRecording(enabled) {
    return this.send("director", { record: enabled });
  }

  disconnectAll() {
    this.frames.forEach((_, frameId) => {
      this.send(frameId, { hangup: true });
      this.send(frameId, { disconnect: true });
    });
  }

  requestDetailedState(frameId = "director") {
    return this.send(frameId, { getDetailedState: true });
  }

  onMessage(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  handleMessage(event) {
    if (event.origin !== this.baseUrl) return;
    this.listeners.forEach((callback) => callback(event.data));
  }
}

function effectForBackground(backgroundMode) {
  if (backgroundMode === BackgroundMode.BLUR) return "3";
  if (
    backgroundMode === BackgroundMode.NEWSROOM ||
    backgroundMode === BackgroundMode.LIBRARY ||
    backgroundMode === BackgroundMode.STAGE
  ) {
    return "5";
  }
  return "0";
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "guest";
}
