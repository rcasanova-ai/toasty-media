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

function includes(haystack, needle, message = needle) {
  assert.ok(haystack.includes(needle), message);
}

includes(html, '<link rel="stylesheet" href="../css/studio-chassis.css">');
includes(html, 'class="live-console live-studio-panel studio-chassis"');
includes(html, 'id="liveConsole" data-lv-view="producer"');
includes(html, 'data-lv-view-btn="producer" aria-pressed="true"');
includes(html, 'data-lv-view-btn="host" aria-pressed="false"');
includes(html, 'studio-chassis-status');
includes(html, 'id="studioSessionStatus"');
includes(html, 'id="studioProgramOutputPill"');
includes(html, 'id="studioRailAudioState"');
includes(html, 'id="studioRailRecordingState"');

const requiredTools = [
  "runshow",
  "participants",
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

const graphicsPanel = html.match(/<section class="lv-panel lv-graphics"[\s\S]*?<\/section>/)?.[0] || "";
assert.ok(graphicsPanel, "missing graphics panel");
assert.ok(!graphicsPanel.includes('id="lvPoSceneGroup"'), "scene rail must not be buried in Graphics");

const hostEffects = html.match(/<section class="lv-panel lv-host-effects"[\s\S]*?<\/section>/)?.[0] || "";
assert.ok(hostEffects, "missing Host background/effects panel");
for (const label of ["None", "Blur", "Branded", "Upload"]) includes(hostEffects, label);
includes(hostEffects, "Shared/virtual sets belong to Producer composition");

includes(html, "shared-set-hook");
includes(html, "Future shared set controls land here");
includes(html, "Audio Mixer / Routing");
includes(html, "Streaming Destinations");
includes(html, "Transcription");
includes(html, "Media / Assets");

includes(director, 'setView("producer")');
includes(director, "function setProducerTool");
includes(director, "session.on(\"program-output\", renderBroadcastChip)");
includes(director, "studioProgramOutputPill");

includes(producerView, "outputStateChip");
includes(producerView, "sceneLabels");
includes(producerView, "No optimistic aria-pressed update here on purpose");

includes(chassisCss, ".studio-chassis[data-lv-view=\"producer\"] .studio-chassis-body");
includes(chassisCss, "grid-template-areas");
includes(chassisCss, ".producer-tool-nav");
includes(chassisCss, "@media (max-width: 760px)");

const changedFiles = execFileSync("git", ["diff", "--name-only"], { cwd: root, encoding: "utf8" })
  .split(/\n/g)
  .filter(Boolean);
const untrackedFiles = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" })
  .split(/\n/g)
  .filter(Boolean);
const touchedFiles = [...new Set([...changedFiles, ...untrackedFiles])];
const forbiddenPatterns = [
  /^js\/room-presence\.js$/,
  /^js\/program-sync\.js$/,
  /^js\/listener\.js$/,
  /^js\/server-sync\.js$/,
  /^scripts\/render-production-server\.mjs$/,
  /^nginx\//,
  /^server\//,
  /^api\//,
  /session-lifecycle/i,
  /durable-session/i
];
for (const file of touchedFiles) {
  assert.ok(!forbiddenPatterns.some((pattern) => pattern.test(file)), `forbidden chassis touch: ${file}`);
}

console.log(`studio-chassis-ia-test passed (${touchedFiles.length} touched files checked)`);
