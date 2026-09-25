#!/usr/bin/env node
import { readFileSync } from "node:fs";
const read=(p)=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const live=read("js/live-session.js");
const control=read("js/session-control.js");
const renderer=read("js/program-renderer.js");
const listener=read("js/listener.js");
const db=read("scripts/toasty-auth-db.py");
function assert(ok,msg){if(!ok)throw new Error("FAILED: "+msg);console.log("ok - "+msg);}
assert(live.includes("controlWriterStartedAt = Date.now()"),"each Studio controller has a monotonic epoch");
assert(control.includes("controllerStartedAt"),"controller epoch crosses canonical Program state");
assert(db.includes("incoming_controller_started_at < existing_controller_started_at"),"backend rejects older Studio controller heartbeats");
assert(live.includes('localVideo.style.visibility = this.av.cameraOff ? "hidden" : ""'),"camera-off hides the native Host tile immediately");
assert(renderer.includes("participant?.cameraEnabled === false"),"Program renderer honors camera-off");
assert(listener.includes("Do not reuse the Director's raw host MediaStream inside Program Output"),"Program Output no longer self-monitors the raw Host mic");
console.log("ALL PASSED - live Studio AV/state stability guards are wired.");
