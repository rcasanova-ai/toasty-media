// Session plan and guest preparation inside Studio. Shown to the host and producer only; nothing here is sent to
// guests or the audience. The same summary feeds Moxie's show context so a question like "what did our guest want to
// avoid?" can be answered privately.
import { studioRequest } from "./studio-api.js";
import { buildPrepSummary, prepContextForMoxie } from "./session-plan-model.js";
import { renderEpisodeBlock, watchEpisodeRecording } from "./episode-studio.js";

function el(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
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

export function renderSessionPrep(container, summary) {
  container.textContent = "";
  const blocks = [];
  if (summary.description || summary.objectives) {
    const intro = el("div", undefined, "lv-prep-block");
    if (summary.description) intro.append(el("p", summary.description));
    if (summary.objectives) intro.append(el("p", `Objectives: ${summary.objectives}`));
    blocks.push(intro);
  }
  if (summary.book) {
    const book = el("div", undefined, "lv-prep-block");
    book.append(el("h4", "Book"), el("p", `${summary.book.title}${summary.book.author ? ` by ${summary.book.author}` : ""}`));
    if (summary.book.synopsis) book.append(el("p", summary.book.synopsis));
    blocks.push(book, listBlock("Characters", summary.book.mainCharacters), listBlock("Themes", summary.book.majorThemes), listBlock("Discussion topics", summary.book.discussionTopics), listBlock("Suggested questions", summary.book.suggestedQuestions));
  }
  blocks.push(listBlock("Topics", summary.topics), listBlock("Opening questions", summary.openingQuestions), listBlock("Talking points", summary.talkingPoints));
  if (summary.specialInstructions) {
    const special = el("div", undefined, "lv-prep-block");
    special.append(el("h4", "Special instructions"), el("p", summary.specialInstructions));
    blocks.push(special);
  }
  for (const guest of summary.guests) {
    const card = el("details", undefined, "lv-prep-guest");
    const head = el("summary", `${guest.name}${guest.role ? ` · ${guest.role}` : ""}`);
    card.append(head);
    const rows = [
      ["Status", guest.submitted ? "Preparation received" : "Waiting for the guest"],
      ["Your note", guest.background], ["Introduce as", guest.preferredIntro], ["Pronunciation", guest.pronunciation], ["Expertise", guest.expertise], ["Notes", guest.notes]
    ].filter(([, value]) => value);
    for (const [label, value] of rows) { const row = el("p"); row.append(el("strong", `${label}: `), document.createTextNode(value)); card.append(row); }
    card.append(...[listBlock("Wants to discuss", guest.topicsToDiscuss), listBlock("Prefers to avoid", guest.topicsToAvoid), listBlock("Links", guest.links)].filter(Boolean));
    blocks.push(card);
  }
  const shown = blocks.filter(Boolean);
  if (!shown.length) container.append(el("p", "No plan yet. Plan this session from Session Planner and it appears here.", "lv-hint"));
  else container.append(...shown);
}

export async function mountSessionPrep(session, panel) {
  if (!panel || !session?.durableSession?.id) return null;
  const body = panel.querySelector("[data-prep-body]");
  const refreshButton = panel.querySelector("[data-prep-refresh]");
  let episodeBody = panel.querySelector("[data-episode-body]");
  if (!episodeBody) { episodeBody = document.createElement("div"); episodeBody.dataset.episodeBody = ""; body.before(episodeBody); }
  const load = async () => {
    let speakers = [];
    try { speakers = (await studioRequest(`/api/sessions/${encodeURIComponent(session.durableSession.id)}/speakers`)).speakers || []; } catch { /* guests may not be loadable for this session; the plan still shows */ }
    const summary = buildPrepSummary(session.durableSession.plan || {}, speakers);
    session.sessionPrep = { summary, contextText: prepContextForMoxie(summary) };
    renderSessionPrep(body, summary);
    renderEpisodeBlock(session, episodeBody, summary);
    if (summary.episode) watchEpisodeRecording(session);
    const has = summary.episode || summary.topics.length || summary.guests.length || summary.segments.length || summary.openingQuestions.length || summary.description || summary.book;
    panel.hidden = !has;
    return summary;
  };
  refreshButton?.addEventListener("click", () => load());
  return load();
}
