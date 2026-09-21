#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const html = readFileSync(join(root, "studio/director.html"), "utf8");
const director = readFileSync(join(root, "js/director.js"), "utf8");
const producerView = readFileSync(join(root, "js/producer-view.js"), "utf8");
const chassisCss = readFileSync(join(root, "css/studio-chassis.css"), "utf8");
const brandThemes = readFileSync(join(root, "js/brand-themes.js"), "utf8");
const programOutputCss = readFileSync(join(root, "css/program-output.css"), "utf8");

function includes(haystack, needle, message = needle) {
  assert.ok(haystack.includes(needle), message);
}

includes(html, '<link rel="stylesheet" href="../css/studio-chassis.css">');
includes(html, 'class="live-console live-studio-panel studio-chassis"');
includes(html, 'id="liveConsole" data-lv-view="host"');
includes(html, 'data-lv-view-btn="host" aria-pressed="true"');
includes(html, 'data-lv-view-btn="producer" aria-pressed="false"');
includes(html, "studio-chassis-status");
includes(html, 'id="studioSessionStatus"');
includes(html, 'id="studioProgramOutputPill"');
includes(html, 'id="studioRailAudioState"');
includes(html, 'id="studioRailRecordingState"');
includes(html, "studio-program-truth");
includes(html, 'id="studioTruthOutput"');
includes(html, 'id="studioTruthScene"');
includes(html, 'id="studioTruthAudio"');
includes(html, 'id="studioTruthRec"');
includes(html, 'id="studioTruthStream"');
includes(html, "studio-workflow-nav");
includes(html, 'data-studio-workflow="studio"');
includes(html, ">Studio Home</h1>");
includes(html, 'id="studioHomeBoard"');
includes(html, 'id="sessionArtifacts"');
includes(html, "producer-domain-nav");
includes(html, 'data-studio-domain="show"');
includes(html, 'data-studio-domain="content"');
includes(html, 'data-studio-domain="intelligence"');
includes(html, 'data-studio-domain="broadcast"');

const requiredTools = [
  "runshow",
  "participants",
  "layout",
  "graphics",
  "ticker",
  "media",
  "soundboard",
  "audience",
  "hottie",
  "transcription",
  "audio",
  "recording",
  "streaming"
];

for (const tool of requiredTools) {
  includes(html, `data-studio-tool="${tool}"`, `missing Producer tool button: ${tool}`);
  includes(html, `data-studio-tool-panel="${tool}"`, `missing Producer tool panel: ${tool}`);
}

const liveRail = html.match(/<section class="lv-panel producer-live-rail"[\s\S]*?<\/section>/)?.[0] || "";
assert.ok(liveRail, "missing permanent Producer live rail");
includes(liveRail, 'id="lvOutputStateChip"');
includes(liveRail, 'id="lvPoSceneGroup"');
includes(liveRail, 'id="lvPoSceneRejected"');
includes(liveRail, 'data-scene="holding"');
includes(liveRail, 'data-scene="live"');
includes(liveRail, 'data-scene="brb"');
includes(liveRail, 'data-scene="technical-difficulties"');
includes(liveRail, 'data-scene="ending"');

const graphicsPanel = html.match(/<section class="lv-panel lv-graphics"[\s\S]*?<\/section>/)?.[0] || "";
assert.ok(graphicsPanel, "missing graphics panel");
assert.ok(!graphicsPanel.includes('id="lvPoSceneGroup"'), "scene rail must not be buried in Graphics");

const persistentRos = html.match(/<section class="lv-panel lv-run-of-show"[\s\S]*?<\/section>/)?.[0] || "";
assert.ok(persistentRos, "missing persistent Run of Show");
assert.ok(persistentRos.includes('data-studio-cockpit="runshow"'), "Run of Show must remain a cockpit rail");
assert.ok(!persistentRos.includes('data-studio-tool-panel="runshow"'), "persistent Run of Show must not be a hideable tool tab");

const hostEffects = html.match(/<section class="lv-panel lv-host-effects"[\s\S]*?<\/section>/)?.[0] || "";
assert.ok(hostEffects, "missing Host background/effects panel");
for (const label of ["None", "Blur", "Branded", "Upload", "Preview"]) includes(hostEffects, label);
includes(hostEffects, "Shared/virtual sets belong to Producer composition");

includes(html, "shared-set-hook");
includes(html, "Future shared set controls land here");
includes(html, "Audio Mixer / Routing");
includes(html, "Streaming Destinations");
includes(html, "Transcription");
includes(html, "Media / Assets");
includes(html, "lv-hottie-workspace");
includes(html, "Ask Hottie");

includes(director, 'setView("host")');
includes(director, "function setProducerTool");
includes(director, "function setProducerDomain");
includes(director, "function bindChassisUi");
includes(director, "openWorkflowSettings");
includes(director, "ensureProgramOutputWindow");
assert.ok(!director.includes('if (workflow === "show") setProducerDomain("show")'), "workflow tabs must not hijack Producer tools");
includes(html, 'id="studioOpenProgramOutput"');
includes(html, "Open Program Output");
includes(html, 'id="studioOpenSoundboard"');
includes(html, 'id="studioWorkflowDrawer"');
includes(director, 'session.on("program-output", renderBroadcastChip)');
includes(director, "studioProgramOutputPill");
includes(director, "studioTruthOutput");

includes(producerView, "outputStateChip");
includes(producerView, "sceneLabels");
includes(producerView, "No optimistic aria-pressed update here on purpose");

includes(chassisCss, ".studio-chassis.live-console[data-lv-view=\"producer\"] .studio-chassis-body");
includes(chassisCss, "grid-template-columns");
includes(chassisCss, ".producer-tool-nav");
includes(chassisCss, ".producer-domain-nav");
includes(chassisCss, "aspect-ratio: 16 / 9");
includes(chassisCss, "@media (max-width: 760px)");
includes(chassisCss, "[data-lv-only=\"host\"]");
includes(chassisCss, "[data-lv-only=\"producer\"]");
includes(chassisCss, "studio-live-identity");
includes(chassisCss, "lv-transport-bar");
includes(html, 'id="studioOpenSettings"');
includes(html, 'id="studioExitSession"');
includes(html, "lv-transport-bar");
includes(html, 'data-studio-tool-primary="true"');
includes(director, "PRIMARY_PRODUCER_TOOLS");
assert.ok(!director.includes("button.hidden = !inDomain"), "Producer tools must not hide behind domain tabs");
includes(director, "button.hidden = !isPrimary");

const studioCss = readFileSync(join(root, "css/studio.css"), "utf8");
includes(studioCss, "max-width: min(35%");
includes(programOutputCss, "max-width: min(35%");
assert.ok(!studioCss.includes(".live-console[data-lv-view=\"producer\"] .lv-host-controls"), "Producer must not park Mic/Camera/Screen off-screen");
includes(studioCss, ".live-console[data-lv-view=\"producer\"] #lvParticipantStage");

assert.ok(!brandThemes.includes("clients/superteam-thailand/silhouette-skyline.png") || !/8alta[\s\S]{0,1800}silhouette-skyline/.test(brandThemes), "8ALTA must not reuse Superteam skyline in nearby artwork");
const altaBlock = brandThemes.slice(brandThemes.indexOf('"8alta"'), brandThemes.indexOf("santati:"));
assert.ok(!altaBlock.includes("silhouette-skyline.png"), "8ALTA artwork must not reference Superteam skyline");
assert.ok(altaBlock.includes("executive-lantern"), "8ALTA has its own artwork treatment");
assert.ok(!programOutputCss.includes('data-brand-theme="8alta"] .po-scene-screen::before {\n  filter: sepia'), "8ALTA Program Output must not be a filtered Superteam silhouette");

const changedFiles = execFileSync("git", ["diff", "--name-only"], { cwd: root, encoding: "utf8" })
  .split(/\n/g)
  .filter(Boolean);
const untrackedFiles = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split(/\n/g)
  .filter(Boolean);
const touchedFiles = [...new Set([...changedFiles, ...untrackedFiles])].filter((file) => !file.includes("__pycache__"));
const forbiddenPatterns = [
  /^js\/room-presence\.js$/,
  /^js\/program-sync\.js$/,
  /^js\/server-sync\.js$/,
  /^js\/program-server-sync\.js$/,
  /^nginx\//,
  /^server\//,
  /^api\//,
  /session-lifecycle/i,
  /durable-session/i
];
for (const file of touchedFiles) {
  assert.ok(!forbiddenPatterns.some((pattern) => pattern.test(file)), `forbidden chassis touch: ${file}`);
}

const listener = readFileSync(join(root, "js/listener.js"), "utf8");
includes(listener, "tickerDurationSeconds");
assert.ok(!listener.includes("RoomPresence ="), "listener RoomPresence wiring is not rewritten");

console.log(`studio-chassis-ia-test passed (${touchedFiles.length} touched files checked)`);
