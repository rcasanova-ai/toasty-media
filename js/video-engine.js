const VDO_ORIGIN = "https://vdo.ninja";
const IFRAME_ALLOW =
  "camera; microphone; display-capture; autoplay; fullscreen; picture-in-picture; web-share";

const DEFAULT_PARAMS = { api: "1" };

export const BackgroundMode = Object.freeze({ NONE:"none", BLUR:"blur", NEWSROOM:"newsroom", LIBRARY:"library", STAGE:"stage" });

export function createDisposableRoomId() {
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).slice(0, 6);
  const timestamp = Date.now().toString(36).slice(-7);
  return `tm${timestamp}${random}`.slice(0, 15);
}
export function isValidRoomId(roomId) { return typeof roomId === "string" && /^[a-zA-Z0-9]{1,30}$/.test(roomId); }
export function getRoomIdFromUrl(search = window.location.search) { const roomId=new URLSearchParams(search).get("room"); return isValidRoomId(roomId)?roomId:null; }
export function getOrCreateRoomId(search = window.location.search) { return getRoomIdFromUrl(search)||createDisposableRoomId(); }
export function getGuestInviteUrl(roomId, brandTheme) { const url=new URL("../studio/guest.html",window.location.href); url.searchParams.set("room",roomId); if(brandTheme)url.searchParams.set("brand",brandTheme); return url.toString(); }
export function getListenerInviteUrl(roomId, brandTheme) { const url=new URL("../studio/listener.html",window.location.href); url.searchParams.set("room",roomId); if(brandTheme)url.searchParams.set("brand",brandTheme); return url.toString(); }

export class VideoEngine {
  constructor(options={}) { this.baseUrl=options.baseUrl||VDO_ORIGIN; this.frames=new Map(); this.listeners=new Set(); window.addEventListener("message",event=>this.handleMessage(event)); }

  // cover=1 matches mountRoomFrame/mountProgramFrame's crop-to-fill behavior — without it, VDO.Ninja
  // letterboxes the local preview (object-fit:contain) inside .vdo-frame's fixed aspect box, so the host's
  // own tile showed black bars while guest tiles (which already had cover=1) filled cleanly.
  //
  // ROOT CAUSE of "VDO chrome/black video after Join" (found via real-device testing): this was missing
  // cleanoutput=1 entirely — every OTHER mount* function below has it; this one never did, going all the
  // way back to before the native-prejoin rewrite. Without it, VDO.Ninja shows its own full UI (status
  // bar, bitrate, etc.) by default. Fixed by adding it here, matching every sibling function.
  //
  // SECOND root cause: videodevice/audiodevice used to receive raw MediaDevices deviceId strings from
  // js/host-prejoin.js's device picker. Per VDO.Ninja's own docs, a device id there requires an EXACT
  // match against ITS OWN device enumeration — but deviceId is deliberately salted per-origin by the
  // browser's privacy model (a real, documented anti-fingerprinting behavior, not a bug in either
  // codebase): a deviceId read on toasty.media is not guaranteed, and in practice usually fails, to match
  // the SAME physical device's id inside the cross-origin vdo.ninja iframe. That silent match failure is
  // what actually produced the black video + VDO's own device-selection UI reappearing — passing yet
  // another query parameter could never fix a mismatch in the VALUE already being passed. Device LABELS
  // (e.g. "FaceTime HD Camera") aren't origin-salted — they're the plain OS/driver device name — and VDO's
  // own docs describe label-based matching ("NameStartsWith"/"NameIncludes") as the primary lookup before
  // falling back to exact device id. js/host-prejoin.js and js/guest.js now pass the selected option's
  // LABEL, not its value/deviceId — see normalizeVdoDeviceLabel below. NOT yet confirmed on a real device;
  // this is a documented-behavior-based fix for a documented cross-origin limitation, not a guess, but it
  // still needs the next real Host+Guest test to confirm VDO actually resolves it this way in practice.
  mountDirectorFrame(container,{roomId,label="Host",videoDeviceLabel,audioDeviceLabel}) {
    const streamId=`${roomId}h`;
    return this.mountFrame(container,"host",{room:roomId,push:streamId,label,webcam:"1",showlabels:"1",cleanoutput:"1",cover:"1",autostart:"1",videodevice:normalizeVdoDeviceLabel(videoDeviceLabel),audiodevice:normalizeVdoDeviceLabel(audioDeviceLabel)});
  }

  // slots=4 reserves 4 even grid cells regardless of how many are actually filled, and cover=1 crops
  // each video to fill its cell instead of leaving letterbox bars — together these turn VDO.Ninja's
  // default speaker+thumbnails auto-layout into a uniform, evenly-sized grid (both documented VDO.Ninja
  // mixer parameters). Used everywhere scene=0 is mounted, so Director's own guest preview matches what
  // Program Output actually shows.
  //
  // layout="screen-dominant" deliberately OMITS slots/cover instead of adding new params: without them,
  // VDO.Ninja's mixer falls back to its native "speaker + thumbnails" auto-layout, which already promotes
  // an active screen-share to the dominant tile and shrinks camera participants to thumbnails — the exact
  // behavior the screen-dominant/PiP requirement asks for, achieved with VDO.Ninja's own default instead
  // of us compositing tiles ourselves (scene=0 is a single merged feed; we cannot address host vs. screen
  // as separate DOM elements on our side).
  mountRoomFrame(container,{roomId,layout="grid"}) { return this.mountFrame(container,"room",{room:roomId,scene:"0",cleanoutput:"1",transparent:"1",showlabels:"1",muted:"1",mute:"1",...layoutParams(layout)}); }
  // Toasty's own Source Registry / Layout Engine mounts ONE clean feed per participant instead of
  // VDO.Ninja's own scene=0 room mixer — that mixer brings its OWN director-style chrome along with it
  // (name-label overlay, connection state) no matter what "clean" flags are added, which is exactly what
  // was leaking into Program Preview (see this repair pass's report). &view=<streamID>, used standalone
  // (no &room/&scene — confirmed against VDO.Ninja's own docs: "Optional if you are publishing... &view
  // in a room combined with &scene or &solo" is the OTHER, heavier pattern, not this one), is VDO.Ninja's
  // plain single-stream viewer mode — simpler than the numbered-scene/solo approaches this codebase
  // already found unreliable (see mountProgramFrame's comment), so this is deliberately NOT that. cleanoutput
  // strips VDO's UI chrome; no &showlabels, since Toasty renders its OWN name/title/company label
  // (.lv-video-tile-label) instead of VDO's redundant one. NOT yet verified end-to-end on a real two-device
  // session — this is the one piece of this repair pass that genuinely needs Ricardo's next real test.
  mountParticipantView(container,{streamId},frameId="participant-view") { return this.mountFrame(container,frameId,{view:streamId,cleanoutput:"1",transparent:"1",cover:"1"}); }
  // Tears a mounted view back down to an empty container (used when a guest disconnects) without
  // guessing at any VDO.Ninja "close" command — just stop pointing an iframe at it at all. emptyText
  // restores the exact placeholder .vdo-frame[data-empty]::before renders (see css/studio.css) — passed
  // in rather than hardcoded here since only the caller knows what that tile's placeholder copy is.
  unmountFrame(container,frameId,emptyText="") { const iframe=this.frames.get(frameId); if(iframe)this.frames.delete(frameId); container.replaceChildren(); if(emptyText)container.dataset.empty=emptyText; }
  // videoDeviceId/audioDeviceId come from the guest's own check-in device pickers (already granted
  // permission for the local preview) — passing them through as videodevice/audiodevice plus autostart
  // lets VDO.Ninja publish immediately with those devices instead of showing its own native
  // device-selection screen (which is both off-brand and, on narrow viewports, wider than the iframe).
  // videoDeviceLabel/audioDeviceLabel: same cross-origin fix as mountDirectorFrame above — a raw
  // MediaDevices deviceId from guest.html's own picker is origin-salted and won't reliably resolve
  // inside the vdo.ninja iframe; the device's LABEL does. This already had cleanoutput=1, so guest join
  // was never exposed to VDO's own UI chrome the way the host path was — only the device-selection half
  // of this bug applied here.
  // streamId: normally generated fresh here, but callers doing a live camera flip (js/guest.js's Flip
  // Camera control) pass the SAME id back in so the remount is the same participant reconnecting with a
  // different device, not a brand-new one — VDO.Ninja's guest-list id is what Director/ParticipantRegistry
  // key identity off of, so a changing id on flip would look like a disconnect+reconnect to everyone else.
  mountGuestFrame(container,{roomId,guestName,backgroundMode,videoDeviceLabel,audioDeviceLabel,streamId}) { const id=streamId||`${roomId}g${Date.now().toString(36).slice(-4)}`.slice(0,24); this.mountFrame(container,"guest",{room:roomId,push:id,label:guestName||"Guest",webcam:"1",showlabels:"1",cleanoutput:"1",autostart:"1",cover:"1",videodevice:normalizeVdoDeviceLabel(videoDeviceLabel),audiodevice:normalizeVdoDeviceLabel(audioDeviceLabel),effects:effectForBackground(backgroundMode)}); return id; }
  mountListenerFrame(container,{roomId}) { return this.mountFrame(container,"listener",{room:roomId,scene:"0",showlabels:"1",cleanoutput:"1"}); }

  // Hidden viewer-only frame used purely to query the room's live guest list (id + label) for the Program
  // Output compositor. showlabels=1 added this repair pass: getGuestList's response is built client-side
  // from session.rpcs[UUID].label (confirmed by reading VDO.Ninja's own source — see this pass's report),
  // and it's plausible a client only actively tracks incoming label updates when it would otherwise render
  // them. Costs nothing (this frame is never shown — see .director-control-frame's 2x2px CSS box) and is
  // not yet confirmed to be the actual cause of "sidebar shows Guest instead of the real name" — flagged
  // as a worth-trying hedge, not a proven fix, pending the next real two-device test.
  mountDirectorControlFrame(container,{roomId}) { return this.mountFrame(container,"control",{room:roomId,director:roomId,cleanoutput:"1",transparent:"1",showlabels:"1"}); }

  // Program Output's video layer: VDO.Ninja's own auto-mixed room grid (scene=0), showing whoever is
  // currently live with VDO.Ninja's own name labels. Numbered director-controlled scenes (scene=1+) and
  // solo/view mode were both tried for real per-seat control and both failed inside VDO.Ninja itself
  // (confirmed via direct testing: solo hits a cross-origin localStorage bug in VDO.Ninja's own
  // chooseBestTURN code; numbered scenes accept the director's addScene assignment over signaling but
  // never actually negotiate media to the viewer) — scene=0 is the one mode that has reliably shown
  // video end-to-end, so Program Output's branded chrome (logo/LIVE/topic/ticker) wraps this instead of
  // compositing individual tiles. Unlike mountRoomFrame (Director's own muted local monitor of this same
  // scene), this is unmuted: Program Output's audio is the real program audio for broadcast/recording.
  mountProgramFrame(container,{roomId,layout="grid"},frameId) { return this.mountFrame(container,frameId,{room:roomId,scene:"0",cleanoutput:"1",transparent:"1",showlabels:"1",controls:"0",...layoutParams(layout)}); }

  mountFrame(container,frameId,params) { const iframe=document.createElement("iframe"); iframe.allow=IFRAME_ALLOW; iframe.allowFullscreen=true; iframe.src=this.buildUrl(params); iframe.title=`Toasty Studio ${frameId}`; container.replaceChildren(iframe); container.removeAttribute("data-empty"); this.frames.set(frameId,iframe); return iframe; }
  buildUrl(params) { const url=new URL("/",this.baseUrl); const merged={...DEFAULT_PARAMS,...params}; Object.entries(merged).forEach(([key,value])=>{ if(value===true)url.searchParams.set(key,""); else if(value!==undefined&&value!==null&&value!==false&&value!=="")url.searchParams.set(key,value); }); return url.toString(); }
  send(frameId,command) { const iframe=this.frames.get(frameId); if(!iframe?.contentWindow)return false; iframe.contentWindow.postMessage(command,this.baseUrl); return true; }
  setMicrophone(enabled){return this.send("host",{mic:enabled});}
  setCamera(enabled){return this.send("host",{camera:enabled});}
  setScreenShare(enabled){return this.send("host",{screenshare:enabled});}
  setGuestMicrophone(enabled){return this.send("guest",{mic:enabled});}
  setGuestCamera(enabled){return this.send("guest",{camera:enabled});}
  setGuestScreenShare(enabled){return this.send("guest",{screenshare:enabled});}

  // Targets ONE remote participant by id, over the director-control frame's signaling channel — not a
  // per-guest iframe (Director never mounts one; scene=0 is a single merged view). Sent under UUID,
  // streamID and target simultaneously because VDO.Ninja's own director-command addressing key has
  // varied across versions and we have no live second-participant harness in this environment to pin
  // down which one this deployed VDO.Ninja build expects — verify against a real two-browser session
  // before depending on this in a demo.
  sendToGuest(guestId,command,frameId="control"){ return this.send(frameId,{...command,UUID:guestId,streamID:guestId,target:guestId}); }
  setGuestRemoteMicrophone(guestId,enabled){ return this.sendToGuest(guestId,{mic:enabled}); }
  setGuestRemoteCamera(guestId,enabled){ return this.sendToGuest(guestId,{camera:enabled}); }
  setGuestRemoteVolume(guestId,volume0to1){ return this.sendToGuest(guestId,{volume:Math.round(Math.max(0,Math.min(1,volume0to1))*100)}); }
  forceGuestHangup(guestId){ return this.sendToGuest(guestId,{hangup:true,disconnect:true}); }

  // "Leave Studio" (host): disconnects only frames THIS browser mounted (own push frame, local room
  // monitor, control frame). Never touches a remote guest's connection or the show's live state.
  disconnectLocalFrames(){ this.frames.forEach((_,frameId)=>{ this.send(frameId,{hangup:true}); this.send(frameId,{disconnect:true}); }); }
  // "End Show" (producer): same local cleanup, PLUS a best-effort remote hangup to every known guest id.
  // Only the local half is guaranteed — see sendToGuest's caveat above for the remote half.
  disconnectAll(guestIds=[]){ this.disconnectLocalFrames(); guestIds.forEach((id)=>this.forceGuestHangup(id)); }
  requestDetailedState(frameId="host"){return this.send(frameId,{getDetailedState:true});}

  // Asks the hidden director-control frame for the room's current guest list. Resolves to a normalized
  // [{id,label}] array (tolerant of the VDO.Ninja response using id/streamID/UUID and label/name keys, and
  // of the response being either an array or an object keyed by slot number "1","2",... — VDO.Ninja's own
  // reference describes the latter).
  //
  // ROOT CAUSE of "0 connected" despite real video working (found this repair pass): this used to send
  // {action:"getGuestList", cib}. VDO.Ninja's IFRAME API commands are boolean/value flags directly on the
  // message object ({mic:true}, {hangup:true}, {getDetailedState:true} — see every other command in this
  // file), never an {action:"..."} envelope. getGuestList follows that same pattern, so the old shape was
  // never recognized: VDO.Ninja never replied, this always hit the 2500ms timeout and resolved to [],
  // and guestSeats could never populate no matter how real the connection was. Confirmed against
  // VDO.Ninja's own IFRAME API reference and the author's Companion-Ninja docs — NOT yet confirmed against
  // a live two-device session (this environment can't run one); re-verify on the next real guest test.
  requestGuestList(frameId="control",timeoutMs=2500) {
    return new Promise((resolve) => {
      const cib = `guestlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
      let done = false;
      const finish = (list) => { if(done) return; done=true; clearTimeout(timer); off(); resolve(list); };
      const off = this.onMessage((message) => {
        if (message?.cib !== cib) return;
        const wrapped = message.guestList ?? message.list ?? message.guests;
        const raw = wrapped !== undefined ? wrapped : Object.fromEntries(Object.entries(message).filter(([key]) => key !== "cib"));
        finish(normalizeGuestListEntries(raw));
      });
      const timer = setTimeout(() => finish([]), timeoutMs);
      if (!this.send(frameId, { getGuestList: true, cib })) finish([]);
    });
  }

  // DIAGNOSTIC ONLY — same request as requestGuestList, but resolves the untouched raw VDO.Ninja response
  // (whatever fields it actually included) instead of the normalized {id,label} shape requestGuestList
  // reduces it to. Used to answer "what does VDO ACTUALLY send us for this guest" without normalization
  // hiding a field that might matter (see this pass's report, section A/B).
  requestRawGuestList(frameId="control",timeoutMs=2500) {
    return new Promise((resolve) => {
      const cib = `rawguestlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
      let done = false;
      const finish = (value) => { if(done) return; done=true; clearTimeout(timer); off(); resolve(value); };
      const off = this.onMessage((message) => {
        if (message?.cib !== cib) return;
        finish(message.guestList ?? message.list ?? message.guests ?? null);
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      if (!this.send(frameId, { getGuestList: true, cib })) finish(null);
    });
  }

  // Lets a caller correlate an onMessage callback's event.source against a specific mounted frame — see
  // handleMessage below. Used by live-session.js's guest-view diagnostics to know whether a given VDO
  // postMessage actually came from the mounted remote-guest-view iframe specifically, not just "some" frame.
  getFrameWindow(frameId){return this.frames.get(frameId)?.contentWindow;}

  onMessage(callback){this.listeners.add(callback);return()=>this.listeners.delete(callback);}
  // event.source (the iframe's window) is now passed as a second argument — additive, existing callbacks
  // that only read the first (data) argument are unaffected.
  handleMessage(event){if(event.origin!==this.baseUrl)return;this.listeners.forEach(callback=>callback(event.data,event.source));}
}

// VDO.Ninja's own docs: a device-name string matches via "NameStartsWith" then "NameIncludes" before
// falling back to an exact device-id match — whitespace can be replaced with underscores for a cleaner
// match. Returns undefined (not an empty string) for a blank/generic label so callers correctly fall back
// to VDO's own default-device auto-select instead of sending it a param that can't match anything.
function normalizeVdoDeviceLabel(label) {
  const trimmed = String(label || "").trim();
  return trimmed ? trimmed.replace(/\s+/g, "_") : undefined;
}

function normalizeGuestListEntries(raw) {
  if (!raw) return [];
  const entries = Array.isArray(raw) ? raw : Object.values(raw);
  return entries.map((entry) => ({
    id: entry?.id || entry?.streamID || entry?.UUID || entry?.uuid || entry?.streamId,
    label: entry?.label || entry?.name || entry?.title || ""
  })).filter((entry) => entry.id);
}

function effectForBackground(backgroundMode){if(backgroundMode===BackgroundMode.BLUR)return"3";return"0";}
// "grid" = today's always-on behavior (uniform cropped 4-slot grid). "screen-dominant" intentionally
// returns no slots/cover so VDO.Ninja's own auto-layout (speaker+thumbnails) takes over — see the
// mountRoomFrame/mountProgramFrame comments above for why that's the right way to get a dominant screen
// share without us compositing tiles ourselves.
function layoutParams(layout){ return layout==="screen-dominant" ? {} : {slots:"4",cover:"1"}; }
