// Publisher completion is distinct from "an iframe exists." VDO.Ninja only lists a guest in the
// director getGuestList after that guest's push actually joins the room. A 2×2 off-screen iframe
// plus a still-open native getUserMedia on the parent page is enough for Chrome to dual-capture
// (Guest #2) and enough for exclusive-camera phones to never publish (Guest #3).

export const PublisherState = Object.freeze({
  NONE: "none",
  IFRAME_MOUNTED: "publisher-iframe-mounted",
  CONNECTING: "publisher-connecting",
  LIVE: "publisher-live",
  ERROR: "publisher-error"
});

export function pickLocalPublisherEntry(detailedState, streamId) {
  if (!detailedState || typeof detailedState !== "object") return null;
  const entries = Array.isArray(detailedState) ? detailedState : Object.values(detailedState);
  const wanted = String(streamId || "");
  return (
    entries.find((entry) => entry && wanted && (entry.streamID === wanted || entry.streamId === wanted)) ||
    entries.find((entry) => entry && (entry.self === true || entry.local === true)) ||
    null
  );
}

export function derivePublisherState({
  iframePresent = false,
  iframeLoaded = false,
  pushConnection = null,
  detailedSelf = null,
  lastError = ""
} = {}) {
  if (lastError) {
    return { state: PublisherState.ERROR, reason: String(lastError) };
  }
  if (!iframePresent) {
    return { state: PublisherState.NONE, reason: "" };
  }
  if (pushConnection === false) {
    return { state: PublisherState.ERROR, reason: "push-connection-false" };
  }
  if (pushConnection === true) {
    return { state: PublisherState.LIVE, reason: "push-connection" };
  }
  const ice = String(detailedSelf?.iceConnectionState || detailedSelf?.connectionState || "");
  if (ice === "connected" || ice === "completed") {
    return { state: PublisherState.LIVE, reason: `ice:${ice}` };
  }
  if (detailedSelf?.videoStream || detailedSelf?.localStream) {
    return { state: PublisherState.LIVE, reason: "local-stream" };
  }
  if (iframeLoaded) {
    return { state: PublisherState.CONNECTING, reason: ice || "waiting-for-push-connection" };
  }
  return { state: PublisherState.IFRAME_MOUNTED, reason: "iframe-only" };
}
