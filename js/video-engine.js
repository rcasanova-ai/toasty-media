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
export function createGuestStreamId(roomId) {
  const salt = Math.random().toString(36).slice(2, 6).padEnd(4, "x");
  return `${roomId}g${Date.now().toString(36).slice(-4)}${salt}`.slice(0, 24);
}

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
  // ROOT CAUSE of "remote viewer iframe created but produces no visible video" (real two-device test,
  // this pass): this used to mount &view=<streamID> completely standalone (no &room, no &scene) — an
  // earlier comment here misread VDO.Ninja's own docs as saying that was the lighter, correct path. The
  // docs' actual example is `?room=roomname&scene&view=streamid1,streamid2` — &view is documented as
  // working "within rooms combined with &scene or &solo" (session.solo is dead code in VDO.Ninja's current
  // source, confirmed by reading it — never read anywhere after being set, so that half is moot); &view
  // alone is only "optional" when you are ALSO publishing into that same room, not a standalone mode on
  // its own. Traced why standalone failed: with no &room, session.roomid stays false, but session.scene
  // still defaults to 0 (not false) even with no &scene param, so &view alone routes into VDO's room/scene
  // auto-mixer code path (updateMixerRun) anyway — just without the room context that path's layout logic
  // depends on, so the WebRTC connection can succeed while the video element never gets sized/shown.
  // Fixed by sending exactly the documented combination: &room (real room context) + bare &scene (opts
  // into the mixer without requesting the full auto-mix or a director-assigned numbered scene — both of
  // which this codebase already found unreliable, see mountProgramFrame's comment) + &view=<streamID>
  // (filters the mixer to just this one participant). cleanoutput strips VDO's UI chrome; no &showlabels,
  // since Toasty renders its OWN name/title/company label instead of VDO's redundant one.
  // codec:"vp9" — VDO.Ninja's own docs (docs.vdo.ninja/platform-specific-issues/android, "Corrupted Video;
  // Green or Grey Pixels") document Android-side decode corruption as a known issue class and recommend
  // &codec=vp9 on the viewer side as the fix. Applied here (not just for Android) since it's the documented
  // remedy for exactly the "healthy connection metadata, no real picture" signature seen on a real Android
  // device viewing a Mac-published stream — not a blind param guess.
  mountParticipantView(container,{roomId,streamId},frameId="participant-view") { return this.mountFrame(container,frameId,{room:roomId,scene:true,view:streamId,cleanoutput:"1",transparent:"1",cover:"1",codec:"vp9"}); }
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
  //
  // micMuted: EVERY mount* call creates a brand-new iframe (mountFrame's container.replaceChildren wipes
  // the old one) — a fresh VDO.Ninja session with no memory of anything the old iframe was told over its
  // postMessage command channel. ROOT CAUSE of "muted phone unmutes itself on Flip Camera" (real-device
  // retest of 511a6cd): js/guest.js's flipCamera() remounts to change the camera but was never re-applying
  // this guest's own mute state to the new iframe, which then published live audio by default. Read from
  // VDO.Ninja's own source (lib.js): &muted (also &mute/&m) sets session.muted=true at URL-parse time,
  // BEFORE any track is acquired — every place lib.js (re)attaches an audio track sets
  // `track.enabled = !session.muted` from that same flag, confirmed at lib.js:45698 and toggleMute's own
  // unmute path. That makes this the one authoritative, race-free way to guarantee a freshly (re)created
  // publisher starts muted: no postMessage sent after the fact, which would have to race the new iframe's
  // own script loading before it could even be listening.
  //
  // isMobile: ROOT CAUSE of "front camera is extremely zoomed, basically one eye" (same retest, confirmed
  // by reading VDO.Ninja's own getUserMediaVideoParams in lib.js): with no explicit resolution/aspect
  // param, VDO's default capture constraint asks for width ideal:1920/height ideal:1080 — a fixed
  // LANDSCAPE target — with no portrait/orientation adjustment applied to the INITIAL getUserMedia call
  // (adjustConstraintsForMobileOrientation in lib.js only runs for a later manual-constraint-change path,
  // never for the autostart publish path this mount always takes). Asking a phone held in portrait for a
  // 1920x1080 landscape frame makes the camera HAL digitally crop/zoom the narrower portrait sensor readout
  // to fill it — baked into the actual captured frames, which is why the SAME crop reaches the Mac. &ar=
  // portrait (VDO's own documented shorthand for a 9:16 ideal aspectRatio constraint, applied at the exact
  // same initial-capture point per lib.js's grabVideo) is VDO's own supported fix for this, not a value we
  // invented. Desktop guests are untouched (isMobile only ever true from js/guest.js's own UA check) since
  // a landscape webcam has no portrait problem to correct.
  mountGuestFrame(container, options) {
    const { streamId, params } = buildGuestPublisherParams(options);
    this.mountFrame(container, "guest", params);
    return streamId;
  }
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

  mountFrame(container,frameId,params) {
    const iframe=document.createElement("iframe");
    iframe.allow=IFRAME_ALLOW;
    iframe.allowFullscreen=true;
    iframe.src=this.buildUrl(params);
    iframe.title=`Toasty Studio ${frameId}`;
    iframe.dataset.frameId=frameId;
    iframe.name = params.push ? `toasty-push-${params.push}` : params.view ? `toasty-view-${params.view}` : `toasty-${frameId}`;
    container.replaceChildren(iframe);
    container.removeAttribute("data-empty");
    this.frames.set(frameId,iframe);
    return iframe;
  }
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

  // Publisher completion — not "an iframe exists." Correlates getDetailedState on THIS page's own
  // push frame so guest.js can tell iframe-mounted / connecting / live / error apart. Same cib
  // pattern as requestPeerVideoState; returns the raw object VDO posted back (or null on timeout).
  requestPublisherDetailedState(frameId="guest", timeoutMs=2500) {
    return new Promise((resolve) => {
      const cib = `pubstate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
      let done = false;
      const finish = (value) => { if(done) return; done=true; clearTimeout(timer); off(); resolve(value); };
      const off = this.onMessage((message) => {
        if (message?.cib !== cib) return;
        finish(message.detailedState || message.getDetailedState || null);
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      if (!this.send(frameId, { getDetailedState: true, cib })) finish(null);
    });
  }

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

  // Asks the GUEST'S OWN push frame for its live device list — straight from ITS OWN enumerateDevices()
  // call inside vdo.ninja's origin, all kinds, unfiltered (VDO.Ninja's own {getDeviceList:true} handler
  // replies with the raw enumerateDevices() result — confirmed by reading main.js). Same cib-correlation
  // pattern as requestGuestList. Deliberately NOT resolved from Toasty's own device-picker.js enumeration:
  // deviceId is origin-salted (see mountDirectorFrame's own comment on why a deviceId read on toasty.media
  // never resolves inside vdo.ninja's iframe), so the only way to know what index changeGuestVideoDevice
  // below actually needs is to ask VDO directly, every time — not a cached/assumed value.
  requestGuestDeviceList(timeoutMs=2500) {
    return new Promise((resolve) => {
      const cib = `devicelist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
      let done = false;
      const finish = (list) => { if(done) return; done=true; clearTimeout(timer); off(); resolve(list); };
      const off = this.onMessage((message) => {
        if (message?.cib !== cib) return;
        finish(Array.isArray(message.deviceList) ? message.deviceList : []);
      });
      const timer = setTimeout(() => finish([]), timeoutMs);
      if (!this.send("guest", { getDeviceList: true, cib })) finish([]);
    });
  }

  // ROOT CAUSE of "flip disconnects Mac / phone preview freezes or blacks / front camera stops coming
  // back" (real-device retest of 3380991): flipCamera previously destroyed and recreated the ENTIRE guest
  // iframe (mountFrame's replaceChildren) just to change camera — a full WebRTC teardown+reconnect on
  // every flip, racing Toasty's own separate native-preview getUserMedia call for the SAME physical camera
  // hardware, which is exactly the contention most phones (one camera open at a time) can't reliably
  // survive. VDO.Ninja has its own, already-built, NON-destructive device switch — confirmed by reading
  // lib.js: cycleCameras() (the function behind VDO's own hidden mobile flip-camera button, cleanoutput
  // hides the button but not the mechanism) and changeVideoDevice (the same mechanism, exposed on the
  // iframe API — main.js's postMessage handler already wires `{changeVideoDevice:index}` straight to it).
  // Both just move VDO's own internal <select>'s selectedIndex and call grabVideo() again, which stops the
  // OLD video track and calls RTCRtpSender.replaceTrack() against the EXISTING peer connection for the NEW
  // one — no iframe destroy, no renegotiation, the remote side transitions smoothly instead of
  // disconnecting. grabVideo's video-device path never touches session.streamSrc's AUDIO track/sender at
  // all (that's grabAudio/changeAudioDevice's job, a separate function and a separate command) — so
  // switching video this way is structurally incapable of touching mute state, unlike the full-remount
  // approach this replaces, which needed &muted re-applied because it destroyed the whole session.
  // index is positional within VDO's OWN videoinput-kind devices, in the SAME order requestGuestDeviceList
  // returns them — confirmed from lib.js's gotDevices2, which builds its device <select> by filtering
  // enumerateDevices()'s result to kind==="videoinput" and appending in that same iteration order, with no
  // resorting. Computing this from a LIVE requestGuestDeviceList() call, never a cached or assumed index,
  // is what keeps this honest instead of guessing at array position.
  changeGuestVideoDevice(index) { return this.send("guest", { changeVideoDevice: index }); }

  // Lets a caller correlate an onMessage callback's event.source against a specific mounted frame — see
  // handleMessage below. Used by live-session.js's guest-view diagnostics to know whether a given VDO
  // postMessage actually came from the mounted remote-guest-view iframe specifically, not just "some" frame.
  getFrameWindow(frameId){return this.frames.get(frameId)?.contentWindow;}

  // DIAGNOSTIC ONLY — never used to gate a UI transition (see js/guest.js's own history: a previous pass
  // gated Join on a similar check and that was the wrong lesson; this is a different situation — reporting
  // the REAL state of an already-mounted remote view, not blocking anything on it). Asks a mounted
  // &view=<id> frame for ITS OWN detailed state and returns the specific peer entry, so a caller can tell
  // "iframe loaded" apart from "actually receiving a visible video track" — see
  // scripts/../this pass's report ("MEDIA STATE MODEL"). Reads videoVisible/videoMuted, confirmed against
  // VDO.Ninja's own source (lib.js's getDetailedState): for a remote peer, videoVisible specifically checks
  // session.rpcs[UUID].videoElement.checkVisibility() — a real DOM-visibility signal, not just connection
  // state — while videoTrack/localStream (used and found unreliable in an earlier pass) only exist on that
  // frame's OWN self entry, meaningless for a pure viewer with nothing of its own to publish.
  async requestPeerVideoState(frameId, peerStreamId, timeoutMs = 2500) {
    const state = await new Promise((resolve) => {
      const cib = `peerstate-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
      let done = false;
      const finish = (value) => { if(done) return; done=true; clearTimeout(timer); off(); resolve(value); };
      const off = this.onMessage((message) => {
        if (message?.cib !== cib) return;
        finish(message.detailedState || null);
      });
      const timer = setTimeout(() => finish(null), timeoutMs);
      if (!this.send(frameId, { getDetailedState: true, cib })) finish(null);
    });
    if (!state) return null;
    const entries = Object.values(state);
    return entries.find((entry) => entry?.streamID === peerStreamId) || null;
  }

  onMessage(callback){this.listeners.add(callback);return()=>this.listeners.delete(callback);}
  // event.source (the iframe's window) is now passed as a second argument — additive, existing callbacks
  // that only read the first (data) argument are unaffected.
  handleMessage(event){if(event.origin!==this.baseUrl)return;this.listeners.forEach(callback=>callback(event.data,event.source));}
}

// ROOT CAUSE of "phone self-preview shows front camera, Mac receives back camera" (real-device retest
// against commit 4d7e33c, diagnosed by reading VDO.Ninja's own source — lib.js's gotDevices, the function
// that actually resolves &videodevice= against the iframe's own enumerateDevices() list): VDO compares
// using its OWN normalizeDeviceLabel, `String(deviceName).replace(/[\W]+/g, "_").toLowerCase()` — EVERY
// non-word character collapsed to one underscore, AND lowercased. This function used to only replace
// whitespace and never lowercased, so any label with punctuation (a comma, parens, a period — which is
// most real camera labels, e.g. Android's own "camera2 1, facing front") or mixed case (e.g. Mac's
// "FaceTime HD Camera") normalized to a DIFFERENT string than VDO computes from the identical raw label,
// so startsWith/includes always failed silently. On a Mac with exactly one real (non-Camo) camera, the
// failed match didn't matter — whatever's left after Camo-filtering is still the only real device. On a
// phone with two real cameras, a failed match falls through to VDO's raw, unsorted enumerateDevices()
// order (see gotDevices' tmp/tmp2/tmp3 fallthrough) — which is what silently published the back camera
// while Toasty's own native preview (a separate getUserMedia call, unaffected by this) correctly showed
// front. Mirroring VDO's exact algorithm here (not just approximating it) is what makes the two origins'
// label strings byte-identical, restoring the "NameStartsWith"/"NameIncludes" match VDO's own docs
// describe. Returns undefined (not an empty string) for a blank/generic label so callers correctly fall
// back to VDO's own default-device auto-select instead of sending it a param that can't match anything.
function normalizeVdoDeviceLabel(label) {
  const trimmed = String(label || "").trim();
  return trimmed ? trimmed.replace(/[\W]+/g, "_").toLowerCase() : undefined;
}

function normalizeGuestListEntries(raw) {
  if (!raw) return [];
  const entries = Array.isArray(raw) ? raw : Object.values(raw);
  return entries.map((entry) => ({
    id: entry?.id || entry?.streamID || entry?.UUID || entry?.uuid || entry?.streamId,
    label: entry?.label || entry?.name || entry?.title || ""
  })).filter((entry) => entry.id);
}

// URL/query surface for one guest publisher. Exported so tests can prove two guests in the same
// room differ only by push id — no shared password/hash/scene/director/iframe name.
export function buildGuestPublisherParams({roomId,guestName,backgroundMode,videoDeviceLabel,audioDeviceLabel,streamId,micMuted,isMobile}={}) {
  const id=streamId||createGuestStreamId(roomId);
  return {
    streamId: id,
    params: {
      room:roomId,
      push:id,
      label:guestName||"Guest",
      webcam:"1",
      showlabels:"1",
      cleanoutput:"1",
      autostart:"1",
      cover:"1",
      // Bare &view (no stream IDs): VDO.Ninja's documented publish-only mode. Without it, a room
      // &push guest auto-loads every other participant into THIS iframe — which is what turned the
      // visible self-PiP into a miniature room composite after the publisher was moved on-screen.
      // Local self-preview is not a remote stream, so it still paints; ParticipantStage keeps
      // rendering Host/other guests. Do NOT pass view=ownId (that pulls a remote copy of self).
      view:true,
      videodevice:normalizeVdoDeviceLabel(videoDeviceLabel),
      audiodevice:normalizeVdoDeviceLabel(audioDeviceLabel),
      effects:effectForBackground(backgroundMode),
      muted:micMuted?true:undefined,
      ar:isMobile?"portrait":undefined
    }
  };
}

function effectForBackground(backgroundMode){if(backgroundMode===BackgroundMode.BLUR)return"3";return"0";}
// "grid" = today's always-on behavior (uniform cropped 4-slot grid). "screen-dominant" intentionally
// returns no slots/cover so VDO.Ninja's own auto-layout (speaker+thumbnails) takes over — see the
// mountRoomFrame/mountProgramFrame comments above for why that's the right way to get a dominant screen
// share without us compositing tiles ourselves.
function layoutParams(layout){ return layout==="screen-dominant" ? {} : {slots:"4",cover:"1"}; }
