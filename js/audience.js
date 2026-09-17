let uid = 0;
function nextId(prefix) { return `${prefix}-${Date.now().toString(36)}-${(uid++).toString(36)}`; }

export const AudienceMessageType = Object.freeze({ COMMENT: "comment", QUESTION: "question", HAND: "hand" });

// Provider-neutral audience store. Audience members are NOT VDO.Ninja participants — this is a
// completely separate model from guestSeats. A real provider (Phase 2: x/youtube/telegram) and the demo
// feed both just call ingest() with a normalized message; nothing downstream cares where it came from.
export class AudienceStore {
  constructor() {
    this.messages = [];
    this._listeners = new Set();
  }

  on(callback) { this._listeners.add(callback); return () => this._listeners.delete(callback); }
  _emit(message) { this._listeners.forEach((cb) => cb(message, this.messages)); }

  ingest({ platform = "demo", platformUserId, displayName, message, type = AudienceMessageType.COMMENT, timestamp = Date.now() }) {
    const normalized = { id: nextId("msg"), platform, platformUserId: platformUserId || displayName, displayName, message, type, timestamp };
    this.messages.push(normalized);
    this._emit(normalized);
    return normalized;
  }

  recent(limit = 200) { return this.messages.slice(-limit); }
  questions() { return this.messages.filter((m) => m.type === AudienceMessageType.QUESTION); }
  clear() { this.messages = []; this._emit(null); }
}

// Seeded, provider-neutral demo dataset + progressive drip so a demo never depends on pasting messages
// in at the right moment. Content is deliberately written around the Thailand/Vietnam show topics so
// AIProducer's question-curation demo (dedup, junk-filtering, relevance) has real signal to chew on —
// these are INPUTS, not canned outputs; AIProducerService still has to do the selection work itself.
export class DemoAudienceFeed {
  constructor(store, script) {
    this.store = store;
    this.script = script || DEMO_AUDIENCE_SCRIPT;
    this._timerId = null;
    this._index = 0;
  }

  start({ intervalMs = 2400 } = {}) {
    this.stop();
    this._index = 0;
    this._tick();
    this._timerId = window.setInterval(() => this._tick(), intervalMs);
  }

  stop() {
    if (this._timerId) window.clearInterval(this._timerId);
    this._timerId = null;
  }

  _tick() {
    if (this._index >= this.script.length) { this.stop(); return; }
    const entry = this.script[this._index++];
    this.store.ingest(entry);
  }
}

const DEMO_AUDIENCE_SCRIPT = [
  { displayName: "Maria", message: "Does Thailand have enough grid capacity for the announced AI data-centre pipeline?", type: AudienceMessageType.QUESTION },
  { displayName: "Somchai", message: "loving this episode from Bangkok!!", type: AudienceMessageType.COMMENT },
  { displayName: "Niran", message: "Are these actually AI facilities or mostly traditional cloud/data centres relabeled?", type: AudienceMessageType.QUESTION },
  { displayName: "dev_anna", message: "🔥🔥🔥", type: AudienceMessageType.COMMENT },
  { displayName: "Pim", message: "curious about grid capacity too — is the power grid actually ready for this many data centres", type: AudienceMessageType.QUESTION },
  { displayName: "guest_88", message: "hi from Brazil, first time watching", type: AudienceMessageType.COMMENT },
  { displayName: "Worawut", message: "same question — can the grid handle the new AI data centre demand in Thailand?", type: AudienceMessageType.QUESTION },
  { displayName: "K.Somsri", message: "can you say that again, audio cut out for a sec", type: AudienceMessageType.COMMENT },
  { displayName: "Aroon", message: "lol", type: AudienceMessageType.COMMENT },
  { displayName: "Tanawat", message: "what's actually driving the AI data-centre investment into Thailand specifically vs. Vietnam or Malaysia?", type: AudienceMessageType.QUESTION },
  { displayName: "investor_dan", message: "any numbers on how much capex is going into Thai data centres this year?", type: AudienceMessageType.QUESTION },
  { displayName: "Chai", message: "great point about the grid", type: AudienceMessageType.COMMENT },
  { displayName: "Nok", message: "second the grid capacity question, seems like the real bottleneck", type: AudienceMessageType.QUESTION },
  { displayName: "random_lurker", message: "😂😂", type: AudienceMessageType.COMMENT },
  { displayName: "Preecha", message: "not sure this counts but — does Thailand's grid even have spare capacity for this?", type: AudienceMessageType.QUESTION },
  { displayName: "grid_nerd_th", message: "the grid point is fair but which utility is actually on the hook to build this out — EGAT or private IPPs?", type: AudienceMessageType.QUESTION },
  { displayName: "Suda", message: "excited for the Vietnam segment", type: AudienceMessageType.COMMENT },
  { displayName: "hand_raiser_1", message: "would love to ask a question live if possible", type: AudienceMessageType.HAND },
  { displayName: "Kanya", message: "what should we watch for once we get to Vietnam's power buildout?", type: AudienceMessageType.QUESTION },
  { displayName: "spam_bot_x", message: "check my profile for crypto tips", type: AudienceMessageType.COMMENT },
  { displayName: "manut_reacts", message: "wait so is this basically the same story as Malaysia's Johor buildout? feels familiar", type: AudienceMessageType.QUESTION },
  { displayName: "fan_of_the_show", message: "can we get Ricardo on a Toasty Peeps jam sometime", type: AudienceMessageType.COMMENT },
  { displayName: "second_screen_sam", message: "anyone know what music is playing rn", type: AudienceMessageType.COMMENT },
  { displayName: "Warinee", message: "ok but genuinely — if the grid can't keep up, does that slow down the timeline these companies announced?", type: AudienceMessageType.QUESTION },
  { displayName: "night_owl_88", message: "watching this at 2am from Chiang Mai, worth it", type: AudienceMessageType.COMMENT },
  { displayName: "Ploy", message: "this is such a good conversation, thank you both", type: AudienceMessageType.COMMENT },
  { displayName: "budget_watcher", message: "does this pipeline actually show up in this year's budget or is it all announcements so far?", type: AudienceMessageType.QUESTION },
  { displayName: "confused_viewer", message: "wait what are we talking about now sorry just joined", type: AudienceMessageType.COMMENT }
];
