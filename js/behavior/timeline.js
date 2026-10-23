// The behavioral timeline: one timestamped record of what was said and observed in a recording. Every track uses the SAME
// clock (seconds from the first frame of the video), so a laugh, a smile, a pause and a sentence can be compared directly.
//
// Tracks: transcript (units), audio (vocal and sound events), face / gesture / motion (visual events), turns (speaker
// turns), interaction (events between people), language (meaning-level events), boundaries (topic and clip edges).
// Only derived scalars and short labels are stored. No face landmarks, no face embeddings, no templates: see assertNoBiometrics().

export const TIMELINE_VERSION = 1;
export const TRACKS = Object.freeze(["transcript", "audio", "face", "gesture", "motion", "turns", "interaction", "language", "boundaries"]);
export const CAPABILITIES = Object.freeze(["transcript", "audio", "face", "hands", "pose", "motion"]);

const clamp01 = (v) => Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
const r2 = (v) => Math.round(v * 100) / 100;

export class BehaviorTimeline {
  constructor({ duration = 0, source = "upload", id = "" } = {}) {
    this.version = TIMELINE_VERSION;
    this.id = id;
    this.source = source;
    this.duration = Math.max(0, Number(duration) || 0);
    this.capabilities = Object.fromEntries(CAPABILITIES.map((c) => [c, { available: false, detail: "not analysed" }]));
    this.tracks = Object.fromEntries(TRACKS.map((t) => [t, []]));
    this._byId = new Map();
    this._n = 0;
  }

  setCapability(name, available, detail = "") {
    if (!(name in this.capabilities)) throw new Error(`unknown capability: ${name}`);
    this.capabilities[name] = { available: Boolean(available), detail: String(detail || "") };
  }
  has(name) { return Boolean(this.capabilities[name]?.available); }

  // ev: { type, t, end?, strength?, speaker?, slot?, label?, data? }. Returns the stored event (with its id).
  add(track, ev) {
    if (!this.tracks[track]) throw new Error(`unknown track: ${track}`);
    if (!ev || !Number.isFinite(ev.t) || ev.t < 0) throw new Error(`event on "${track}" needs a finite, non-negative t`);
    const end = Number.isFinite(ev.end) && ev.end >= ev.t ? ev.end : ev.t;
    const stored = { ...ev, id: ev.id || `${track}-${++this._n}`, track, t: r2(ev.t), end: r2(end), strength: ev.strength == null ? undefined : r2(clamp01(ev.strength)) };
    if (stored.strength === undefined) delete stored.strength;
    this.tracks[track].push(stored);
    this._byId.set(stored.id, stored);
    if (stored.end > this.duration) this.duration = stored.end;
    return stored;
  }
  addAll(track, events) { return events.map((e) => this.add(track, e)); }
  get(id) { return this._byId.get(id) || null; }

  // Events overlapping [a, b]. track: a name, an array of names, or null for all.
  query(track, a, b) {
    const names = track == null ? TRACKS : Array.isArray(track) ? track : [track];
    const out = [];
    for (const n of names) for (const e of this.tracks[n] || []) if (e.end >= a && e.t <= b) out.push(e);
    return out.sort((x, y) => x.t - y.t);
  }
  sort() { for (const t of TRACKS) this.tracks[t].sort((a, b) => a.t - b.t || a.end - b.end); return this; }

  toJSON() {
    const json = { version: this.version, id: this.id, source: this.source, duration: r2(this.duration), capabilities: this.capabilities, tracks: this.tracks };
    BehaviorTimeline.assertNoBiometrics(json);
    return json;
  }

  // Refuse to serialise anything that looks like a face template: named landmark/embedding fields or long numeric vectors.
  static assertNoBiometrics(value, path = "timeline") {
    if (Array.isArray(value)) {
      if (value.length > 64 && value.every((v) => typeof v === "number")) throw new Error(`biometric guard: numeric vector of ${value.length} at ${path}`);
      value.forEach((v, i) => BehaviorTimeline.assertNoBiometrics(v, `${path}[${i}]`));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (/landmark|embedding|descriptor|faceprint|template|vector|blendshape/i.test(k)) throw new Error(`biometric guard: field "${k}" at ${path}`);
        BehaviorTimeline.assertNoBiometrics(v, `${path}.${k}`);
      }
    }
    return true;
  }
}
