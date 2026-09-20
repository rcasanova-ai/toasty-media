// Session Library grouping — uses only fields the durable live_sessions row already returns
// (status, title, brandId, createdAt, lastActiveAt, endedAt, participantCount). No invented
// draft/upcoming backend states: OPEN is "not yet live", LIVE is on-air, ENDED splits into
// recent vs past by endedAt.

export const SESSION_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

export function brandLabel(brandId) {
  const labels = {
    toasty: "Toasty Studio",
    peeps: "Toasty Peeps",
    superteam: "Superteam Thailand",
    "8alta": "8ALTA",
    santati: "Santati",
    optimai: "OptimAI Network",
    tangem: "Tangem"
  };
  return labels[brandId] || brandId || "Toasty Studio";
}

export function groupSessions(sessions = [], now = Date.now()) {
  const live = [];
  const upcoming = [];
  const recent = [];
  const past = [];
  for (const session of sessions) {
    if (session.status === "LIVE") live.push(session);
    else if (session.status === "OPEN") upcoming.push(session);
    else if (session.status === "ENDED") {
      const ended = Date.parse(session.endedAt || session.lastActiveAt || "") || 0;
      if (ended && now - ended <= SESSION_RECENT_MS) recent.push(session);
      else past.push(session);
    } else {
      upcoming.push(session);
    }
  }
  return { live, upcoming, recent, past };
}

export function isTransientFetchError(error) {
  const message = String(error?.message || error || "");
  return /failed to fetch|networkerror|load failed|network request failed/i.test(message);
}
