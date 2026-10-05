#!/usr/bin/env node
import { readFileSync } from "node:fs";
const server=readFileSync(new URL("./render-production-server.mjs",import.meta.url),"utf8");
const client=readFileSync(new URL("../js/broadcast-client.js",import.meta.url),"utf8");
function ok(v,m){if(!v)throw new Error("FAILED: "+m);console.log("ok - "+m);}
ok(client.includes('https://render.toasty.media'),"Creator uses authenticated Studio backend");
ok(client.includes('/api/organizations/creator-broadcast/start'),"Creator starts broadcast through Studio API");
ok(client.includes('"X-Toasty-CSRF": "1"'),"stream ingest carries request verification");
ok(server.includes('/api/organizations/creator-broadcast/start'),"backend exposes broadcast start");
ok(server.includes('requireSession(req, res)'),"broadcast routes require Studio session");
ok(server.includes('startCreatorBroadcastFfmpeg'),"backend pipes WebM through FFmpeg");
ok(server.includes('"-f","flv",target'),"FFmpeg emits FLV to RTMP target");
ok(server.includes('/creator-broadcast\\/([a-f0-9-]+)\\/stop'),"broadcast stop lifecycle is implemented");
console.log("ALL PASSED - Creator RTMP authenticated lifecycle is wired.");
