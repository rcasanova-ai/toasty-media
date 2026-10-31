import { studioApiEndpoint } from "./studio-api.js";

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get("token") || "";
let stream = null, recorder = null, chunks = [], blob = null, objectUrl = "";
const endpoint = `${studioApiEndpoint()}/api/organizations/talk-auditions/invite/${encodeURIComponent(token)}`;

function say(message) { $("status").textContent = message; }
function stopTracks() { stream?.getTracks().forEach((track) => track.stop()); stream = null; }
function resetReview() { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = ""; blob = null; $("preview").removeAttribute("src"); $("preview").muted = true; $("preview").controls = false; $("retry").hidden = true; $("submit").hidden = true; $("start").hidden = false; }

async function load() {
  if (!token) return fail("This invitation link is incomplete.");
  try {
    const response = await fetch(endpoint, { credentials: "omit" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "This invitation is unavailable.");
    $("greeting").textContent = `Ready, ${data.name?.split(/\s+/)[0] || "there"}?`;
    $("loading").hidden = true; $("recorder").hidden = false;
  } catch (error) { fail(error.message); }
}
function fail(message) { $("loading").innerHTML = `<h2>Invitation unavailable</h2><p></p>`; $("loading").querySelector("p").textContent = message; }

$("start").onclick = async () => {
  resetReview();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } });
    $("preview").srcObject = stream; await $("preview").play();
    const mimeType = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = () => { blob = new Blob(chunks, { type: recorder.mimeType || "video/webm" }); stopTracks(); $("preview").srcObject = null; objectUrl = URL.createObjectURL(blob); $("preview").src = objectUrl; $("preview").muted = false; $("preview").controls = true; $("preview").play().catch(() => {}); $("retry").hidden = false; $("submit").hidden = false; say("Review your recording, then submit or record again."); };
    recorder.start(1000); $("start").hidden = true; $("stop").disabled = false; say("Recording…");
  } catch { say("Camera and microphone access is required to record your audition."); }
};
$("stop").onclick = () => { if (recorder?.state === "recording") recorder.stop(); $("stop").disabled = true; };
$("retry").onclick = () => { resetReview(); say("Ready to record again."); };
$("submit").onclick = async () => {
  if (!blob) return;
  $("submit").disabled = true; $("retry").disabled = true; say("Uploading securely… Keep this page open.");
  try {
    const response = await fetch(`${endpoint}/submit`, { method: "POST", headers: { "Content-Type": blob.type.split(";")[0], "X-Toasty-CSRF": "1" }, body: blob, credentials: "omit" });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || "Upload failed.");
    say(data.message); $("submit").hidden = true; $("retry").hidden = true; $("preview").controls = false;
  } catch (error) { say(error.message); $("submit").disabled = false; $("retry").disabled = false; }
};
addEventListener("beforeunload", () => { stopTracks(); if (objectUrl) URL.revokeObjectURL(objectUrl); });
load();
