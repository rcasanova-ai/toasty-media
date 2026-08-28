import { applyBrandTheme, getInitialBrandTheme } from "./brand-themes.js";
import { VideoEngine, getRoomIdFromUrl, isValidRoomId } from "./video-engine.js";

const state = {
  roomId: getRoomIdFromUrl(),
  brandTheme: getInitialBrandTheme(window.location.search, { useStorage: false })
};

const engine = new VideoEngine();

const elements = {
  listenerFrame: document.querySelector("#listenerFrame"),
  listenerState: document.querySelector("#listenerState"),
  studioBrandLogo: document.querySelector("#studioBrandLogo"),
  studioBrandText: document.querySelector("#studioBrandText"),
  poweredBy: document.querySelector("#poweredBy")
};

init();

function init() {
  applyBrandTheme(state.brandTheme, {
    root: document.body,
    logoImg: elements.studioBrandLogo,
    logoText: elements.studioBrandText,
    poweredBy: elements.poweredBy
  });

  if (!isValidRoomId(state.roomId)) {
    elements.listenerState.textContent = "Invalid invite";
    elements.listenerFrame.dataset.empty = "Ask the host for a fresh listener link";
    return;
  }

  engine.mountListenerFrame(elements.listenerFrame, { roomId: state.roomId });
  elements.listenerState.textContent = "View only";
}
