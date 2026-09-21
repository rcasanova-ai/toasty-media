#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  StudioHomeAction,
  StudioLifecycle,
  canOpenLiveStudio,
  duplicateSessionConfig,
  emptyHomeOverlay,
  isTerminalSession,
  mapSessionLifecycle,
  moveSessionToCollection,
  organizeStudioHome,
  primaryHomeAction,
  renameHomeSession
} from "../js/studio-home.js";
import { deferredArtifactReport, loadSessionArtifacts } from "../js/session-artifacts.js";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

const live = { id: "ls_live", title: "Week 1 update", status: "LIVE", startedAt: "2026-09-21", lastActiveAt: "2026-09-21T08:00:00Z", createdAt: "2026-09-20", roomId: "tmweek1", brandId: "toasty" };
const draft = { id: "ls_draft", title: "Untitled", status: "OPEN", createdAt: "2026-09-21", lastActiveAt: "2026-09-21T07:00:00Z", roomId: "tmdraft" };
const ended = { id: "ls_ended", title: "Last Thursday", status: "ENDED", createdAt: "2026-09-10", endedAt: "2026-09-10T18:00:00Z", lastActiveAt: "2026-09-10T18:00:00Z", roomId: "tmended", brandId: "peeps" };

console.log("Lifecycle mapping");
{
  assertEqual(mapSessionLifecycle(live), StudioLifecycle.ACTIVE, "LIVE is ACTIVE");
  assertEqual(mapSessionLifecycle(draft), StudioLifecycle.DRAFT, "OPEN without startedAt is DRAFT");
  assertEqual(mapSessionLifecycle(ended), StudioLifecycle.ENDED, "ENDED is ENDED");
  assert(isTerminalSession(ended), "ENDED is terminal");
  assert(!canOpenLiveStudio(ended), "ended cannot open live studio");
  assert(canOpenLiveStudio(live), "active can open live studio");
  assertEqual(primaryHomeAction(live), StudioHomeAction.OPEN_STUDIO, "active primary is Open Studio");
  assertEqual(primaryHomeAction(ended), StudioHomeAction.VIEW_SESSION, "ended primary is View Session");
}

console.log("Home organization");
{
  const home = organizeStudioHome([live, draft, ended], emptyHomeOverlay());
  assert(home.active.some((item) => item.session.id === "ls_live"), "active contains live session");
  assert(!home.active.some((item) => item.session.id === "ls_ended"), "ended is not in Active");
  assert(home.collections.find((item) => item.id === "shows").items.length >= 1, "unassigned sessions land in Shows");
  assert(home.collections.find((item) => item.id === "archive").hidden, "empty Archive is hidden by default");
  const archived = moveSessionToCollection(emptyHomeOverlay(), ended.id, "archive");
  const after = organizeStudioHome([live, ended], archived);
  assertEqual(after.items.find((item) => item.session.id === ended.id).lifecycle, StudioLifecycle.ARCHIVED, "moved to archive");
  assertEqual(primaryHomeAction(ended, archived), StudioHomeAction.VIEW_SESSION, "archived ended still views");
}

console.log("Duplicate copies setup only");
{
  const config = duplicateSessionConfig(ended);
  assertEqual(config.title, "Copy of Last Thursday", "duplicate title is Copy of");
  assertEqual(config.brandId, "peeps", "duplicate keeps brand");
  assertEqual(config.copiesHistory, false, "duplicate does not copy history");
  const renamed = renameHomeSession(emptyHomeOverlay(), ended.id, "Thursday recap");
  assertEqual(duplicateSessionConfig(ended, renamed).title, "Copy of Thursday recap", "duplicate uses overlay title");
}

console.log("Artifacts only from real persistence");
{
  const pack = await loadSessionArtifacts(ended, {
    recallRecordingId: () => null,
    loadRecording: async () => ({ blob: null, manifest: null })
  });
  assert(pack.sections.some((section) => section.id === "metadata"), "session metadata always available");
  assert(!pack.sections.some((section) => section.id === "recordings"), "no fake recording section");
  assert(!pack.sections.some((section) => section.id === "transcript"), "no fake transcript section");
  const report = deferredArtifactReport();
  assert(report.find((row) => row.artifact === "session metadata").persistedToday, "metadata persisted on live_sessions");
  assert(!report.find((row) => row.artifact === "Hottie research").persistedToday, "Hottie research is deferred after reload");
}

console.log("Director surfaces");
{
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const html = readFileSync(join(root, "studio/director.html"), "utf8");
  const manager = readFileSync(join(root, "js/session-manager.js"), "utf8");
  const director = readFileSync(join(root, "js/director.js"), "utf8");
  assert(html.includes("Studio Home"), "gate heading is Studio Home");
  assert(!html.includes("Live Studio Sessions"), "legacy Live Studio Sessions heading is gone");
  assert(html.includes("sessionArtifacts"), "artifacts surface exists");
  assert(manager.includes('mode: "artifacts"'), "ended URL resolves to artifacts");
  assert(manager.includes("canOpenLiveStudio"), "live open is gated");
  assert(director.includes('entry?.mode === "artifacts"'), "director does not boot live studio for artifacts");
  assert(director.includes("applyDurableSession"), "live path still applies durable session");
  assert(!director.includes("RoomPresence ="), "director does not rewrite RoomPresence");
}

console.log("ALL PASSED — Studio Home lifecycle and artifacts.");
