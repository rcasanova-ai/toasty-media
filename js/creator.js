import { ToastyBroadcastController } from "./broadcast-client.js";
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
    screen=null;
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
    setStatus(hasSystemAudio?"Game / screen captured with system audio.":"Game / screen captured. No system audio track was shared.");
    screen.getVideoTracks()[0]?.addEventListener("ended",()=>{
      screen=null;
      preview.srcObject=null;
      $("#stageEmpty").hidden=false;
      $("#captureBtn").textContent="Capture game / screen";
      setStatus("Capture ended.");
    },{once:true});
  }catch(e){
    screen=null;
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
    setStatus("Mic off.");
    return;
  }
  try{
    mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:false},video:false});
    $("#micBtn").classList.add("active");
    setStatus("Mic ready.");
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
$("#recordBtn").onclick=async()=>{
  if(rec&&rec.state!=="inactive"){rec.stop();return}
  if(!screen&&!$("#voiceoverPreview").src&&!cam)return setStatus("Capture a game/screen, load a video, or turn on the camera first.");
  if(!mic)await $("#micBtn").onclick();
  const source=screen||$("#voiceoverPreview").captureStream?.();
  const videoStream=getProgramVideoStream();
  const audioCtx=new AudioContext();
  await audioCtx.resume().catch(()=>{});
  const dest=audioCtx.createMediaStreamDestination();
  for(const s of [source,mic])for(const t of s?.getAudioTracks?.()||[]){
    try{audioCtx.createMediaStreamSource(new MediaStream([t])).connect(dest)}catch{}
  }
  const combined=new MediaStream([...videoStream.getVideoTracks(),...dest.stream.getAudioTracks()]);
  chunks=[];marks=[];started=Date.now();
  const mime=MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")?"video/webm;codecs=vp9,opus":"video/webm";
  try{rec=new MediaRecorder(combined,{mimeType:mime})}catch(e){return setStatus("Recording is not supported in this browser: "+(e?.message||"unknown error"))}
  rec.ondataavailable=e=>e.data.size&&chunks.push(e.data);
  rec.onstop=()=>{
    combined.getVideoTracks().forEach(t=>t.stop());
    audioCtx.close().catch(()=>{});
    const blob=new Blob(chunks,{type:rec.mimeType||"video/webm"});
    const recordingId="creator-"+Date.now().toString(36);
    const objectUrl=URL.createObjectURL(blob);
    lastRecording={blob,recordingId,objectUrl,durationSeconds:Math.max(1,Math.round((Date.now()-started)/1000))};
    $("#recordingPreview").src=objectUrl;
    $("#recordingResult").hidden=false;
    $("#recordingResultStatus").textContent="Recording ready. Download WebM now, or create MP4/transcript.";
    $("#recordBtn").classList.remove("on");
    $("#recordBtn").textContent="Record";
    $("#markBtn").disabled=true;
    setStatus("Recording ready.");
  };
  rec.start(1000);
  $("#recordBtn").classList.add("on");
  $("#recordBtn").textContent="Stop";
  $("#markBtn").disabled=false;
  setStatus("Recording program output…");
};
$("#markBtn").onclick=()=>{const sec=((Date.now()-started)/1000).toFixed(1);marks.push(sec);$("#clips").replaceChildren(...marks.map((m,i)=>{const row=document.createElement("div");row.textContent="Clip "+(i+1)+" · "+m+"s";return row;}));};
$("#voiceoverPreview").onplay=()=>setStatus("Voiceover playback running.");
const bc=new ToastyBroadcastController({getProgramUrl:()=>location.href,requireLegacyAuthGate:false,onStateChange:s=>{$("#liveBtn").classList.toggle("on",s==="live")}}).init();
const panel=$("#broadcastPanel");
$("#broadcastMount").appendChild(panel);
panel.setAttribute("role","dialog");
panel.setAttribute("aria-modal","true");
const closeBroadcast=document.createElement("button");
closeBroadcast.type="button";
closeBroadcast.className="creator-broadcast-close";
closeBroadcast.setAttribute("aria-label","Close broadcast settings");
closeBroadcast.textContent="× Close";
panel.prepend(closeBroadcast);
function closeBroadcastPanel(){panel.hidden=true;$("#liveBtn").focus();}
function openBroadcastPanel(){panel.hidden=false;closeBroadcast.focus();}
closeBroadcast.onclick=closeBroadcastPanel;
$("#liveBtn").onclick=()=>panel.hidden?openBroadcastPanel():closeBroadcastPanel();
document.addEventListener("keydown",e=>{if(e.key==="Escape"&&!panel.hidden)closeBroadcastPanel();});
$("#broadcastMount").addEventListener("click",e=>{if(e.target===$("#broadcastMount")&&!panel.hidden)closeBroadcastPanel();});
$("#openProgramOutput").hidden=true;
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
$("#downloadWebmBtn").onclick=()=>{if(!lastRecording)return;downloadBlob(lastRecording.blob,lastRecording.recordingId+".webm");};
$("#downloadMp4Btn").onclick=async()=>{if(!lastRecording)return;const b=$("#downloadMp4Btn"),s=$("#recordingResultStatus");b.disabled=true;s.textContent="Creating MP4…";try{const form=new FormData();form.append("manifest",JSON.stringify({kind:"master-program",recordingId:lastRecording.recordingId,durationSeconds:lastRecording.durationSeconds,title:"Toasty Creator"}));form.append("source",lastRecording.blob,lastRecording.recordingId+".webm");const r=await fetch(studioApiEndpoint()+"/api/recordings/finalize",{method:"POST",credentials:"include",headers:{"X-Toasty-CSRF":"1"},body:form});if(!r.ok){let e={};try{e=await r.json()}catch{}throw new Error(e.error||"Could not create MP4.");}const blob=await r.blob();downloadBlob(blob,lastRecording.recordingId+".mp4");s.textContent="MP4 ready and downloaded.";}catch(e){s.textContent=e.message;}finally{b.disabled=false;}};
$("#downloadTranscriptBtn").onclick=async()=>{if(!lastRecording)return;const b=$("#downloadTranscriptBtn"),s=$("#recordingResultStatus");b.disabled=true;s.textContent="Transcribing recording…";try{const form=new FormData();form.append("source",lastRecording.blob,lastRecording.recordingId+".webm");const r=await fetch(studioApiEndpoint()+"/api/creator/recordings/transcribe",{method:"POST",credentials:"include",headers:{"X-Toasty-CSRF":"1"},body:form});const d=await r.json();if(!r.ok)throw new Error(d.error||"Could not transcribe recording.");downloadBlob(new Blob([d.transcript||""],{type:"text/plain;charset=utf-8"}),lastRecording.recordingId+"-transcript.txt");s.textContent="Transcript ready and downloaded.";}catch(e){s.textContent=e.message;}finally{b.disabled=false;}};
