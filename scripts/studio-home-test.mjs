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
  isLiveNowSession,
  mapSessionLifecycle,
  moveSessionToCollection,
  organizeStudioHome,
  primaryHomeAction,
  renameHomeSession
} from "../js/studio-home.js";
import { deferredArtifactReport, loadSessionArtifacts } from "../js/session-artifacts.js";
import { extractReusableSetup, setupOmitsHistory } from "../js/session-setup.js";

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
  assertEqual(primaryHomeAction(live), StudioHomeAction.RESUME_LIVE_SESSION, "active primary is Resume Live Session");
  assertEqual(primaryHomeAction(draft), StudioHomeAction.OPEN_STUDIO, "draft primary is Open Studio");
  assertEqual(primaryHomeAction(ended), StudioHomeAction.VIEW_SESSION, "ended primary is View Session");
  assert(isLiveNowSession(live), "LIVE status is LIVE NOW");
  assert(isLiveNowSession({ ...live, status: "ACTIVE" }), "ACTIVE status is LIVE NOW");
  assert(isLiveNowSession({ ...draft, startedAt: "2026-09-21T08:00:00Z" }), "OPEN with startedAt is LIVE NOW");
  assert(!isLiveNowSession(draft), "DRAFT is not LIVE NOW");
  assert(!isLiveNowSession(ended), "ENDED is not LIVE NOW");
  assert(!isLiveNowSession({ ...draft, lastActiveAt: "2026-09-21T12:00:00Z" }), "recency does not make a draft LIVE NOW");
  const archivedOverlay = { ...emptyHomeOverlay(), archived: { ls_live: true } };
  assert(!isLiveNowSession(live, archivedOverlay), "ARCHIVED is not LIVE NOW");
}

console.log("Home organization");
{
  const home = organizeStudioHome([live, draft, ended], emptyHomeOverlay());
  assert(home.liveNow.some((item) => item.session.id === "ls_live"), "LIVE NOW contains live session");
  assert(!home.liveNow.some((item) => item.session.id === "ls_draft"), "draft is not in LIVE NOW");
  assert(!home.liveNow.some((item) => item.session.id === "ls_ended"), "ended is not in LIVE NOW");
  assert(home.active.some((item) => item.session.id === "ls_live"), "active contains live session");
  assert(!home.active.some((item) => item.session.id === "ls_ended"), "ended is not in Active");
  assert(!home.recent.some((item) => item.session.id === "ls_live"), "live session is not duplicated in Recent");
  assert(home.recent.length <= 3, "Recent still respects Rule of 3");
  assert(home.collections.find((item) => item.id === "shows").items.length >= 1, "unassigned sessions land in Shows");
  assert(home.collections.find((item) => item.id === "archive").hidden, "empty Archive is hidden by default");
  const archived = moveSessionToCollection(emptyHomeOverlay(), ended.id, "archive");
  const after = organizeStudioHome([live, ended], archived);
  assertEqual(after.items.find((item) => item.session.id === ended.id).lifecycle, StudioLifecycle.ARCHIVED, "moved to archive");
  assertEqual(primaryHomeAction(ended, archived), StudioHomeAction.VIEW_SESSION, "archived ended still views");
  const scheduledOverlay = { ...emptyHomeOverlay(), scheduledAt: { ls_live: "2099-01-01T00:00:00Z" } };
  assert(!isLiveNowSession(live, scheduledOverlay, Date.parse("2026-09-21T08:00:00Z")), "SCHEDULED is not LIVE NOW");
  const extras = [1, 2, 3, 4].map((n) => ({ id: `ls_d${n}`, title: `Draft ${n}`, status: "OPEN", createdAt: "2026-09-21", lastActiveAt: `2026-09-21T0${n}:00:00Z`, roomId: `tmd${n}` }));
  const crowded = organizeStudioHome([live, ...extras], emptyHomeOverlay());
  assertEqual(crowded.liveNow.length, 1, "LIVE NOW is separate from Recent");
  assertEqual(crowded.recent.length, 3, "LIVE NOW does not consume a Recent slot");
  assert(!crowded.recent.some((item) => item.session.id === "ls_live"), "crowded Recent still excludes the live session");
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

console.log("Duplicate copies reusable production setup, never history");
{
  const rich = {
    ...ended,
    setup: extractReusableSetup({
      brandId: "peeps",
      policy: { sessionType: "jam", privacy: "confidential", capturePolicy: "none", access: "invited_only" },
      program: {
        compositionMode: "active-speaker",
        layout: "active-speaker",
        shareLayout: "screen-speaker",
        assetLayout: "asset-speaker",
        tickerSpeed: 24,
        tickerText: "LIVE FROM THURSDAY — do not copy",
        scene: "live"
      },
      runOfShowItems: [
        { title: "Open", notes: "welcome", estimatedMinutes: 3, status: "completed", startedAt: 1, completedAt: 2 },
        { title: "Interview", preparedQuestions: ["Why now?"], estimatedMinutes: 12, status: "current", startedAt: 99 }
      ]
    })
  };
  const config = duplicateSessionConfig(rich);
  assertEqual(config.setup.sessionType, "jam", "duplicate copies show/session type");
  assertEqual(config.setup.layouts.compositionMode, "active-speaker", "duplicate copies layout mode");
  assertEqual(config.setup.layouts.shareLayout, "screen-speaker", "duplicate copies share layout");
  assertEqual(config.setup.ticker.speed, 24, "duplicate copies ticker speed");
  assertEqual(config.setup.runOfShow[0].title, "Open", "duplicate copies Run of Show titles");
  assertEqual(config.setup.runOfShow[1].preparedQuestions[0], "Why now?", "duplicate copies prepared questions");
  assert(!("status" in config.setup.runOfShow[0]), "ROS template has no live status");
  assert(!("startedAt" in config.setup.runOfShow[0]), "ROS template has no timestamps");
  assert(!("tickerText" in config.setup), "duplicate does not copy live ticker text");
  assert(!("scene" in config.setup), "duplicate does not copy live scene");
  assert(setupOmitsHistory(config.setup), "sanitized setup omits history keys");
  assert(config.omitsHistory, "duplicate config reports history omitted");
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
  const liveSession = readFileSync(join(root, "js/live-session.js"), "utf8");
  assert(html.includes("Studio Home"), "gate heading is Studio Home");
  assert(!html.includes("Live Studio Sessions"), "legacy Live Studio Sessions heading is gone");
  assert(html.includes("studioHomeBoard"), "Studio Home board render target exists");
  assert(html.includes("sessionArtifacts"), "artifacts surface exists");
  assert(manager.includes('mode: "artifacts"'), "ended URL resolves to artifacts");
  assert(manager.includes("canOpenLiveStudio"), "live open is gated");
  assert(director.includes('entry?.mode === "artifacts"'), "director does not boot live studio for artifacts");
  assert(director.includes('entry?.mode === "artifacts"'), "director branches on resolved session mode");
  assert(director.includes("session.applyDurableSession(entry?.session || entry)"), "director passes durable session record into LiveSession");
  assert(liveSession.includes('from "./studio-api.js"'), "LiveSession imports studio API helper");
  assert(liveSession.includes("studioRequest"), "LiveSession can call authenticated Studio APIs after New Session");
  assert(manager.includes("/duplicate"), "duplicate hits the session duplicate API");
  assert(manager.includes("/title"), "rename hits the session title API");
  assert(manager.includes("/delete"), "delete hits the session delete API");
  assert(manager.includes("Resume Live Session"), "live card resumes existing session");
  assert(manager.includes("End Session"), "live card can end session");
  assert(manager.includes("The live room will close"), "end confirm explains the room closes");
  assert(manager.includes("/api/sessions/${sessionId}/end") || manager.includes("/end"), "end uses existing end API");
  assert(manager.includes("You already have a live session"), "new session warns when live exists");
  assert(manager.includes("End & Create New"), "conflict offers end and create");
  assert(manager.includes("studio-home-live-now"), "LIVE NOW section exists");
  assert(manager.includes("confirmEndSession"), "end uses Cancel / End Session confirm");
  assert(!manager.includes("Open Studio") || manager.includes("Resume Live Session"), "resume copy is not Open Studio");
  assert(!manager.includes("This hides the card here"), "delete is not overlay-only");
  assert(!director.includes("RoomPresence ="), "director does not rewrite RoomPresence");
}

console.log("ALL PASSED — Studio Home lifecycle and artifacts.");
