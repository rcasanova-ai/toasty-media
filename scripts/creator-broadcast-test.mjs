#!/usr/bin/env node
// Creator and Studio share ONE Program/Broadcast/Recording core. This guards the wiring (source level) and
// the architecture rules that must never regress. Behaviour is covered by studio-mode-model-test.mjs and
// studio-broadcast-server-test.mjs.
import { readFileSync, readdirSync } from "node:fs";
const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const server = read("scripts/render-production-server.mjs");
const client = read("js/broadcast-client.js");
const creator = read("js/creator.js");
const director = read("js/director.js");
const live = read("js/live-session.js");
const panel = read("js/go-live-panel.js");
const nginx = read("scripts/nginx-render.conf.example");
const db = read("scripts/toasty-auth-db.py");
const code = (src) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
function ok(v, m) { if (!v) throw new Error("FAILED: " + m); console.log("ok - " + m); }

// One core, two surfaces
for (const [name, src] of [["Creator", creator], ["Studio (LiveSession)", live]]) {
  ok(/ProgramFeed/.test(src) && /ProgramOrchestrator/.test(src), `${name} uses the shared ProgramFeed + ProgramOrchestrator`);
  ok(/StudioBroadcastClient/.test(src), `${name} broadcasts through the shared StudioBroadcastClient`);
}
ok(/GoLivePanel/.test(creator) && /GoLivePanel/.test(director), "Creator and Studio share the same Go Live chooser");
ok(/MasterProgramRecorder/.test(creator), "Creator records with the same master recorder Studio uses");
ok(!/new MediaRecorder/.test(creator), "Creator has no private MediaRecorder pipeline");

// Client rules
ok(client.includes("/api/organizations/creator-broadcast/"), "client talks to the authenticated Studio broadcast API");
ok(client.includes('"X-Toasty-CSRF": "1"'), "every request carries request verification");
ok(!/getDisplayMedia/.test(code(client)), "the broadcast client never captures anything itself");
ok(!/localStorage/.test(code(client)) && !/localStorage/.test(code(creator)), "neither the broadcast client nor Creator touch localStorage at all");
ok(!/localStorage\.(set|get)Item\([^)]*(key|destination|stream)/i.test(code(client)), "client does not persist destinations or keys in localStorage");
ok(/localStorage/.test(panel) && /destination NAMES only/.test(panel) && !/localStorage\.setItem\([^)]*streamKey/.test(panel), "the chooser remembers only destination NAMES, never URLs/keys");
const panelCode = panel.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
ok(!/render\.toasty\.media|bitrate|Broadcast service|ffmpeg|resolution/i.test(panelCode), "chooser exposes no service URL / bitrate / engineering controls");
ok(/setUint32\(0, seq\)/.test(client) && !/duplex:\s*"half"/.test(client) && !/TransformStream/.test(client), "program is sent as short chunk requests, not one long-lived streaming fetch");

// Server rules
ok(server.includes("creator-broadcast/") && server.includes("requireSession(req, res)"), "broadcast routes require a Studio session");
ok(server.includes("encryptSecret(JSON.stringify({ streamUrl, streamKey }))"), "destination secrets are encrypted before storage");
ok(!/streamKey[^;\n]{0,40}sendJson|sendJson[^;\n]{0,80}streamKey/.test(server), "no handler sends a stream key back to the browser");
ok(db.includes("CREATE TABLE IF NOT EXISTS broadcast_destinations") && db.includes("organization_id"), "destinations are stored per organization");
ok(/"-c", "copy", "-f", "flv", url/.test(server), "each destination is an isolated copy-relay of ONE encode");
ok(!/"-filter_complex"/.test(server.slice(server.indexOf("function launchStudioBroadcast"))), "no per-destination re-encode / split inside the broadcast engine");
ok(!/creatorBroadcastJobs/.test(server), "the old long-lived-request ingest is gone");

ok(!/nobuffer/.test(server.slice(server.indexOf("function launchStudioBroadcast")).split("const encoder")[0].split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")), "encoder input never uses -fflags nobuffer (it drops the first keyframe)");

// nginx: dedicated, ordered above the generic org block, no 30s long-request trap
const bi = nginx.indexOf("location ~ ^/api/organizations/creator-broadcast/");
const gi = nginx.indexOf("location ~ ^/api/organizations(/.*)?$");
ok(bi > 0 && gi > bi, "nginx has a dedicated broadcast location ABOVE the generic /api/organizations block");
const block = nginx.slice(bi, nginx.indexOf("# ---- end Studio broadcast ----"));
ok(block.includes("zone=toasty_presence") && !block.includes("zone=toasty_settings"), "chunk cadence uses the high-rate zone, not the 60r/m settings zone");
ok(/client_max_body_size 10m/.test(block), "chunk body limit is explicit");

// Hygiene: escaped-newline regressions
for (const f of ["studio/director.html", "studio/creator.html", "studio/dashboard.html", "css/studio.css", "css/golive.css"]) {
  ok(!/>\\n|\\n\s*</.test(read(f)), `${f} has no literal \\n artifacts between tags`);
}
for (const f of readdirSync(new URL("../js/", import.meta.url)).filter((n) => n.endsWith(".js"))) {
  const src = read("js/" + f);
  ok(!/\}\\n\s+(const|let|function|async|export|import)\s/.test(src) && !/;\\n\s+(const|let|function|async|export|import)\s/.test(src), `js/${f} has no literal \\n code-joining artifacts`);
}
console.log("ALL PASSED - Creator and Studio share one Program/Broadcast/Recording core; secrets stay server-side.");
