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
for (const id of ['q_led', 'q_crypto', 'q_comfort', 'q_limits']) {
  const r = E.askDub(s, id); assert.equal(r.kind, 'answer', id); assert.ok(r.evidence.length);
}
const priv = E.askDub(s, 'x_round');
assert.equal(priv.kind, 'private'); assert.deepEqual(priv.evidence, []);
assert.ok(!JSON.stringify(priv).match(/\$\d/));
const unk = E.askDub(s, 'q_terms');
assert.equal(unk.kind, 'unknown'); assert.equal(unk.canAsk, true);
assert.match(unk.text, /don’t have sufficient evidence/);
assert.equal(s.interview.awaitingClarification, 'q_terms');

// clarification becomes persistent, provenance-tagged context
const claim = E.clarify(s, 'q_terms', 'yes');
assert.equal(claim.provenance, 'self'); assert.equal(claim.source, 'Sarah');
assert.equal(E.askDub(s, 'q_terms').kind, 'answer');
assert.equal(E.coverage(s), 64);

// batch: 8 investigated, $2.00, 3 qualified, 5 excluded; David excluded for crypto
const b = E.runBatchQualification(s);
assert.equal(b.investigated, 8); assert.equal(b.contextSpend, 2); assert.equal(b.qualified.length, 3); assert.equal(b.excluded.length, 5);
assert.deepEqual(b.qualified.map((c) => c.id), ['sarah', 'niran', 'michael']);
const david = CANDIDATES.find((c) => c.id === 'david');
assert.ok(david.surface > 90 && /crypto/i.test(david.exclusion.reason));

// David: strong keyword match, excluded on context, answered from evidence
const dq = E.answerFromDub(DAVID_DUB, DAVID_INTENTS[1]);
assert.equal(dq.kind, 'answer'); assert.match(dq.text, /71%/); assert.ok(dq.evidence.length);
assert.equal(E.answerFromDub(DAVID_DUB, { topic: 'something_else' }).kind, 'unknown');

// agent run: whole pool investigated in the planned order inside the budget; request text is the seeded outcome
assert.equal(INVESTIGATION_ORDER.length, CANDIDATES.length);
assert.ok(new Set(INVESTIGATION_ORDER).size === 8 && INVESTIGATION_ORDER.every((id) => E.candidate(id)));
assert.ok(E.contextSpend(s) <= INVESTIGATION_BUDGET_USD && /interview the best three/.test(REQUEST_TEXT));

// introductions: one authorization approaches all three qualified, $75 reserved, excluded never approached
assert.equal(E.introTotal(), 75);
assert.throws(() => E.reserveJam(E.initialState(), 'david'));
const ai = E.initialState(); E.authorizeIntroductions(ai); E.authorizeIntroductions(ai);
assert.equal(E.jamReserved(ai), 75); assert.deepEqual(Object.keys(ai.jams).sort(), ['michael', 'niran', 'sarah']);
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
