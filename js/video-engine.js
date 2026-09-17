const VDO_ORIGIN = "https://vdo.ninja";
const IFRAME_ALLOW =
  "camera; microphone; display-capture; autoplay; fullscreen; picture-in-picture; web-share";

const DEFAULT_PARAMS = { api: "1" };
const HOST_CAMERA_HINT = "FaceTime";

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
  mountDirectorFrame(container,{roomId,label="Host"}) {
    const streamId=`${roomId}h`;
    container.dataset.empty="true";
    const launch=document.createElement("div");
    launch.className="camera-launch-card";
    launch.innerHTML=`
      <span class="camera-launch-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="13" height="14" rx="3"></rect><path d="m16 10 5-3v10l-5-3"></path></svg>
      </span>
      <span class="camera-launch-copy">
        <strong>Ready when you are</strong>
        <small>Camera and microphone stay off until you continue.</small>
      </span>
    `;
    const start=document.createElement("button");
    start.type="button";
    start.className="btn btn-primary";
    start.textContent="Enable camera & microphone";
    start.setAttribute("aria-label","Start Live Studio camera and microphone");
    start.addEventListener("click",()=>this.mountFrame(container,"host",{room:roomId,push:streamId,label,webcam:true,vdo:HOST_CAMERA_HINT,showlabels:"1",cover:"1"}),{once:true});
    launch.appendChild(start);
    container.replaceChildren(launch);
    container.removeAttribute("data-empty");
    return null;
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
  // videoDeviceId/audioDeviceId come from the guest's own check-in device pickers (already granted
  // permission for the local preview) — passing them through as videodevice/audiodevice plus autostart
  // lets VDO.Ninja publish immediately with those devices instead of showing its own native
  // device-selection screen (which is both off-brand and, on narrow viewports, wider than the iframe).
  mountGuestFrame(container,{roomId,guestName,backgroundMode,videoDeviceId,audioDeviceId}) { const suffix=Date.now().toString(36).slice(-4); const streamId=`${roomId}g${suffix}`.slice(0,24); return this.mountFrame(container,"guest",{room:roomId,push:streamId,label:guestName||"Guest",webcam:"1",showlabels:"1",cleanoutput:"1",autostart:"1",cover:"1",videodevice:videoDeviceId||undefined,audiodevice:audioDeviceId||undefined,effects:effectForBackground(backgroundMode)}); }
  mountListenerFrame(container,{roomId}) { return this.mountFrame(container,"listener",{room:roomId,scene:"0",showlabels:"1",cleanoutput:"1"}); }

  // Hidden viewer-only frame used purely to query the room's live guest list (id + label) for the Program Output compositor.
  mountDirectorControlFrame(container,{roomId}) { return this.mountFrame(container,"control",{room:roomId,director:roomId,cleanoutput:"1",transparent:"1"}); }

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
  // [{id,label}] array (tolerant of the VDO.Ninja response using id/streamID/UUID and label/name keys).
  requestGuestList(frameId="control",timeoutMs=2500) {
    return new Promise((resolve) => {
      const cib = `guestlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;
      let done = false;
      const finish = (list) => { if(done) return; done=true; clearTimeout(timer); off(); resolve(list); };
      const off = this.onMessage((message) => {
        if (message?.cib !== cib) return;
        const raw = message.guestList || message.list || message.guests || [];
        finish(raw.map((entry) => ({
          id: entry.id || entry.streamID || entry.UUID || entry.uuid || entry.streamId,
          label: entry.label || entry.name || entry.title || ""
        })).filter((entry) => entry.id));
      });
      const timer = setTimeout(() => finish([]), timeoutMs);
      if (!this.send(frameId, { action: "getGuestList", cib })) finish([]);
    });
  }

  onMessage(callback){this.listeners.add(callback);return()=>this.listeners.delete(callback);}
  handleMessage(event){if(event.origin!==this.baseUrl)return;this.listeners.forEach(callback=>callback(event.data));}
}

function effectForBackground(backgroundMode){if(backgroundMode===BackgroundMode.BLUR)return"3";return"0";}
// "grid" = today's always-on behavior (uniform cropped 4-slot grid). "screen-dominant" intentionally
// returns no slots/cover so VDO.Ninja's own auto-layout (speaker+thumbnails) takes over — see the
// mountRoomFrame/mountProgramFrame comments above for why that's the right way to get a dominant screen
// share without us compositing tiles ourselves.
function layoutParams(layout){ return layout==="screen-dominant" ? {} : {slots:"4",cover:"1"}; }
