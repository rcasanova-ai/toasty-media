// Toasty-owned, renderer-neutral edit decision list. No Concat code or dependency.
// Source times are absolute; timeline caption times are local to each segment.
import { ASPECTS, validateTemplate } from "./clip-templates.js";
import { captionWords } from "./clip-timeline.js";

const finite = (n) => typeof n === "number" && Number.isFinite(n);
const clean = (s, limit = 120) => String(s ?? "").replace(/[\u0000-\u001f]/g, " ").slice(0, limit);
const round = (n) => Math.round(n * 1000) / 1000;

export function createEditDecisionList({ sourceId, duration, clips, transcript = [], format = "9:16", template = {}, brand = "toasty" }) {
  if (!sourceId || !finite(duration) || duration <= 0) throw new TypeError("Valid sourceId and source duration required");
  if (!(format in ASPECTS)) throw new RangeError("Unsupported output format");
  if (!Array.isArray(clips) || clips.length === 0 || clips.length > 100) throw new RangeError("Supply 1 to 100 clips");
  const style = validateTemplate(template);
  const edits = clips.map((clip, index) => {
    if (!finite(clip?.start) || !finite(clip?.end) || clip.start < 0 || clip.end > duration || clip.end <= clip.start) {
      throw new RangeError("Invalid clip bounds at index " + index);
    }
    const words = captionWords(transcript, clip.start, clip.end)
      .map(w => ({ text: clean(w.text, 80), start: round(w.start), end: round(w.end) }))
      .filter(w => w.end > w.start);
    return {
      id: "shot-" + (index + 1),
      sourceId: clean(sourceId, 200),
      source: { in: round(clip.start), out: round(clip.end) },
      timelineStart: round(clips.slice(0, index).reduce((sum, item) => sum + item.end - item.start, 0)),
      title: clean(clip.title, 90),
      captions: words,
      overlays: Array.isArray(clip.overlays) ? clip.overlays.slice(0, 20).map(o => ({
        text: clean(o?.text, 140),
        at: finite(o?.at) ? Math.max(0, round(o.at)) : 0
      })) : []
    };
  });
  const total = round(edits.reduce((sum, e) => sum + e.source.out - e.source.in, 0));
  return {
    version: 1, engine: "toasty", source: { id: clean(sourceId, 200), duration: round(duration) },
    output: { format, width: ASPECTS[format].width, height: ASPECTS[format].height, duration: total },
    brand: clean(brand, 60),
    style: {
      captions: style.captions, camera: style.camera, transition: style.transition,
      overlays: style.overlays, intro: style.intro, outro: style.outro,
      audio: style.audio, music: style.music, theme: style.theme
    },
    edits
  };
}

export function validateEditDecisionList(input) {
  if (!input || input.version !== 1 || input.engine !== "toasty") throw new TypeError("Unsupported Toasty EDL version");
  if (!Array.isArray(input.edits) || !input.edits.length) throw new TypeError("Empty EDL");
  const clips = input.edits.map(e => ({ start: e?.source?.in, end: e?.source?.out, title: e.title, overlays: e.overlays }));
  return createEditDecisionList({
    sourceId: input.source?.id, duration: input.source?.duration,
    format: input.output?.format, brand: input.brand,
    template: input.style, clips
  });
}
