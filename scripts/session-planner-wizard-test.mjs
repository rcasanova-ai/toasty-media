#!/usr/bin/env node
// The Session Planner wizard's model: templates, the editable guest briefing (including Toasty Lit book club), what the
// host and producer see during a session, and what Moxie may use as context. Pure functions, no network.
import { SESSION_TEMPLATES, applyTemplate, buildGuestBriefing, buildPrepSummary, prepContextForMoxie, emptyLit, splitLines, templateById } from "../js/session-plan-model.js";

const assert = (c, m) => { if (!c) throw new Error(`FAILED: ${m}`); console.log(`  ok — ${m}`); };

console.log("Templates");
assert(["interview", "podcast", "panel", "lit", "livestream", "custom"].every((id) => SESSION_TEMPLATES.some((t) => t.id === id)), "the wizard offers interview, podcast, panel, book club, livestream and custom sessions");
let plan = applyTemplate({ runOfShow: [] }, "lit");
assert(plan.sessionType === "book_club" && plan.template === "lit" && Object.keys(plan.lit).length === Object.keys(emptyLit()).length, "the Toasty Lit template sets the book club type and the book fields");
assert(plan.runOfShow.length >= 4 && plan.runOfShow[0].label === "Welcome and introductions", "it seeds a starter run of show");
const kept = applyTemplate({ runOfShow: [{ id: "x", label: "My segment", startOffset: 0 }] }, "podcast");
assert(kept.runOfShow.length === 1 && kept.runOfShow[0].label === "My segment", "choosing a template never overwrites segments the host already wrote");
assert(templateById("nope").id === "custom", "an unknown template falls back to a custom session");

console.log("\nToasty Lit briefing for guests");
plan = { ...plan, description: "Our monthly book club.", objectives: "Help listeners decide whether to read it.", scheduledAt: "2026-11-02T19:00",
  lit: { bookTitle: "Example Novel", author: "A. Writer", genre: "Literary fiction", synopsis: "A short premise written by the host.", mainCharacters: "Ana, a surveyor\n- Ben, her brother", majorThemes: "Memory\nInheritance", discussionTopics: "Is the ending earned?\nWho is the narrator?", suggestedQuestions: "HOST ONLY: what did you cut?", hostNotes: "PRIVATE: guest is nervous" } };
const brief = buildGuestBriefing(plan, { title: "Lit: Example Novel", hostName: "Sam" });
const text = JSON.stringify(brief);
assert(brief.intro.includes("Sam") && brief.intro.includes("Lit: Example Novel") && brief.intro.includes("2026-11-02 at 19:00"), "the introduction names the host, the session and the time");
assert(/do not need to have read the whole book/i.test(text), "it tells guests they do not need to have read the whole book");
for (const title of ["The book at a glance", "The premise", "Main characters", "Major themes", "Topics we may discuss", "How to prepare"]) assert(brief.sections.some((s) => s.title === title), `it has a "${title}" section`);
assert(brief.sections.find((s) => s.title === "Main characters").body === "Ana, a surveyor\nBen, her brother", "list fields are tidied one item per line");
assert(!text.includes("HOST ONLY") && !text.includes("PRIVATE"), "suggested questions and host notes are never put in the guest briefing");

console.log("\nBriefing for a non-book session");
const interview = buildGuestBriefing({ template: "interview", sessionType: "interview", topics: "Funding\nHiring", description: "A conversation about growth." }, { title: "Growth" });
assert(interview.sections.some((s) => s.title === "Topics we may cover" && s.body === "Funding\nHiring") && !interview.sections.some((s) => /book/i.test(s.title)), "an interview lists topics and has no book section");

console.log("\nWhat the host and producer see in Studio");
const speakers = [
  { id: "s1", displayName: "Maya", sessionRole: "Guest", hostBackground: "Debut author", profileSubmittedAt: "2026-10-20T10:00:00Z", pronunciationNotes: "MY-uh", bioShort: "Writes about maps.",
    prep: { preferredIntro: "Maya, author of Maps", expertise: "Cartography", topicsToDiscuss: "Writing process\nResearch", topicsToAvoid: "My divorce", supportingLinks: "https://example.com/maya", additionalNotes: "Late start please" } },
  { id: "s2", email: "ben@example.com", sessionRole: "Guest" }
];
const summary = buildPrepSummary({ ...plan, topics: "Memory in fiction\nEndings", hostPrep: { openingQuestions: "What drew you to it?\nHow did you read it?", talkingPoints: "Structure", specialInstructions: "Keep spoilers to the second half" } }, speakers);
assert(summary.topics.length === 2 && summary.openingQuestions.length === 2 && summary.talkingPoints[0] === "Structure" && summary.specialInstructions.includes("spoilers"), "topics, opening questions, talking points and special instructions are available");
assert(summary.book.title === "Example Novel" && summary.book.suggestedQuestions.length === 1 && summary.book.hostNotes.includes("PRIVATE"), "the host sees the book details and their own private notes");
const maya = summary.guests.find((g) => g.id === "s1");
assert(maya.submitted && maya.preferredIntro === "Maya, author of Maps" && maya.topicsToAvoid[0] === "My divorce" && maya.pronunciation === "MY-uh", "a guest's submitted preparation appears");
assert(summary.guests.find((g) => g.id === "s2").submitted === false, "a guest who has not responded is shown as waiting");

console.log("\nContext for Moxie");
const context = prepContextForMoxie(summary);
assert(context.includes("Maya") && context.includes("prefers to avoid: My divorce") && context.includes("Example Novel"), "Moxie can use the plan and each guest's preparation");
assert(context.length <= 6000, "the context is bounded");
assert(prepContextForMoxie(null) === "", "no plan gives no context");
assert(splitLines("- a\n* b\n\n  c ").join("|") === "a|b|c", "line parsing strips bullets and blanks");

console.log("\nALL PASSED: the planner model builds editable briefings and keeps host-only notes out of guest material.");
