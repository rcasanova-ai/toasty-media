import assert from 'node:assert/strict';
import * as E from '../peeps/demo/engine.js';
import { CANDIDATES, INTENTS, PRICING, DAVID_DUB, DAVID_INTENTS, INVESTIGATION_ORDER, INVESTIGATION_BUDGET_USD, REQUEST_TEXT } from '../peeps/demo/data.js';

const s = E.initialState();
assert.equal(E.coverage(s), 62);

// unlock is idempotent and priced at the platform microprice
E.unlockContext(s, 'sarah'); E.unlockContext(s, 'sarah');
assert.equal(E.contextSpend(s), PRICING.contextUnlockUsd);
assert.ok(s.ledger.every((e) => e.mode === 'demo' && e.settlement === 'none'));

// Dub answers from evidence, is honest about unknown/private
for (const id of ['q_banking', 'q_procurement', 'q_fit', 'q_comfort', 'q_limits']) {
  const r = E.askDub(s, id); assert.equal(r.kind, 'answer', id); assert.ok(r.evidence.length);
}
const priv = E.askDub(s, 'x_round');
assert.equal(priv.kind, 'private'); assert.deepEqual(priv.evidence, []);
assert.match(priv.text, /policy does not permit me to disclose/);
assert.ok(!priv.text.match(/DBS|Kasikorn|UOB|named contact|commercial terms/i));
const unk = E.askDub(s, 'q_terms');
assert.equal(unk.kind, 'unknown'); assert.equal(unk.canAsk, true);
assert.match(unk.text, /don’t have sufficient evidence/);
assert.equal(s.interview.awaitingClarification, 'q_terms');

// clarification becomes persistent, provenance-tagged context
const claim = E.clarify(s, 'q_terms', 'yes');
assert.equal(claim.provenance, 'self'); assert.equal(claim.source, 'Sarah');
assert.equal(E.askDub(s, 'q_terms').kind, 'answer');
assert.equal(E.coverage(s), 64);

// batch: David wins the profile search; Sarah wins qualification.
const b = E.runBatchQualification(s);
assert.equal(b.investigated, 2); assert.equal(b.contextSpend, 0.5); assert.equal(b.qualified.length, 1); assert.equal(b.excluded.length, 1);
assert.deepEqual(b.qualified.map((c) => c.id), ['sarah']);
const david = CANDIDATES.find((c) => c.id === 'david');
const sarah = CANDIDATES.find((c) => c.id === 'sarah');
assert.equal(david.surface, 94); assert.equal(sarah.surface, 82);
assert.match(david.exclusion.reason, /institutional banking/i);
assert.match(david.exclusion.detail, /enterprise procurement/i);
assert.match(david.exclusion.detail, /regulated financial/i);

// David: strong illustrative profile match, excluded on institutional capability gap
const dq = E.answerFromDub(DAVID_DUB, DAVID_INTENTS[0]);
assert.equal(dq.kind, 'answer'); assert.match(dq.text, /30,000/); assert.ok(dq.evidence.length);
const gap = E.answerFromDub(DAVID_DUB, DAVID_INTENTS[2]);
assert.equal(gap.kind, 'answer'); assert.match(gap.text, /do not have evidence/i); assert.deepEqual(gap.evidence, []);
assert.equal(E.answerFromDub(DAVID_DUB, { topic: 'something_else' }).kind, 'unknown');

// agent run: whole pool investigated in the planned order inside the budget; request text is the seeded outcome
assert.equal(INVESTIGATION_ORDER.length, CANDIDATES.length);
assert.ok(new Set(INVESTIGATION_ORDER).size === 2 && INVESTIGATION_ORDER.every((id) => E.candidate(id)));
assert.ok(E.contextSpend(s) <= INVESTIGATION_BUDGET_USD && /Solana payments startup/.test(REQUEST_TEXT));

// introductions: one authorization approaches Sarah only, excluded David is never approached
assert.equal(E.introTotal(), 25);
assert.throws(() => E.reserveJam(E.initialState(), 'david'));
const ai = E.initialState(); E.authorizeIntroductions(ai); E.authorizeIntroductions(ai);
assert.equal(E.jamReserved(ai), 25); assert.deepEqual(Object.keys(ai.jams).sort(), ['sarah']);
assert.equal(ai.jam.created, true);

// Jam requires acceptance; completion settles once
assert.throws(() => E.createJam(s));
E.requestIntro(s); E.acceptIntro(s); E.createJam(s); E.createJam(s);
assert.equal(s.ledger.filter((e) => e.kind === 'jam_commit').length, 1);
E.completeJam(s); E.completeJam(s);
assert.equal(s.sarahDough, 25);
assert.equal(s.ledger.filter((e) => e.kind === 'dough_credit').length, 1);
assert.equal(E.coverage(s), 68);
assert.equal(s.dub.breadcrumbs.at(-1).status, 'verified');

// trust scaffolding
assert.equal(E.evaluateTrust({ valueUsd: 25, duplicatePayout: true }).decision, 'hold');
assert.equal(E.evaluateTrust({ valueUsd: 25, actualMin: 5 }).decision, 'hold');
assert.equal(E.evaluateTrust({ valueUsd: 25, actualMin: 5, demoClock: true }).decision, 'release');
assert.equal(E.evaluateTrust({ valueUsd: 250, trustLevel: 2 }).decision, 'step_up');
assert.equal(E.evaluateTrust({ valueUsd: 25, repeat24h: 4 }).decision, 'hold');

// held payout never credits Dough
const h = E.initialState(); E.requestIntro(h); E.acceptIntro(h); E.createJam(h);
E.completeJam(h, { demoClock: false, actualMin: 3 });
assert.equal(h.sarahDough, 0); assert.ok(h.ledger.some((e) => e.kind === 'payment_hold'));

// growth loop
E.claimDub(s); E.claimDub(s);
assert.equal(s.ledger.filter((e) => e.kind === 'dough_pending_claim').length, 1);
assert.equal(s.growth.claimedDub.breadcrumbs.length, 1);

// persistence + reset
const mem = new Map(); const st = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) };
E.saveState(st, s); assert.equal(E.loadState(st).sarahDough, 25);
assert.equal(E.resetState(st).sarahDough, 0); assert.equal(E.loadState(st).sarahDough, 0);
// request prompt is locked: no editable control, flow uses the canonical constant only
import { readFileSync } from 'node:fs';
const ui = readFileSync(new URL('../peeps/demo/demo.js', import.meta.url), 'utf8');
assert.ok(!/<textarea[^>]*id="ask"/.test(ui) && !/\$\('#ask'\)/.test(ui), 'request must not be an input or read from the DOM');
assert.ok(/text: REQUEST_TEXT/.test(ui) && !/S\.request\?\.text/.test(ui), 'flow must use the canonical request');
console.log('peeps-demo-test: all assertions passed');
