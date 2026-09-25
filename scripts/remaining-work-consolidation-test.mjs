#!/usr/bin/env node
import { readFileSync } from "node:fs";

const read=(p)=>readFileSync(new URL("../"+p,import.meta.url),"utf8");
const focus=read("js/focus-group.js");
const live=read("js/live-session.js");
const show=read("js/show-context.js");
const research=read("js/peeps-research.js");
const peeps=read("peeps/app/index.html");
const roadmap=read("docs/ROADMAP.md");
const admin=read("js/expertise-admin.js");
const director=read("studio/director.html");
const experts=read("experts/index.html");
const app=read("app/index.html");

function assert(ok,msg){if(!ok)throw new Error("FAILED: "+msg);console.log("ok - "+msg);}

assert(focus.includes("buildFocusGroupDeliveryPack"),"focus-group intelligence pack is present");
assert(focus.includes("recommendedFollowUpResearch"),"expanded focus-group findings are present");
assert(live.includes('attachFocusGroupToSession'),"focus-group Studio bridge is present");
assert(show.includes("researchContext"),"Moxie show context carries research context");
assert(research.includes("recordDemandEvent")&&research.includes("summarizeDemand"),"Peeps demand intelligence is present");
assert(peeps.includes("Human insight, on demand")&&peeps.includes("Focus group"),"Human Insight Network UX is present in Peeps");
assert(roadmap.includes("Moxie as a Real Focus Group Moderator Copilot"),"focus-group roadmap is reconciled to Moxie");
assert(!admin.includes("'AI Production'")&&!admin.includes("'Guest Finder'"),"retired AI Production and Guest Finder labels are gone from admin");
assert(admin.includes("'Moxie'")&&admin.includes("'Toasty Peeps'"),"admin uses current Moxie and Peeps product model");
assert(director.includes('aria-label="Legacy Studio navigation" hidden style="display:none!important"'),"retired Studio mode chrome remains hard-hidden");
assert(experts.includes("Toasty Peeps")&&experts.includes("url=../peeps/"),"legacy experts URL routes to Peeps");
assert(app.includes("url=../studio/"),"legacy app URL routes to Studio");
console.log("ALL PASSED - remaining stale product work is reconciled into current Toasty surfaces.");
