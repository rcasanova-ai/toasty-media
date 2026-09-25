#!/usr/bin/env node
import { readFileSync } from "node:fs";
const read=(p)=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const auth=read("js/studio-auth.js");
const director=read("js/director.js");
const live=read("js/live-session.js");
const onboarding=read("studio/onboarding.html");
function assert(ok,msg){if(!ok)throw new Error("FAILED: "+msg);console.log("ok - "+msg);}
assert(auth.includes('openStudio(session.user?.branding, { destination: "./onboarding.html" })'),"new signup enters onboarding wizard");
assert(auth.includes('const resolvedDestination = destination || (query.get("session") ? "./director.html" : "./dashboard.html")'),"normal login still lands on dashboard/direct session");
assert(onboarding.includes("studio-onboarding.js"),"onboarding surface is wired");
assert(live.includes('result.session.status !== "ENDED"'),"End Session requires backend ENDED confirmation");
assert(!live.includes('endDurableSession request failed'),"End Session no longer swallows backend failure");
assert(director.includes("async function endCurrentSession(button)"),"one shared authoritative End Session action exists");
assert(director.includes('window.location.href = url.toString()'),"successful End Session exits live Studio");
assert(director.includes("Could not end this session:"),"End Session failure is visible to the user");
console.log("ALL PASSED - onboarding and End Session release checks.");
