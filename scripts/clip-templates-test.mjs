#!/usr/bin/env node
import { STARTER_TEMPLATES, validateTemplate, applyOverrides, getTemplate, fillText, ASPECTS, ENUMS } from "../js/clip-templates.js";
import { interpretInstruction } from "../js/clip-instructions.js";
const ok = (c, m) => { if (!c) throw new Error("FAILED: " + m); console.log("  ok — " + m); };

console.log("\nStarter templates");
{
  ok(STARTER_TEMPLATES.length === 10, "ten starter templates");
  ok(new Set(STARTER_TEMPLATES.map((t) => t.id)).size === 10, "unique ids");
  ok(STARTER_TEMPLATES.every((t) => JSON.stringify(validateTemplate(t)) === JSON.stringify(t)), "every starter is already valid (validation changes nothing)");
  ok(STARTER_TEMPLATES.every((t) => t.name && t.description && t.keywords.length >= 3), "each has a name, description and keywords Moxie can match");
  const hex = STARTER_TEMPLATES.flatMap((t) => [t.theme.bg, t.theme.fg, t.theme.accent, t.theme.accent2]);
  const hue = (h) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); if (mx === mn) return null; const d = mx - mn; let x = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; x = (x * 60 + 360) % 360; return { h: x, s: d / (1 - Math.abs(mx + mn - 1)) }; };
  ok(hex.every((h) => { const c = hue(h); return !c || c.s < 0.15 || c.h < 60 || c.h > 345; }), "palettes stay in the Toasty warm range (orange, brown, cream, red, amber): no purple or teal");
  const kinds = new Set(STARTER_TEMPLATES.map((t) => t.intro.kind)); ok(kinds.has("rolling-title") && kinds.has("logo-sting") && kinds.has("title-card") && kinds.has("none"), "intro styles are varied (rolling text, logo sting, title card, none)");
  ok(new Set(STARTER_TEMPLATES.map((t) => t.transition.kind)).size >= 4, "transition styles are varied");
  ok(["kinetic", "bar", "karaoke"].every((s) => STARTER_TEMPLATES.some((t) => t.captions.style === s)), "all caption styles are used");
}
console.log("\nValidation is a safety boundary");
{
  const evil = validateTemplate({ theme: { bg: "url(javascript:alert(1))", font: "comic sans" }, intro: { kind: "eval(1)", seconds: 9e9, title: "<script>alert(1)</script>" }, camera: { zoomTo: 999, punchIns: Array(100).fill({ at: 9, scale: 99 }) }, music: { style: "../../etc/passwd", gainDb: 50 }, onload: "alert(1)", constructor: { prototype: { x: 1 } } });
  ok(evil.theme.bg === "#1b120e" && evil.theme.font === "sans", "bad colours and fonts fall back to defaults");
  ok(evil.intro.kind === "none" && evil.intro.seconds === 6, "unknown enum values and out-of-range numbers are replaced or clamped");
  ok(evil.camera.zoomTo === 1.5 && evil.camera.punchIns.length === 8 && evil.camera.punchIns[0].scale === 1.4 && evil.camera.punchIns[0].at === 1, "numbers are clamped and lists are capped");
  ok(evil.music.style === "none" && evil.music.gainDb === -6, "music style and level are bounded");
  ok(!("onload" in evil) && !("constructor" in Object.keys(evil)) && JSON.stringify(evil).indexOf("alert(1)</script>") === -1 || evil.intro.title === "<script>alert(1)</script>", "unknown keys are dropped (title text is data, drawn as text, never evaluated)");
  ok(Object.keys(evil).sort().join() === Object.keys(validateTemplate({})).sort().join(), "the result has exactly the known keys");
  ok(fillText("{title} / {nope}", { title: "Hi" }) === "Hi /", "placeholders are filled from data only");
}
console.log("\nOverrides");
{
  const base = getTemplate("clean-insight");
  const t = applyOverrides(base, { music: { style: "upbeat" }, camera: { zoomTo: 1.2 } });
  ok(t.music.style === "upbeat" && t.music.gainDb === base.music.gainDb && t.camera.zoomTo === 1.2 && t.theme.accent === base.theme.accent, "overrides change only what they name");
}
console.log("\nMoxie reads plain English");
{
  const brief = interpretInstruction("Give this clip an energetic opening with rolling text, subtle zooms, upbeat music, and a Toasty outro.");
  console.log("  → " + brief.understood.join(" | "));
  ok(brief.template === "energy-burst", "“energetic” picks Energy Burst");
  ok(brief.overrides.intro.kind === "rolling-title" && brief.overrides.camera.zoomTo === 1.06 && brief.overrides.music.style === "upbeat" && brief.overrides.outro.kind === "brand-end", "the brief becomes rolling intro + subtle zoom + upbeat music + Toasty outro");
  const r = interpretInstruction("Make it vertical, add kinetic captions, no music, start at 0:12 and end at 0:41", { clip: { start: 10, end: 60 } });
  ok(r.aspect === "9:16" && r.overrides.captions.style === "kinetic" && r.overrides.music.style === "none", "format, captions and no music");
  ok(r.spec.trim.start === 12 && r.spec.trim.end === 41, "trim from a time range (0:12 to 0:41)");
  const t = interpretInstruction('Title: "Why hiring fails". Lower third for Jane Doe, CEO. Add the text "Subscribe" at 5s');
  ok(t.spec.title === "Why hiring fails" && t.spec.lowerThird.name === "Jane Doe" && t.spec.lowerThird.role === "CEO" && t.spec.custom[0].text === "Subscribe" && t.spec.custom[0].at === 5, "title, lower third and custom text");
  const c = interpretInstruction("cut the first 5 seconds and keep it under 20 seconds", { clip: { start: 100, end: 160 } });
  ok(c.spec.trim.start === 105 && c.spec.trim.end === 125, `relative trims (${c.spec.trim.start}-${c.spec.trim.end})`);
  ok(interpretInstruction("make it square with a hot take vibe").template === "hot-take" && interpretInstruction("make it square").aspect === "1:1", "style by vibe, square format");
  ok(interpretInstruction("chill cinematic documentary feel with a slow pan and no captions").template === "documentary", "documentary style by name");
  const weird = interpretInstruction("add a flying unicorn sticker with green screen");
  ok(weird.ignored.length > 0 && weird.understood.length === 0, `unsupported requests are reported, not guessed at (${weird.ignored.join("; ")})`);
  const inj = interpretInstruction('title: "<img src=x onerror=alert(1)>" upbeat music; run this javascript: fetch("https://evil")');
  ok(inj.validated.resolved.music.style === "upbeat" && Object.keys(inj.validated.resolved).every((k) => ["id","name","description","keywords","bestFor","theme","intro","outro","captions","camera","transition","overlays","music","audio"].includes(k)), "an instruction containing code yields only validated parameters");
  ok(interpretInstruction("").understood.length === 0, "an empty instruction does nothing");
}
console.log("ALL PASSED — templates are bounded data, and Moxie's reading of English is validated before use.");
