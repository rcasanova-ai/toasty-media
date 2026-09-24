#!/usr/bin/env node
// js/program-geometry.js — the Program Output layout engine's per-layout/per-orientation geometry spec.
// Pure functions, no DOM/browser needed except a tiny stub for applyProgramGeometry's style.setProperty
// calls. Run: node scripts/program-geometry-test.mjs

import { resolveProgramGeometry, applyProgramGeometry, programOrientationFor, ProgramOrientation } from "../js/program-geometry.js";
import { ProgramLayout } from "../js/program-composition.js";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function fakeStage() {
  const properties = {};
  return {
    dataset: {},
    style: { setProperty: (name, value) => { properties[name] = value; } },
    _properties: properties
  };
}

console.log("Every ProgramLayout resolves a complete, sane geometry in both orientations");
{
  for (const layout of Object.values(ProgramLayout)) {
    for (const orientation of Object.values(ProgramOrientation)) {
      const geometry = resolveProgramGeometry(layout, orientation);
      assert(geometry.layout === layout, `${layout}/${orientation} — layout echoed back`);
      assert(geometry.orientation === orientation, `${layout}/${orientation} — orientation echoed back`);
      assert(typeof geometry.canvasPadding === "string" && geometry.canvasPadding.length > 0, `${layout}/${orientation} — canvasPadding is a non-empty string`);
      assert(typeof geometry.gap === "string", `${layout}/${orientation} — gap is a string`);
      const scale = geometry.frame.scale;
      assert(typeof scale === "number" && scale > 0.5 && scale <= 1, `${layout}/${orientation} — frame scale ${scale} is a sane fraction of its cell (0.5, 1]`);
      assert(typeof geometry.frame.radius === "string", `${layout}/${orientation} — frame radius is a string`);
      assert(typeof geometry.frame.border === "string", `${layout}/${orientation} — frame border is a string`);
      assert(typeof geometry.frame.shadow === "string", `${layout}/${orientation} — frame shadow is a string`);
      assert(geometry.frame.fit === "cover", `${layout}/${orientation} — fit mode is cover`);
      for (const zone of ["logo", "caption", "ticker", "cta"]) {
        assert(geometry.safeZones[zone], `${layout}/${orientation} — safe zone "${zone}" is declared`);
      }
    }
  }
}

console.log("\nAn unrecognized layout falls back to DUO's spec, not undefined/NaN geometry");
{
  const fallback = resolveProgramGeometry("not-a-real-layout", ProgramOrientation.LANDSCAPE);
  const duo = resolveProgramGeometry(ProgramLayout.DUO, ProgramOrientation.LANDSCAPE);
  assert(fallback.canvasPadding === duo.canvasPadding, "unrecognized layout uses DUO's canvasPadding");
  assert(fallback.frame.scale === duo.frame.scale, "unrecognized layout uses DUO's frame scale");
}

console.log("\nLandscape and portrait use genuinely different geometry per layout (not a shared table with an ignored orientation argument)");
{
  for (const layout of Object.values(ProgramLayout)) {
    const landscape = resolveProgramGeometry(layout, ProgramOrientation.LANDSCAPE);
    const portrait = resolveProgramGeometry(layout, ProgramOrientation.PORTRAIT);
    const differs = landscape.canvasPadding !== portrait.canvasPadding || landscape.frame.scale !== portrait.frame.scale;
    assert(differs, `${layout} — portrait geometry differs from landscape (canvasPadding or frame scale)`);
  }
}

console.log("\nprogramOrientationFor is SSR/no-window safe and respects matchMedia");
{
  assert(programOrientationFor(undefined) === ProgramOrientation.LANDSCAPE, "no view -> landscape default, never throws");
  assert(programOrientationFor({}) === ProgramOrientation.LANDSCAPE, "a view with no matchMedia -> landscape default");
  const portraitView = { matchMedia: () => ({ matches: true }) };
  assert(programOrientationFor(portraitView) === ProgramOrientation.PORTRAIT, "matchMedia matches -> portrait");
  const landscapeView = { matchMedia: () => ({ matches: false }) };
  assert(programOrientationFor(landscapeView) === ProgramOrientation.LANDSCAPE, "matchMedia does not match -> landscape");
}

console.log("\napplyProgramGeometry writes every geometry field as a CSS custom property on the stage");
{
  const stage = fakeStage();
  const geometry = resolveProgramGeometry(ProgramLayout.TRIO, ProgramOrientation.LANDSCAPE);
  applyProgramGeometry(stage, geometry);
  assert(stage.dataset.orientation === "landscape", "stage.dataset.orientation is set");
  assert(stage._properties["--po-canvas-padding"] === geometry.canvasPadding, "--po-canvas-padding matches the resolved geometry");
  assert(stage._properties["--po-frame-scale"] === String(geometry.frame.scale), "--po-frame-scale is written as a string");
  assert(stage._properties["--po-frame-fit"] === "cover", "--po-frame-fit is written");
  assert(stage._properties["--po-safe-logo-top"] === geometry.safeZones.logo.top, "safe-zone properties are written per side");
  assert(stage._properties["--po-safe-cta-right"] === geometry.safeZones.cta.right, "CTA safe zone right side is written");
}

console.log("\napplyProgramGeometry is a no-op (never throws) on a stage with no style, e.g. a detached/unmounted element");
{
  applyProgramGeometry(null, resolveProgramGeometry(ProgramLayout.SINGLE));
  applyProgramGeometry({}, resolveProgramGeometry(ProgramLayout.SINGLE));
  console.log("  ok — null/style-less stage does not throw");
}

console.log("\nAll program-geometry tests passed.");
