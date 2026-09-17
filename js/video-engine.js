const VDO_ORIGIN = "https://vdo.ninja";
const IFRAME_ALLOW = "camera; microphone; display-capture; autoplay; fullscreen; picture-in-picture; web-share";
const DEFAULT_PARAMS = { api: "1" };
const HOST_CAMERA_HINT = "FaceTime";

export const BackgroundMode = Object.freeze({ NONE:"none", BLUR:"blur", NEWSROOM:"newsroom", LIBRARY:"library", STAGE:"stage" });
export function createDisposableRoomId(){const bytes=crypto.getRandomValues(new Uint8Array(18));return `tm${Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("")}`.slice(0,30);}
export function createRoomSecret(){const bytes=crypto.getRandomValues(new Uint8Array(24));return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");}
export function isValidRoomId(roomId){return typeof roomId==="string"&&/^[a-zA-Z0-9]{1,30}$/.test(roomId);}
export function getRoomIdFromUrl(search=window.location.search){const roomId=new URLSearchParams(search).get("room");return isValidRoomId(roomId)?roomId:null;}
export function getOrCreateRoomId(search=window.location.search){return getRoomIdFromUrl(search)||createDisposableRoomId();}
export function getGuestInviteUrl(roomId,brandTheme){const url=new URL("../studio/guest.html",window.location.href);url.searchParams.set("room",roomId);if(brandTheme)url.searchParams.set("brand",brandTheme);return url.toString();}
export function getListenerInviteUrl(roomId,brandTheme){const url=new URL("../studio/listener.html",window.location.href);url.searchParams.set("room",roomId);if(brandTheme)url.searchParams.set("brand",brandTheme);return url.toString();}

export class VideoEngine{
 constructor(options={}){this.baseUrl=options.baseUrl||VDO_ORIGIN;this.frames=new Map();this.listeners=new Set();window.addEventListener("message",event=>this.handleMessage(event));}
 mountDirectorFrame(container,{roomId,label="Host",password}){const streamId=`${roomId}h`;container.dataset.empty="true";const launch=document.createElement("div");launch.className="camera-launch-card";launch.innerHTML=`<span class="camera-launch-copy"><strong>Ready when you are</strong><small>Camera and microphone stay off until you continue.</small></span>`;const start=document.createElement("button");start.type="button";start.className="btn btn-primary";start.textContent="Enable camera & microphone";start.addEventListener("click",()=>this.mountFrame(container,"host",{room:roomId,password,push:streamId,label,webcam:true,vdo:HOST_CAMERA_HINT,showlabels:"1"}),{once:true});launch.appendChild(start);container.replaceChildren(launch);container.removeAttribute("data-empty");return null;}
 mountRoomFrame(container,{roomId,password}){return this.mountFrame(container,"room",{room:roomId,password,scene:"0",cleanoutput:"1",transparent:"1",showlabels:"1",muted:"1",mute:"1",slots:"4",cover:"1"});}
 mountGuestFrame(container,{roomId,password,guestName,backgroundMode,videoDeviceId,audioDeviceId}){const suffix=Date.now().toString(36).slice(-4);const streamId=`${roomId}g${suffix}`.slice(0,24);return this.mountFrame(container,"guest",{room:roomId,password,push:streamId,label:guestName||"Guest",webcam:"1",showlabels:"1",cleanoutput:"1",autostart:"1",videodevice:videoDeviceId||undefined,audiodevice:audioDeviceId||undefined,effects:effectForBackground(backgroundMode)});}
 mountListenerFrame(container,{roomId,password}){return this.mountFrame(container,"listener",{room:roomId,password,scene:"0",showlabels:"1",cleanoutput:"1"});}
 mountDirectorControlFrame(container,{roomId,password}){return this.mountFrame(container,"control",{room:roomId,password,director:roomId,cleanoutput:"1",transparent:"1"});}
 mountProgramFrame(container,{roomId,password},frameId){return this.mountFrame(container,frameId,{room:roomId,password,scene:"0",cleanoutput:"1",transparent:"1",showlabels:"1",controls:"0",slots:"4",cover:"1"});}
 mountFrame(container,frameId,params){const iframe=document.createElement("iframe");iframe.allow=IFRAME_ALLOW;iframe.allowFullscreen=true;iframe.referrerPolicy="no-referrer";iframe.src=this.buildUrl(params);iframe.title=`Toasty Studio ${frameId}`;container.replaceChildren(iframe);container.removeAttribute("data-empty");this.frames.set(frameId,iframe);return iframe;}
 buildUrl(params){const url=new URL("/",this.baseUrl);const merged={...DEFAULT_PARAMS,...params};Object.entries(merged).forEach(([key,value])=>{if(value===true)url.searchParams.set(key,"");else if(value!==undefined&&value!==null&&value!==false&&value!=="")url.searchParams.set(key,value);});return url.toString();}
 send(frameId,command){const iframe=this.frames.get(frameId);if(!iframe?.contentWindow)return false;iframe.contentWindow.postMessage(command,this.baseUrl);return true;}
 setMicrophone(enabled){return this.send("host",{mic:enabled});} setCamera(enabled){return this.send("host",{camera:enabled});} setScreenShare(enabled){return this.send("host",{screenshare:enabled});}
 setGuestMicrophone(enabled){return this.send("guest",{mic:enabled});} setGuestCamera(enabled){return this.send("guest",{camera:enabled});} setGuestScreenShare(enabled){return this.send("guest",{screenshare:enabled});}
 disconnectAll(){this.frames.forEach((_,frameId)=>{this.send(frameId,{hangup:true});this.send(frameId,{disconnect:true});});}
 requestDetailedState(frameId="host"){return this.send(frameId,{getDetailedState:true});}
 requestGuestList(frameId="control",timeoutMs=2500){return new Promise(resolve=>{const cib=`guestlist-${Date.now().toString(36)}-${Math.random().toString(36).slice(2,6)}`;let done=false;const finish=list=>{if(done)return;done=true;clearTimeout(timer);off();resolve(list);};const off=this.onMessage(message=>{if(message?.cib!==cib)return;const raw=message.guestList||message.list||message.guests||[];finish(raw.map(entry=>({id:entry.id||entry.streamID||entry.UUID||entry.uuid||entry.streamId,label:entry.label||entry.name||entry.title||""})).filter(entry=>entry.id));});const timer=setTimeout(()=>finish([]),timeoutMs);if(!this.send(frameId,{action:"getGuestList",cib}))finish([]);});}
 onMessage(callback){this.listeners.add(callback);return()=>this.listeners.delete(callback);} handleMessage(event){if(event.origin!==this.baseUrl)return;this.listeners.forEach(callback=>callback(event.data));}
}
function effectForBackground(backgroundMode){if(backgroundMode===BackgroundMode.BLUR)return"3";return"0";}
