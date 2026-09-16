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

  mountDirectorFrame(container,{roomId,label="Host"}) {
    const streamId=`${roomId}h`;
    container.dataset.empty="true";
    const start=document.createElement("button");
    start.type="button";
    start.className="btn btn-primary";
    start.textContent="Start camera & microphone";
    start.setAttribute("aria-label","Start Live Studio camera and microphone");
    start.addEventListener("click",()=>this.mountFrame(container,"host",{room:roomId,push:streamId,label,webcam:true,vdo:HOST_CAMERA_HINT,showlabels:"1"}),{once:true});
    container.replaceChildren(start);
    return null;
  }

  // slots=4 reserves 4 even grid cells regardless of how many are actually filled, and cover=1 crops
  // each video to fill its cell instead of leaving letterbox bars — together these turn VDO.Ninja's
  // default speaker+thumbnails auto-layout into a uniform, evenly-sized grid (both documented VDO.Ninja
  // mixer parameters). Used everywhere scene=0 is mounted, so Director's own guest preview matches what
  // Program Output actually shows.
  mountRoomFrame(container,{roomId}) { return this.mountFrame(container,"room",{room:roomId,scene:"0",cleanoutput:"1",transparent:"1",showlabels:"1",muted:"1",mute:"1",slots:"4",cover:"1"}); }
  // videoDeviceId/audioDeviceId come from the guest's own check-in device pickers (already granted
  // permission for the local preview) — passing them through as videodevice/audiodevice plus autostart
  // lets VDO.Ninja publish immediately with those devices instead of showing its own native
  // device-selection screen (which is both off-brand and, on narrow viewports, wider than the iframe).
  mountGuestFrame(container,{roomId,guestName,backgroundMode,videoDeviceId,audioDeviceId}) { const suffix=Date.now().toString(36).slice(-4); const streamId=`${roomId}g${suffix}`.slice(0,24); return this.mountFrame(container,"guest",{room:roomId,push:streamId,label:guestName||"Guest",webcam:"1",showlabels:"1",cleanoutput:"1",autostart:"1",videodevice:videoDeviceId||undefined,audiodevice:audioDeviceId||undefined,effects:effectForBackground(backgroundMode)}); }
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
  mountProgramFrame(container,{roomId},frameId) { return this.mountFrame(container,frameId,{room:roomId,scene:"0",cleanoutput:"1",transparent:"1",showlabels:"1",controls:"0",slots:"4",cover:"1"}); }

  mountFrame(container,frameId,params) { const iframe=document.createElement("iframe"); iframe.allow=IFRAME_ALLOW; iframe.allowFullscreen=true; iframe.src=this.buildUrl(params); iframe.title=`Toasty Studio ${frameId}`; container.replaceChildren(iframe); container.removeAttribute("data-empty"); this.frames.set(frameId,iframe); return iframe; }
  buildUrl(params) { const url=new URL("/",this.baseUrl); const merged={...DEFAULT_PARAMS,...params}; Object.entries(merged).forEach(([key,value])=>{ if(value===true)url.searchParams.set(key,""); else if(value!==undefined&&value!==null&&value!==false&&value!=="")url.searchParams.set(key,value); }); return url.toString(); }
  send(frameId,command) { const iframe=this.frames.get(frameId); if(!iframe?.contentWindow)return false; iframe.contentWindow.postMessage(command,this.baseUrl); return true; }
  setMicrophone(enabled){return this.send("host",{mic:enabled});}
  setCamera(enabled){return this.send("host",{camera:enabled});}
  setScreenShare(enabled){return this.send("host",{screenshare:enabled});}
  setGuestMicrophone(enabled){return this.send("guest",{mic:enabled});}
  setGuestCamera(enabled){return this.send("guest",{camera:enabled});}
  setGuestScreenShare(enabled){return this.send("guest",{screenshare:enabled});}
  disconnectAll(){this.frames.forEach((_,frameId)=>{this.send(frameId,{hangup:true});this.send(frameId,{disconnect:true});});}
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
