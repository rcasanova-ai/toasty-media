const VDO_ORIGIN = "https://vdo.ninja";
const IFRAME_ALLOW =
  "camera; microphone; display-capture; autoplay; fullscreen; picture-in-picture; web-share";

const DEFAULT_PARAMS = {
  api: "1"
};

const HOST_CAMERA_HINT = "FaceTime";

export const BackgroundMode = Object.freeze({
  NONE: "none",
  BLUR: "blur",
  NEWSROOM: "newsroom",
  LIBRARY: "library",
  STAGE: "stage"
});

export function createDisposableRoomId() {
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 6);
  const timestamp = Date.now().toString(36).slice(-7);
  return `tm${timestamp}${random}`.slice(0, 15);
}

export function isValidRoomId(roomId) {
  return typeof roomId === "string" && /^[a-zA-Z0-9]{1,30}$/.test(roomId);
}

export function getRoomIdFromUrl(search = window.location.search) {
  const roomId = new URLSearchParams(search).get("room");
  return isValidRoomId(roomId) ? roomId : null;
}

export function getOrCreateRoomId(search = window.location.search) {
  return getRoomIdFromUrl(search) || createDisposableRoomId();
}

export function getGuestInviteUrl(roomId, brandTheme) {
  const url = new URL("../studio/guest.html", window.location.href);
  url.searchParams.set("room", roomId);
  if (brandTheme) {
    url.searchParams.set("brand", brandTheme);
  }
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
    const streamId = `${roomId}h`;
    return this.mountFrame(container, "host", {
      room: roomId,
      push: streamId,
      label,
      webcam: true,
      vdo: HOST_CAMERA_HINT,
      showlabels: "1"
    });
  }

  mountRoomFrame(container, { roomId }) {
    return this.mountFrame(container, "room", {
      room: roomId,
      scene: "0",
      cleanoutput: "1",
      transparent: "1",
      showlabels: "1",
      muted: "1",
      mute: "1"
    });
  }

  mountGuestFrame(container, { roomId, guestName, backgroundMode }) {
    const suffix = Date.now().toString(36).slice(-4);
    const streamId = `${roomId}g${suffix}`.slice(0, 24);
    return this.mountFrame(container, "guest", {
      room: roomId,
      push: streamId,
      label: guestName || "Guest",
      webcam: "1",
      showlabels: "1",
      cleanoutput: "0",
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
      if (value === true) {
        url.searchParams.set(key, "");
      } else if (value !== undefined && value !== null && value !== false && value !== "") {
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
    return this.send("host", { mic: enabled });
  }

  setCamera(enabled) {
    return this.send("host", { camera: enabled });
  }

  setScreenShare(enabled) {
    return this.send("host", { screenshare: enabled });
  }

  setGuestMicrophone(enabled) {
    return this.send("guest", { mic: enabled });
  }

  setGuestCamera(enabled) {
    return this.send("guest", { camera: enabled });
  }

  setGuestScreenShare(enabled) {
    return this.send("guest", { screenshare: enabled });
  }

  disconnectAll() {
    this.frames.forEach((_, frameId) => {
      this.send(frameId, { hangup: true });
      this.send(frameId, { disconnect: true });
    });
  }

  requestDetailedState(frameId = "host") {
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
  return "0";
}

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 32) || "guest";
}
