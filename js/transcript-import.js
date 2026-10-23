// Turn a transcript file into timed lines { t, end, speaker, text } (seconds). Reads SRT, WebVTT, Toasty transcript JSON
// (from "Download Transcript") and plain "[00:12] Name: text" / "Name: text" text. All local.
const toSeconds = (s) => { const m = String(s).trim().replace(",", ".").match(/^(?:(\d+):)?(\d{1,2}):(\d{2})(?:\.(\d+))?$/); return m ? (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) + (m[4] ? Number("0." + m[4]) : 0) : null; };

function parseCues(text) {
  const lines = [];
  const blocks = text.replace(/\r/g, "").split(/\n{2,}/);
  for (const b of blocks) {
    const rows = b.split("\n").filter(Boolean);
    const timing = rows.findIndex((r) => /-->/.test(r));
    if (timing < 0) continue;
    const [a, c] = rows[timing].split("-->").map((x) => x.trim().split(/\s+/)[0]);
    const start = toSeconds(a), end = toSeconds(c);
    if (start == null) continue;
    const body = rows.slice(timing + 1).join(" ").replace(/<[^>]+>/g, "").trim();
    const sp = body.match(/^([A-Z][\w .'-]{0,24}):\s+(.*)$/);
    if (body) lines.push({ t: start, end: end ?? undefined, speaker: sp ? sp[1] : "", text: sp ? sp[2] : body });
  }
  return lines;
}

export function parseTranscript(text, { recordingStartMs = null } = {}) {
  const raw = String(text || "").trim();
  if (!raw) return [];
  if (raw.startsWith("{") || raw.startsWith("[")) {
    try {
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : data.lines || data.transcript?.lines || [];
      return arr.map((l) => {
        const t = Number.isFinite(l.t) ? l.t : Number.isFinite(l.start) ? l.start : Number.isFinite(l.offsetSeconds) ? l.offsetSeconds : (l.timestamp && recordingStartMs != null ? (Number(l.timestamp) - recordingStartMs) / 1000 : null);
        return t == null ? null : { t, end: l.end ?? undefined, speaker: l.speaker || "", text: String(l.text || "") };
      }).filter((l) => l && l.text);
    } catch (_) { /* fall through to text */ }
  }
  if (/-->/.test(raw)) return parseCues(raw);
  const out = [];
  let last = 0;
  for (const row of raw.split(/\n/)) {
    const m = row.match(/^\s*\[?(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\]?\s*(?:([A-Z][\w .'-]{0,24}):\s+)?(.*)$/);
    if (m && toSeconds(m[1]) != null && m[3]) { last = toSeconds(m[1]); out.push({ t: last, speaker: m[2] || "", text: m[3].trim() }); }
  }
  return out;
}
