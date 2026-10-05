import { StudioBroadcastClient } from "./broadcast-client.js";
import { ProgramFeed } from "./program-feed.js";
import { ProgramOrchestrator } from "./program-orchestrator.js";
import { MasterProgramRecorder, nextRecordingId } from "./program-recording.js";
import { GoLivePanel } from "./go-live-panel.js";
import { studioApiEndpoint } from "./studio-api.js";
import { createDisposableRoomId, getGuestInviteUrl } from "./video-engine.js";
const $=s=>document.querySelector(s); let screen=null,cam=null,mic=null,rec=null,chunks=[],started=0,marks=[],lastRecording=null,currentScene="game",programCanvas=null,programCtx=null,programRaf=0;
async function auth(){try{const r=await fetch(studioApiEndpoint()+"/auth/session",{credentials:"include"});const j=await r.json();if(!j.authenticated) location.href="./sessions.html";}catch{location.href="./sessions.html"}}
auth();
$("[data-mode='voiceover']").onclick=()=>$("#voiceoverFile").click();
document.querySelectorAll("[data-mode]").forEach(b=>b.onclick=()=>{document.querySelectorAll("[data-mode]").forEach(x=>x.classList.remove("active"));b.classList.add("active");if(b.dataset.mode==="voiceover")$("#voiceoverFile").click()});
$("#captureBtn").onclick=async()=>{
  if(screen){
    screen.getTracks().forEach(t=>t.stop());
    screen=null;syncProgramAudio();
    $("#screenPreview").srcObject=null;
    $("#stageEmpty").hidden=false;
    $("#captureBtn").textContent="Capture game / screen";
    setStatus("Capture ended.");
    return;
  }
  if(!navigator.mediaDevices?.getDisplayMedia){
    setStatus("Screen capture is not supported in this browser. Open Creator in desktop Chrome or Edge.");
    return;
  }
  try{
    screen=await navigator.mediaDevices.getDisplayMedia({
      video:{frameRate:{ideal:30,max:60}},
      audio:true,
      systemAudio:"include",
      surfaceSwitching:"include"
    });
    const preview=$("#screenPreview");
    preview.srcObject=screen;
    await preview.play().catch(()=>{});
    $("#stageEmpty").hidden=true;
    $("#captureBtn").textContent="Stop capture";
    const hasSystemAudio=screen.getAudioTracks().length>0;
    setStatus(hasSystemAudio?"Game / screen captured with system audio.":"Game / screen captured. No system audio track was shared.");syncProgramAudio();
    screen.getVideoTracks()[0]?.addEventListener("ended",()=>{
      screen=null;syncProgramAudio();
      preview.srcObject=null;
      $("#stageEmpty").hidden=false;
      $("#captureBtn").textContent="Capture game / screen";
      setStatus("Capture ended.");
    },{once:true});
  }catch(e){
    screen=null;syncProgramAudio();
    $("#screenPreview").srcObject=null;
    const denied=e?.name==="NotAllowedError";
    setStatus(denied?"Screen capture was cancelled or blocked.":"Could not capture the screen: "+(e?.message||"unknown error"));
  }
};
$("#cameraBtn").onclick=async()=>{
  if(cam){
    cam.getTracks().forEach(t=>t.stop());
    cam=null;
    $("#cameraPreview").srcObject=null;
    $("#cameraBtn").classList.remove("active");
    if(currentScene==="game-camera")setStatus("Camera off. Game capture remains active.");
    return;
  }
  try{
    cam=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
    const preview=$("#cameraPreview");
    preview.srcObject=cam;
    await preview.play().catch(()=>{});
    $("#cameraBtn").classList.add("active");
    if(currentScene==="game")setScene("game-camera");
    setStatus("Camera ready.");
  }catch(e){
    setStatus("Could not start camera: "+(e?.message||"permission denied"));
  }
};
$("#micBtn").onclick=async()=>{
  if(mic){
    mic.getTracks().forEach(t=>t.stop());
    mic=null;
    $("#micBtn").classList.remove("active");
    setStatus("Mic off.");syncProgramAudio();
    return;
  }
  try{
    mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:false},video:false});
    $("#micBtn").classList.add("active");
    setStatus("Mic ready.");syncProgramAudio();
  }catch(e){
    setStatus("Could not start mic: "+(e?.message||"permission denied"));
  }
};
function setScene(scene){
  currentScene=scene;
  document.querySelectorAll("[data-scene]").forEach(x=>x.classList.toggle("active",x.dataset.scene===scene));
  $("#stage").className="stage "+(scene==="brb"?"brB":scene);
}
document.querySelectorAll("[data-scene]").forEach(b=>b.onclick=()=>setScene(b.dataset.scene));
$("#voiceoverFile").onchange=e=>{const f=e.target.files[0];if(!f)return;const v=$("#voiceoverPreview");v.src=URL.createObjectURL(f);v.hidden=false;setStatus("Voiceover video loaded. Turn on Mic, then Record.")};
function ensureProgramCanvas(){
  if(programCanvas)return programCanvas;
  programCanvas=document.createElement("canvas");
  programCanvas.width=1280;
  programCanvas.height=720;
  programCanvas.hidden=true;
  document.body.appendChild(programCanvas);
  programCtx=programCanvas.getContext("2d");
  return programCanvas;
}
function drawContain(video,x,y,w,h){
  if(!video||video.readyState<2)return false;
  const vw=video.videoWidth||w,vh=video.videoHeight||h;
  const scale=Math.min(w/vw,h/vh);
  const dw=vw*scale,dh=vh*scale;
  programCtx.drawImage(video,x+(w-dw)/2,y+(h-dh)/2,dw,dh);
  return true;
}
function drawCover(video,x,y,w,h){
  if(!video||video.readyState<2)return false;
  const vw=video.videoWidth||w,vh=video.videoHeight||h;
  const scale=Math.max(w/vw,h/vh);
  const sw=w/scale,sh=h/scale,sx=(vw-sw)/2,sy=(vh-sh)/2;
  programCtx.drawImage(video,sx,sy,sw,sh,x,y,w,h);
  return true;
}
function renderProgramFrame(){
  ensureProgramCanvas();
  const w=programCanvas.width,h=programCanvas.height;
  programCtx.fillStyle="#050506";
  programCtx.fillRect(0,0,w,h);
  const screenVideo=$("#voiceoverPreview").src&&!screen?$("#voiceoverPreview"):$("#screenPreview");
  if(currentScene==="brb"){
    programCtx.fillStyle="#f7f3ff";
    programCtx.font="900 54px Inter, system-ui, sans-serif";
    programCtx.textAlign="center";
    programCtx.fillText("BE RIGHT BACK",w/2,h/2);
  }else if(currentScene==="camera"){
    drawCover($("#cameraPreview"),0,0,w,h);
  }else{
    drawContain(screenVideo,0,0,w,h);
    if(currentScene==="game-camera"&&cam){
      const cw=Math.round(w*.24),ch=Math.round(h*.28),pad=24;
      programCtx.save();
      programCtx.beginPath();
      programCtx.roundRect(w-cw-pad,h-ch-pad,cw,ch,18);
      programCtx.clip();
      drawCover($("#cameraPreview"),w-cw-pad,h-ch-pad,cw,ch);
      programCtx.restore();
      programCtx.strokeStyle="#fff";
      programCtx.lineWidth=4;
      programCtx.strokeRect(w-cw-pad,h-ch-pad,cw,ch);
    }
  }
  programRaf=requestAnimationFrame(renderProgramFrame);
}
function getProgramVideoStream(){
  ensureProgramCanvas();
  if(!programRaf)renderProgramFrame();
  return programCanvas.captureStream(30);
}
// ---- ONE Program, shared with Studio's core (program-feed / program-orchestrator / go-live-panel) ----
// Program here = the canvas picture + ONE audio mix (screen/game audio once, mic once). Record and Go Live
// are two consumers of that same feed — going live while recording (or the reverse) never builds a second one.
let programAudio=null,voiceoverCapture=null,voiceoverCaptureSrc="";
// captureStream() mints a NEW stream (new tracks) on every call — cache one per loaded file so the voiceover
// video's audio joins the mix exactly once.
function voiceoverStream(){
  const v=$("#voiceoverPreview");
  if(!v.src)return null;
  if(voiceoverCaptureSrc!==v.src){voiceoverCapture=v.captureStream?.()||null;voiceoverCaptureSrc=v.src}
  return voiceoverCapture;
}
function syncProgramAudio(){
  if(!programAudio)return;
  const want=new Set();
  for(const src of [screen||voiceoverStream(),mic]){
    for(const t of src?.getAudioTracks?.()||[]){
      want.add(t.id);
      if(!programAudio.nodes.has(t.id)&&t.readyState==="live"){
        try{const node=programAudio.ctx.createMediaStreamSource(new MediaStream([t]));node.connect(programAudio.dest);programAudio.nodes.set(t.id,node)}catch{}
      }
    }
  }
  for(const [id,node] of programAudio.nodes)if(!want.has(id)){try{node.disconnect()}catch{}programAudio.nodes.delete(id)}
}
async function acquireProgram(){
  if(!screen&&!$("#voiceoverPreview").src&&!cam)throw new Error("Capture a game/screen, load a video, or turn on the camera first.");
  if(!mic)await $("#micBtn").onclick();
  const videoStream=getProgramVideoStream();
  const ctx=new AudioContext();
  await ctx.resume().catch(()=>{});
  const dest=ctx.createMediaStreamDestination();
  programAudio={ctx,dest,nodes:new Map()};
  syncProgramAudio();
  const stream=new MediaStream([...videoStream.getVideoTracks(),...dest.stream.getAudioTracks()]);
  return {stream,dispose(){videoStream.getTracks().forEach(t=>t.stop());programAudio?.ctx.close().catch(()=>{});programAudio=null}};
}
const programFeed=new ProgramFeed({acquire:acquireProgram,label:"Creator Program"});
const broadcast=new StudioBroadcastClient();
let masterRecorder=null;
const studio=new ProgramOrchestrator({
  feed:programFeed,
  broadcaster:broadcast,
  recorder:{
    async start({stream}){
      chunks=[];marks=[];started=Date.now();
      masterRecorder=new MasterProgramRecorder({status:setStatus});
      const info=await masterRecorder.start({recordingId:"creator-"+nextRecordingId(),captureStream:stream});
      return {...info,startedAt:info.startedAt||Date.now()};
    },
    async stop(){
      const result=await masterRecorder.stop();
      masterRecorder=null;
      onRecordingStopped(result);
      return result;
    }
  }
});
function onRecordingStopped(result){
  const objectUrl=URL.createObjectURL(result.blob);
  lastRecording={blob:result.blob,recordingId:result.recordingId,objectUrl,mp4:null,mp4State:"preparing",durationSeconds:Math.max(1,Math.round((result.stoppedAt-result.startedAt)/1000))};
  $("#recordingPreview").src=objectUrl;
  $("#recordingResult").hidden=false;
  setStatus("Recording ready.");
  void finalizeMp4();
  renderRecordingResult();
}
async function finalizeMp4(){
  const rec=lastRecording;if(!rec)return;
  rec.mp4State="preparing";renderRecordingResult();
  try{
    const form=new FormData();
    form.append("manifest",JSON.stringify({kind:"master-program",recordingId:rec.recordingId,durationSeconds:rec.durationSeconds,title:"Toasty Creator"}));
    form.append("source",rec.blob,rec.recordingId+".webm");
    const r=await fetch(studioApiEndpoint()+"/api/recordings/finalize",{method:"POST",credentials:"include",headers:{"X-Toasty-CSRF":"1"},body:form});
    if(!r.ok){let e={};try{e=await r.json()}catch{}throw new Error(e.error||"Could not create MP4.");}
    rec.mp4=await r.blob();rec.mp4State="ready";
  }catch(e){rec.mp4State="failed";rec.mp4Error=e.message}
  if(lastRecording===rec)renderRecordingResult();
}
// Truthful recording actions: "Download MP4" only ever downloads an MP4. Until it exists the button says
// "Preparing MP4…"; on failure there is "Retry MP4". The source WebM lives under Advanced.
function renderRecordingResult(){
  const rec=lastRecording;if(!rec)return;
  const mp4=$("#downloadMp4Btn"),retry=$("#retryMp4Btn"),s=$("#recordingResultStatus");
  mp4.disabled=rec.mp4State!=="ready";
  mp4.textContent=rec.mp4State==="preparing"?"Preparing MP4…":"Download MP4";
  mp4.hidden=rec.mp4State==="failed";
  retry.hidden=rec.mp4State!=="failed";
  s.textContent=rec.mp4State==="ready"?"MP4 ready.":rec.mp4State==="preparing"?"Recording saved. Preparing MP4… you can already play it.":"MP4 could not be prepared ("+(rec.mp4Error||"error")+"). Retry MP4 — your recording is safe under Advanced → Download source WebM.";
}
$("#recordBtn").onclick=async()=>{
  const btn=$("#recordBtn");
  btn.disabled=true;
  try{
    if(studio.recording.active)await studio.stopRecording();
    else{setStatus("Recording the Program…");await studio.startRecording();}
  }catch(e){setStatus(e?.message||"Could not record.")}
  finally{btn.disabled=false}
};
$("#markBtn").onclick=()=>{const sec=((Date.now()-started)/1000).toFixed(1);marks.push(sec);$("#clips").replaceChildren(...marks.map((m,i)=>{const row=document.createElement("div");row.textContent="Clip "+(i+1)+" · "+m+"s";return row;}));};
$("#voiceoverPreview").onplay=()=>setStatus("Voiceover playback running.");
const goLive=new GoLivePanel({client:broadcast,studio});
$("#liveBtn").onclick=async()=>{
  if(studio.mode==="live"){if(confirm("End the live broadcast? Toasty will finish the automatic recording."))await studio.endLive();return}
  goLive.open();
};
const MODE_LABEL={backstage:"BACKSTAGE",record:"● RECORDING",live:"● LIVE"};
function renderMode(snap){
  const {mode,recording,destinations}=snap;
  const chip=$("#modeChip");chip.dataset.mode=mode;chip.textContent=MODE_LABEL[mode];
  const dests=$("#modeDestinations");
  dests.replaceChildren(...destinations.filter(d=>d.state!=="stopped"&&d.state!=="idle").map(d=>{const c=document.createElement("span");c.dataset.state=d.state;const name={x:"X",youtube:"YouTube",tiktok:"TikTok",instagram:"Instagram"}[d.destination]||d.destination;c.textContent=d.state==="live"?name+" ● LIVE":d.state==="error"?name+" ERROR":name+" connecting…";if(d.error)c.title=d.error;return c}));
  const rec=$("#modeRec");rec.hidden=!(recording.active&&mode==="live");rec.textContent=recording.origin==="live-auto"?"● REC · automatic":"● REC";
  const recBtn=$("#recordBtn");recBtn.classList.toggle("on",recording.active);recBtn.textContent=recording.active?"Stop":"Record";
  const live=$("#liveBtn");live.classList.toggle("on",mode==="live");live.textContent=mode==="live"?"End Live":snap.busy==="going-live"?"Connecting…":"Go Live";
  $("#markBtn").disabled=!recording.active;
  if(snap.notice||snap.recordingError)setStatus(snap.recordingError||snap.notice);
}
studio.on(renderMode);renderMode(studio.snapshot());
addEventListener("beforeunload",()=>{broadcast.stop()});
function setStatus(s){$("#status").textContent=s}

async function createCreatorAgentKey(){const s=$("#agentKeyStatus");try{const r=await fetch(studioApiEndpoint()+"/api/creator/tokens",{method:"POST",credentials:"include",headers:{"X-Toasty-CSRF":"1"}});const d=await r.json();if(!r.ok)throw new Error(d.error||"Could not create API key.");s.textContent="API key (shown once): "+d.token;}catch(e){s.textContent=e.message;}}
$("#agentKeyBtn").onclick=createCreatorAgentKey;

const creatorRoomId=createDisposableRoomId();
$("#inviteFriendBtn").onclick=async()=>{
  const url=getGuestInviteUrl(creatorRoomId,"toasty");
  const s=$("#inviteFriendStatus");
  try{
    await navigator.clipboard.writeText(url);
    s.textContent="Invite link copied. Your friend can join without an account.";
  }catch{
    s.innerHTML="";
    const a=document.createElement("a");
    a.href=url;a.target="_blank";a.rel="noopener";a.textContent="Open friend invite";
    s.append("Copy this invite: ",a);
  }
};

function downloadBlob(blob,name){const a=document.createElement("a");const url=URL.createObjectURL(blob);a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
$("#downloadWebmBtn").onclick=()=>{if(!lastRecording)return;downloadBlob(lastRecording.blob,lastRecording.recordingId+"-source.webm");};
$("#downloadMp4Btn").onclick=()=>{if(!lastRecording||lastRecording.mp4State!=="ready")return;downloadBlob(lastRecording.mp4,lastRecording.recordingId+".mp4");};
$("#retryMp4Btn").onclick=()=>finalizeMp4();
$("#downloadTranscriptBtn").onclick=async()=>{if(!lastRecording)return;const b=$("#downloadTranscriptBtn"),s=$("#recordingResultStatus");b.disabled=true;s.textContent="Transcribing recording…";try{const form=new FormData();form.append("source",lastRecording.blob,lastRecording.recordingId+".webm");const r=await fetch(studioApiEndpoint()+"/api/creator/recordings/transcribe",{method:"POST",credentials:"include",headers:{"X-Toasty-CSRF":"1"},body:form});const d=await r.json();if(!r.ok)throw new Error(d.error||"Could not transcribe recording.");downloadBlob(new Blob([d.transcript||""],{type:"text/plain;charset=utf-8"}),lastRecording.recordingId+"-transcript.txt");s.textContent="Transcript ready and downloaded.";}catch(e){s.textContent=e.message;}finally{b.disabled=false;}};
