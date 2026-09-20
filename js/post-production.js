function secondsFrom(startedAt, timestamp) {
  if (!startedAt || !timestamp) return 0;
  return Math.max(0, Math.round((Number(timestamp) - Number(startedAt)) / 1000));
}

function clock(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}

function lines(session) {
  return session?.transcript?.lines || [];
}

function quoteCandidates(session, limit = 6) {
  return lines(session)
    .filter((line) => String(line.text || "").split(/\s+/).length >= 7)
    .slice(-40)
    .map((line) => ({
      speaker: line.speaker || "Speaker",
      text: line.text,
      timestamp: line.timestamp || null
    }))
    .slice(0, limit);
}

function agenda(session) {
  return session?.runOfShow?.items || [];
}

function markers(session) {
  return session?.markers?.items || [];
}

function clipSuggestions(session, limit = 5) {
  const startedAt = session?.recording?.last?.startedAt || session?.recording?.startedAt || session?._startedAt || Date.now();
  const fromMarkers = markers(session).slice(-limit).map((marker) => {
    const start = Math.max(0, secondsFrom(startedAt, marker.timestamp) - 20);
    return {
      start,
      end: start + 60,
      title: marker.label || marker.type || "Marked moment",
      why: "Producer marked this moment during the session."
    };
  });
  if (fromMarkers.length) return fromMarkers;
  return quoteCandidates(session, limit).map((quote) => {
    const start = Math.max(0, secondsFrom(startedAt, quote.timestamp) - 15);
    return {
      start,
      end: start + 45,
      title: quote.text.slice(0, 58),
      why: `Quote from ${quote.speaker}.`
    };
  });
}

export function buildSessionDeliverables(session, { preset = "session" } = {}) {
  const currentAgenda = agenda(session);
  const quotes = quoteCandidates(session);
  const clips = clipSuggestions(session);
  const accomplishments = currentAgenda.filter((item) => item.status === "completed" || item.status === "current").map((item) => item.title);
  const chapters = currentAgenda.map((item) => ({
    title: item.title,
    status: item.status,
    durationMinutes: item.estimatedMinutes || 0,
    notes: item.notes || ""
  }));
  const keyMoments = [
    ...markers(session).map((marker) => ({ title: marker.label || marker.type, timestamp: marker.timestamp, source: "marker" })),
    ...quotes.slice(0, 3).map((quote) => ({ title: quote.text.slice(0, 72), timestamp: quote.timestamp, source: quote.speaker }))
  ];
  const summary = accomplishments.length
    ? `Covered ${accomplishments.join(", ")}.`
    : "Session recorded. Add transcript or markers for richer post-production output.";
  const linkedin = `${summary}\n\nKey moments:\n${clips.slice(0, 3).map((clip) => `- ${clip.title}`).join("\n")}`;
  const xThread = [`This week's Toasty Studio update: ${summary}`, ...clips.slice(0, 3).map((clip) => `${clip.title} (${clock(clip.start)}-${clock(clip.end)})`)];
  return {
    preset,
    summary,
    chapters,
    keyMoments,
    quotes,
    socialPosts: {
      linkedin,
      xThread
    },
    articleRecap: `${summary}\n\n${currentAgenda.map((item) => `${item.title}: ${item.notes || "covered live."}`).join("\n")}`,
    clipSuggestions: clips.map((clip) => ({ ...clip, startLabel: clock(clip.start), endLabel: clock(clip.end) })),
    shortsSuggestions: clips.slice(0, 3).map((clip) => ({
      start: clip.start,
      end: Math.min(clip.end, clip.start + 35),
      hook: clip.title,
      caption: clip.why,
      startLabel: clock(clip.start),
      endLabel: clock(Math.min(clip.end, clip.start + 35))
    }))
  };
}

export function buildWeeklyUpdatePackage(session) {
  const base = buildSessionDeliverables(session, { preset: "weekly-update" });
  return {
    preset: "WEEKLY UPDATE PACKAGE",
    shortSummary: base.summary,
    majorAccomplishments: agenda(session).filter((item) => /built|update|demo|focus|next/i.test(item.title)).map((item) => ({ title: item.title, notes: item.notes || "" })),
    demoMoments: base.clipSuggestions.filter((clip) => /demo|built|show|product/i.test(`${clip.title} ${clip.why}`)).slice(0, 4),
    keyQuotes: base.quotes,
    nextWeekPriorities: agenda(session).filter((item) => /next|cta|outro/i.test(item.title)).map((item) => item.notes || item.title),
    linkedInPost: base.socialPosts.linkedin,
    xPostThread: base.socialPosts.xThread,
    clipRecommendations: base.clipSuggestions,
    shortFormRecommendations: base.shortsSuggestions
  };
}

export function formatDeliverableMarkdown(pack) {
  return JSON.stringify(pack, null, 2);
}
