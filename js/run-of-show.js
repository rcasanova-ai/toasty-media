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

function defaultAgenda() {
  const now = Date.now();
  return [
    { id: nextId("topic"), title: "Opening", notes: "", preparedQuestions: [], status: TopicStatus.COMPLETED, estimatedMinutes: 5, startedAt: now - 20 * 60000, completedAt: now - 15 * 60000 },
    { id: nextId("topic"), title: "Canada", notes: "", preparedQuestions: [], status: TopicStatus.COMPLETED, estimatedMinutes: 8, startedAt: now - 15 * 60000, completedAt: now - 8 * 60000 },
    { id: nextId("topic"), title: "Thailand", notes: "Announced AI data-centre pipeline and whether the grid has capacity for it; distinguishing real AI facilities from traditional cloud/data centres.", preparedQuestions: [], status: TopicStatus.CURRENT, estimatedMinutes: 10, startedAt: now - 8 * 60000, completedAt: null },
    { id: nextId("topic"), title: "Vietnam", notes: "Manufacturing shift and power/grid buildout to support it.", preparedQuestions: [], status: TopicStatus.UPCOMING, estimatedMinutes: 10, startedAt: null, completedAt: null },
    { id: nextId("topic"), title: "Closing", notes: "", preparedQuestions: [], status: TopicStatus.UPCOMING, estimatedMinutes: 5, startedAt: null, completedAt: null }
  ];
}
