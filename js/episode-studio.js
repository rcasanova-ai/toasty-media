// Episode controls inside Studio's private Session Plan panel. Host and producer only. Shows the episode's story beats,
// questions and private notes without forcing a teleprompter, lets the producer mark moments while recording, and
// ties the finished recording and transcript back to the planned episode. Reuses the existing marker log, "recording"
// event and TranscriptStore; it adds no recording code of its own.
import { studioRequest } from "./studio-api.js";
import { EPISODE_STATUSES, EPISODE_MOXIE_PROMPTS, MOMENT_KINDS } from "./episode-model.js";

const KIND_LABEL = { clip: "Clip moment", important: "Important", fact_check: "Check this fact" };
const el = (tag, text, className) => { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; };

async function production(session, op, item) {
  const result = await studioRequest(`/api/sessions/${encodeURIComponent(session.durableSession.id)}/episode-production`, { method: "POST", body: JSON.stringify({ op, item }) });
  if (result.session) session.durableSession.plan = result.session.plan;
  return result.session;
}

function recordingOffsetSeconds(session) {
  const startedAt = session.recording?.status === "recording" ? session.recording.startedAt : null;
  return startedAt ? Math.max(0, Math.round((Date.now() - startedAt) / 1000)) : Math.round((session.elapsedMs?.() || 0) / 1000);
}

function listBlock(title, items) {
  if (!items?.length) return null;
  const wrap = el("div", undefined, "lv-prep-block");
  wrap.append(el("h4", title));
  const ul = el("ul");
  for (const item of items) ul.append(el("li", item));
  wrap.append(ul);
  return wrap;
}

export function renderEpisodeBlock(session, container, summary) {
  container.textContent = "";
  const e = summary.episode;
  if (!e) { container.hidden = true; return; }
  container.hidden = false;
  const head = el("div", undefined, "lv-prep-block");
  head.append(el("h4", `Episode${e.number ? ` ${e.number}` : ""}: ${e.workingTitle || "Untitled"}`));
  const status = el("select"); status.setAttribute("aria-label", "Episode status");
  for (const s of EPISODE_STATUSES) { const o = el("option", s.label); o.value = s.id; if (s.id === e.status) o.selected = true; status.append(o); }
  status.addEventListener("change", () => production(session, "status", { status: status.value }).catch((err) => console.warn("[Episode] status not saved", err)));
  head.append(status);
  if (e.openingHook) head.append(el("p", `Opening hook: ${e.openingHook}`));
  container.append(head);

  const marks = el("div", undefined, "lv-prep-block");
  marks.append(el("h4", "Mark a moment"));
  const status2 = el("p", `${e.production.moments.length} marked so far`, "lv-hint");
  for (const kind of MOMENT_KINDS) {
    const b = el("button", KIND_LABEL[kind], "lv-mini-btn"); b.type = "button";
    b.addEventListener("click", async () => {
      const at = recordingOffsetSeconds(session);
      try { session.addMarker?.(`${KIND_LABEL[kind]} @ ${at}s`); } catch (_) { /* the marker log is best effort */ }
      try {
        await production(session, "moments", { kind, label: `${KIND_LABEL[kind]}`, atSeconds: at, recordingId: session.recording?.recordingId || "" });
        status2.textContent = `Marked ${KIND_LABEL[kind].toLowerCase()} at ${Math.floor(at / 60)}:${String(at % 60).padStart(2, "0")}`;
      } catch (err) { status2.textContent = "Could not save that mark. It is still in the recording markers."; }
    });
    marks.append(b, document.createTextNode(" "));
  }
  marks.append(status2);
  container.append(marks);

  const more = el("details", undefined, "lv-prep-guest");
  more.append(el("summary", "Story beats, questions and private notes"));
  more.append(...[listBlock("Story beats", e.storyBeats), listBlock("Key topics", e.topics), listBlock("Interview questions", e.questions), listBlock("Remember", e.importantDetails), listBlock("Facts to verify", e.factsToVerify), listBlock("Sensitive", e.sensitiveDetails)].filter(Boolean));
  if (e.privateNotes) more.append(el("p", `Private notes: ${e.privateNotes}`));
  container.append(more);
}

// Wires the recording lifecycle once per session. Safe to call repeatedly.
export function watchEpisodeRecording(session) {
  if (session.__episodeWatch || typeof session.on !== "function") return;
  session.__episodeWatch = true;
  let lastSeen = session.recording?.last?.recordingId || null;
  session.on("recording", (state) => {
    const last = state?.last;
    if (state?.status !== "idle" || !last?.recordingId || last.recordingId === lastSeen) return;
    lastSeen = last.recordingId;
    if (!session.durableSession?.plan?.episode) return;
    const episode = session.durableSession.plan.episode;
    production(session, "recordings", { recordingId: last.recordingId, durationSeconds: last.durationSeconds || 0 })
      .then(() => {
        const lines = session.transcript?.lines || [];
        if (lines.length) return production(session, "transcript", { recordingId: last.recordingId, lineCount: lines.length, speakers: [...new Set(lines.map((l) => l.speaker).filter(Boolean))] });
        return null;
      })
      .then(() => (["draft", "planned", "ready_to_record"].includes(episode.status) ? production(session, "status", { status: "recorded" }) : null))
      .catch((err) => console.warn("[Episode] could not link the recording to the episode", err));
  });
}

export { EPISODE_MOXIE_PROMPTS };
