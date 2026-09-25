#!/usr/bin/env node
import { readFileSync } from "node:fs";

const read=(p)=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const html=read("studio/director.html");
const live=read("js/live-session.js");
const video=read("js/video-engine.js");
const listener=read("js/listener.js");
const renderer=read("js/program-renderer.js");
const control=read("js/session-control.js");
const db=read("scripts/toasty-auth-db.py");
const server=read("scripts/render-production-server.mjs");

function assert(ok,msg){if(!ok)throw new Error("FAILED: "+msg);console.log("ok - "+msg);}

// Product shell must not regress to retired UI.
assert(html.includes('aria-label="Legacy Studio navigation" hidden style="display:none!important"'),"retired AI Production navigation remains hard-hidden");
assert(html.includes('aria-label="Legacy advanced controls" hidden style="display:none!important"'),"legacy Advanced controls remain hard-hidden");
assert(!html.includes('id="lvTopSettings">Settings</button>'),"duplicate topbar Settings label cannot return");

// Host AV is authoritative across local tile, transport, and Program.
assert(live.includes("this.engine.setCamera(!this.av.cameraOff)"),"camera toggle controls transport");
assert(live.includes("track.enabled = !this.av.cameraOff"),"camera toggle controls native track");
assert(live.includes('localVideo.style.visibility = this.av.cameraOff ? "hidden" : ""'),"camera toggle controls visible Host tile");
assert(renderer.includes("participant?.cameraEnabled === false"),"Program renderer honors camera-off");
assert(live.includes("this.engine.setMicrophone(!this.av.micMuted)"),"mic toggle controls transport");
assert(live.includes("track.enabled = !this.av.micMuted"),"mic toggle controls native mic track");

// One audible path. Host self-view and hidden control paths may never monitor local/room audio.
assert(live.includes("video.muted = true"),"Host self-view is always muted");
assert(video.includes('mountDirectorControlFrame(container,{roomId})') && video.includes('muted:"1",mute:"1"'),"Director control frame is muted");
assert(video.includes("view:true"),"Host/control publisher paths include publish-only/view guard");
assert(listener.includes("Do not reuse the Director's raw host MediaStream inside Program Output"),"Program Output does not reuse the raw Host mic stream");
assert(!/audioMixer\.addParticipant\(\{\s*participantId:\s*["']host["'][\s\S]{0,180}stream:\s*this\._hostPreviewStream/.test(live),"Director does not route Host mic into local ProgramAudioBus");

// Canonical control state must not flap between stale Studio tabs.
assert(control.includes("controllerStartedAt"),"canonical state carries controller epoch");
assert(live.includes("controlWriterStartedAt = Date.now()"),"each active Studio controller has an epoch");
assert(db.includes("incoming_controller_started_at < existing_controller_started_at"),"backend rejects stale controller writes");

// Account/org foundation cannot strand legacy users.
assert(server.includes("ensureDefaultOrganizationForUser"),"legacy accounts self-heal missing organizations");

// Cost and AI remain fail-closed.
assert(server.includes("COST_SAFETY_SWITCHES"),"cost safety switches are present");
assert(server.includes("byok_required"),"AI requires organization BYOK");

console.log("ALL PASSED - Toasty Studio release gate.");
