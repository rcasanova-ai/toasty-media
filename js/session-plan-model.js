// Pure model for the Session Planner wizard and for the preparation Studio shows during a session.
// No DOM, no network: the planner page, the Studio prep panel, Moxie's show context and the tests all use these.

export const SESSION_TEMPLATES = Object.freeze([
  { id: "interview", sessionType: "interview", title: "Interview", blurb: "One host, one guest, a conversation with a clear angle.", segments: [["Welcome and introduction", 0], ["The conversation", 5], ["Closing thoughts", 50]] },
  { id: "podcast", sessionType: "podcast", title: "Podcast", blurb: "A regular show with topics, guests and a repeatable run of show.", segments: [["Cold open", 0], ["Main discussion", 5], ["Wrap up and where to find us", 50]] },
  { id: "panel", sessionType: "panel", title: "Panel discussion", blurb: "Several guests, a moderator and a shared set of questions.", segments: [["Introductions", 0], ["Moderated discussion", 8], ["Audience questions", 40], ["Closing round", 52]] },
  { id: "lit", sessionType: "book_club", title: "Book club", blurb: "Toasty Lit style: two hosts, a rotating guest and a concise book briefing.", segments: [["Welcome and introductions", 0], ["The book in brief", 5], ["Discussion", 12], ["Favourite moments", 40], ["Closing thoughts", 52]] },
  { id: "livestream", sessionType: "livestream", title: "Livestream", blurb: "A live show to your channels with guests, audience and a tight schedule.", segments: [["Starting soon", 0], ["Show open", 2], ["Main segment", 8], ["Audience questions", 40], ["Sign off", 55]] },
  { id: "custom", sessionType: "custom", title: "Custom session", blurb: "Start from a blank plan and build exactly what you need.", segments: [] }
]);

export const SESSION_TYPES = Object.freeze([
  "podcast", "interview", "panel", "book_club", "livestream", "custom", "focus_group", "webinar", "ama", "demo", "workshop", "prerecorded",
  "research_session", "product_launch", "community_call", "investor_update", "roundtable", "other"
]);

export function emptyLit() {
  return { bookTitle: "", author: "", genre: "", synopsis: "", mainCharacters: "", majorThemes: "", discussionTopics: "", suggestedQuestions: "", hostNotes: "" };
}

export function emptyHostPrep() {
  return { openingQuestions: "", talkingPoints: "", specialInstructions: "" };
}

export function emptyBriefing() {
  return { intro: "", sections: [], approved: false, approvedAt: null };
}

export function templateById(id) {
  return SESSION_TEMPLATES.find((t) => t.id === id) || SESSION_TEMPLATES.find((t) => t.id === "custom");
}

// Applying a template sets the session type and, only if the plan has no segments yet, a starter run of show.
export function applyTemplate(plan, templateId, makeId = (i) => `ros_${i}`) {
  const template = templateById(templateId);
  const next = { ...plan, template: template.id, sessionType: template.sessionType };
  if (template.id === "lit") next.lit = { ...emptyLit(), ...(plan.lit || {}) };
  if (!Array.isArray(plan.runOfShow) || !plan.runOfShow.length) {
    next.runOfShow = template.segments.map(([label, startOffset], i) => ({ id: makeId(i), label, startOffset, notes: "" }));
  }
  return next;
}

const lines = (text) => String(text || "").split(/\r?\n/).map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
export const splitLines = lines;

// The editable briefing the host reviews before it is sent to guests. Built only from what the host entered; host
// notes and suggested questions are never included. For a book club it explains the book without needing the guest
// to have read it, and without reproducing any of the book's text.
export function buildGuestBriefing(plan, { title = "", hostName = "" } = {}) {
  const sessionTitle = title || plan.title || "the session";
  const when = plan.scheduledAt ? ` on ${String(plan.scheduledAt).replace("T", " at ")}` : "";
  const intro = `Thank you for joining ${hostName ? `${hostName} for ` : ""}${sessionTitle}${when}. This briefing tells you what to expect so you can come in prepared.`;
  const sections = [];
  const about = [plan.description, plan.objectives && `What we hope to achieve: ${plan.objectives}`].filter(Boolean).join("\n\n");
  if (about) sections.push({ title: "About this session", body: about });
  const lit = plan.lit || {};
  if (plan.template === "lit" || plan.sessionType === "book_club") {
    const book = [lit.bookTitle && `${lit.bookTitle}${lit.author ? ` by ${lit.author}` : ""}`, lit.genre && `Genre: ${lit.genre}`].filter(Boolean).join("\n");
    sections.push({ title: "The book at a glance", body: [book, "You do not need to have read the whole book to take part. This briefing covers what you need to join the conversation."].filter(Boolean).join("\n\n") });
    if (lit.synopsis) sections.push({ title: "The premise", body: lit.synopsis });
    if (lit.mainCharacters) sections.push({ title: "Main characters", body: lines(lit.mainCharacters).join("\n") });
    if (lit.majorThemes) sections.push({ title: "Major themes", body: lines(lit.majorThemes).join("\n") });
    if (lit.discussionTopics) sections.push({ title: "Topics we may discuss", body: lines(lit.discussionTopics).join("\n") });
  } else if (Array.isArray(plan.topics) ? plan.topics.length : lines(plan.topics).length) {
    const topics = Array.isArray(plan.topics) ? plan.topics : lines(plan.topics);
    sections.push({ title: "Topics we may cover", body: topics.join("\n") });
  }
  sections.push({ title: "How to prepare", body: "Open your private preparation page to tell us how you would like to be introduced, which topics you would like to discuss and anything you would prefer to avoid. Only the host and producer see what you submit." });
  return { intro, sections };
}

// Everything the host and producer can look at while recording. Guest preparation is included only for guests who
// submitted it; nothing here is sent to other guests.
export function buildPrepSummary(plan = {}, speakers = []) {
  const lit = plan.lit || {};
  const hostPrep = plan.hostPrep || {};
  const topics = Array.isArray(plan.topics) ? plan.topics : lines(plan.topics);
  return {
    title: plan.title || "",
    sessionType: plan.sessionType || "",
    template: plan.template || "",
    description: plan.description || "",
    objectives: plan.objectives || "",
    scheduledAt: plan.scheduledAt || "",
    durationMinutes: plan.expectedDurationMinutes || null,
    topics,
    openingQuestions: lines(hostPrep.openingQuestions),
    talkingPoints: lines(hostPrep.talkingPoints),
    specialInstructions: hostPrep.specialInstructions || "",
    segments: (plan.runOfShow || []).map((s) => ({ label: s.label, startOffset: s.startOffset, notes: s.notes || "" })),
    book: plan.template === "lit" || plan.sessionType === "book_club" ? {
      title: lit.bookTitle || "", author: lit.author || "", genre: lit.genre || "", synopsis: lit.synopsis || "",
      mainCharacters: lines(lit.mainCharacters), majorThemes: lines(lit.majorThemes), discussionTopics: lines(lit.discussionTopics),
      suggestedQuestions: lines(lit.suggestedQuestions), hostNotes: lit.hostNotes || ""
    } : null,
    guests: speakers.map((s) => ({
      id: s.id, name: s.displayName || s.email || "Guest", role: s.sessionRole || "", background: s.hostBackground || "",
      title: s.title || "", company: s.company || "", bio: s.bioShort || s.bioLong || "", pronunciation: s.pronunciationNotes || "",
      submitted: Boolean(s.profileSubmittedAt || Object.keys(s.prep || {}).length),
      preferredIntro: s.prep?.preferredIntro || "", expertise: s.prep?.expertise || "",
      topicsToDiscuss: lines(s.prep?.topicsToDiscuss), topicsToAvoid: lines(s.prep?.topicsToAvoid),
      links: lines(s.prep?.supportingLinks), notes: s.prep?.additionalNotes || ""
    }))
  };
}

// Compact, plain-text context Moxie may use for the host. It carries the host's own plan and each guest's
// preparation, because the host and producer are the only ones who see it. Moxie's answers stay private to the host
// until the host approves sharing them.
export function prepContextForMoxie(summary) {
  if (!summary) return "";
  const out = [];
  if (summary.title) out.push(`Session: ${summary.title}${summary.sessionType ? ` (${summary.sessionType.replace(/_/g, " ")})` : ""}`);
  if (summary.objectives) out.push(`Objectives: ${summary.objectives}`);
  if (summary.topics.length) out.push(`Planned topics: ${summary.topics.join("; ")}`);
  if (summary.openingQuestions.length) out.push(`Opening questions: ${summary.openingQuestions.join("; ")}`);
  if (summary.talkingPoints.length) out.push(`Talking points: ${summary.talkingPoints.join("; ")}`);
  if (summary.book) out.push(`Book: ${summary.book.title}${summary.book.author ? ` by ${summary.book.author}` : ""}. Themes: ${summary.book.majorThemes.join("; ")}. Characters: ${summary.book.mainCharacters.join("; ")}.`);
  for (const g of summary.guests) {
    const bits = [g.role && `role ${g.role}`, g.background && `background: ${g.background}`, g.expertise && `expertise: ${g.expertise}`, g.preferredIntro && `introduce as: ${g.preferredIntro}`, g.pronunciation && `pronunciation: ${g.pronunciation}`, g.topicsToDiscuss.length && `wants to discuss: ${g.topicsToDiscuss.join("; ")}`, g.topicsToAvoid.length && `prefers to avoid: ${g.topicsToAvoid.join("; ")}`].filter(Boolean);
    out.push(`Guest ${g.name}${bits.length ? ` (${bits.join(", ")})` : ""}`);
  }
  return out.join("\n").slice(0, 6000);
}
