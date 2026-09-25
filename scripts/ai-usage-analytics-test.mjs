#!/usr/bin/env node
import { readFileSync } from "node:fs";

const read=(p)=>readFileSync(new URL("../"+p, import.meta.url),"utf8");
const server=read("scripts/render-production-server.mjs");
const db=read("scripts/toasty-auth-db.py");
const producer=read("js/ai-producer.js");
const live=read("js/live-session.js");
const admin=read("js/platform-admin.js");
const adminHtml=read("studio/platform-admin.html");
const growth=read("js/session-growth.js");
const growthHtml=read("studio/session-growth.html");

function assert(ok,msg){if(!ok)throw new Error("FAILED: "+msg);console.log("ok - "+msg);}

assert(db.includes('if action == "platform_ai_usage_report"'),"database exposes aggregate AI usage report");
assert(db.includes("GROUP BY provider, model"),"AI report aggregates by provider/model");
assert(db.includes("LEFT JOIN ai_usage_events"),"AI report includes sessions with zero usage");
assert(server.includes('feature: "moxie_live_producer"'),"live Moxie calls are recorded as detailed telemetry");
assert(server.includes("sessionId = sessionText(body.sessionId"),"server accepts session attribution for live Moxie");
assert(producer.includes("sessionId: this.getSessionId()"),"browser sends durable session id with Moxie requests");
assert(live.includes("getSessionId: () => this.durableSession?.id || null"),"LiveSession threads durable session id into Moxie provider");
assert(adminHtml.includes("AI usage by session"),"Platform Admin exposes cross-session comparison surface");
assert(admin.includes("paAiModels") && admin.includes("paAiSessions"),"Platform Admin renders model and session analytics");
assert(growthHtml.includes('data-tab="aiusage"'),"session Growth has AI Usage tab");
assert(growth.includes("/ai-usage") && growth.includes("renderAiUsage()"),"session Growth renders per-session AI telemetry");
console.log("ALL PASSED - AI usage analytics architecture.");
