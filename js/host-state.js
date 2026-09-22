// Explicit Host lifecycle states — the single source of truth for what Leave Studio, Talk to Moxie, the
// Join button, and the prejoin status text should show. Before this existed, none of those controls were
// gated on anything real: Leave Studio and Talk to Moxie were just always-visible/always-enabled markup
// with no code ever hiding or disabling them based on whether the Host had actually joined — which is
// exactly why a real-device test caught "Leave Studio" showing before Join was ever clicked. "The Live
// Studio page is open" and "the Host has joined" were never actually distinguished in code; this makes
// that distinction the thing every control reads from, instead of incidental DOM/session existence.
export const HostState = Object.freeze({
  PREJOIN_LOADING: "prejoin-loading", // requesting camera/mic permission; no preview yet; Join disabled
  PREJOIN_READY: "prejoin-ready",     // preview is live; identity/device fields usable; Join enabled
  JOINING: "joining",                 // Join clicked; the SAME MediaStream is being carried into the studio
  IN_STUDIO: "in-studio",             // native video visible, VDO transport hidden, Talk to Moxie live
  LEAVING: "leaving"                  // tearing down: stopping tracks, destroying transport, clearing registry
});
