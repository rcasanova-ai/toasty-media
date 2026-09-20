#!/usr/bin/env node
// Program Output visual pass — Technical Difficulties state wiring, session title flow, and the
// semantic-color-token cascade bug caught live while building this (see comment in program-output.css's
// .program-output rule): aliasing --po-text-primary etc. on :root silently locked them to the :root
// fallback forever, never seeing a brand's actual override, because --studio-cream is set via inline
// style on body.program-output, and a var() alias only re-resolves against an override at the SAME
// cascade level it's declared at. Caught by checking computed style in a live browser (Peeps' masthead
// rendered dark-theme colors instead of its own light-brand colors) — this test guards it from silently
// coming back since a plain "does the token exist" check wouldn't catch a wrong cascade level.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SceneId, normalizeScene, buildCanonicalState } from "../js/session-control.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("Technical Difficulties scene");
{
  assert(SceneId.TECHNICAL_DIFFICULTIES === "technical-difficulties", "SceneId.TECHNICAL_DIFFICULTIES has the expected value");
  assert(normalizeScene("technical-difficulties") === SceneId.TECHNICAL_DIFFICULTIES, "normalizeScene accepts technical-difficulties as valid, not silently falling back to holding");
  assert(normalizeScene("not-a-real-scene") === SceneId.HOLDING, "normalizeScene still falls back to holding for a genuinely unknown scene (regression guard on the fallback itself)");

  const liveSessionSrc = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
  assert(/scene === "technical-difficulties" \? SceneId\.TECHNICAL_DIFFICULTIES/.test(liveSessionSrc), 'LiveSession.setScene maps the string "technical-difficulties" to the new SceneId (producer button -> session.setScene(button.dataset.scene) wiring)');
  const setSceneStart = liveSessionSrc.indexOf("setScene(scene) {");
  const setSceneBody = liveSessionSrc.slice(setSceneStart, setSceneStart + 400);
  const tearsDownSession = /leaveStudio\(\)|endShow\(\)/.test(setSceneBody);
  assert(!tearsDownSession, "setScene() does not tear down the session/participants — Technical Difficulties is a pure scene flag, reversible to Live without losing state");

  const directorHtml = readFileSync(join(ROOT, "studio/director.html"), "utf8");
  assert(/data-scene="technical-difficulties"/.test(directorHtml), "Producer has a Technical Difficulties scene button");
  const listenerHtml = readFileSync(join(ROOT, "studio/listener.html"), "utf8");
  assert(/id="poTechnical"/.test(listenerHtml) && /id="poTechnicalLogo"/.test(listenerHtml), "Program Output has the Technical Difficulties scene screen with a brand-aware logo slot");
}

console.log("\nSession title flows through canonical program state (masthead's secondary line)");
{
  const state = buildCanonicalState({ roomId: "test-room", sessionTitle: "Toasty Peeps Live Demo" });
  assert(state.sessionTitle === "Toasty Peeps Live Demo", "buildCanonicalState passes sessionTitle through");
  const stateWithout = buildCanonicalState({ roomId: "test-room" });
  assert(stateWithout.sessionTitle === "", "sessionTitle defaults to empty string, not undefined (listener.js checks it directly for hidden/visible)");

  const liveSessionSrc = readFileSync(join(ROOT, "js/live-session.js"), "utf8");
  assert(/sessionTitle: this\.durableSession\?\.title \|\| ""/.test(liveSessionSrc), "LiveSession.canonicalControlState sources sessionTitle from the durable session's own title, not a duplicate/new field");
}

console.log("\nSemantic color tokens are declared at the correct cascade level (the actual bug caught live)");
{
  const css = readFileSync(join(ROOT, "css/program-output.css"), "utf8");
  const rootBlock = css.slice(css.indexOf(":root {"), css.indexOf(":root {") + css.slice(css.indexOf(":root {")).indexOf("\n}") + 2);
  assert(!rootBlock.includes("--po-text-primary"), "--po-text-primary is NOT declared on :root (that would freeze it to the :root fallback and never see a brand's own --studio-cream override — confirmed live: Peeps rendered dark-theme text before this was fixed)");

  const programOutputBlock = css.slice(css.indexOf(".program-output {"), css.indexOf(".program-output {") + css.slice(css.indexOf(".program-output {")).indexOf("\n}") + 2);
  for (const token of ["--po-text-primary", "--po-text-secondary", "--po-text-on-media", "--po-surface", "--po-surface-muted"]) {
    assert(programOutputBlock.includes(token), `${token} IS declared on .program-output (body) — the same element applyBrandTheme sets --studio-cream/--studio-surface on, so the alias re-resolves against each brand's real override`);
  }
  assert(programOutputBlock.includes("var(--studio-cream)"), "--po-text-primary aliases the existing brand-flipping --studio-cream, not a new hardcoded color (would break white-label skins)");
}

console.log("\nSolo (1-participant) composition is a centered ~4:3 frame, not full-bleed");
{
  const css = readFileSync(join(ROOT, "css/program-output.css"), "utf8");
  const soloBlock = css.slice(css.indexOf('.po-stage[data-layout="1"] .po-tile {'), css.indexOf('.po-stage[data-layout="1"] .po-tile {') + 200);
  assert(soloBlock.includes("aspect-ratio: 4 / 3"), "solo tile has an explicit 4:3 aspect-ratio");
  assert(soloBlock.includes("max-width: 100%"), "solo tile is still capped at 100% width (cannot overflow the containing flex row even at an unusual viewport)");
}

console.log("\nTrio (3-participant) composition is an intentional 2+1, not a plain 3-column row");
{
  const css = readFileSync(join(ROOT, "css/program-output.css"), "utf8");
  assert(!/data-layout="3"\]\s*\{\s*grid-template-columns:\s*repeat\(3,/.test(css), "trio layout is no longer a flat repeat(3, ...) row");
  assert(/data-layout="3"\]\s*\{[^}]*grid-template-columns:\s*repeat\(2,/.test(css), "trio layout uses a 2-column grid (2 up, 1 centered below)");
  assert(css.includes(':nth-child(3) {') && css.includes("grid-column: 1 / -1"), "the third trio tile spans both columns, centered underneath the top two");
}

console.log("\nAll program-output visual pass checks passed.");
