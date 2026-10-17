#!/usr/bin/env node
// Unit tests for the Human Presence protocol core: challenge generation, evidence validation, the trust gate
// (nothing is "passed" or "verified" without a trusted verifier), signed receipts and status derivation.
import assert from "node:assert/strict";
import {
  CHALLENGE_TTL_MS, MIN_MS_PER_STEP, NullLivenessVerifier, RECEIPT_FRESH_MS, assessReceipt, buildReceiptPayload,
  deriveReceiptKeys, deriveStatus, evaluateEvidence, generateChallenge, getFlags, parseReceipt, registerVerifier,
  resolveVerifier, sha256Hex, signReceipt, subjectRef, unregisterVerifier, validateEvidenceEnvelope
} from "./human-presence/core.mjs";

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed += 1; console.log(`  ok - ${name}`); } catch (error) { console.error(`  FAILED - ${name}`); throw error; }
}

function goodEvidence(challenge, nonce) {
  let t = 0;
  return {
    nonce,
    steps: challenge.steps.map((s) => { const start = t; t += 1500; return { stepId: s.stepId, type: s.type, startOffsetMs: start, endOffsetMs: t, signals: { motion: 0.4, completed: true } }; }),
    client: { video: true, audio: true }
  };
}
const trustedPass = { id: "fake-trusted", version: "1", trusted: true, verify: async () => ({ outcome: "passed", assurance: "medium", reasonCodes: [], methods: [] }) };
const untrustedPass = { id: "fake-untrusted", version: "1", trusted: false, verify: async () => ({ outcome: "passed", assurance: "high", reasonCodes: [] }) };

console.log("Flags");
await test("everything is off by default", () => {
  const f = getFlags({});
  assert.equal(f.enabled, false);
  assert.equal(f.peepsIntegration, false);
  assert.equal(f.providerId, "none");
});
await test("the Peeps flag needs the master flag", () => {
  assert.equal(getFlags({ HUMAN_PRESENCE_PEEPS_ENABLED: "1" }).peepsIntegration, false);
  assert.equal(getFlags({ HUMAN_PRESENCE_ENABLED: "1", HUMAN_PRESENCE_PEEPS_ENABLED: "1" }).peepsIntegration, true);
});
await test("retention is bounded and defaults to 30 days", () => {
  assert.equal(getFlags({}).resultRetentionDays, 30);
  assert.equal(getFlags({ HUMAN_PRESENCE_RETENTION_DAYS: "0" }).resultRetentionDays, 30);
  assert.equal(getFlags({ HUMAN_PRESENCE_RETENTION_DAYS: "7" }).resultRetentionDays, 7);
});

console.log("\nChallenge generation");
await test("challenges are unique, three steps, at least two action types, 60 second expiry", () => {
  const ids = new Set(); const nonces = new Set(); const combos = new Set();
  for (let i = 0; i < 300; i += 1) {
    const { record } = generateChallenge({ now: 1_000_000 });
    ids.add(record.id); nonces.add(record.nonceHash);
    combos.add(JSON.stringify(record.steps.map((s) => [s.type, s.direction || s.gesture || s.phrase])));
    assert.equal(record.steps.length, 3);
    assert.ok(new Set(record.steps.map((s) => s.type)).size >= 2);
    assert.equal(Date.parse(record.expiresAt) - Date.parse(record.issuedAt), CHALLENGE_TTL_MS);
  }
  assert.equal(ids.size, 300);
  assert.equal(nonces.size, 300);
  assert.ok(combos.size > 150, "step content is randomized");
});
await test("the stored record contains only hashes, never the secret or the nonce", () => {
  const { record, clientView } = generateChallenge();
  const stored = JSON.stringify(record);
  assert.ok(!stored.includes(clientView.responseSecret));
  assert.ok(!stored.includes(clientView.nonce));
  assert.equal(record.secretHash, sha256Hex(clientView.responseSecret));
  assert.equal(record.nonceHash, sha256Hex(clientView.nonce));
});

console.log("\nEvidence envelope");
const { record: ch, clientView: cv } = generateChallenge();
await test("well-formed evidence is accepted and sanitized", () => {
  const r = validateEvidenceEnvelope(goodEvidence(ch, cv.nonce), ch);
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasonCodes, []);
});
await test("raw media or biometric fields are rejected", () => {
  for (const field of ["frame", "image", "audio", "landmarks", "faceTemplate", "embedding"]) {
    const e = goodEvidence(ch, cv.nonce);
    e[field] = "AAAA";
    assert.equal(validateEvidenceEnvelope(e, ch).ok, false, field);
    const e2 = goodEvidence(ch, cv.nonce);
    e2.steps[0].signals[field] = 1;
    assert.equal(validateEvidenceEnvelope(e2, ch).ok, false, `signals.${field}`);
  }
});
await test("oversize bodies and long strings are rejected", () => {
  const big = goodEvidence(ch, cv.nonce);
  big.client.analyzer = "x".repeat(200);
  assert.equal(validateEvidenceEnvelope(big, ch).ok, false);
  const huge = goodEvidence(ch, cv.nonce);
  huge.steps[0].signals = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, i]));
  assert.equal(validateEvidenceEnvelope(huge, ch).reasonCodes[0], "evidence_too_large");
});
await test("steps must match the issued challenge in order, type and count", () => {
  const swapped = goodEvidence(ch, cv.nonce);
  swapped.steps.reverse();
  assert.equal(validateEvidenceEnvelope(swapped, ch).ok, ch.steps[0].stepId === ch.steps[2].stepId);
  const short = goodEvidence(ch, cv.nonce);
  short.steps.pop();
  assert.equal(validateEvidenceEnvelope(short, ch).reasonCodes[0], "steps_mismatch");
  const wrongType = goodEvidence(ch, cv.nonce);
  wrongType.steps[0].type = "head_turn" === ch.steps[0].type ? "spoken_phrase" : "head_turn";
  assert.equal(validateEvidenceEnvelope(wrongType, ch).reasonCodes[0], "steps_mismatch");
});
await test("inconsistent client timings are flagged, not trusted", () => {
  const e = goodEvidence(ch, cv.nonce);
  e.steps[1].startOffsetMs = 10;
  assert.ok(validateEvidenceEnvelope(e, ch).reasonCodes.includes("inconsistent_client_timing"));
});

console.log("\nTrust gate");
const check = () => validateEvidenceEnvelope(goodEvidence(ch, cv.nonce), ch);
const okElapsed = ch.steps.length * MIN_MS_PER_STEP + 2000;
await test("with no verifier configured every result is inconclusive", async () => {
  const v = await evaluateEvidence({ challenge: ch, evidenceCheck: check(), elapsedMs: okElapsed, verifier: resolveVerifier("none") });
  assert.equal(v.outcome, "inconclusive");
  assert.equal(v.assurance, "none");
  assert.equal(v.verifierTrusted, false);
  assert.ok(v.reasonCodes.includes("no_trusted_verifier"));
});
await test("an untrusted verifier cannot produce a pass", async () => {
  const v = await evaluateEvidence({ challenge: ch, evidenceCheck: check(), elapsedMs: okElapsed, verifier: untrustedPass });
  assert.equal(v.outcome, "inconclusive");
  assert.ok(v.reasonCodes.includes("untrusted_verifier_pass_ignored"));
});
await test("only a trusted verifier can pass, and only on clean evidence", async () => {
  const good = await evaluateEvidence({ challenge: ch, evidenceCheck: check(), elapsedMs: okElapsed, verifier: trustedPass });
  assert.equal(good.outcome, "passed");
  assert.equal(good.assurance, "medium");
  const fast = await evaluateEvidence({ challenge: ch, evidenceCheck: check(), elapsedMs: 300, verifier: trustedPass });
  assert.equal(fast.outcome, "inconclusive");
  assert.ok(fast.reasonCodes.includes("implausible_timing"));
  const e = goodEvidence(ch, cv.nonce); e.steps[1].startOffsetMs = 10;
  const flagged = await evaluateEvidence({ challenge: ch, evidenceCheck: validateEvidenceEnvelope(e, ch), elapsedMs: okElapsed, verifier: trustedPass });
  assert.equal(flagged.outcome, "inconclusive");
});
await test("a throwing or hanging verifier degrades to inconclusive", async () => {
  const boom = { id: "boom", trusted: true, verify: async () => { throw new Error("down"); } };
  assert.equal((await evaluateEvidence({ challenge: ch, evidenceCheck: check(), elapsedMs: okElapsed, verifier: boom })).outcome, "inconclusive");
  const hang = { id: "hang", trusted: true, verify: () => new Promise(() => {}) };
  const v = await evaluateEvidence({ challenge: ch, evidenceCheck: check(), elapsedMs: okElapsed, verifier: hang, verifierTimeoutMs: 50 });
  assert.equal(v.outcome, "inconclusive");
  assert.ok(v.reasonCodes.includes("verifier_error"));
});
await test("garbage verifier output cannot smuggle a pass", async () => {
  const junk = { id: "junk", trusted: true, verify: async () => ({ outcome: "PASSED!!", assurance: "godlike" }) };
  const v = await evaluateEvidence({ challenge: ch, evidenceCheck: check(), elapsedMs: okElapsed, verifier: junk });
  assert.equal(v.outcome, "inconclusive");
  assert.equal(v.assurance, "none");
});
await test("registry falls back to the null verifier", () => {
  assert.ok(resolveVerifier("does-not-exist") instanceof NullLivenessVerifier);
  registerVerifier(trustedPass);
  assert.equal(resolveVerifier("fake-trusted"), trustedPass);
  unregisterVerifier("fake-trusted");
  assert.ok(resolveVerifier("fake-trusted") instanceof NullLivenessVerifier);
});

console.log("\nSigned receipts");
const keys = deriveReceiptKeys({}, "unit-test-session-secret");
const verdict = { outcome: "inconclusive", assurance: "none", methods: ["head_turn"], verifierId: "none", verifierVersion: "0", verifierTrusted: false };
const issuedAt = new Date(1_700_000_000_000).toISOString();
const payload = buildReceiptPayload({ receiptId: "hpr_1", requestId: "hpq_1", challenge: ch, result: verdict, scopeId: "scope1", subject: subjectRef(keys, "scope1", "guest-1"), issuedAt });
const token = signReceipt(payload, keys);
await test("receipts verify and carry no personal data", () => {
  const a = assessReceipt(token, keys, { now: Date.parse(issuedAt) + 1000 });
  assert.equal(a.valid, true);
  assert.equal(a.fresh, true);
  assert.ok(!JSON.stringify(a.payload).includes("guest-1"), "subject is an opaque reference");
  assert.equal(a.payload.nonceHash, ch.nonceHash);
});
await test("tampered payloads and signatures are rejected", () => {
  const [p, body, mac] = token.split(".");
  const forged = JSON.parse(Buffer.from(body, "base64url").toString());
  forged.outcome = "passed"; forged.verifier.trusted = true;
  const forgedToken = `${p}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`;
  assert.equal(parseReceipt(forgedToken, keys).valid, false);
  assert.equal(parseReceipt(`${p}.${body}.${mac.slice(0, -2)}AA`, keys).valid, false);
  assert.equal(parseReceipt("garbage", keys).valid, false);
});
await test("a receipt signed with another key is rejected", () => {
  const other = deriveReceiptKeys({}, "a-different-secret");
  assert.equal(parseReceipt(signReceipt(payload, other), keys).valid, false);
});
await test("key rotation: old receipts verify while the old key is still listed", () => {
  const rotated = deriveReceiptKeys({ HUMAN_PRESENCE_RECEIPT_KEYS: "n2:new-secret-value-0000,d1:old-secret-value-0000" });
  const oldKeys = deriveReceiptKeys({ HUMAN_PRESENCE_RECEIPT_KEYS: "d1:old-secret-value-0000" });
  const oldToken = signReceipt(payload, oldKeys);
  assert.equal(parseReceipt(oldToken, rotated).valid, true);
  assert.equal(parseReceipt(signReceipt(payload, rotated), oldKeys).valid, false);
});
await test("scope and subject binding, staleness and revocation", () => {
  const sub = payload.sub;
  assert.equal(assessReceipt(token, keys, { now: Date.parse(issuedAt), expectScope: "other" }).reason, "scope_mismatch");
  assert.equal(assessReceipt(token, keys, { now: Date.parse(issuedAt), expectSubject: "sub_other" }).reason, "subject_mismatch");
  assert.equal(assessReceipt(token, keys, { now: Date.parse(issuedAt), expectScope: "scope1", expectSubject: sub }).valid, true);
  const stale = assessReceipt(token, keys, { now: Date.parse(issuedAt) + RECEIPT_FRESH_MS + 1 });
  assert.equal(stale.valid, true);
  assert.equal(stale.fresh, false);
  assert.equal(assessReceipt(token, keys, { revoked: true }).valid, false);
});
await test("subject references differ per scope and participant", () => {
  assert.notEqual(subjectRef(keys, "a", "p"), subjectRef(keys, "b", "p"));
  assert.notEqual(subjectRef(keys, "a", "p"), subjectRef(keys, "a", "q"));
});

console.log("\nStatus derivation (the only path to 'verified')");
const now = Date.parse(issuedAt) + 1000;
const request = { status: "completed", expiresAt: new Date(now + 1e6).toISOString() };
const res = (o) => ({ outcome: "passed", assurance: "medium", verifierTrusted: true, receiptId: "r", createdAt: issuedAt, validUntil: new Date(now + 60_000).toISOString(), ...o });
await test("no request, pending, declined, cancelled", () => {
  assert.equal(deriveStatus({}).status, "not_requested");
  assert.equal(deriveStatus({ request: { ...request, status: "pending" }, now }).status, "pending");
  assert.equal(deriveStatus({ request: { ...request, status: "declined" }, now }).status, "declined");
  assert.equal(deriveStatus({ request: { ...request, status: "cancelled" }, now }).verified, false);
});
await test("verified requires a trusted, fresh, unrevoked pass", () => {
  assert.equal(deriveStatus({ request, result: res(), now }).verified, true);
  assert.equal(deriveStatus({ request, result: res({ verifierTrusted: false }), now }).status, "inconclusive");
  assert.equal(deriveStatus({ request, result: res({ assurance: "none" }), now }).verified, false);
  assert.equal(deriveStatus({ request, result: res({ validUntil: new Date(now - 1).toISOString() }), now }).status, "expired");
  assert.equal(deriveStatus({ request, result: res(), now, revoked: true }).verified, false);
});
await test("inconclusive and failed are never shown as verified", () => {
  for (const outcome of ["inconclusive", "failed"]) {
    const s = deriveStatus({ request, result: res({ outcome, verifierTrusted: true }), now });
    assert.equal(s.verified, false);
    assert.ok(!/verified human/i.test(s.label));
  }
});
await test("an expired request with no result reads as expired, never verified", () => {
  const s = deriveStatus({ request: { status: "pending", expiresAt: new Date(now - 1).toISOString() }, now });
  assert.equal(s.status, "expired");
});

console.log(`\n${passed} passed`);
