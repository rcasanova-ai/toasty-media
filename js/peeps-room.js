import { BackgroundMode, VideoEngine } from "./video-engine.js";
import { studioApiEndpoint } from "./studio-api.js";

const params=new URLSearchParams(location.search);
const jamId=params.get("jam");
const invite=params.get("invite");
// Peeps pages are served from toasty.media, but the Jam API lives at render.toasty.media (see
// scripts/render-production-server.mjs's APP_BASE_URL vs js/studio-api.js's PRODUCTION_API_ENDPOINT) —
// location.origin would silently 404 every call in production. studioApiEndpoint() is the one place
// that origin split is already handled correctly (and it also covers local dev, where the static site
// and API run on different ports).
const api=params.get("api")||studioApiEndpoint();
const engine=new VideoEngine();
const $=id=>document.getElementById(id);

// Device choices (camera/mic labels, mute/off state) made during the Jam Lobby preview
// (peeps/jam-invite.html, js/peeps-jam-invite-page.js) — handed off via sessionStorage, same origin,
// one navigation, read once here and never re-used across a different Jam id.
function readDevicePrefs(){try{const raw=sessionStorage.getItem(`toasty:jam:${jamId}:devicePrefs`);return raw?JSON.parse(raw):null;}catch{return null;}}
const devicePrefs=jamId?readDevicePrefs():null;

let access=null,joined=false,startedAt=0,tick=null,micOn=!(devicePrefs?.micMuted),cameraOn=!(devicePrefs?.cameraOff),screenOn=false;

function fmt(ms){let s=Math.floor(ms/1000);return [Math.floor(s/3600),Math.floor((s%3600)/60),s%60].map(v=>String(v).padStart(2,"0")).join(":");}
async function post(path,payload){const r=await fetch(`${api}${path}`,{method:"POST",headers:{"content-type":"application/json","X-Toasty-CSRF":"1"},credentials:"include",body:JSON.stringify(payload)});let data={};try{data=await r.json();}catch{}if(!r.ok)throw new Error(data.error||`HTTP ${r.status}`);return data;}
async function evidence(type,detail={}){try{await post(`/api/jams/${encodeURIComponent(jamId)}/events`,{invite,type,detail});}catch(e){console.warn("[Peeps Jam] evidence event failed",e);}}
function renderPolicy(){const map={private:["Private Jam","No recording or transcription. Only attendance/time evidence is retained."],transcript:["Transcript enabled","Audio may be processed for the consented transcript. Recording is not retained."],record:["Recording + transcript","This Jam may be recorded and transcribed under the accepted policy."]};const item=map[access.capture]||map.private;$("captureState").textContent=item[0];$("captureCopy").textContent=item[1];$("consentWrap").hidden=access.capture==="private";$("brandLabel").textContent=access.brand&&access.brand!=="peeps"?`${access.brand} protected room`:"Peeps protected room";}
async function join(){if(!access)return;if(access.capture!=="private"&&!$("captureConsent").checked){$("note").textContent="Consent is required before this capture-enabled Jam can start.";return;}if(access.capture!=="private")await evidence("capture.consent",{capture:access.capture});joined=true;startedAt=Date.now();engine.mountGuestFrame($("vdoFrame"),{roomId:access.media.roomId,password:access.media.roomSecret,guestName:access.participant?.name||"Participant",backgroundMode:$("blur").classList.contains("selected")?BackgroundMode.BLUR:BackgroundMode.NONE,videoDeviceLabel:devicePrefs?.cameraLabel,audioDeviceLabel:devicePrefs?.microphoneLabel,micMuted:Boolean(devicePrefs?.micMuted)});if(!cameraOn)engine.setGuestCamera(false);$("roomState").textContent="Jam live";$("join").disabled=true;$("leave").disabled=false;$("vdoFrame").hidden=false;$("placeholder").hidden=true;$("note").textContent="Protected room joined. Verified presence evidence is accumulating.";tick=setInterval(()=>$("timer").textContent=fmt(Date.now()-startedAt),1000);await evidence("participant.joined",{capture:access.capture});await evidence("jam.started",{capture:access.capture});}
async function leave(){if(!joined)return;joined=false;clearInterval(tick);engine.disconnectAll();const seconds=Math.floor((Date.now()-startedAt)/1000);$("roomState").textContent="Jam ended";$("leave").disabled=true;$("note").textContent="Jam ended. The attendance/time dispute window can now begin.";await evidence("participant.left",{verifiedOverlapSeconds:seconds});await evidence("jam.ended",{verifiedOverlapSeconds:seconds});await evidence("dispute.window.opened",{minutes:30});}
async function init(){if(!jamId||!invite){$("roomState").textContent="Invite required";$("note").textContent="Open the participant-specific Peeps invitation. Room IDs and media passwords are never accepted from the public URL.";return;}try{access=await post(`/api/jams/${encodeURIComponent(jamId)}/access`,{invite});$("jamLabel").textContent=jamId;renderPolicy();$("join").disabled=false;$("note").textContent="Invite verified. Media credentials were issued only after authorization and are not present in this page URL.";}catch(e){$("roomState").textContent="Jam backend unavailable";$("join").disabled=true;$("note").textContent="This Jam cannot open until the protected Jam access backend is available.";return;}$("mic").textContent=micOn?"Mic on":"Mic off";$("camera").textContent=cameraOn?"Camera on":"Camera off";$("join").onclick=join;$("leave").onclick=leave;$("mic").onclick=()=>{micOn=!micOn;engine.setGuestMicrophone(micOn);$("mic").textContent=micOn?"Mic on":"Mic off";};$("camera").onclick=()=>{cameraOn=!cameraOn;engine.setGuestCamera(cameraOn);$("camera").textContent=cameraOn?"Camera on":"Camera off";};$("screen").onclick=()=>{screenOn=!screenOn;engine.setGuestScreenShare(screenOn);$("screen").textContent=screenOn?"Stop sharing":"Share screen";};$("blur").onclick=()=>$("blur").classList.toggle("selected");}
init();
