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
  'Find founders in Thailand who raised a seed round in the last 18 months. No crypto. I want to interview the best three about their fundraising experience.';

export const INVESTIGATION_BUDGET_USD = 5;

export const PARSED_CRITERIA = [
  { key: 'Location', value: 'Thailand', icon: 'pin' },
  { key: 'Role', value: 'Founder', icon: 'user' },
  { key: 'Event', value: 'Seed funding', icon: 'spark' },
  { key: 'Recency', value: '≤ 18 months', icon: 'clock' },
  { key: 'Exclude', value: 'Crypto', icon: 'ban', negative: true },
  { key: 'Purpose', value: 'Fundraising research', icon: 'search' },
  { key: 'Desired outcome', value: '3 interviews', icon: 'mic' },
];

export const REQUESTER = {
  name: 'Ricardo',
  org: 'Halcyon Research',
  agent: 'Halcyon Agent',
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
    headline: 'Founder & CEO, Lumen Ledger — finance-ops automation for mid-market teams',
    role: 'Founder & CEO',
    location: 'Bangkok, Thailand',
    industries: ['Enterprise SaaS', 'Finance operations', 'B2B automation'],
    expertise: ['Seed fundraising', 'Enterprise sales', 'Founder-led hiring', 'Southeast Asia go-to-market'],
    languages: ['English', 'Mandarin', 'Thai (conversational)'],
  },
  interests: {
    topics: ['Founder fundraising', 'Regional SaaS markets', 'AI in finance ops'],
    opportunities: ['Paid research conversations', 'Advisory', 'Founder interviews'],
    people: ['First-time founders', 'Seed-stage investors who back regional SaaS'],
  },
  boundaries: {
    topics: ['Investor-specific confidential details', 'Private cap-table details', 'Personal finances'],
    requests: ['Unpaid "pick your brain" asks', 'Recruiting pitches', 'Anything requiring an NDA up front'],
    industries: ['Crypto / digital assets', 'Gambling', 'Adult'],
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
    { id: 'website', label: 'Website', state: 'connected', detail: 'lumenledger.example · company page', demo: true },
    { id: 'github', label: 'GitHub', state: 'not_connected', detail: 'Not connected', demo: false },
    { id: 'x', label: 'X / social', state: 'not_connected', detail: 'Not connected', demo: false },
    { id: 'cv', label: 'CV', state: 'uploaded', detail: 'sarah-chen-cv.pdf · uploaded', demo: true },
    { id: 'portfolio', label: 'Portfolio', state: 'not_connected', detail: 'Not connected', demo: false },
    { id: 'docs', label: 'Uploaded documents', state: 'uploaded', detail: 'Seed announcement (press release)', demo: true },
    { id: 'jams', label: 'Prior Jams', state: 'verified', detail: '0 completed', demo: true },
    { id: 'breadcrumbs', label: 'Breadcrumbs', state: 'verified', detail: '2 on record', demo: true },
  ],
  breadcrumbs: [
    { id: 'bc_seed_1', text: 'Founder & CEO of Lumen Ledger', status: 'verified', date: 'Mar 2024', evidence: ['Company registry', 'LinkedIn'] },
    { id: 'bc_seed_2', text: 'Speaker, Bangkok SaaS Summit 2025', status: 'self', date: 'Nov 2025', evidence: ['Self-attested'] },
  ],
  knowledge: [
    {
      id: 'k_role', topic: 'role',
      text: 'Founder & CEO of Lumen Ledger',
      answer: 'Sarah is founder and CEO of Lumen Ledger.',
      provenance: 'verified', access: 'public',
      evidence: [{ label: 'Founder profile', kind: 'connected' }, { label: 'Company website', kind: 'connected' }],
    },
    {
      id: 'k_location', topic: 'location',
      text: 'Lives in Bangkok, Thailand',
      answer: 'Sarah is based in Bangkok.',
      provenance: 'corroborated', access: 'public',
      evidence: [{ label: 'LinkedIn', kind: 'connected' }, { label: 'CV', kind: 'uploaded' }],
    },
    {
      id: 'k_seed_close', topic: 'seed_close',
      text: 'Closed a seed round in February 2026',
      answer: 'Yes. The company announced a seed round that closed in February 2026.',
      provenance: 'corroborated', access: 'public',
      evidence: [{ label: 'Company announcement', kind: 'uploaded' }, { label: 'LinkedIn', kind: 'connected' }],
    },
    {
      id: 'k_led_raise', topic: 'led_raise',
      text: 'Personally led the fundraising process through close',
      answer: 'Yes. Available evidence indicates Sarah led the fundraising process through close in February 2026.',
      provenance: 'corroborated', access: 'dub',
      evidence: [{ label: 'Founder profile', kind: 'connected' }, { label: 'Company announcement', kind: 'uploaded' }, { label: 'Self-attested context', kind: 'self' }],
    },
    {
      id: 'k_sector', topic: 'sector',
      text: 'Company is enterprise SaaS (finance-ops automation)',
      answer: 'No. Her recent professional activity is primarily enterprise SaaS, with no crypto or digital-asset exposure.',
      provenance: 'corroborated', access: 'dub',
      evidence: [{ label: 'Company website', kind: 'connected' }, { label: 'Company announcement', kind: 'uploaded' }, { label: 'Founder profile', kind: 'connected' }],
    },
    {
      id: 'k_open_research', topic: 'research_policy',
      text: 'Open to compensated research and advisory conversations',
      answer: 'Yes. Sarah permits compensated research and advisory Jams, including with founders she does not know. Her 60-minute Jam rate is $25.',
      provenance: 'self', access: 'public',
      evidence: [{ label: 'Sarah’s availability settings', kind: 'self' }],
    },
    {
      id: 'k_off_limits', topic: 'off_limits',
      text: 'Will not disclose investor-specific confidential information or private cap-table details',
      answer: 'Investor-specific confidential information and private cap-table details are restricted.',
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
      id: 'k_round_size', topic: 'round_size',
      text: 'Round size and valuation',
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
  { id: 'q_led', topic: 'led_raise', script: true, ask: 'Did Sarah personally lead her company’s seed raise?' },
  { id: 'q_crypto', topic: 'sector', script: true, ask: 'Is Sarah’s work primarily related to cryptocurrency?' },
  { id: 'q_comfort', topic: 'research_policy', script: true, ask: 'Is Sarah open to compensated fundraising research?', attachRate: true },
  { id: 'q_limits', topic: 'off_limits', script: true, ask: 'What topics will Sarah not disclose?' },
  {
    id: 'q_terms', topic: 'lead_terms', script: true, unknownDemo: true,
    ask: 'Did Sarah personally negotiate the final terms with the lead investor?',
    clarify: {
      prompt: 'Did you personally negotiate the lead investor’s final terms?',
      learnedText: 'Personally negotiated the lead investor’s final terms',
      answerYes: 'Sarah confirms she participated directly in the final negotiation.',
      answerNo: 'Sarah confirms that she did not personally negotiate the final terms.',
      answerContext: 'Sarah confirms her involvement and adds context: she negotiated the structure directly; counsel handled the drafting.',
    },
  },
  { id: 'x_round', topic: 'round_size', script: false, ask: 'What was the round size and valuation?' },
  { id: 'x_lang', topic: 'languages', script: false, ask: 'Which languages does she work in?' },
];

// ---- Candidates ----------------------------------------------------------------------------
// surface = naive keyword match. contextual = after unlock + Dub qualification.
// exclusion: null means qualified.
export const CANDIDATES = [
  {
    id: 'sarah', name: 'Sarah Chen', initials: 'SC', hue: 22, headline: 'Founder · Bangkok', sector: 'Enterprise SaaS',
    raise: 'Seed · Feb 2026', openTo: 'Open to research', crypto: 'No crypto exposure', confidence: 'High',
    surface: 96, contextual: 94, rate: 25, rateUnit: 'hour', hero: true, exclusion: null,
    reasons: ['Led her seed raise through close (Feb 2026)', 'Enterprise SaaS, no crypto exposure', 'Permits compensated research', 'Clarified negotiation role herself'],
  },
  {
    id: 'niran', name: 'Niran Suwannarat', initials: 'NS', hue: 160, headline: 'Founder · Chiang Mai', sector: 'Logistics SaaS',
    raise: 'Seed · Nov 2025', openTo: 'Open to research', crypto: 'No crypto exposure', confidence: 'High',
    surface: 90, contextual: 91, rate: 30, rateUnit: 'hour', seeded: true, exclusion: null,
    reasons: ['Seed closed Nov 2025 (10 months)', 'Logistics SaaS, no crypto', 'Available for interviews this week'],
  },
  {
    id: 'michael', name: 'Michael Tan', initials: 'MT', hue: 200, headline: 'Founder · Phuket', sector: 'Healthtech SaaS',
    raise: 'Seed · Jun 2025', openTo: 'Open to research', crypto: 'No crypto exposure', confidence: 'Medium',
    surface: 84, contextual: 87, rate: 20, rateUnit: 'hour', seeded: true, exclusion: null,
    reasons: ['Seed closed Jun 2025 (16 months — inside window)', 'Clinic-scheduling SaaS', 'Lower rate, strong first-raise story'],
  },
  {
    id: 'david', name: 'David Reyes', initials: 'DR', hue: 345, headline: 'Founder · Bangkok', sector: 'Payments infra',
    raise: 'Seed · Jan 2026', openTo: 'Open to research', crypto: 'Crypto exposure detected', confidence: 'High',
    surface: 95, contextual: 0, rate: 35, rateUnit: 'hour', seeded: true,
    exclusion: { reason: 'Recent work primarily crypto', detail: '71% of the last 12 months of activity is token and stablecoin infrastructure.' },
  },
  {
    id: 'anong', name: 'Anong Wattana', initials: 'AW', hue: 290, headline: 'Founder · Bangkok', sector: 'Consumer app',
    raise: 'Seed · Mar 2024', openTo: 'Open to research', crypto: 'No crypto exposure', confidence: 'High',
    surface: 82, contextual: 0, rate: 25, rateUnit: 'hour', seeded: true,
    exclusion: { reason: 'Seed round outside the 18-month window', detail: 'Closed Mar 2024 (31 months ago).' },
  },
  {
    id: 'tom', name: 'Tom Becker', initials: 'TB', hue: 40, headline: 'Founder · Singapore', sector: 'Devtools',
    raise: 'Seed · Jan 2026', openTo: 'Open to research', crypto: 'No crypto exposure', confidence: 'Medium',
    surface: 80, contextual: 0, rate: 30, rateUnit: 'hour', seeded: true,
    exclusion: { reason: 'No longer lives in Thailand', detail: 'Relocated to Singapore in Aug 2026.' },
  },
  {
    id: 'kittipong', name: 'Kittipong Srisuk', initials: 'KS', hue: 120, headline: 'Head of Growth · Bangkok', sector: 'Fintech SaaS',
    raise: 'Company raised seed · Dec 2025', openTo: 'Open to research', crypto: 'No crypto exposure', confidence: 'Medium',
    surface: 78, contextual: 0, rate: 20, rateUnit: 'hour', seeded: true,
    exclusion: { reason: 'Insufficient evidence', detail: 'Not a founder and nothing establishes he ran the raise; his Dub holds no evidence of fundraising involvement.' },
  },
  {
    id: 'mei', name: 'Mei Lin Park', initials: 'ML', hue: 250, headline: 'Founder · Phuket', sector: 'Travel SaaS',
    raise: 'Seed · Apr 2026', openTo: 'Not open to research', crypto: 'No crypto exposure', confidence: 'High',
    surface: 88, contextual: 0, rate: 0, rateUnit: 'hour', seeded: true,
    exclusion: { reason: 'Boundary: not open to research requests', detail: 'Her Dub declines interviews and research. Respected without contacting her.' },
  },
];

// ---- Jam ------------------------------------------------------------------------------------
export const JAM = {
  id: 'jam_demo_fundraising_001',
  title: 'Fundraising Research Jam',
  minutes: 60,
  rate: PRICING.jam60Usd,
};

export const TRANSCRIPT = [
  { t: '00:02', who: 'Ricardo', text: 'Thanks for joining, Sarah. I’d love to start with how the raise actually began.' },
  { t: '00:05', who: 'Sarah', text: 'Happy to. It started six months before I needed the money. Warm intros mattered far more than the deck.' },
  { t: '00:09', who: 'Ricardo', text: 'What surprised you most about the process?' },
  { t: '00:12', who: 'Sarah', text: 'How long diligence took compared to the first meeting. Plan for ten weeks, not four.' },
  { t: '00:16', who: 'Ricardo', text: 'And what would you do differently?' },
  { t: '00:19', who: 'Sarah', text: 'Talk to customers’ finance leads earlier. Investors wanted proof of buyer urgency, not just usage.' },
];

export const POST_JAM = {
  durationLabel: '0:20 demo clip (60-minute Jam, compressed for the pitch)',
  summary:
    'Sarah described a six-month runway-to-raise approach built on warm introductions, a ten-week diligence reality, and buyer-urgency evidence from finance leads. She would start customer evidence earlier next time.',
  insights: [
    'Warm introductions outperformed cold outreach and deck quality.',
    'Diligence took about ten weeks from first meeting to close.',
    'Investors weighted buyer-urgency evidence over raw usage.',
  ],
  actions: ['Follow up: request Sarah’s diligence timeline template (with her permission).', 'Add “buyer urgency evidence” to the fundraising interview guide.'],
};

// ---- Growth loop ---------------------------------------------------------------------------
export const EXTERNAL_MATCHES = [
  { id: 'ext1', name: 'Somchai P.', initials: 'SP', hue: 70, headline: 'Founder · Khon Kaen', note: 'Public announcement: seed round, Jan 2026', source: 'Public announcement + registry record' },
  { id: 'ext2', name: 'Pim K.', initials: 'PK', hue: 310, headline: 'Founder · Hua Hin', note: 'Founder interview in a regional publication', source: 'Public interview + company site' },
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
      id: 'd_seed', topic: 'seed_recent', text: 'Closed a seed round in January 2026',
      answer: 'Yes. David’s company announced a seed round in January 2026, and he led the raise.',
      provenance: 'corroborated', access: 'dub',
      evidence: [{ label: 'Company announcement', kind: 'uploaded' }, { label: 'LinkedIn', kind: 'connected' }],
    },
    {
      id: 'd_crypto', topic: 'crypto_share', text: '71% of recent professional activity relates to crypto',
      answer: '71% of David’s professional activity during the last 12 months relates to crypto.',
      provenance: 'corroborated', access: 'dub',
      evidence: [{ label: 'Company product pages (token & stablecoin rails)', kind: 'connected' }, { label: 'GitHub activity', kind: 'connected' }, { label: 'Conference talks', kind: 'connected' }],
    },
  ],
};
export const DAVID_INTENTS = [
  { id: 'd_q_seed', topic: 'seed_recent', ask: 'Did David lead a seed round within the last 18 months?' },
  { id: 'd_q_crypto', topic: 'crypto_share', ask: 'How much of David’s recent professional activity involves cryptocurrency?' },
];

// Order the agent investigates the pool. David and Sarah get full conversations; the rest stream.
export const INVESTIGATION_ORDER = ['david', 'sarah', 'niran', 'michael', 'tom', 'anong', 'mei', 'kittipong'];
export const FAST_STREAM_NOTES = {
  niran: 'Seed Nov 2025 · logistics SaaS · open to research',
  michael: 'Seed Jun 2025 · healthtech SaaS · open to research',
  tom: 'Relocated to Singapore Aug 2026',
  anong: 'Seed closed Mar 2024 (31 months ago)',
  mei: 'Dub declines research and interviews',
  kittipong: 'Nothing establishes he ran the raise',
};
