// Pure, DOM-free engine for the Peeps golden-path demo. Runs in the browser and in Node tests.
// Every money movement here is a DEMO ledger entry: settlement is always 'none' (no chain, no bank).
import { SARAH_DUB, INTENTS, CANDIDATES, PRICING, JAM, TRANSCRIPT, REQUESTER, INVITEE, TRUST_TIERS } from './data.js';

export const STORAGE_KEY = 'toasty.peeps.demo.v1'; // isolated namespace: never touches production data
export const STEPS = ['start', 'dub', 'outcome', 'discovery', 'interview', 'matches', 'permission', 'jam', 'studio', 'postjam', 'growth'];

export const LIFECYCLE = [
  'Outcome', 'Discovery', 'Context unlock', 'Dub ↔ Dub', 'Qualification', 'Permission',
  'Jam', 'Studio', 'Payment', 'Breadcrumb', 'Richer Dub', 'Network growth',
];

export const COVERAGE = { base: 62, perLearnedClaim: 2, perBreadcrumb: 4 };
const DEMO_RAIL = 'x402 / Solana USDC rail · DEMO transaction · no on-chain settlement';

const clone = (o) => JSON.parse(JSON.stringify(o));

export function initialState() {
  return {
    v: 1,
    step: 'start',
    dub: clone(SARAH_DUB),
    request: { parsed: false },
    discovery: { scanned: false },
    unlocked: {},
    interview: { log: [], asked: [], awaitingClarification: null, learned: [] },
    batch: { done: false },
    intro: { requested: false, accepted: false },
    jam: { created: false, joined: false, ended: false },
    studio: { consent: false },
    post: { stage: 0, breadcrumb: null, settled: false, coverageBefore: null },
    ledger: [],
    sarahDough: 0,
    growth: { stage: 0, claimed: false },
  };
}

export function loadState(storage) {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return initialState();
    const s = JSON.parse(raw);
    return s && s.v === 1 ? s : initialState();
  } catch { return initialState(); }
}
export function saveState(storage, s) { try { storage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* demo still works */ } }
export function resetState(storage) { try { storage.removeItem(STORAGE_KEY); } catch { /* noop */ } return initialState(); }

export const today = () => new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

// ---- ledger --------------------------------------------------------------------------------
export function addLedger(s, e) {
  const entry = { id: `demo_tx_${String(s.ledger.length + 1).padStart(3, '0')}`, ts: new Date().toISOString(), mode: 'demo', settlement: 'none', rail: DEMO_RAIL, ...e };
  s.ledger.push(entry);
  return entry;
}
export const contextSpend = (s) => round2(s.ledger.filter((e) => e.kind === 'context_unlock').reduce((a, e) => a + e.amountUsd, 0));
export const round2 = (n) => Math.round(n * 100) / 100;
export const candidate = (id) => CANDIDATES.find((c) => c.id === id);

export function unlockContext(s, id) {
  if (s.unlocked[id]) return null; // idempotent: never double-charge
  const c = candidate(id);
  const e = addLedger(s, { kind: 'context_unlock', label: `Context unlocked · ${c.name}`, amountUsd: PRICING.contextUnlockUsd, from: REQUESTER.org, to: 'Peeps platform', candidateId: id });
  s.unlocked[id] = e.id;
  s.discovery.scanned = true;
  return e;
}

// ---- Dub reasoning: answers only from claims it holds --------------------------------------
export function answerFromDub(dub, intent) {
  const claim = dub.knowledge.find((k) => k.topic === intent.topic);
  const owner = dub.profile.name.split(' ')[0];
  if (!claim) {
    return {
      kind: 'unknown', provenance: 'unknown', text: 'I don’t have sufficient evidence to establish that.',
      evidence: [], canAsk: !!(dub.clarifications && dub.clarifications.allowed && intent.clarify),
      followUp: dub.clarifications.allowed && intent.clarify ? `${owner} allows clarification requests. I can ask ${dub.profile.name.split(' ')[0]}.` : null,
    };
  }
  if (claim.access === 'private') {
    // Dub knows it but policy forbids disclosure; never leak the source or the content.
    return { kind: 'private', provenance: 'private', text: `I hold context on that, but ${owner}’s policy does not permit me to disclose it.`, evidence: [], claimId: claim.id };
  }
  if (claim.access === 'permission') {
    return { kind: 'permission', provenance: claim.provenance, text: `${owner} must approve disclosure of that. I can request permission.`, evidence: [], claimId: claim.id };
  }
  return { kind: 'answer', provenance: claim.provenance, text: claim.answer, evidence: claim.evidence, claimId: claim.id, addedAt: claim.addedAt, source: claim.source, learned: !!claim.learned };
}

export function askDub(s, intentId) {
  const intent = INTENTS.find((i) => i.id === intentId);
  if (!intent) throw new Error(`Unknown intent ${intentId}`);
  const a = answerFromDub(s.dub, intent);
  if (!s.interview.asked.includes(intentId)) s.interview.asked.push(intentId);
  s.interview.log.push({ who: 'requester', text: intent.ask, intentId });
  const rec = { who: 'dub', intentId, ...a };
  if (a.kind === 'unknown' && a.canAsk) s.interview.awaitingClarification = intentId;
  s.interview.log.push(rec);
  return rec;
}

// Human clarification → persistent, provenance-tagged Dub context.
export function clarify(s, intentId, response, note) {
  const intent = INTENTS.find((i) => i.id === intentId);
  if (!intent || !intent.clarify) throw new Error('Not clarifiable');
  if (s.dub.knowledge.some((k) => k.topic === intent.topic)) return s.dub.knowledge.find((k) => k.topic === intent.topic); // idempotent
  const c = intent.clarify;
  const answer = response === 'yes' ? c.answerYes : response === 'no' ? c.answerNo : (note ? `Sarah confirms her involvement and adds: “${note}”` : c.answerContext);
  const claim = {
    id: `k_learned_${intent.topic}`, topic: intent.topic,
    text: response === 'no' ? 'Did not personally negotiate the lead investor’s final terms' : c.learnedText,
    answer, provenance: 'self', access: 'dub', source: 'Sarah', addedAt: today(), learned: true,
    evidence: [{ label: 'Sarah (direct clarification)', kind: 'self' }],
  };
  s.dub.knowledge.push(claim);
  s.interview.learned.push(claim.id);
  s.interview.awaitingClarification = null;
  const rec = { who: 'dub', intentId, ...answerFromDub(s.dub, intent) };
  s.interview.log.push(rec);
  return claim;
}

export function coverage(s) {
  const learned = s.dub.knowledge.filter((k) => k.learned).length;
  const crumbs = s.dub.breadcrumbs.filter((b) => b.earned).length;
  return Math.min(100, COVERAGE.base + learned * COVERAGE.perLearnedClaim + crumbs * COVERAGE.perBreadcrumb);
}

// ---- batch qualification -------------------------------------------------------------------
export function runBatchQualification(s) {
  CANDIDATES.forEach((c) => unlockContext(s, c.id));
  s.batch.done = true;
  return batchSummary(s);
}
export function batchSummary(s) {
  const qualified = CANDIDATES.filter((c) => !c.exclusion).sort((a, b) => b.contextual - a.contextual);
  const excluded = CANDIDATES.filter((c) => c.exclusion);
  return { investigated: CANDIDATES.length, contextSpend: contextSpend(s), qualified, excluded };
}

// ---- trust & anti-bot scaffolding ----------------------------------------------------------
export function requiredTrustLevel(valueUsd) { return TRUST_TIERS.find((t) => valueUsd <= t.upTo).level; }

export function evaluateTrust(i) {
  const {
    valueUsd = 25, trustLevel = 2, plannedMin = 60, actualMin = 60, demoClock = false,
    deviceMatch = true, duplicatePayout = false, repeat24h = 0, studioVerified = true,
  } = i;
  const signals = [];
  const add = (id, label, status, detail) => signals.push({ id, label, status, detail }); // status: pass | flag | bypass
  add('studio', 'Verified Studio participation', studioVerified ? 'pass' : 'flag', studioVerified ? 'Both participants were present in the recorded room.' : 'No verified Studio presence.');
  add('device', 'Device / session consistency', deviceMatch ? 'pass' : 'flag', deviceMatch ? 'Same device and session throughout.' : 'Session changed devices mid-Jam.');
  add('dup', 'Duplicate identity / payout destination', duplicatePayout ? 'flag' : 'pass', duplicatePayout ? 'Payout destination is shared with another account.' : 'Payout destination is unique.');
  const tooFast = actualMin < plannedMin * 0.25;
  add('speed', 'Completion speed', demoClock && tooFast ? 'bypass' : tooFast ? 'flag' : 'pass',
    demoClock && tooFast ? 'Demo clock: compressed session. In live mode this would hold the payout.' : tooFast ? `Finished in ${actualMin} min of ${plannedMin} planned.` : `${actualMin} of ${plannedMin} minutes.`);
  add('repeat', 'Repeated participation', repeat24h >= 3 ? 'flag' : 'pass', repeat24h >= 3 ? `${repeat24h} paid Jams with the same counterparty in 24h.` : 'No suspicious repetition.');
  const need = requiredTrustLevel(valueUsd);
  add('tier', 'Progressive verification', trustLevel >= need ? 'pass' : 'flag', `$${valueUsd} needs Level ${need}; account is Level ${trustLevel}.`);
  const flagged = signals.filter((x) => x.status === 'flag');
  let decision = 'release';
  if (trustLevel < need) decision = 'step_up';
  else if (flagged.length) decision = 'hold';
  return { decision, signals, flagged: flagged.length };
}

// ---- Jam lifecycle -------------------------------------------------------------------------
export function requestIntro(s) { s.intro.requested = true; }
export function acceptIntro(s) {
  s.intro.accepted = true;
  s.intro.disclosed = ['Display name', 'Company', 'Contact via Toasty only'];
}
export function createJam(s) {
  if (!s.intro.accepted) throw new Error('Jam requires Sarah’s acceptance');
  if (s.jam.created) return;
  s.jam.created = true;
  addLedger(s, { kind: 'jam_commit', label: 'Jam committed · funds held until completion', amountUsd: JAM.rate, from: REQUESTER.org, to: 'Jam escrow (held)', jamId: JAM.id });
}

export function completeJam(s, { actualMin = 60, demoClock = true, overrides = {} } = {}) {
  if (!s.jam.created) throw new Error('No Jam to complete');
  if (s.post.settled) return s.post.trust;
  s.post.coverageBefore = coverage(s);
  const trust = evaluateTrust({ valueUsd: JAM.rate, trustLevel: 2, plannedMin: 60, actualMin, demoClock, ...overrides });
  s.post.trust = trust;
  s.jam.ended = true;
  s.dub.breadcrumbs.push({
    id: 'bc_jam_1', text: 'Participated in a 60-minute founder fundraising research Jam.', status: 'verified', date: today(),
    evidence: ['Studio session', 'Transcript'], earned: true,
  });
  s.post.breadcrumb = 'bc_jam_1';
  s.dub.sources.find((x) => x.id === 'jams').detail = '1 completed';
  s.dub.sources.find((x) => x.id === 'breadcrumbs').detail = '3 on record';
  if (trust.decision === 'release') {
    addLedger(s, { kind: 'dough_credit', label: 'Dough released to Sarah', amountUsd: JAM.rate, from: 'Jam escrow (held)', to: 'Sarah · Dough', jamId: JAM.id });
    s.sarahDough = round2(s.sarahDough + JAM.rate);
    s.post.settled = true;
  } else {
    addLedger(s, { kind: 'payment_hold', label: `Payout held for review (${trust.decision})`, amountUsd: JAM.rate, from: 'Jam escrow (held)', to: 'Review queue', jamId: JAM.id });
    s.post.settled = true; s.post.held = true;
  }
  s.post.coverageAfter = coverage(s);
  return trust;
}

export function transcriptFor() { return TRANSCRIPT; }

// ---- Non-Peep → Peep growth loop -----------------------------------------------------------
export function claimDub(s) {
  if (s.growth.claimed) return s.growth.claimedDub;
  const dub = {
    owner: INVITEE.name, headline: INVITEE.headline, coverage: 12,
    breadcrumbs: [{ text: 'Participated in a 60-minute founder fundraising research Jam.', status: 'verified', date: today(), evidence: ['Studio session', 'Transcript'] }],
    pendingDoughUsd: PRICING.externalOfferUsd,
  };
  s.growth.claimed = true; s.growth.claimedDub = dub;
  addLedger(s, { kind: 'dough_pending_claim', label: `Compensation waiting to be claimed · ${INVITEE.name}`, amountUsd: PRICING.externalOfferUsd, from: 'Jam escrow (held)', to: `${INVITEE.name} · unclaimed Dough`, });
  return dub;
}

// ---- lifecycle rail ------------------------------------------------------------------------
export function railIndex(s) {
  switch (s.step) {
    case 'outcome': return 0;
    case 'discovery': return Object.keys(s.unlocked).length ? 2 : 1;
    case 'interview': return 3;
    case 'matches': return 4;
    case 'permission': return 5;
    case 'jam': return 6;
    case 'studio': return 7;
    case 'postjam': return 8 + Math.min(2, s.post.stage);
    case 'growth': return 11;
    default: return -1;
  }
}
