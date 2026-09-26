// Read-only "originating Jam" context for studio/director.html (Phase 4). Peeps remains the source of
// truth for people/recruitment — this never turns Studio into a Peeps management UI, it only reads
// GET /api/sessions/:id/jam and displays it. The session id comes straight from the URL's own ?session=
// param, exactly what js/session-planner-page.js's "Open Studio" link (and Peeps' own jam.html) already
// set it to — no coupling to director.js's internal LiveSession instance needed for a display-only panel.
import { getStudioSessionJamContext } from "./peeps-jam-api.js";

async function init() {
  const panel = document.getElementById("jamContextPanel");
  const sessionId = new URLSearchParams(window.location.search).get("session");
  if (!panel || !sessionId) return;
  try {
    const result = await getStudioSessionJamContext(sessionId);
    const jam = result.jam;
    if (!jam) return;
    document.getElementById("jamContextTitle").textContent = `“${jam.title || "Untitled Jam"}” — ${jam.status}`;
    document.getElementById("jamContextObjective").textContent = jam.objective || "No objective set.";
    document.getElementById("jamContextOrg").textContent = jam.organizationName ? `Client: ${jam.organizationName}` : "";
    document.getElementById("jamContextParticipants").textContent = `${jam.confirmedCount} / ${jam.targetParticipantCount} participants confirmed`;
    document.getElementById("jamContextConsent").textContent = `${jam.consentSummary.consentCaptured} / ${jam.consentSummary.totalParticipants} participants have completed required consent`;
    panel.hidden = false;
  } catch {
    // Read-only convenience panel — a failed lookup must never break the Studio producer view.
  }
}

init();
