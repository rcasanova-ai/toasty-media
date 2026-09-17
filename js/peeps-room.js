import { BackgroundMode, VideoEngine } from "./video-engine.js";

const params=new URLSearchParams(location.search);
const roomId=params.get("room");
const roomSecret=params.get("key");
const inviteToken=params.get("invite");
const jamId=params.get("jam")||"JAM-2048";
const capture=params.get("capture")||"private";
const brand=params.get("brand")||"peeps";
const participant=params.get("name")||"Participant";
const engine=new VideoEngine();
const $=id=>document.getElementById(id);
let joined=false, startedAt=0, tick=null, micOn=true, cameraOn=true, screenOn=false;

function authorized(){return /^[A-Za-z0-9]{16,30}$/.test(roomId||"")&&/^[A-Fa-f0-9]{32,96}$/.test(roomSecret||"")&&/^[A-Za-z0-9_-]{24,}$/.test(inviteToken||"");}
function emit(type,detail={}){const event={type,jamId,at:new Date().toISOString(),participant,detail};window.dispatchEvent(new CustomEvent("peeps:jam-event",{detail:event}));console.info("[Peeps Jam]",event);}
function fmt(ms){let s=Math.floor(ms/1000);return [Math.floor(s/3600),Math.floor((s%3600)/60),s%60].map(v=>String(v).padStart(2,"0")).join(":");}
function setCaptureCopy(){const map={private:["Private Jam","No recording or transcription. Only attendance/time evidence is retained."],transcript:["Transcript enabled","Audio may be processed for the consented transcript. Recording is not retained."],record:["Recording + transcript","This Jam may be recorded and transcribed under the agreed capture policy."]};const item=map[capture]||map.private;$('captureState').textContent=item[0];$('captureCopy').textContent=item[1];$('consentWrap').hidden=capture==='private';}
function updateTimer(){if(joined)$('timer').textContent=fmt(Date.now()-startedAt);}

async function join(){if(!authorized())return; if(capture!=='private'&&!$('captureConsent').checked){$('note').textContent='Consent is required before capture-enabled Jams can start.';return;} joined=true;startedAt=Date.now();engine.mountGuestFrame($('vdoFrame'),{roomId,password:roomSecret,guestName:participant,backgroundMode:$('blur').classList.contains('selected')?BackgroundMode.BLUR:BackgroundMode.NONE});$('roomState').textContent='Jam live';$('join').disabled=true;$('leave').disabled=false;$('vdoFrame').hidden=false;$('placeholder').hidden=true;$('note').textContent='Protected room joined · verified presence evidence is accumulating.';tick=setInterval(updateTimer,1000);emit('participant.joined',{capture,brand});emit('jam.started',{capture});}
function leave(){if(!joined)return;joined=false;clearInterval(tick);engine.disconnectAll();$('roomState').textContent='Jam ended';$('leave').disabled=true;$('note').innerHTML='Jam ended · 30-minute attendance/time dispute window started. <a class="link" href="./jam-receipt.html">View Breadcrumb →</a>';emit('participant.left',{verifiedOverlapSeconds:Math.floor((Date.now()-startedAt)/1000)});emit('dispute.window.opened',{minutes:30});}

function init(){setCaptureCopy();$('jamLabel').textContent=jamId;$('brandLabel').textContent=brand==='peeps'?'Peeps protected room':`${brand} protected room`;if(!authorized()){$('roomState').textContent='Invite invalid';$('join').disabled=true;$('note').textContent='This protected Jam invite is invalid or expired. Open the participant-specific link from Peeps.';return;}$('join').onclick=join;$('leave').onclick=leave;$('mic').onclick=()=>{micOn=!micOn;engine.setGuestMicrophone(micOn);$('mic').textContent=micOn?'Mic on':'Mic off';};$('camera').onclick=()=>{cameraOn=!cameraOn;engine.setGuestCamera(cameraOn);$('camera').textContent=cameraOn?'Camera on':'Camera off';};$('screen').onclick=()=>{screenOn=!screenOn;engine.setGuestScreenShare(screenOn);$('screen').textContent=screenOn?'Stop sharing':'Share screen';};$('blur').onclick=()=>{$('blur').classList.toggle('selected');};emit('jam.room.opened',{capture,brand});window.addEventListener('beforeunload',()=>{if(joined)emit('participant.left',{reason:'page-close',verifiedOverlapSeconds:Math.floor((Date.now()-startedAt)/1000)});});}
init();
