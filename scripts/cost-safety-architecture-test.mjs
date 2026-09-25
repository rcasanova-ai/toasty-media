#!/usr/bin/env node
import { readFileSync } from "node:fs";

const server = readFileSync(new URL("./render-production-server.mjs", import.meta.url), "utf8");
const settings = readFileSync(new URL("../studio/settings.html", import.meta.url), "utf8");
const settingsJs = readFileSync(new URL("../js/studio-settings.js", import.meta.url), "utf8");

function assert(ok, message) {
  if (!ok) throw new Error("FAILED: " + message);
  console.log("ok - " + message);
}

assert(server.includes("COST_SAFETY_SWITCHES"), "global cost safety switches exist");
for (const name of ["TOASTY_ENABLE_AI","TOASTY_ENABLE_TRANSCRIPTION","TOASTY_ENABLE_RECORDING_FINALIZE","TOASTY_ENABLE_RENDERING","TOASTY_ENABLE_UPLOADS","TOASTY_ENABLE_PUBLIC_MEDIA"]) {
  assert(server.includes(name), name + " is wired");
}
assert(server.includes('req.url.endsWith("/usage")'), "organization usage endpoint exists");
assert(server.includes("maxUploadsBytesPerMonth"), "monthly upload limit is enforced");
assert(server.includes("maxRenderJobsPerDay"), "daily render jobs are enforced");
assert(server.includes("maxConcurrentRenders"), "render concurrency is enforced");
assert(server.includes("maxRecordingMinutes"), "recording duration is enforced");
assert(server.includes('deltas: { aiRequests: 1 }'), "AI usage is counted");
assert(server.includes("renderSlotHeld"), "render slot accounting cannot decrement another job");
assert(settings.includes('data-panel="usage"'), "Usage & Safety settings panel exists");
assert(settingsJs.includes('orgPath("/usage")'), "Usage & Safety UI reads the server endpoint");
console.log("ALL PASSED - cost safety architecture is wired.");
