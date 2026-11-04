#!/usr/bin/env node
// Static integration checks for the shared room invite and consent handshake.
import { readFileSync } from "node:fs";
const get = p => readFileSync(new URL("../"+p, import.meta.url),"utf8");
const check = (v,m) => {if(!v)throw Error(m);console.log("ok",m)};
const host=get("js/director.js"), guest=get("js/guest.js"), html=get("studio/guest.html"), transport=get("js/video-engine.js");
const director=get("studio/director.html");
check(host.includes('guestUrl.searchParams.set("sharedBackground", selection)'),"host shares preset in invite");
check(director.includes('id="sharedRoomTheme"'),"host preset picker exists");
check(html.includes('id="sharedBackgroundConsent"'),"guest opt-in exists");
check(guest.includes('checkbox.checked') && guest.includes('state.selectedBackground = suggested'),"guest must opt in to override");
check(transport.includes('return"5"') && transport.includes('imagelist:sharedBackgroundImage'),"VDO replacement effect configured");
for(const name of ["newsroom","library","stage"])check(get("studio/backgrounds/"+name+".svg").startsWith("<svg"),name+" image present");
check(get("js/live-session.js").includes('backgroundMode: document.querySelector("#sharedRoomTheme")'),"host publisher receives selected background");
check(get(".htaccess").includes('Access-Control-Allow-Origin "https://vdo.ninja"'),"hosted scene images allow VDO rendering");
