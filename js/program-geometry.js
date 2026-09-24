// Program Output geometry — the layout engine's contract for how a branded canvas composes video
// frames, not a grab-bag of unrelated CSS numbers. Every ProgramLayout gets an explicit spec: how much
// canvas margin surrounds the composition, how much a frame is scaled DOWN from its slot (the gap between
// that and 100% is branded canvas showing through — see BrandProfile's backgroundSilhouette/surfaceGradient
// in js/brand-themes.js, which paint that canvas), frame chrome (radius/border/shadow), video fit/focal
// point, and the safe-zone rectangles chrome (logo/caption/ticker/CTA) reserves.
//
// js/program-renderer.js's syncProgramRenderer() calls resolveProgramGeometry() once per composeProgram()
// result and applies it as CSS custom properties on the stage element (css/program-output.css's
// .po-stage/.po-tile, and the Producer's mirrored .lv-program-preview in css/studio.css both key off the
// SAME custom properties) — deliberately NOT new fixed CSS rules, so this module is the one place that
// actually decides "how floaty is this layout," in code, per layout and per orientation.
//
// This intentionally reuses the existing CSS Grid track sizing (composeProgram's minmax(0, 1fr) tracks —
// see program-output-geometry-test.mjs for exactly why those tracks must never regress to a bare 1fr) for
// containment/overflow safety, and only controls how much SMALLER than its grid cell each frame renders.
// That split is deliberate: the grid still guarantees no tile can ever push the stage wider than the
// viewport; geometry only ever shrinks a tile relative to its already-safe cell, so it can't reintroduce
// the overflow bug that stylesheet's regression test guards against.

import { ProgramLayout } from "./program-composition.js";

export const ProgramOrientation = Object.freeze({ LANDSCAPE: "landscape", PORTRAIT: "portrait" });

const DEFAULT_FRAME = Object.freeze({
  scale: 0.92,
  radius: "16px",
  border: "1px solid rgba(255, 255, 255, 0.14)",
  shadow: "0 20px 46px rgba(0, 0, 0, 0.42)",
  fit: "cover",
  focal: "center 38%"
});

// Safe-zone rectangles chrome (logo/caption/ticker/CTA) reserves on the canvas, as percentages of the
// canvas box. Logo/ticker are already rendered as separate .po-chrome rows above/below .po-stage today
// (never overlaid on video), and there is no CTA overlay implemented yet (see js/program-renderer.js) —
// these are still declared here, uniformly, so every layout carries a real, inspectable safe-zone contract
// instead of that being decided ad hoc if/when a CTA overlay is built.
const DEFAULT_SAFE_ZONES = Object.freeze({
  logo: Object.freeze({ top: "3%", left: "3%", width: "20%", height: "12%" }),
  caption: Object.freeze({ bottom: "4%", left: "5%", width: "62%", height: "14%" }),
  ticker: Object.freeze({ bottom: "0%", left: "0%", width: "100%", height: "7%" }),
  cta: Object.freeze({ bottom: "10%", right: "4%", width: "24%", height: "16%" })
});

// canvasPadding: extra margin around the WHOLE composition, beyond the frame scale-down below — this is
// what keeps e.g. SINGLE from just being one big video with a thin border, and keeps SCREEN_ONLY/ASSET_FULL
// (which intentionally scale close to 100%, since a shared screen or a full-bleed asset IS the content)
// from touching the canvas edge.
const LANDSCAPE_SPEC = Object.freeze({
  [ProgramLayout.SINGLE]: { canvasPadding: "6% 12%", gap: "0", frame: { scale: 0.84 } },
  [ProgramLayout.DUO]: { canvasPadding: "5% 7%", gap: "3%", frame: { scale: 0.9 } },
  [ProgramLayout.TRIO]: { canvasPadding: "4% 6%", gap: "2.6%", frame: { scale: 0.88 } },
  [ProgramLayout.QUAD]: { canvasPadding: "3.5% 5%", gap: "2.2%", frame: { scale: 0.86 } },
  [ProgramLayout.SPOTLIGHT]: { canvasPadding: "4% 5%", gap: "2.4%", frame: { scale: 0.92 } },
  [ProgramLayout.ACTIVE_SPEAKER]: { canvasPadding: "4% 5%", gap: "2.4%", frame: { scale: 0.92 } },
  [ProgramLayout.SCREEN_SPEAKER]: { canvasPadding: "3% 4%", gap: "2%", frame: { scale: 0.96, focal: "center" } },
  [ProgramLayout.SCREEN_ONLY]: { canvasPadding: "2.5% 3%", gap: "0", frame: { scale: 0.97, focal: "center" } },
  [ProgramLayout.SCREEN_STRIP]: { canvasPadding: "3% 4%", gap: "1.6%", frame: { scale: 0.94, focal: "center" } },
  [ProgramLayout.ASSET_FULL]: { canvasPadding: "2% 2.5%", gap: "0", frame: { scale: 0.98, focal: "center" } },
  [ProgramLayout.ASSET_SPEAKER]: { canvasPadding: "3% 4%", gap: "2%", frame: { scale: 0.95 } },
  [ProgramLayout.ASSET_SPEAKER_PIP]: { canvasPadding: "2.5% 3%", gap: "0", frame: { scale: 0.98, focal: "center" } }
});

// Portrait keeps frames a touch smaller and canvas margins a touch tighter side-to-side (there's less
// horizontal room to spare) but MORE margin top/bottom between stacked frames, so a portrait composition
// still reads as frames floating on a canvas rather than becoming edge-to-edge stacked rectangles.
const PORTRAIT_SPEC = Object.freeze({
  [ProgramLayout.SINGLE]: { canvasPadding: "8% 6%", gap: "0", frame: { scale: 0.86 } },
  [ProgramLayout.DUO]: { canvasPadding: "5% 5%", gap: "3.2%", frame: { scale: 0.88 } },
  [ProgramLayout.TRIO]: { canvasPadding: "4% 4%", gap: "2.6%", frame: { scale: 0.87 } },
  [ProgramLayout.QUAD]: { canvasPadding: "3.5% 3.5%", gap: "2.2%", frame: { scale: 0.85 } },
  [ProgramLayout.SPOTLIGHT]: { canvasPadding: "4% 4%", gap: "2.2%", frame: { scale: 0.89 } },
  [ProgramLayout.ACTIVE_SPEAKER]: { canvasPadding: "4% 4%", gap: "2.2%", frame: { scale: 0.89 } },
  [ProgramLayout.SCREEN_SPEAKER]: { canvasPadding: "3% 3%", gap: "1.8%", frame: { scale: 0.95, focal: "center" } },
  [ProgramLayout.SCREEN_ONLY]: { canvasPadding: "2.5% 2.5%", gap: "0", frame: { scale: 0.97, focal: "center" } },
  [ProgramLayout.SCREEN_STRIP]: { canvasPadding: "3% 3%", gap: "1.6%", frame: { scale: 0.93, focal: "center" } },
  [ProgramLayout.ASSET_FULL]: { canvasPadding: "2% 2%", gap: "0", frame: { scale: 0.98, focal: "center" } },
  [ProgramLayout.ASSET_SPEAKER]: { canvasPadding: "3% 3%", gap: "1.8%", frame: { scale: 0.94 } },
  [ProgramLayout.ASSET_SPEAKER_PIP]: { canvasPadding: "2.5% 2.5%", gap: "0", frame: { scale: 0.98, focal: "center" } }
});

function mergeFrame(overrides = {}) {
  return { ...DEFAULT_FRAME, ...overrides };
}

// layout is a ProgramLayout value (or "fullmedia"/unrecognized — falls back to DUO's spec, a reasonable
// balanced default rather than an unstyled/undefined geometry).
export function resolveProgramGeometry(layout, orientation = ProgramOrientation.LANDSCAPE) {
  const table = orientation === ProgramOrientation.PORTRAIT ? PORTRAIT_SPEC : LANDSCAPE_SPEC;
  const entry = table[layout] || table[ProgramLayout.DUO];
  return {
    layout,
    orientation,
    canvasPadding: entry.canvasPadding,
    gap: entry.gap,
    frame: mergeFrame(entry.frame),
    safeZones: DEFAULT_SAFE_ZONES
  };
}

// Real orientation detection belongs with the DOM (a stage's rendered aspect ratio), not this pure data
// module — this just centralizes the one query so program-renderer.js and any other caller agree on what
// "portrait" means. Matches css/program-output.css's existing `@media (max-aspect-ratio: 3/4)` portrait
// breakpoint exactly, so JS-driven geometry and the CSS restacking it complements never disagree.
export function programOrientationFor(view) {
  if (!view?.matchMedia) return ProgramOrientation.LANDSCAPE;
  return view.matchMedia("(max-aspect-ratio: 3/4)").matches ? ProgramOrientation.PORTRAIT : ProgramOrientation.LANDSCAPE;
}

const SAFE_ZONE_SIDES = ["top", "bottom", "left", "right", "width", "height"];

// Applies a resolved geometry to a stage element as CSS custom properties — see css/program-output.css's
// ":root" block and css/studio.css's .lv-program-preview rules for the consuming side. Both Program
// Output's real stage (.po-stage) and the Producer's mirrored preview (.lv-program-preview) read the same
// property names, since js/program-renderer.js's syncProgramRenderer() is the ONE function that mounts
// both (see that file's header comment) and this is called from inside it.
export function applyProgramGeometry(stage, geometry) {
  if (!stage?.style) return;
  stage.dataset.orientation = geometry.orientation;
  stage.style.setProperty("--po-canvas-padding", geometry.canvasPadding);
  stage.style.setProperty("--po-frame-gap-dynamic", geometry.gap);
  stage.style.setProperty("--po-frame-scale", String(geometry.frame.scale));
  stage.style.setProperty("--po-frame-radius-dynamic", geometry.frame.radius);
  stage.style.setProperty("--po-frame-border-dynamic", geometry.frame.border);
  stage.style.setProperty("--po-frame-shadow-dynamic", geometry.frame.shadow);
  stage.style.setProperty("--po-frame-fit", geometry.frame.fit);
  stage.style.setProperty("--po-frame-focal", geometry.frame.focal);
  for (const [name, rect] of Object.entries(geometry.safeZones)) {
    for (const side of SAFE_ZONE_SIDES) {
      stage.style.setProperty(`--po-safe-${name}-${side}`, rect[side] ?? "auto");
    }
  }
}
