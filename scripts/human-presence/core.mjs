// Human Presence Verification, protocol core (hp-v0.1). Pure functions, no I/O, no network, no storage.
//
// WHAT THIS IS: a randomized, server-issued active challenge (head movement, hand gesture, spoken phrase)
// with strict session/participant binding, expiry, one-shot consumption, signed receipts and an audit trail.
//
// WHAT THIS IS NOT: a deepfake detector. Completing a challenge does not establish authenticity. Until a
// trusted liveness verifier is registered and enabled, EVERY result is "inconclusive" and nothing is ever
// labelled verified. A pass can only come from a verifier that declares `trusted: true`; client-reported
// success is never an input to the outcome.
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const PROTOCOL_VERSION = "hp-v0.1";
export const RECEIPT_PREFIX = "hpr1";
export const CHALLENGE_TTL_MS = 60_000;
export const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
export const RECEIPT_FRESH_MS = 15 * 60 * 1000;
export const MAX_CHALLENGES_PER_REQUEST = 5;
export const MIN_MS_PER_STEP = 800;
export const MAX_EVIDENCE_BYTES = 4096;
export const CONSENT_VERSION = "hp-consent-v1";

export const OUTCOMES = Object.freeze(["passed", "failed", "inconclusive"]);
export const ASSURANCE_LEVELS = Object.freeze(["none", "low", "medium", "high"]);

export const HEAD_DIRECTIONS = Object.freeze(["left", "right", "up", "down"]);
export const HAND_GESTURES = Object.freeze([
  { id: "fingers_1", label: "Hold up one finger", fingers: 1 },
  { id: "fingers_2", label: "Hold up two fingers", fingers: 2 },
  { id: "fingers_3", label: "Hold up three fingers", fingers: 3 },
  { id: "fingers_4", label: "Hold up four fingers", fingers: 4 },
  { id: "fingers_5", label: "Show an open hand", fingers: 5 },
  { id: "fist", label: "Make a fist", fingers: 0 }
]);
const PHRASE_WORDS = Object.freeze([
  "amber", "harbor", "velvet", "copper", "meadow", "lantern", "pepper", "orchard", "ribbon", "summit", "walnut", "thistle",
  "marble", "saffron", "cinder", "willow", "biscuit", "compass", "juniper", "mosaic", "nutmeg", "paddle", "quartz", "sparrow"
]);
export const ACTION_TYPES = Object.freeze(["head_turn", "hand_gesture", "spoken_phrase"]);

const b64 = (buf) => Buffer.from(buf).toString("base64url");
export const sha256Hex = (value) => createHash("sha256").update(String(value)).digest("hex");

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

// ---------- feature flags (all default OFF) ----------

export function getFlags(env = process.env) {
  const on = (name) => env[name] === "1" || env[name] === "true";
  const days = (name, fallback) => {
    const n = Number(env[name]);
    return Number.isFinite(n) && n >= 1 && n <= 3650 ? Math.floor(n) : fallback;
  };
  const enabled = on("HUMAN_PRESENCE_ENABLED");
  return Object.freeze({
    enabled,
    // Peeps Jam / Dub / Breadcrumb integration is a second gate: the Studio feature can run without it.
    peepsIntegration: enabled && on("HUMAN_PRESENCE_PEEPS_ENABLED"),
    // Admin only test mode is the default: only platform admins can request or read checks.
    adminOnly: env.HUMAN_PRESENCE_ADMIN_ONLY !== "0",
    providerId: String(env.HUMAN_PRESENCE_PROVIDER || "none"),
    // Result rows (never media) are deleted after this many days; the audit log has its own, longer clock.
    resultRetentionDays: days("HUMAN_PRESENCE_RETENTION_DAYS", 30),
    auditRetentionDays: days("HUMAN_PRESENCE_AUDIT_RETENTION_DAYS", 180)
  });
}

// ---------- challenge generation (server-side only) ----------

function pick(list, rng) {
  return list[rng(list.length)];
}

export function generateSteps(rng = (n) => randomInt(n)) {
  const steps = [];
  // Always three steps, at least two distinct action types, order randomized.
  const first = pick(ACTION_TYPES, rng);
  const chosen = [first];
  while (chosen.length < 3) {
    const next = pick(ACTION_TYPES, rng);
    const distinct = new Set([...chosen, next]).size;
    if (chosen.length === 2 && distinct < 2) continue;
    chosen.push(next);
  }
  chosen.forEach((type, index) => {
    const stepId = `s${index + 1}`;
    if (type === "head_turn") {
      steps.push({ stepId, type, direction: pick(HEAD_DIRECTIONS, rng), prompt: "" });
    } else if (type === "hand_gesture") {
      const g = pick(HAND_GESTURES, rng);
      steps.push({ stepId, type, gesture: g.id, fingers: g.fingers, prompt: g.label });
    } else {
      const words = [];
      while (words.length < 3) {
        const w = pick(PHRASE_WORDS, rng);
        if (!words.includes(w)) words.push(w);
      }
      steps.push({ stepId, type, phrase: `${words.join(" ")} ${10 + rng(90)}`, prompt: "" });
    }
  });
  for (const s of steps) {
    if (s.type === "head_turn") s.prompt = `Slowly turn your head ${s.direction}, then face the camera`;
    if (s.type === "spoken_phrase") s.prompt = `Say out loud: ${s.phrase}`;
  }
  return steps;
}

// The server picks everything; a client never selects an action, id, nonce or timestamp.
export function generateChallenge({ now = Date.now(), ttlMs = CHALLENGE_TTL_MS, rng } = {}) {
  const id = `hpc_${b64(randomBytes(12))}`;
  const nonce = b64(randomBytes(24));
  const responseSecret = b64(randomBytes(32));
  return {
    // Fields safe to persist (secret and nonce only as hashes) ...
    record: {
      id,
      nonceHash: sha256Hex(nonce),
      secretHash: sha256Hex(responseSecret),
      steps: generateSteps(rng),
      issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlMs).toISOString()
    },
    // ... and fields returned to the one participant that starts the challenge, exactly once.
    clientView: { responseSecret, nonce }
  };
}

export function publicChallengeView(record, clientView) {
  return {
    challengeId: record.id,
    protocol: PROTOCOL_VERSION,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    steps: record.steps.map((s) => ({ ...s })),
    ...(clientView || {})
  };
}

// ---------- evidence envelope validation ----------
//
// The client may send only small, derived, self-reported signals. Raw frames, audio, landmarks or face
// templates are not accepted: unknown keys, oversize bodies and long strings are rejected outright, so the
// server cannot be used to store biometric media even by accident.

const SIGNAL_KEYS = new Set(["motion", "level", "transcriptMatch", "durationMs", "completed"]);
const STEP_KEYS = new Set(["stepId", "type", "startOffsetMs", "endOffsetMs", "signals"]);
const TOP_KEYS = new Set(["nonce", "steps", "client"]);
const CLIENT_KEYS = new Set(["video", "audio", "virtualCameraSuspected", "analyzer"]);

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function validateEvidenceEnvelope(evidence, challenge) {
  const reasons = [];
  const fail = (code) => ({ ok: false, reasonCodes: [code], sanitized: null });
  if (!isPlainObject(evidence)) return fail("evidence_malformed");
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(evidence)); } catch { return fail("evidence_malformed"); }
  if (size > MAX_EVIDENCE_BYTES) return fail("evidence_too_large");
  for (const k of Object.keys(evidence)) if (!TOP_KEYS.has(k)) return fail("evidence_unknown_field");
  if (typeof evidence.nonce !== "string" || evidence.nonce.length > 80) return fail("evidence_malformed");
  if (!Array.isArray(evidence.steps) || evidence.steps.length !== challenge.steps.length) return fail("steps_mismatch");

  const steps = [];
  let lastEnd = 0;
  for (let i = 0; i < evidence.steps.length; i += 1) {
    const s = evidence.steps[i];
    const expected = challenge.steps[i];
    if (!isPlainObject(s)) return fail("evidence_malformed");
    for (const k of Object.keys(s)) if (!STEP_KEYS.has(k)) return fail("evidence_unknown_field");
    if (s.stepId !== expected.stepId || s.type !== expected.type) return fail("steps_mismatch");
    const start = Number(s.startOffsetMs);
    const end = Number(s.endOffsetMs);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      reasons.push("inconsistent_client_timing");
    } else if (start < lastEnd - 50) {
      reasons.push("inconsistent_client_timing");
    } else {
      lastEnd = end;
    }
    const signals = {};
    if (s.signals !== undefined) {
      if (!isPlainObject(s.signals)) return fail("evidence_malformed");
      for (const [k, v] of Object.entries(s.signals)) {
        if (!SIGNAL_KEYS.has(k)) return fail("evidence_unknown_field");
        if (typeof v === "number" && Number.isFinite(v)) signals[k] = Math.round(v * 1000) / 1000;
        else if (typeof v === "boolean") signals[k] = v;
        else return fail("evidence_malformed");
      }
    }
    steps.push({ stepId: s.stepId, type: s.type, startOffsetMs: Math.max(0, Math.round(start) || 0), endOffsetMs: Math.max(0, Math.round(end) || 0), signals });
  }
  const client = {};
  if (evidence.client !== undefined) {
    if (!isPlainObject(evidence.client)) return fail("evidence_malformed");
    for (const [k, v] of Object.entries(evidence.client)) {
      if (!CLIENT_KEYS.has(k)) return fail("evidence_unknown_field");
      if (typeof v === "boolean") client[k] = v;
      else if (typeof v === "string" && v.length <= 40) client[k] = v;
      else return fail("evidence_malformed");
    }
  }
  return { ok: true, reasonCodes: [...new Set(reasons)], sanitized: { nonce: evidence.nonce, steps, client } };
}

// ---------- liveness verifier interface ----------
//
// A verifier receives the sanitized evidence and the SERVER-measured timing. It must return
// { outcome, assurance, reasonCodes, methods }. Only a verifier with `trusted === true` can produce
// "passed"; the core downgrades any other pass to "inconclusive". No trusted verifier ships in this repo.

export class NullLivenessVerifier {
  constructor() {
    this.id = "none";
    this.version = "0";
    this.trusted = false;
  }

  async verify() {
    return { outcome: "inconclusive", assurance: "none", reasonCodes: ["no_trusted_verifier"], methods: [] };
  }
}

const verifierRegistry = new Map();
export function registerVerifier(verifier) {
  if (!verifier || typeof verifier.verify !== "function" || !verifier.id) throw new Error("Invalid liveness verifier.");
  verifierRegistry.set(verifier.id, verifier);
}
export function unregisterVerifier(id) {
  verifierRegistry.delete(id);
}
export function resolveVerifier(providerId = "none") {
  return verifierRegistry.get(providerId) || new NullLivenessVerifier();
}

export async function evaluateEvidence({ challenge, evidenceCheck, elapsedMs, verifier, verifierTimeoutMs = 8000 }) {
  const reasons = [...evidenceCheck.reasonCodes];
  const minElapsed = challenge.steps.length * MIN_MS_PER_STEP;
  if (elapsedMs < minElapsed) reasons.push("implausible_timing");
  const methods = [...new Set(challenge.steps.map((s) => s.type))];
  const v = verifier || new NullLivenessVerifier();
  let verdict;
  let timer;
  try {
    verdict = await Promise.race([
      Promise.resolve(v.verify({ challenge: { id: challenge.id, steps: challenge.steps }, evidence: evidenceCheck.sanitized, elapsedMs })),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("verifier timeout")), verifierTimeoutMs); })
    ]);
  } catch {
    verdict = { outcome: "inconclusive", assurance: "none", reasonCodes: ["verifier_error"], methods: [] };
  } finally {
    clearTimeout(timer);
  }
  let outcome = OUTCOMES.includes(verdict?.outcome) ? verdict.outcome : "inconclusive";
  let assurance = ASSURANCE_LEVELS.includes(verdict?.assurance) ? verdict.assurance : "none";
  const vReasons = Array.isArray(verdict?.reasonCodes) ? verdict.reasonCodes.map(String).slice(0, 8) : [];
  // The trust gate: no pass without a trusted verifier, and no pass on implausible or malformed evidence.
  if (outcome === "passed" && v.trusted !== true) {
    outcome = "inconclusive";
    assurance = "none";
    vReasons.push("untrusted_verifier_pass_ignored");
  }
  if (outcome === "passed" && (reasons.length > 0)) {
    outcome = "inconclusive";
    assurance = "none";
    vReasons.push("evidence_flags_block_pass");
  }
  if (outcome !== "passed") assurance = "none";
  return {
    outcome,
    assurance,
    methods,
    verifierId: String(v.id),
    verifierVersion: String(v.version || "0"),
    verifierTrusted: v.trusted === true,
    reasonCodes: [...new Set([...reasons, ...vReasons])]
  };
}

// ---------- signed receipts ----------
//
// hpr1.<base64url JSON payload>.<base64url HMAC-SHA256>. Contains no biometric data and no personal data:
// the participant appears only as an opaque, scope-bound reference.

export function deriveReceiptKeys(env = process.env, fallbackSecret = "") {
  const explicit = String(env.HUMAN_PRESENCE_RECEIPT_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const keys = [];
  explicit.forEach((entry, i) => {
    const [kid, secret] = entry.includes(":") ? entry.split(":") : [`k${i + 1}`, entry];
    if (secret && secret.length >= 16) keys.push({ kid, secret });
  });
  if (!keys.length && fallbackSecret) {
    // Domain-separated from session cookie signing: a leaked receipt MAC says nothing about cookie MACs.
    keys.push({ kid: "d1", secret: createHmac("sha256", fallbackSecret).update("human-presence/receipt/v1").digest("hex") });
  }
  return keys;
}

export function subjectRef(keys, scopeId, participantKey) {
  if (!keys.length) throw new Error("No receipt key configured.");
  return `sub_${createHmac("sha256", keys[0].secret).update(`subject|${scopeId}|${participantKey}`).digest("base64url").slice(0, 22)}`;
}

function canonical(obj) {
  if (Array.isArray(obj)) return `[${obj.map(canonical).join(",")}]`;
  if (isPlainObject(obj)) return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
  return JSON.stringify(obj);
}

export function buildReceiptPayload({ receiptId, requestId, challenge, result, scopeId, subject, issuedAt, freshMs = RECEIPT_FRESH_MS }) {
  return {
    v: PROTOCOL_VERSION,
    rid: receiptId,
    req: requestId,
    chal: challenge.id,
    scope: scopeId,
    sub: subject,
    outcome: result.outcome,
    assurance: result.assurance,
    methods: result.methods,
    verifier: { id: result.verifierId, version: result.verifierVersion, trusted: result.verifierTrusted },
    nonceHash: challenge.nonceHash,
    issuedAt,
    challengeIssuedAt: challenge.issuedAt,
    challengeExpiresAt: challenge.expiresAt,
    validUntil: new Date(Date.parse(issuedAt) + freshMs).toISOString()
  };
}

export function signReceipt(payload, keys) {
  if (!keys.length) throw new Error("No receipt key configured.");
  const { kid, secret } = keys[0];
  const body = b64(canonical({ ...payload, kid }));
  const mac = b64(createHmac("sha256", secret).update(`${RECEIPT_PREFIX}.${body}`).digest());
  return `${RECEIPT_PREFIX}.${body}.${mac}`;
}

// Verifies the MAC and structure only. Revocation and binding are the caller's job (see assessReceipt).
export function parseReceipt(token, keys) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts[0] !== RECEIPT_PREFIX) return { valid: false, reason: "malformed" };
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return { valid: false, reason: "malformed" }; }
  const key = keys.find((k) => k.kid === payload?.kid);
  if (!key) return { valid: false, reason: "unknown_key" };
  const expected = b64(createHmac("sha256", key.secret).update(`${RECEIPT_PREFIX}.${parts[1]}`).digest());
  if (!safeEqual(expected, parts[2])) return { valid: false, reason: "bad_signature" };
  return { valid: true, payload };
}

export function assessReceipt(token, keys, { now = Date.now(), expectScope, expectSubject, revoked = false } = {}) {
  const parsed = parseReceipt(token, keys);
  if (!parsed.valid) return { valid: false, fresh: false, reason: parsed.reason };
  const p = parsed.payload;
  if (revoked) return { valid: false, fresh: false, reason: "revoked", payload: p };
  if (expectScope && p.scope !== expectScope) return { valid: false, fresh: false, reason: "scope_mismatch", payload: p };
  if (expectSubject && p.sub !== expectSubject) return { valid: false, fresh: false, reason: "subject_mismatch", payload: p };
  const fresh = Date.parse(p.validUntil) > now;
  return { valid: true, fresh, reason: fresh ? "ok" : "stale", payload: p };
}

// ---------- status derivation (the only place a participant can become "verified") ----------

export const STATUS_LABELS = Object.freeze({
  not_requested: "Not checked",
  pending: "Check requested",
  in_progress: "Check in progress",
  inconclusive: "Check completed, result inconclusive",
  failed: "Check did not pass",
  declined: "Participant declined the check",
  expired: "Check expired",
  verified: "Verified human presence"
});

export function deriveStatus({ request, result, now = Date.now(), revoked = false } = {}) {
  const base = (status, extra = {}) => ({ status, label: STATUS_LABELS[status], verified: false, ...extra });
  if (!request) return base("not_requested");
  if (request.status === "declined") return base("declined");
  if (request.status === "cancelled") return base("not_requested");
  if (revoked || request.status === "revoked") return base("not_requested", { revoked: true });
  if (!result) {
    if (request.status === "expired" || Date.parse(request.expiresAt) <= now) return base("expired");
    return base(request.status === "in_progress" ? "in_progress" : "pending");
  }
  const common = { outcome: result.outcome, assurance: result.assurance, receiptId: result.receiptId, completedAt: result.createdAt, validUntil: result.validUntil };
  if (result.outcome === "passed" && result.verifierTrusted === true && result.assurance !== "none") {
    if (Date.parse(result.validUntil) <= now) return base("expired", { ...common, stale: true });
    return { status: "verified", label: STATUS_LABELS.verified, verified: true, ...common };
  }
  if (result.outcome === "failed") return base("failed", common);
  return base("inconclusive", common);
}

// Whitelisted text a UI may show for reason codes. Never exposes anything about what was seen.
export const REASON_COPY = Object.freeze({
  no_trusted_verifier: "No trusted liveness analysis is enabled yet, so this check cannot confirm authenticity.",
  implausible_timing: "The steps were completed unusually fast.",
  inconsistent_client_timing: "The step timings did not line up.",
  verifier_error: "The analysis service was unavailable.",
  untrusted_verifier_pass_ignored: "A pass from an unapproved analyzer was ignored.",
  evidence_flags_block_pass: "The submission had flags that block a pass."
});
