#!/usr/bin/env node
import { readFileSync } from "node:fs";
const html=readFileSync(new URL("../studio/director.html", import.meta.url),"utf8");
const js=readFileSync(new URL("../js/director.js", import.meta.url),"utf8");
const css=readFileSync(new URL("../css/studio-chassis.css", import.meta.url),"utf8");
function assert(ok,msg){if(!ok)throw new Error("FAILED: "+msg);console.log("ok - "+msg);}
assert(html.includes('class="studio-global-nav"')&&html.includes('style="display:none!important"'),"legacy global Studio nav is hard-hidden");
assert(html.includes('aria-label="Legacy advanced controls"')&&html.includes('style="display:none!important"'),"legacy Advanced drawer is hard-hidden");
assert(html.split('id="lvTopSettings"').length===2,"exactly ONE Settings control exists");
assert(/id="lvTopSettings"[^>]*>Settings<\/button>/.test(html)&&html.indexOf('id="lvTopSettings"')<html.indexOf('id="lvTopMore"'),"Settings sits in the top-right header, beside the More menu");
assert(!html.includes('id="openSettingsQuick"')&&!html.includes('class="quick-actions"'),"the left-rail Quick Actions card (duplicate Share Screen/Dashboard) is gone");
assert(js.includes('elements.topSettings?.addEventListener')&&js.includes('window.open("./dashboard.html", "_blank", "noopener")'),"Settings opens the dashboard in a new tab");
assert(css.includes(".studio-global-nav,")&&css.includes("display: none !important;"),"CSS prevents stale state from resurrecting retired chrome");
console.log("ALL PASSED - visible Studio shell no longer exposes retired AI Production / Advanced chrome.");
