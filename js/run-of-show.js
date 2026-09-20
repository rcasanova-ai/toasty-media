let uid = 0;
function nextId(prefix) { return `${prefix}-${Date.now().toString(36)}-${(uid++).toString(36)}`; }

export const TopicStatus = Object.freeze({ UPCOMING: "upcoming", CURRENT: "current", COMPLETED: "completed" });

// Compact agenda model. A topic's notes/preparedQuestions double as its running summary — there is
// deliberately no separate "show summary" pipeline here; once a topic completes, its notes ARE what
// ShowContext hands the AI Producer about it (see show-context.js).
export class RunOfShow {
  constructor(items) {
    this.items = items || defaultAgenda();
    this._listeners = new Set();
  }

  on(callback) { this._listeners.add(callback); return () => this._listeners.delete(callback); }
  _emit() { this._listeners.forEach((callback) => callback(this.items)); }

  addTopic({ title, notes = "", preparedQuestions = [], estimatedMinutes = 5 }) {
    const topic = { id: nextId("topic"), title, notes, preparedQuestions, status: TopicStatus.UPCOMING, estimatedMinutes, startedAt: null, completedAt: null };
    this.items.push(topic);
    this._emit();
    return topic;
  }

  load(items = []) {
    const next = (items || [])
      .map((item, index) => ({
        id: item.id || nextId("topic"),
        title: String(item.title || `Segment ${index + 1}`).trim(),
        notes: String(item.notes || item.script || ""),
        preparedQuestions: Array.isArray(item.preparedQuestions) ? item.preparedQuestions : [],
        status: Object.values(TopicStatus).includes(item.status) ? item.status : TopicStatus.UPCOMING,
        estimatedMinutes: Number(item.estimatedMinutes || item.duration || 5) || 5,
        startedAt: item.startedAt || null,
        completedAt: item.completedAt || null
      }))
      .filter((item) => item.title);
    this.items = next.length ? normalizeStatuses(next) : defaultAgenda();
    this._emit();
    return this.items;
  }

  editTopic(id, patch) {
    const topic = this.items.find((item) => item.id === id);
    if (!topic) return;
    Object.assign(topic, patch);
    this._emit();
  }

  removeTopic(id) {
    this.items = this.items.filter((item) => item.id !== id);
    this._emit();
  }

  reorder(id, toIndex) {
    const fromIndex = this.items.findIndex((item) => item.id === id);
    if (fromIndex === -1) return;
    const [topic] = this.items.splice(fromIndex, 1);
    this.items.splice(Math.max(0, Math.min(toIndex, this.items.length)), 0, topic);
    this._emit();
  }

  markCurrent(id) {
    const now = Date.now();
    this.items.forEach((item) => {
      if (item.id === id) { item.status = TopicStatus.CURRENT; item.startedAt = item.startedAt || now; }
    });
    this._emit();
  }

  complete(id) {
    const topic = this.items.find((item) => item.id === id);
    if (!topic) return;
    topic.status = TopicStatus.COMPLETED;
    topic.completedAt = Date.now();
    this._emit();
  }

  // The one-button "keep the show moving" action: completes whatever is current, then promotes the
  // next upcoming item to current.
  moveNext() {
    const current = this.current();
    if (current) this.complete(current.id);
    const next = this.items.find((item) => item.status === TopicStatus.UPCOMING);
    if (next) this.markCurrent(next.id);
    this._emit();
  }

  moveBack() {
    const currentIndex = this.items.findIndex((item) => item.status === TopicStatus.CURRENT);
    const targetIndex = currentIndex > 0 ? currentIndex - 1 : Math.max(0, this.items.findIndex((item) => item.status !== TopicStatus.COMPLETED));
    const target = this.items[targetIndex];
    if (!target) return null;
    this.items.forEach((item, index) => {
      if (index < targetIndex) item.status = TopicStatus.COMPLETED;
      else if (index === targetIndex) { item.status = TopicStatus.CURRENT; item.startedAt = item.startedAt || Date.now(); item.completedAt = null; }
      else { item.status = TopicStatus.UPCOMING; item.completedAt = null; }
    });
    this._emit();
    return target;
  }

  goTo(id) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    this.items.forEach((item, itemIndex) => {
      if (itemIndex < index) item.status = TopicStatus.COMPLETED;
      else if (itemIndex === index) { item.status = TopicStatus.CURRENT; item.startedAt = item.startedAt || Date.now(); item.completedAt = null; }
      else { item.status = TopicStatus.UPCOMING; item.completedAt = null; }
    });
    this._emit();
    return this.items[index];
  }

  current() { return this.items.find((item) => item.status === TopicStatus.CURRENT) || null; }
  upcoming() { return this.items.filter((item) => item.status === TopicStatus.UPCOMING); }
  completed() { return this.items.filter((item) => item.status === TopicStatus.COMPLETED); }
  next() { return this.upcoming()[0] || null; }

  currentElapsedMs() {
    const topic = this.current();
    if (!topic?.startedAt) return 0;
    return Date.now() - topic.startedAt;
  }

  // Case-insensitive title match against a free-text mention (e.g. "transition into Vietnam" -> Vietnam).
  findByTitleMention(text) {
    const lower = text.toLowerCase();
    return this.items.find((item) => lower.includes(item.title.toLowerCase())) || null;
  }

  // Demo-reset hook: back to the known Opening/Canada/Thailand(current)/Vietnam/Closing starting state.
  reset() {
    this.items = defaultAgenda();
    this._emit();
  }
}

export function parseRunOfShowText(text = "") {
  const blocks = String(text || "")
    .split(/\n\s*\n/g)
    .map((block) => block.trim())
    .filter(Boolean);
  const source = blocks.length > 1 ? blocks : String(text || "").split(/\n/g).map((line) => line.trim()).filter(Boolean);
  return source.map((block) => {
    const lines = block.split(/\n/g).map((line) => line.trim()).filter(Boolean);
    const first = lines[0] || "";
    const durationMatch = first.match(/\((\d+)\s*(?:m|min|minutes?)\)$/i);
    const title = first.replace(/^\s*[-*#\d.)]+\s*/, "").replace(/\s*\(\d+\s*(?:m|min|minutes?)\)$/i, "").trim();
    return {
      title: title || "Segment",
      notes: lines.slice(1).join("\n"),
      estimatedMinutes: durationMatch ? Number(durationMatch[1]) : 5
    };
  });
}

function normalizeStatuses(items) {
  const hasCurrent = items.some((item) => item.status === TopicStatus.CURRENT);
  if (!hasCurrent && items[0]) items[0].status = TopicStatus.CURRENT;
  let seenCurrent = false;
  return items.map((item) => {
    if (item.status === TopicStatus.CURRENT) {
      if (seenCurrent) item.status = TopicStatus.UPCOMING;
      seenCurrent = true;
    }
    return item;
  });
}

function defaultAgenda() {
  return [
    { id: nextId("topic"), title: "INTRO", notes: "", preparedQuestions: [], status: TopicStatus.CURRENT, estimatedMinutes: 2, startedAt: Date.now(), completedAt: null },
    { id: nextId("topic"), title: "WEEK UPDATE", notes: "", preparedQuestions: [], status: TopicStatus.UPCOMING, estimatedMinutes: 4, startedAt: null, completedAt: null },
    { id: nextId("topic"), title: "WHAT WE BUILT", notes: "", preparedQuestions: [], status: TopicStatus.UPCOMING, estimatedMinutes: 5, startedAt: null, completedAt: null },
    { id: nextId("topic"), title: "LIVE DEMO", notes: "", preparedQuestions: [], status: TopicStatus.UPCOMING, estimatedMinutes: 6, startedAt: null, completedAt: null },
    { id: nextId("topic"), title: "FOCUS GROUP / PEEPS", notes: "", preparedQuestions: [], status: TopicStatus.UPCOMING, estimatedMinutes: 4, startedAt: null, completedAt: null },
    { id: nextId("topic"), title: "WHAT'S NEXT", notes: "", preparedQuestions: [], status: TopicStatus.UPCOMING, estimatedMinutes: 3, startedAt: null, completedAt: null },
    { id: nextId("topic"), title: "CTA", notes: "", preparedQuestions: [], status: TopicStatus.UPCOMING, estimatedMinutes: 2, startedAt: null, completedAt: null },
    { id: nextId("topic"), title: "OUTRO", notes: "", preparedQuestions: [], status: TopicStatus.UPCOMING, estimatedMinutes: 1, startedAt: null, completedAt: null }
  ];
}
