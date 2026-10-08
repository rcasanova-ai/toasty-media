// Seeded, deterministic data for the Toasty Peeps golden-path demo.
// Everything in this file is DEMO / SEEDED data. Nothing here is a real person, a real balance
// or a real on-chain transaction.

export const PRICING = {
  contextUnlockUsd: 0.25, // Peeps platform-standard microprice, not configured per Peep
  jam30Usd: 15,
  jam60Usd: 25,
  externalOfferUsd: 40,
};

export const REQUEST_TEXT =
  'A Solana payments startup needs someone who can open institutional banking and fintech partnerships in Southeast Asia.';

export const INVESTIGATION_BUDGET_USD = 5;

export const PARSED_CRITERIA = [
  { key: 'Market', value: 'Southeast Asia', icon: 'pin' },
  { key: 'Capability', value: 'Banking + payment partnerships', icon: 'spark' },
  { key: 'Buyer', value: 'Institutional financial institutions', icon: 'user' },
  { key: 'Must have', value: 'Procurement + compliance fluency', icon: 'clock' },
  { key: 'Not enough', value: 'Crypto reach alone', icon: 'ban', negative: true },
  { key: 'Purpose', value: 'Warm qualified introduction', icon: 'search' },
  { key: 'Desired outcome', value: '1 qualified partner operator', icon: 'mic' },
];

export const REQUESTER = {
  name: 'Requester',
  org: 'Confidential Solana payments startup',
  agent: 'Requester Agent',
  demoOrg: true,
};

// ---- Provenance + access vocab -------------------------------------------------------------
export const PROVENANCE = {
  verified: { label: 'Verified', tip: 'Supported by strong evidence.' },
  corroborated: { label: 'Corroborated', tip: 'Supported by multiple sources.' },
  self: { label: 'Self-attested', tip: 'The human told their Dub.' },
  inferred: { label: 'Inferred', tip: 'Reasonable inference from evidence; not established fact.' },
  unknown: { label: 'Unknown', tip: 'The Dub does not have enough information.' },
  private: { label: 'Private', tip: 'The Dub knows this, but policy does not permit disclosure.' },
};

export const ACCESS = {
  public: { label: 'Public', tip: 'Visible normally.' },
  dub: { label: 'Dub-readable', tip: 'Agents can reason against it within policy.' },
  paid: { label: 'Paid context', tip: 'Available after an authorized micro-payment.' },
  permission: { label: 'Permission required', tip: 'The human must approve disclosure.' },
  private: { label: 'Private', tip: 'Never disclosed. Source material is never exposed.' },
};

// ---- Sarah's Dub (the hero Dub, also the "my Dub" shown in Act 1) --------------------------
export const SARAH_DUB = {
  id: 'dub_sarah_chen',
  profile: {
    name: 'Sarah Chen',
    headline: 'Former regional fintech partnerships director — banking and payment rails, Southeast Asia',
    role: 'Fintech partnerships operator',
    location: 'Singapore / Bangkok',
    industries: ['Fintech', 'Banking partnerships', 'Payments', 'Regulated financial services'],
    expertise: ['Institutional banking relationships', 'Payment-sector partnerships', 'Enterprise procurement', 'Compliance-led go-to-market'],
    languages: ['English', 'Mandarin', 'Thai (conversational)'],
  },
  interests: {
    topics: ['Bank partnership strategy', 'Payment-sector distribution', 'Institutional procurement', 'Fintech compliance'],
    opportunities: ['Paid qualification calls', 'Advisory', 'Partnership scoping'],
    people: ['Founders building regulated payment products', 'Fintech BD leaders', 'Banking innovation teams'],
  },
  boundaries: {
    topics: ['Named bank contacts without consent', 'Private commercial terms', 'Non-public procurement details'],
    requests: ['Unpaid "pick your brain" asks', 'Lead lists', 'Requests to bypass bank process'],
    industries: ['Gambling', 'Adult'],
  },
  availability: {
    introductions: true,
    research: true,
    advisory: true,
    interviews: true,
    focusGroups: false,
  },
  pricing: { jam30: PRICING.jam30Usd, jam60: PRICING.jam60Usd, introRule: 'Introductions only after a paid Jam or explicit approval' },
  clarifications: { allowed: true, channel: 'Lightweight prompt · usually answered within a day' },
  sources: [
    { id: 'linkedin', label: 'LinkedIn', state: 'connected', detail: 'Profile + employment history', demo: true },
    { id: 'website', label: 'Website', state: 'connected', detail: 'sarahchen.example · advisory page', demo: true },
    { id: 'github', label: 'GitHub', state: 'not_connected', detail: 'Not connected', demo: false },
    { id: 'x', label: 'X / social', state: 'not_connected', detail: 'Not connected', demo: false },
    { id: 'cv', label: 'CV', state: 'uploaded', detail: 'sarah-chen-fintech-partnerships.pdf · uploaded', demo: true },
    { id: 'portfolio', label: 'Portfolio', state: 'not_connected', detail: 'Not connected', demo: false },
    { id: 'docs', label: 'Uploaded documents', state: 'uploaded', detail: 'Case notes and speaking bio (simulated)', demo: true },
    { id: 'jams', label: 'Prior Jams', state: 'verified', detail: '0 completed', demo: true },
    { id: 'breadcrumbs', label: 'Breadcrumbs', state: 'verified', detail: '2 on record', demo: true },
  ],
  breadcrumbs: [
    { id: 'bc_fintech_1', text: 'Former regional fintech partnerships director with payment-sector focus.', status: 'verified', date: 'Mar 2026', evidence: ['LinkedIn', 'Uploaded CV'] },
    { id: 'bc_fintech_2', text: 'Speaker on bank partnership readiness for regulated fintech teams.', status: 'self', date: 'Aug 2026', evidence: ['Self-attested'] },
  ],
  knowledge: [
    {
      id: 'k_role', topic: 'role',
      text: 'Former regional fintech partnerships director',
      answer: 'Sarah was a regional fintech partnerships director focused on banking and payment-sector partnerships.',
      provenance: 'verified', access: 'public',
      evidence: [{ label: 'LinkedIn', kind: 'connected' }, { label: 'Uploaded CV', kind: 'uploaded' }],
    },
    {
      id: 'k_location', topic: 'location',
      text: 'Works across Singapore, Thailand and regional Southeast Asia',
      answer: 'Sarah works across Singapore, Thailand and regional Southeast Asia.',
      provenance: 'corroborated', access: 'public',
      evidence: [{ label: 'LinkedIn', kind: 'connected' }, { label: 'CV', kind: 'uploaded' }],
    },
    {
      id: 'k_banking', topic: 'banking_relationships',
      text: 'Established banking and payment-sector partnership experience',
      answer: 'Yes. Sarah has established banking and payment-sector partnership experience in Southeast Asia.',
      provenance: 'corroborated', access: 'public',
      evidence: [{ label: 'Uploaded CV', kind: 'uploaded' }, { label: 'Speaking bio', kind: 'uploaded' }],
    },
    {
      id: 'k_procurement', topic: 'institutional_procurement',
      text: 'Understands institutional procurement and compliance review',
      answer: 'Yes. Her Dub has evidence of institutional procurement, compliance review, and vendor onboarding experience.',
      provenance: 'corroborated', access: 'dub',
      evidence: [{ label: 'Uploaded CV', kind: 'uploaded' }, { label: 'Self-attested context', kind: 'self' }],
    },
    {
      id: 'k_fit', topic: 'solana_fit',
      text: 'Can advise a Solana payments startup without exposing confidential requester identity',
      answer: 'Yes. Sarah can assess a confidential Solana payments opportunity at the capability level without receiving the requester’s identity.',
      provenance: 'corroborated', access: 'dub',
      evidence: [{ label: 'Availability settings', kind: 'self' }, { label: 'Boundaries policy', kind: 'self' }],
    },
    {
      id: 'k_open_research', topic: 'research_policy',
      text: 'Open to compensated research and advisory conversations',
      answer: 'Yes. Sarah permits compensated qualification and advisory Jams, including confidential startup requests. Her 60-minute Jam rate is $25.',
      provenance: 'self', access: 'public',
      evidence: [{ label: 'Sarah’s availability settings', kind: 'self' }],
    },
    {
      id: 'k_off_limits', topic: 'off_limits',
      text: 'Will not disclose named bank contacts, private commercial terms or non-public procurement details',
      answer: 'Named bank contacts, private commercial terms and non-public procurement details are restricted.',
      provenance: 'self', access: 'public',
      evidence: [{ label: 'Sarah’s boundaries', kind: 'self' }],
    },
    {
      id: 'k_languages', topic: 'languages',
      text: 'Speaks English, Mandarin and conversational Thai',
      answer: 'Sarah speaks English and Mandarin, and conversational Thai.',
      provenance: 'self', access: 'dub',
      evidence: [{ label: 'CV', kind: 'uploaded' }],
    },
    {
      id: 'k_named_banks', topic: 'named_banks',
      text: 'Named bank contacts and private relationship details',
      answer: '',
      provenance: 'private', access: 'private',
      evidence: [], // source material is never exposed
    },
  ],
};

// ---- Interview script ----------------------------------------------------------------------
// Each intent asks the Dub something. The Dub answers ONLY from claims it holds. `topic` ties the
// intent to claim.topic. A missing claim is an honest "unknown".
export const INTENTS = [
  { id: 'q_banking', topic: 'banking_relationships', script: true, ask: 'Does Sarah have banking and payment-sector partnership experience in Southeast Asia?' },
  { id: 'q_procurement', topic: 'institutional_procurement', script: true, ask: 'Has Sarah navigated institutional procurement and compliance review?' },
  { id: 'q_fit', topic: 'solana_fit', script: true, ask: 'Can Sarah engage on a confidential Solana payments opportunity without receiving requester identity?' },
  { id: 'q_comfort', topic: 'research_policy', script: true, ask: 'Is Sarah open to a compensated qualification Jam?', attachRate: true },
  { id: 'q_limits', topic: 'off_limits', script: true, ask: 'What topics will Sarah not disclose?' },
  {
    id: 'q_terms', topic: 'willingness', script: true, unknownDemo: true,
    ask: 'Is Sarah willing to engage with this type of startup now?',
    clarify: {
      prompt: 'Are you willing to evaluate a confidential Solana payments startup seeking banking and fintech partnerships in Southeast Asia?',
      learnedText: 'Willing to evaluate confidential Solana payments partnership opportunities',
      answerYes: 'Sarah confirms she is willing to evaluate the opportunity and discuss partnership paths.',
      answerNo: 'Sarah confirms that she is not available for this opportunity.',
      answerContext: 'Sarah confirms willingness to engage and adds context: she can discuss qualification paths without receiving the requester’s identity.',
    },
  },
  { id: 'x_round', topic: 'named_banks', script: false, ask: 'Which named bank relationships can she introduce us to?' },
  { id: 'x_lang', topic: 'languages', script: false, ask: 'Which languages does she work in?' },
];

// ---- Candidates ----------------------------------------------------------------------------
// surface = naive keyword match. contextual = after unlock + Dub qualification.
// exclusion: null means qualified.
export const CANDIDATES = [
  {
    id: 'david', name: 'David Reyes', initials: 'DR', hue: 345, headline: 'Web3 founder · conference speaker', sector: 'Crypto community + token launches',
    raise: '30,000 followers', openTo: 'Open to advisory', crypto: 'Deep crypto exposure', confidence: 'High',
    surface: 94, contextual: 0, rate: 35, rateUnit: 'hour', seeded: true,
    exclusion: { reason: 'No demonstrated institutional banking capability', detail: 'David has strong Web3 community and token-launch experience, but his Dub has no evidence of institutional banking relationships, enterprise procurement, or regulated financial-institution navigation.' },
  },
  {
    id: 'sarah', name: 'Sarah Chen', initials: 'SC', hue: 22, headline: 'Former fintech partnerships director', sector: 'Banking + payments partnerships',
    raise: 'Regional SEA experience', openTo: 'Open to qualification Jam', crypto: 'Fintech, not token-launch led', confidence: 'High',
    surface: 82, contextual: 92, rate: 25, rateUnit: 'hour', hero: true, exclusion: null,
    reasons: ['Former regional fintech partnerships director', 'Established banking and payment-sector experience', 'Understands institutional procurement and compliance', 'Confirmed willingness to engage through her Dub'],
  },
];

// ---- Jam ------------------------------------------------------------------------------------
export const JAM = {
  id: 'jam_demo_partnership_001',
  title: 'Banking Partnership Qualification Jam',
  minutes: 60,
  rate: PRICING.jam60Usd,
};

export const TRANSCRIPT = [
  { t: '00:02', who: 'Requester', text: 'Thanks, Sarah. At a high level, where do Solana payment startups usually get stuck with banks?' },
  { t: '00:05', who: 'Sarah', text: 'The first blocker is procurement readiness. Banks need risk, compliance and settlement answers before an innovation team can champion anything.' },
  { t: '00:09', who: 'Requester', text: 'What makes a fintech partnership lead credible to them?' },
  { t: '00:12', who: 'Sarah', text: 'Someone who understands regulated vendor onboarding, not just ecosystem momentum. You need the bank’s operating path, not a louder pitch.' },
  { t: '00:16', who: 'Requester', text: 'Could you help us map that path in Southeast Asia?' },
  { t: '00:19', who: 'Sarah', text: 'Yes, at the capability level first. I will not disclose private bank contacts, but I can help qualify the route and readiness gaps.' },
];

export const POST_JAM = {
  durationLabel: '0:20 demo clip (60-minute Jam, compressed for the pitch)',
  summary:
    'Sarah qualified the request around banking partnership readiness: procurement, compliance review, settlement questions and Southeast Asia payment-sector routing. She withheld named bank contacts and private commercial details.',
  insights: [
    'Institutional banks require procurement and compliance readiness before partnership momentum matters.',
    'Crypto audience size is not evidence of bank-access capability.',
    'Sarah can help map readiness gaps while protecting private relationship details.',
  ],
  actions: ['Follow up: request a banking-partnership readiness map from Sarah.', 'Keep requester identity confidential until both sides approve disclosure.'],
};

// ---- Growth loop ---------------------------------------------------------------------------
export const EXTERNAL_MATCHES = [
  { id: 'ext1', name: 'Maya P.', initials: 'MP', hue: 70, headline: 'Payments compliance operator · Jakarta', note: 'Public panel: bank onboarding for fintechs', source: 'Public event page + profile' },
  { id: 'ext2', name: 'Arun K.', initials: 'AK', hue: 310, headline: 'Regional bank innovation advisor', note: 'Public interview on payment partnerships', source: 'Public interview + company site' },
];
export const INVITEE = EXTERNAL_MATCHES[0];

export const TRUST_TIERS = [
  { level: 1, name: 'Basic', upTo: 25, needs: 'Email + verified Studio presence' },
  { level: 2, name: 'Established', upTo: 100, needs: 'Level 1 + verified payout destination + 1 verified Breadcrumb' },
  { level: 3, name: 'Trusted', upTo: Infinity, needs: 'Level 2 + identity check + participation history' },
];

// ---- David's Dub: excellent on keywords, excluded on context ---------------------------------
export const DAVID_DUB = {
  id: 'dub_david_reyes',
  profile: { name: 'David Reyes' },
  clarifications: { allowed: false },
  knowledge: [
    {
      id: 'd_web3', topic: 'web3_reach', text: '30,000 followers, crypto conference speaker and 8 years in Web3',
      answer: 'Yes. David has 30,000 followers, speaks at crypto conferences and has 8 years of Web3 experience.',
      provenance: 'corroborated', access: 'dub',
      evidence: [{ label: 'Public social profile (simulated)', kind: 'connected' }, { label: 'Conference bio (simulated)', kind: 'connected' }],
    },
    {
      id: 'd_community', topic: 'community_launches', text: 'Strong community and token-launch experience',
      answer: 'David’s evidence is strongest around crypto community-building and token-launch work.',
      provenance: 'corroborated', access: 'dub',
      evidence: [{ label: 'Token-launch case notes (simulated)', kind: 'uploaded' }, { label: 'Conference talks (simulated)', kind: 'connected' }],
    },
    {
      id: 'd_bank_gap', topic: 'bank_gap', text: 'No demonstrated institutional banking relationships or enterprise procurement experience',
      answer: 'I do not have evidence of institutional banking relationships, enterprise procurement experience or regulated financial-institution navigation for David.',
      provenance: 'unknown', access: 'dub',
      evidence: [],
    },
  ],
};
export const DAVID_INTENTS = [
  { id: 'd_q_web3', topic: 'web3_reach', ask: 'Does David have a strong crypto profile?' },
  { id: 'd_q_community', topic: 'community_launches', ask: 'What is David’s strongest demonstrated capability?' },
  { id: 'd_q_bank_gap', topic: 'bank_gap', ask: 'Does David have demonstrated institutional banking relationships and procurement experience?' },
];

// Order the agent investigates the pool. David and Sarah get full conversations; the rest stream.
export const INVESTIGATION_ORDER = ['david', 'sarah'];
export const FAST_STREAM_NOTES = {
  david: 'High Web3 reach · no bank procurement evidence',
  sarah: 'Fintech partnerships · banking and payment-sector experience',
};
