import {
  authorizeBookingPayment,
  authorizeExpertDiscoveryPayment,
  createExpertDiscoveryRequirement,
  displayPaymentStatus,
  settleBookingPayment
} from "./toasty-commerce.js";
import { applyBrandTheme, getInitialBrandTheme } from "./brand-themes.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const PROFILE_STORAGE = "toasty_expert_profile_draft_v2";
const WORKSPACE_STORAGE = "toasty_experts_workspace_v1";
const SOLANA_EXPLORER = "https://explorer.solana.com/tx";
const EVIDENCE_STATUSES = Object.freeze({
  PROPOSED: "PROPOSED",
  APPROVED: "APPROVED",
  EDITED: "EDITED",
  REJECTED: "REJECTED",
  STALE: "STALE"
});

const EXPERTS = Object.freeze([
  {
    id: "exp-nadia-maclean",
    name: "Nadia MacLean",
    avatar: "NM",
    headline: "Canadian soccer business analyst",
    bio: "Former club operations strategist focused on Canadian soccer commercialization, supporter growth, sponsorship, and league development.",
    location: "Toronto, Canada",
    languages: ["English", "French"],
    categories: ["Soccer/football", "Media", "Business strategy"],
    topics: ["canadian premier league", "canada soccer", "soccer business", "sponsorship", "club operations", "supporter growth"],
    skills: ["broadcast analysis", "market mapping", "club strategy"],
    experience: ["8 years in Canadian club operations", "Advised sports media teams on league explainers"],
    organizations: ["North Star Sports Advisory", "Harbour City FC"],
    education: ["MBA, Sports Management"],
    credentials: ["Profile reviewed", "Sports business analyst"],
    publications: ["The economics of emerging football leagues"],
    research: ["Fan growth patterns in second-tier football markets"],
    speaking: ["Soccer business panels", "Podcast guest on North American football"],
    media: ["Regional radio contributor", "Podcast analyst"],
    links: ["https://example.com/nadia-maclean"],
    linkedinUrl: "https://linkedin.com/in/demo-nadia-maclean",
    website: "https://example.com/nadia-maclean",
    github: "",
    cvReference: "demo-cv-nadia-maclean.pdf",
    availability: "Tue and Thu afternoons ET",
    hourlyPrice: 375,
    sessionPrice: 425,
    currency: "USDC",
    preferredEngagementTypes: ["Podcast guest", "Interview", "Webinar speaker"],
    verificationState: "Credentials reviewed",
    reputationScore: 94,
    completedEngagements: 18,
    sourceConfirmedEvidence: ["conference speaker on Canadian soccer business", "media interview about Canadian Premier League sponsorship"],
    demonstratedExpertise: ["completed Studio podcast guest booking", "positive ratings for soccer business explainers"],
    publicDataOnly: true
  },
  {
    id: "exp-julien-roche",
    name: "Julien Roche",
    avatar: "JR",
    headline: "Football journalist covering Canada and CONCACAF",
    bio: "Bilingual journalist who explains Canadian player development, CPL storylines, national team context, and media narratives.",
    location: "Montreal, Canada",
    languages: ["English", "French"],
    categories: ["Soccer/football", "Media"],
    topics: ["canadian premier league", "concacaf", "canada soccer", "player development", "world cup", "sports media"],
    skills: ["live commentary", "guest research", "story framing"],
    experience: ["Covered Canadian soccer for 9 seasons", "Hosted weekly football analysis show"],
    organizations: ["Maple Pitch Review"],
    education: ["BA Journalism"],
    credentials: ["Profile reviewed"],
    publications: ["Why the CPL matters before 2026"],
    research: [],
    speaking: ["Broadcast guest", "Fan conference moderator"],
    media: ["Weekly football show", "Matchday analyst"],
    links: ["https://example.com/julien-roche"],
    linkedinUrl: "https://linkedin.com/in/demo-julien-roche",
    website: "https://example.com/julien-roche",
    github: "",
    cvReference: "demo-media-kit-julien-roche.pdf",
    availability: "Weekday mornings ET",
    hourlyPrice: 275,
    sessionPrice: 325,
    currency: "USDC",
    preferredEngagementTypes: ["Podcast guest", "Interview", "Conference speaker"],
    verificationState: "Profile reviewed",
    reputationScore: 91,
    completedEngagements: 31,
    sourceConfirmedEvidence: ["published Canadian Premier League analysis", "podcast interviews about Canada soccer"],
    demonstratedExpertise: ["repeat media bookings on soccer topics"],
    publicDataOnly: true
  },
  {
    id: "exp-owen-kerr",
    name: "Owen Kerr",
    avatar: "OK",
    headline: "Club academy and player pathway consultant",
    bio: "Former academy director specializing in Canadian player pathways, youth development, scouting operations, and league-to-national-team pipelines.",
    location: "Vancouver, Canada",
    languages: ["English"],
    categories: ["Soccer/football", "Business strategy"],
    topics: ["canadian soccer", "academy development", "scouting", "player pathways", "cpl", "youth football"],
    skills: ["technical review", "talent pathway analysis", "executive briefing"],
    experience: ["Built academy scouting programs", "Consulted on youth-to-pro pathway design"],
    organizations: ["Pacific Pathway Lab"],
    education: ["UEFA B coaching education"],
    credentials: ["Credentials reviewed"],
    publications: ["Building durable player pathways in Canada"],
    research: ["Youth minutes and league sustainability"],
    speaking: ["Coaching clinics", "Sports innovation webinars"],
    media: ["Guest analyst for development podcasts"],
    links: ["https://example.com/owen-kerr"],
    linkedinUrl: "https://linkedin.com/in/demo-owen-kerr",
    website: "https://example.com/owen-kerr",
    github: "",
    cvReference: "demo-cv-owen-kerr.pdf",
    availability: "Mon and Wed evenings PT",
    hourlyPrice: 450,
    sessionPrice: 500,
    currency: "USDC",
    preferredEngagementTypes: ["Podcast guest", "Consultation", "Technical review"],
    verificationState: "Verified",
    reputationScore: 96,
    completedEngagements: 12,
    publicDataOnly: true
  },
  {
    id: "exp-marcus-vale",
    name: "Marcus Vale",
    avatar: "MV",
    headline: "Solana payments infrastructure operator",
    bio: "Engineer and operator focused on stablecoin settlement, agent payment flows, and production Solana integrations.",
    location: "Lisbon, Portugal",
    languages: ["English", "Portuguese"],
    categories: ["Crypto/Solana", "AI", "Enterprise technology"],
    topics: ["solana", "usdc", "x402", "agent payments", "wallets", "stablecoin settlement"],
    skills: ["architecture review", "developer education", "payment operations"],
    experience: ["Built stablecoin payout tooling", "Advised agent commerce teams"],
    organizations: ["RailForge Labs"],
    education: ["MSc Distributed Systems"],
    credentials: ["Credentials reviewed"],
    publications: ["Stablecoin settlement for autonomous services"],
    research: ["Machine-native payment authorization patterns"],
    speaking: ["Solana ecosystem meetups", "Agent commerce panels"],
    media: ["Technical podcasts"],
    links: ["https://example.com/marcus-vale"],
    linkedinUrl: "https://linkedin.com/in/demo-marcus-vale",
    website: "https://example.com/marcus-vale",
    github: "https://github.com/demo-marcus-vale",
    cvReference: "demo-cv-marcus-vale.pdf",
    availability: "Flexible UTC mornings",
    hourlyPrice: 525,
    sessionPrice: 650,
    currency: "USDC",
    preferredEngagementTypes: ["Technical review", "Webinar speaker", "Consultation"],
    verificationState: "Verified",
    reputationScore: 97,
    completedEngagements: 22,
    sourceConfirmedEvidence: ["public Solana settlement talks", "technical writing on stablecoin settlement"],
    demonstratedExpertise: ["completed x402 payment architecture reviews"],
    publicDataOnly: true
  },
  {
    id: "exp-leila-haddad",
    name: "Dr. Leila Haddad",
    avatar: "LH",
    headline: "Healthcare AI researcher",
    bio: "Researcher translating clinical AI, evaluation design, healthcare safety, and regulated deployment for executive and public audiences.",
    location: "Boston, United States",
    languages: ["English", "Arabic"],
    categories: ["Healthcare/science", "AI"],
    topics: ["healthcare ai", "clinical evaluation", "medical safety", "research translation", "digital health"],
    skills: ["research call", "technical review", "webinar speaking"],
    experience: ["Clinical AI evaluation programs", "Published health informatics research"],
    organizations: ["Cedar Clinical AI Lab"],
    education: ["PhD Health Informatics"],
    credentials: ["Credentials reviewed"],
    publications: ["Evaluating clinical AI in operational settings"],
    research: ["Model drift in hospital workflows"],
    speaking: ["Healthcare AI webinars", "Research panels"],
    media: ["Science explainers"],
    links: ["https://example.com/leila-haddad"],
    linkedinUrl: "https://linkedin.com/in/demo-leila-haddad",
    website: "https://example.com/leila-haddad",
    github: "",
    cvReference: "demo-cv-leila-haddad.pdf",
    availability: "Fridays ET",
    hourlyPrice: 700,
    sessionPrice: 850,
    currency: "USDC",
    preferredEngagementTypes: ["Research call", "Technical review", "Webinar speaker"],
    verificationState: "Verified",
    reputationScore: 95,
    completedEngagements: 16,
    publicDataOnly: true
  },
  {
    id: "exp-kenji-sato",
    name: "Kenji Sato",
    avatar: "KS",
    headline: "Cybersecurity incident response advisor",
    bio: "Security leader helping teams understand ransomware readiness, breach communications, cloud security, and board-level cyber risk.",
    location: "Seattle, United States",
    languages: ["English", "Japanese"],
    categories: ["Cybersecurity", "Enterprise technology"],
    topics: ["cybersecurity", "incident response", "ransomware", "cloud security", "board risk"],
    skills: ["executive briefing", "technical review", "incident tabletop"],
    experience: ["Led enterprise incident response teams", "Briefed boards on cyber risk"],
    organizations: ["Signal Shore Security"],
    education: ["MS Cybersecurity"],
    credentials: ["Credentials reviewed"],
    publications: ["How boards should rehearse cyber incidents"],
    research: [],
    speaking: ["Security leadership conferences"],
    media: ["Cyber risk podcast guest"],
    links: ["https://example.com/kenji-sato"],
    linkedinUrl: "https://linkedin.com/in/demo-kenji-sato",
    website: "https://example.com/kenji-sato",
    github: "",
    cvReference: "demo-cv-kenji-sato.pdf",
    availability: "Wed afternoons PT",
    hourlyPrice: 625,
    sessionPrice: 750,
    currency: "USDC",
    preferredEngagementTypes: ["Technical review", "Consultation", "Conference speaker"],
    verificationState: "Verified",
    reputationScore: 93,
    completedEngagements: 19,
    publicDataOnly: true
  },
  {
    id: "exp-maya-chen",
    name: "Maya Chen",
    avatar: "MC",
    headline: "Data center and AI infrastructure strategist",
    bio: "Infrastructure strategist focused on data centers, AI compute procurement, energy constraints, and Southeast Asia expansion.",
    location: "Singapore",
    languages: ["English", "Mandarin"],
    categories: ["Data centers/infrastructure", "AI", "Enterprise technology"],
    topics: ["ai infrastructure", "data centers", "gpu procurement", "energy", "southeast asia", "cloud"],
    skills: ["market briefing", "podcast guest", "consulting"],
    experience: ["12 years in regional infrastructure strategy", "AI data-center procurement work"],
    organizations: ["Compute Harbor Advisory"],
    education: ["BEng Electrical Engineering"],
    credentials: ["Profile reviewed"],
    publications: ["Power constraints in AI infrastructure markets"],
    research: [],
    speaking: ["Executive infrastructure summits"],
    media: ["Cloud and AI shows"],
    links: ["https://example.com/maya-chen"],
    linkedinUrl: "https://linkedin.com/in/demo-maya-chen",
    website: "https://example.com/maya-chen",
    github: "",
    cvReference: "demo-cv-maya-chen.pdf",
    availability: "Asia business hours",
    hourlyPrice: 475,
    sessionPrice: 575,
    currency: "USDC",
    preferredEngagementTypes: ["Podcast guest", "Conference speaker", "Consultation"],
    verificationState: "Profile reviewed",
    reputationScore: 90,
    completedEngagements: 14,
    publicDataOnly: true
  },
  {
    id: "exp-sofia-ramos",
    name: "Sofia Ramos",
    avatar: "SR",
    headline: "Sustainability and climate operations advisor",
    bio: "Advisor on carbon accounting, supply chain sustainability, ESG reporting, and practical climate transition programs.",
    location: "Mexico City, Mexico",
    languages: ["English", "Spanish"],
    categories: ["Sustainability", "Business strategy"],
    topics: ["sustainability", "carbon accounting", "esg", "supply chain", "climate operations"],
    skills: ["webinar speaker", "research call", "executive briefing"],
    experience: ["Led regional sustainability operations", "Designed supplier emissions programs"],
    organizations: ["Verde Operations Group"],
    education: ["MSc Environmental Management"],
    credentials: ["Credentials reviewed"],
    publications: ["Supplier emissions without theater"],
    research: [],
    speaking: ["Climate operations webinars"],
    media: ["Sustainability podcasts"],
    links: ["https://example.com/sofia-ramos"],
    linkedinUrl: "https://linkedin.com/in/demo-sofia-ramos",
    website: "https://example.com/sofia-ramos",
    github: "",
    cvReference: "demo-cv-sofia-ramos.pdf",
    availability: "Tue mornings CT",
    hourlyPrice: 425,
    sessionPrice: 525,
    currency: "USDC",
    preferredEngagementTypes: ["Webinar speaker", "Consultation", "Research call"],
    verificationState: "Credentials reviewed",
    reputationScore: 92,
    completedEngagements: 17,
    publicDataOnly: true
  },
  {
    id: "exp-arun-iyer",
    name: "Arun Iyer",
    avatar: "AI",
    headline: "Enterprise AI transformation operator",
    bio: "Operator helping executives separate durable AI workflows from demo theater across procurement, support, knowledge, and back-office processes.",
    location: "London, United Kingdom",
    languages: ["English", "Hindi"],
    categories: ["AI", "Enterprise technology", "Business strategy"],
    topics: ["enterprise ai", "workflow automation", "ai adoption", "agent operations", "procurement", "change management"],
    skills: ["keynote", "executive workshop", "podcast guest"],
    experience: ["Scaled AI workflows inside global enterprises", "Advised leadership teams on operating models"],
    organizations: ["Northbank AI Systems"],
    education: ["MSc Management Science"],
    credentials: ["Profile reviewed"],
    publications: ["Why AI pilots stall after the demo"],
    research: [],
    speaking: ["Enterprise AI keynotes"],
    media: ["Executive podcasts"],
    links: ["https://example.com/arun-iyer"],
    linkedinUrl: "https://linkedin.com/in/demo-arun-iyer",
    website: "https://example.com/arun-iyer",
    github: "",
    cvReference: "demo-cv-arun-iyer.pdf",
    availability: "UK afternoons",
    hourlyPrice: 600,
    sessionPrice: 725,
    currency: "USDC",
    preferredEngagementTypes: ["Conference speaker", "Webinar speaker", "Consultation"],
    verificationState: "Profile reviewed",
    reputationScore: 89,
    completedEngagements: 21,
    publicDataOnly: true
  },
  {
    id: "exp-camille-price",
    name: "Camille Price",
    avatar: "CP",
    headline: "Media format strategist and executive producer",
    bio: "Producer and strategist for interviews, webinars, thought-leadership shows, guest preparation, and editorial packaging.",
    location: "New York, United States",
    languages: ["English"],
    categories: ["Media", "Business strategy"],
    topics: ["podcasts", "webinars", "interviews", "executive media", "show development", "guest prep"],
    skills: ["producer review", "host coaching", "format strategy"],
    experience: ["Produced executive interview series", "Built webinar formats for B2B teams"],
    organizations: ["Framecraft Media"],
    education: ["BA Media Studies"],
    credentials: ["Profile reviewed"],
    publications: ["How to brief an expert guest"],
    research: [],
    speaking: ["Creator economy panels"],
    media: ["Production podcasts"],
    links: ["https://example.com/camille-price"],
    linkedinUrl: "https://linkedin.com/in/demo-camille-price",
    website: "https://example.com/camille-price",
    github: "",
    cvReference: "demo-media-kit-camille-price.pdf",
    availability: "Mon to Thu ET",
    hourlyPrice: 350,
    sessionPrice: 450,
    currency: "USDC",
    preferredEngagementTypes: ["Consultation", "Technical review", "Podcast guest"],
    verificationState: "Profile reviewed",
    reputationScore: 88,
    completedEngagements: 27,
    publicDataOnly: true
  }
]);

const state = {
  matches: [],
  selectedExpert: null,
  request: null,
  engagement: null,
  discoveryPayment: null,
  payment: null,
  review: null,
  profileSources: [],
  profileEvidence: [],
  judgmentTask: null,
  judgmentResponse: null,
  judgmentPayment: null
};

export const ToastyExperts = {
  experts: EXPERTS,
  findExperts,
  getExpert,
  requestExpert,
  acceptEngagement,
  authorizeDiscoveryPayment,
  authorizePayment,
  completeEngagement,
  getEngagement,
  getPaymentStatus,
  createX402PaymentRequirement
};

if (typeof window !== "undefined") window.ToastyExperts = ToastyExperts;

document.addEventListener("DOMContentLoaded", () => {
  const brandTheme = getInitialBrandTheme();
  const theme = applyBrandTheme(brandTheme, {
    root: document.body,
    logoImg: $("#expertBrandLogo"),
    poweredBy: $("#expertPoweredBy")
  });
  const studioUrl = `./director.html?brand=${encodeURIComponent(theme.id)}`;
  $("#expertBrandLink").href = studioUrl;
  $("#backToStudio").href = studioUrl;
  $("#expertsSideTitle").textContent = `${theme.label} Experts`;
  $("#expertsHeroTitle").textContent = `Book credible humans from inside ${theme.textLogo}.`;
  bindNavigation();
  bindDemo();
  bindDirectory();
  bindOnboarding();
  renderDirectory(EXPERTS);
  renderFlow();
  renderJudgment();
  renderApiDocs();
  loadProfileDraft();

  const topic = new URLSearchParams(location.search).get("topic");
  if (topic) {
    $("#description").value = topic;
    runMatch();
  }
});

function bindNavigation() {
  $$(".expert-nav button").forEach((button) => {
    button.addEventListener("click", () => setView(button.dataset.target));
  });
  const initial = (location.hash || "#demo").slice(1);
  setView(["demo", "directory", "onboarding", "agent"].includes(initial) ? initial : "demo");
}

function bindDemo() {
  $("#requestForm").addEventListener("submit", (event) => {
    event.preventDefault();
    runMatch();
  });
  $("#loadScenario").addEventListener("click", () => {
    $("#topic").value = "Canadian Premier League growth";
    $("#description").value = "I need a Canadian soccer expert for a 45-minute podcast about the growth of the Canadian Premier League.";
    $("#expertiseRequired").value = "soccer, Canada, Canadian Premier League, sports business";
    $("#locationPreference").value = "Canada preferred";
    $("#language").value = "English";
    $("#budget").value = "500";
    $("#engagementType").value = "Podcast guest";
    $("#durationMinutes").value = "45";
    $("#constraints").value = "Can explain the league to a general business audience; available within two weeks.";
    toast("Demo request loaded");
  });
  $("#acceptRequest").addEventListener("click", () => {
    state.engagement = ToastyExperts.acceptEngagement(state.request.id);
    persistWorkspace();
    renderFlow();
    toast(`${state.selectedExpert.name} accepted the invitation`);
  });
  $("#authorizePayment").addEventListener("click", () => {
    state.payment = ToastyExperts.authorizePayment(state.engagement.id);
    state.engagement.paymentId = state.payment.id;
    state.engagement.state = "Confirmed";
    persistWorkspace();
    renderFlow();
    renderLedger();
    toast("Negotiated booking payment authorized for release");
  });
  $("#completeEngagement").addEventListener("click", () => {
    const result = ToastyExperts.completeEngagement(state.engagement.id);
    state.engagement = result.engagement;
    state.payment = result.payment;
    state.review = result.review;
    persistWorkspace();
    renderFlow();
    renderLedger();
    toast("Engagement completed and settlement proof recorded");
  });
  $("#createJudgmentTask").addEventListener("click", createJudgmentTask);
  $("#settleJudgmentResponse").addEventListener("click", settleJudgmentResponse);
  $("#escalateJudgment").addEventListener("click", escalateJudgmentToExpert);
}

function bindDirectory() {
  const categories = [...new Set(EXPERTS.flatMap((expert) => expert.categories))].sort();
  $("#directoryCategory").innerHTML = `<option value="">All categories</option>${categories.map((category) => `<option>${escapeHtml(category)}</option>`).join("")}`;
  $("#directorySearch").addEventListener("input", filterDirectory);
  $("#directoryCategory").addEventListener("change", filterDirectory);
}

function bindOnboarding() {
  $("#onboardingForm").addEventListener("submit", (event) => {
    event.preventDefault();
    saveProfileDraft();
  });
  ["expertName", "headline", "expertLocation", "expertLanguages", "linkedin", "website", "expertBio", "expertTopics", "hourlyPrice", "availability", "preferredEngagements", "verificationState", "profileText"].forEach((id) => {
    $(`#${id}`).addEventListener("input", updateProfileReadiness);
  });
  $("#fillLinkedIn").addEventListener("click", fillFromLinkedIn);
  $("#uploadCvButton").addEventListener("click", () => $("#dropInput").click());
  $("#startManual").addEventListener("click", () => {
    $("#expertName").focus();
    toast("Manual profile entry ready");
  });
  $("#enrichPublic").addEventListener("click", enrichFromPublicSources);
  $("#bulkAccept").addEventListener("click", () => bulkEvidence(EVIDENCE_STATUSES.APPROVED));
  $("#bulkReject").addEventListener("click", () => bulkEvidence(EVIDENCE_STATUSES.REJECTED));
  $("#evidenceReviewList").addEventListener("click", handleEvidenceAction);
  $("#clearProfile").addEventListener("click", () => {
    localStorage.removeItem(PROFILE_STORAGE);
    state.profileSources = [];
    state.profileEvidence = [];
    $("#onboardingForm").reset();
    $("#hourlyPrice").value = "350";
    $("#verificationState").value = "Profile reviewed";
    renderSources();
    renderEvidenceReview();
    renderDueDiligence();
    updateProfileReadiness();
    toast("Local profile draft cleared");
  });
  $("#dropInput").addEventListener("change", (event) => handleFiles([...event.target.files]));
  const dropzone = $("#dropzone");
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("is-dragging");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragging"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("is-dragging");
    handleFiles([...event.dataTransfer.files]);
  });
}

function setView(name) {
  $$(".expert-view").forEach((view) => { view.hidden = view.dataset.view !== name; });
  $$(".expert-nav button").forEach((button) => button.classList.toggle("active", button.dataset.target === name));
  history.replaceState({}, "", `#${name}`);
}

function runMatch() {
  const request = readRequestForm();
  state.discoveryPayment = ToastyExperts.authorizeDiscoveryPayment(request);
  const matches = ToastyExperts.findExperts(request).candidates;
  state.matches = matches;
  state.request = null;
  state.selectedExpert = null;
  state.engagement = null;
  state.payment = null;
  state.review = null;
  state.judgmentTask = null;
  state.judgmentResponse = null;
  state.judgmentPayment = null;
  renderResults(matches, request);
  renderFlow();
  renderLedger();
  renderJudgment();
  $("#resultsWrap").hidden = false;
  toast(`x402 discovery paid; matched ${matches.length} experts`);
}

function findExperts(request) {
  const normalized = normalizeRequest(request);
  const candidates = EXPERTS.map((expert) => scoreExpert(expert, normalized))
    .sort((a, b) => b.score - a.score)
    .slice(0, 6);
  return { request: normalized, candidates };
}

function getExpert(id) {
  return EXPERTS.find((expert) => expert.id === id) || null;
}

function requestExpert({ requester = "Studio production", expertId, request, price, currency = "USDC" }) {
  const expert = getExpert(expertId);
  if (!expert) throw new Error("Expert not found");
  const now = new Date().toISOString();
  return {
    id: createId("req"),
    requester,
    expertId,
    scope: request.description,
    price: Number(price || expert.sessionPrice || expert.hourlyPrice),
    currency,
    durationMinutes: Number(request.durationMinutes || 45),
    desiredDateTime: request.desiredDateTime || "Flexible within two weeks",
    deliverable: `${request.engagementType || "Engagement"} participation for: ${request.topic}`,
    state: "Sent",
    createdAt: now,
    updatedAt: now,
    viewedAt: null
  };
}

function acceptEngagement(requestId) {
  if (!state.request || state.request.id !== requestId) throw new Error("Request not found");
  const now = new Date().toISOString();
  state.request = { ...state.request, state: "Accepted", viewedAt: state.request.viewedAt || now, updatedAt: now };
  return {
    id: createId("eng"),
    requestId,
    expertId: state.request.expertId,
    requester: state.request.requester,
    type: readRequestForm().engagementType,
    state: "Pending payment",
    scope: state.request.scope,
    price: state.request.price,
    currency: state.request.currency,
    durationMinutes: state.request.durationMinutes,
    scheduledFor: state.request.desiredDateTime,
    paymentId: null,
    createdAt: now,
    updatedAt: now
  };
}

function authorizeDiscoveryPayment(request) {
  const now = new Date().toISOString();
  return authorizeExpertDiscoveryPayment({
    request,
    idFactory: createId,
    signatureFactory: makeDemoSignature,
    now
  });
}

function authorizePayment(engagementId) {
  if (!state.engagement || state.engagement.id !== engagementId) throw new Error("Engagement not found");
  return authorizeBookingPayment({
    engagement: state.engagement,
    idFactory: createId,
    now: new Date().toISOString()
  });
}

function completeEngagement(engagementId) {
  if (!state.engagement || state.engagement.id !== engagementId) throw new Error("Engagement not found");
  const now = new Date().toISOString();
  const payment = settleBookingPayment({
    payment: state.payment,
    signatureFactory: makeDemoSignature,
    now
  });
  payment.explorerUrl = `${SOLANA_EXPLORER}/${payment.transactionSignature}?cluster=devnet`;
  const engagement = {
    ...state.engagement,
    state: "Completed",
    completedAt: now,
    updatedAt: now
  };
  const review = {
    id: createId("rev"),
    engagementId,
    completionStatus: "Completed",
    requesterRating: 5,
    expertRating: 5,
    writtenFeedback: "Strong fit for the requested production. Payment settlement proof recorded separately from private engagement details.",
    paymentSuccess: true,
    engagementType: engagement.type,
    createdAt: now
  };
  return { engagement, payment, review };
}

function getEngagement(id) {
  return state.engagement?.id === id ? state.engagement : null;
}

function getPaymentStatus(paymentId) {
  if (state.discoveryPayment?.id === paymentId) return state.discoveryPayment;
  if (state.judgmentPayment?.id === paymentId) return state.judgmentPayment;
  return state.payment?.id === paymentId ? state.payment : null;
}

function createX402PaymentRequirement(action, amount = 0.001) {
  return createExpertDiscoveryRequirement({ action, amount });
}

function createJudgmentTask() {
  const request = readRequestForm();
  const candidates = state.matches.length ? state.matches : ToastyExperts.findExperts({
    ...request,
    expertiseRequired: ["Canadian soccer", "media", "sports business"],
    budget: 700
  }).candidates;
  const contributor = candidates.find((expert) => includesLoose(expert.topics, "Canadian soccer") || includesLoose(expert.categories, "Media")) || candidates[0] || EXPERTS[0];
  state.judgmentTask = {
    id: createId("task"),
    prompt: "Which of these three podcast titles would make you most likely to listen?",
    options: [
      "Can Canada build a soccer league that lasts?",
      "Inside the Canadian Premier League growth story",
      "Why Canadian soccer is entering its builder era"
    ],
    requirements: ["Canadian soccer knowledge", "media taste", "sports business context"],
    responsesRequired: 5,
    pricePerAcceptedResponse: 0.10,
    currency: "USDC",
    topic: "Canadian soccer"
  };
  state.judgmentResponse = {
    id: createId("resp"),
    taskId: state.judgmentTask.id,
    contributorId: contributor.id,
    contributorName: contributor.name,
    accepted: true,
    answer: "Inside the Canadian Premier League growth story is the strongest title because it promises a clear business narrative while staying accessible to listeners who do not already follow the league.",
    demonstratedExpertise: "Accepted Canadian soccer judgment"
  };
  state.judgmentPayment = null;
  renderJudgment();
  renderLedger();
  toast(`Matched ${contributor.name} for human judgment`);
}

async function settleJudgmentResponse() {
  if (!state.judgmentTask || !state.judgmentResponse) {
    toast("Create a judgment task first");
    return;
  }
  $("#settleJudgmentResponse").disabled = true;
  try {
    const result = await postJson("/api/agent/microtasks/settle", {
      task: state.judgmentTask,
      response: state.judgmentResponse,
      amount: state.judgmentTask.pricePerAcceptedResponse
    });
    if (!result.ok) throw new Error(result.error || "Microtask settlement failed");
    state.judgmentTask = result.task;
    state.judgmentResponse = result.response;
    state.judgmentPayment = result.payment;
    applyDemonstratedExpertise(result.response.contributorId, result.demonstratedExpertise);
    renderJudgment();
    renderLedger();
    toast("Accepted response paid and reputation updated");
  } catch (error) {
    renderJudgment();
    toast(error.message || "Microtask payment failed");
  }
}

function applyDemonstratedExpertise(contributorId, demonstratedExpertise) {
  const expert = EXPERTS.find((item) => item.id === contributorId);
  if (!expert) return;
  expert.demonstratedExpertise = [...new Set([...(expert.demonstratedExpertise || []), demonstratedExpertise].filter(Boolean))];
  expert.completedEngagements += 1;
  expert.reputationScore = Math.min(100, expert.reputationScore + 1);
}

function escalateJudgmentToExpert() {
  const contributorId = state.judgmentResponse?.contributorId;
  const expert = EXPERTS.find((item) => item.id === contributorId) || state.matches[0] || EXPERTS[0];
  state.selectedExpert = expert;
  state.request = ToastyExperts.requestExpert({
    requester: "Agent escalated after human judgment pulse",
    expertId: expert.id,
    request: {
      ...readRequestForm(),
      topic: "Canadian soccer podcast expert validation",
      description: "The agent received human title judgments and now needs deeper expert analysis for a 45-minute podcast.",
      engagementType: "Podcast guest",
      durationMinutes: 45
    },
    price: expert.sessionPrice
  });
  renderFlow();
  renderLedger();
  toast(`Escalated to expert booking with ${expert.name}`);
}

function normalizeRequest(request) {
  return {
    topic: String(request.topic || "").trim(),
    description: String(request.description || "").trim(),
    expertiseRequired: tags(request.expertiseRequired),
    locationPreference: String(request.locationPreference || "").trim(),
    language: String(request.language || "English").trim(),
    budget: Number(request.budget || 0),
    engagementType: String(request.engagementType || "Podcast guest").trim(),
    desiredDateTime: String(request.desiredDateTime || "Flexible within two weeks").trim(),
    durationMinutes: Number(request.durationMinutes || 45),
    additionalConstraints: String(request.additionalConstraints || "").trim()
  };
}

function scoreExpert(expert, request) {
  const requestTerms = tokenize([
    request.topic,
    request.description,
    request.locationPreference,
    request.language,
    request.engagementType,
    request.additionalConstraints,
    ...request.expertiseRequired
  ].join(" "));
  const expertTerms = tokenize([
    expert.name,
    expert.headline,
    expert.bio,
    expert.location,
    ...expert.languages,
    ...expert.categories,
    ...expert.topics,
    ...expert.skills,
    ...expert.experience,
    ...expert.organizations,
    ...expert.credentials,
    ...expert.publications,
    ...expert.research,
    ...expert.speaking,
    ...expert.media,
    ...expert.preferredEngagementTypes,
    ...(expert.sourceConfirmedEvidence || []),
    ...(expert.demonstratedExpertise || [])
  ].join(" "));

  const matched = [...requestTerms].filter((term) => expertTerms.has(term) || [...expertTerms].some((candidate) => candidate.includes(term) || term.includes(candidate)));
  const categoryHits = request.expertiseRequired.filter((tag) => includesLoose([...expert.categories, ...expert.topics, ...expert.skills], tag));
  const formatHit = expert.preferredEngagementTypes.includes(request.engagementType);
  const locationHit = request.locationPreference && includesLoose([expert.location], request.locationPreference.replace(" preferred", ""));
  const languageHit = expert.languages.includes(request.language);
  const budgetHit = request.budget >= (expert.sessionPrice || expert.hourlyPrice);
  const verifiedBoost = ["Verified", "Credentials reviewed"].includes(expert.verificationState) ? 8 : 3;
  const evidenceHits = request.expertiseRequired.filter((tag) => includesLoose([...(expert.sourceConfirmedEvidence || []), ...(expert.demonstratedExpertise || [])], tag));
  const evidenceBoost = Math.min(6, evidenceHits.length * 2);

  const score = clamp(
    42 +
      matched.length * 4 +
      categoryHits.length * 7 +
      (formatHit ? 8 : 0) +
      (locationHit ? 8 : 0) +
      (languageHit ? 5 : 0) +
      (budgetHit ? 7 : -5) +
      verifiedBoost +
      evidenceBoost +
      Math.min(8, expert.completedEngagements / 4),
    35,
    98
  );

  const reasons = [
    categoryHits.length ? `Direct topic overlap: ${categoryHits.slice(0, 3).join(", ")}` : "",
    locationHit ? `Location fit: ${expert.location}` : "",
    formatHit ? `Preferred format includes ${request.engagementType}` : "",
    evidenceHits.length ? `Supporting evidence: ${evidenceHits.slice(0, 2).join(", ")}` : "",
    budgetHit ? `${expert.sessionPrice} ${expert.currency} fits the ${request.budget} budget` : `${expert.sessionPrice} ${expert.currency} may need negotiation`,
    `${expert.verificationState}; ${expert.completedEngagements} completed engagements`,
    expert.experience[0]
  ].filter(Boolean);

  return {
    ...expert,
    score: Math.round(score),
    confidence: score >= 88 ? "High" : score >= 72 ? "Medium" : "Exploratory",
    matchReasons: reasons,
    matchedTerms: matched.slice(0, 10),
    budgetFit: budgetHit
  };
}

function renderResults(matches, request) {
  $("#candidateCount").textContent = String(matches.length);
  $("#bestScore").textContent = matches[0] ? `${matches[0].score}%` : "0%";
  $("#budgetFit").textContent = String(matches.filter((match) => match.budgetFit).length);
  $("#results").innerHTML = matches.map((expert) => `
    <article class="result-card">
      <div class="result-head">
        <div class="result-person">
          <div class="avatar">${escapeHtml(expert.avatar)}</div>
          <div>
            <h3>${escapeHtml(expert.name)}</h3>
            <p>${escapeHtml(expert.headline)}</p>
          </div>
        </div>
        <div class="score">${expert.score}%</div>
      </div>
      <div class="chips">${expert.categories.slice(0, 3).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("")}</div>
      <div class="evidence"><b>Why this matches</b><br>${expert.matchReasons.slice(0, 4).map(escapeHtml).join(" · ")}</div>
      <dl class="mini-profile">
        <div><dt>Price</dt><dd>${expert.sessionPrice} ${expert.currency}</dd></div>
        <div><dt>Availability</dt><dd>${escapeHtml(expert.availability)}</dd></div>
        <div><dt>Reputation</dt><dd>${expert.reputationScore}/100</dd></div>
      </dl>
      <div class="result-actions">
        <button class="expert-btn secondary" type="button" data-profile="${expert.id}">Profile</button>
        <button class="expert-btn accent" type="button" data-invite="${expert.id}">Invite</button>
      </div>
    </article>
  `).join("");
  $$("[data-profile]").forEach((button) => button.addEventListener("click", () => {
    renderProfileModal(matches.find((expert) => expert.id === button.dataset.profile));
  }));
  $$("[data-invite]").forEach((button) => button.addEventListener("click", () => {
    const expert = matches.find((item) => item.id === button.dataset.invite);
    state.selectedExpert = expert;
    state.request = ToastyExperts.requestExpert({
      requester: "Studio demo production",
      expertId: expert.id,
      request,
      price: expert.sessionPrice
    });
    state.engagement = null;
    state.payment = null;
    state.review = null;
    persistWorkspace();
    renderFlow();
    renderLedger();
    toast(`Invitation sent to ${expert.name}`);
  }));
}

function renderProfileModal(expert) {
  if (!expert) return;
  toast(`${expert.name}: ${expert.bio}`);
}

function renderFlow() {
  const selected = state.selectedExpert;
  const steps = [
    ["Request expertise", state.matches.length ? "done" : "current"],
    ["x402 discovery paid", state.discoveryPayment ? "done" : state.matches.length ? "current" : "waiting"],
    ["Match expert", selected ? "done" : state.matches.length ? "current" : "waiting"],
    ["Invite sent", state.request ? "done" : "waiting"],
    ["Expert accepts", state.engagement ? "done" : state.request ? "current" : "waiting"],
    ["Booking/task", state.engagement ? "done" : "waiting"],
    ["Authorize negotiated rate", state.payment ? "done" : state.engagement ? "current" : "waiting"],
    ["Complete service", state.engagement?.state === "Completed" ? "done" : state.payment ? "current" : "waiting"],
    ["Release settlement", state.payment?.transactionSignature ? "done" : "waiting"],
    ["Reputation", state.review ? "done" : "waiting"]
  ];
  $("#flowList").innerHTML = steps.map(([label, status]) => `<li data-state="${status}"><span></span>${label}</li>`).join("");
  $("#acceptRequest").disabled = !state.request || Boolean(state.engagement);
  $("#authorizePayment").disabled = !state.engagement || Boolean(state.payment);
  $("#completeEngagement").disabled = !state.payment || state.engagement?.state === "Completed";
  renderPaymentBox();
}

function renderPaymentBox() {
  const box = $("#paymentBox");
  if (!state.discoveryPayment && !state.payment && !state.engagement) {
    box.innerHTML = "<small>Payment status</small><strong>x402 discovery required</strong><span>Complete the configured x402 payment to unlock ranked matches.</span>";
    return;
  }
  if (state.discoveryPayment && !state.engagement) {
    box.innerHTML = `
      <small>Payment status</small>
      <strong>${escapeHtml(displayPaymentStatus(state.discoveryPayment.status))}</strong>
      <span>${state.discoveryPayment.amount} ${state.discoveryPayment.currency} · ${state.discoveryPayment.rail} · ${state.discoveryPayment.network}</span>
      <span>Booking settlement starts after an expert accepts.</span>
    `;
    return;
  }
  if (!state.payment) {
    box.innerHTML = `<small>Payment status</small><strong>Negotiated rate required</strong><span>${state.engagement.price} ${state.engagement.currency} for ${escapeHtml(state.selectedExpert.name)}</span>`;
    return;
  }
  const explorer = state.payment.explorerUrl ? `<a href="${state.payment.explorerUrl}" target="_blank" rel="noreferrer">View Solana transaction</a>` : "<span>Transaction submits on completion in this devnet demo.</span>";
  box.innerHTML = `
    <small>Payment status</small>
    <strong>${escapeHtml(displayPaymentStatus(state.payment.status))}</strong>
    <span>${state.payment.amount} ${state.payment.currency} · ${state.payment.network}</span>
    ${explorer}
  `;
}

function renderLedger() {
  const panel = $("#ledgerPanel");
  const entries = [];
  if (state.discoveryPayment) entries.push(["x402 discovery", `${displayPaymentStatus(state.discoveryPayment.status)} · ${state.discoveryPayment.amount} ${state.discoveryPayment.currency}`]);
  if (state.judgmentTask) entries.push(["Judgment task", `${state.judgmentTask.responsesRequired} responses · ${state.judgmentTask.pricePerAcceptedResponse} ${state.judgmentTask.currency} each`]);
  if (state.judgmentPayment) entries.push(["Judgment settlement", `${state.judgmentPayment.amount} ${state.judgmentPayment.currency} · ${state.judgmentPayment.network}`]);
  if (state.judgmentPayment?.transactionSignature) entries.push(["Judgment proof", state.judgmentPayment.transactionSignature]);
  if (state.request) entries.push(["Expert request", `${state.request.state} · ${state.request.price} ${state.request.currency}`]);
  if (state.engagement) entries.push(["Engagement", `${state.engagement.state} · ${state.engagement.type}`]);
  if (state.payment) entries.push(["Booking settlement", `${displayPaymentStatus(state.payment.status)} · ${state.payment.network}`]);
  if (state.payment?.transactionSignature) entries.push(["Settlement proof", state.payment.transactionSignature]);
  if (state.review) entries.push(["Reputation", `${state.review.requesterRating}/5 requester rating · payment success ${state.review.paymentSuccess}`]);
  panel.hidden = entries.length === 0;
  $("#ledgerEntries").innerHTML = entries.map(([label, value]) => `<article><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></article>`).join("");
}

function renderJudgment() {
  const contributor = state.judgmentResponse?.contributorName || "Not matched yet";
  $("#judgmentContributor").textContent = contributor;
  $("#judgmentRationale").textContent = state.judgmentResponse
    ? `${state.judgmentResponse.demonstratedExpertise}; response is ready for acceptance.`
    : "Create the task to match a qualified contributor.";
  $("#judgmentAnswer").textContent = state.judgmentResponse?.answer || "Waiting";
  $("#judgmentPayment").textContent = state.judgmentPayment?.transactionSignature
    ? `${state.judgmentPayment.amount} ${state.judgmentPayment.currency} paid · ${state.judgmentPayment.transactionSignature}`
    : "Payment proof appears after settlement.";
  $("#settleJudgmentResponse").disabled = !state.judgmentResponse || Boolean(state.judgmentPayment);
  $("#escalateJudgment").disabled = !state.judgmentPayment;
}

function renderDirectory(experts) {
  $("#directoryGrid").innerHTML = experts.map((expert) => `
    <article class="directory-card">
      <div class="avatar">${escapeHtml(expert.avatar)}</div>
      <h3>${escapeHtml(expert.name)}</h3>
      <p>${escapeHtml(expert.headline)}</p>
      <div class="chips">${expert.topics.slice(0, 5).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("")}</div>
      <dl class="mini-profile">
        <div><dt>Location</dt><dd>${escapeHtml(expert.location)}</dd></div>
        <div><dt>Verification</dt><dd>${escapeHtml(expert.verificationState)}</dd></div>
        <div><dt>Session</dt><dd>${expert.sessionPrice} ${expert.currency}</dd></div>
      </dl>
    </article>
  `).join("");
}

function filterDirectory() {
  const search = $("#directorySearch").value.toLowerCase();
  const category = $("#directoryCategory").value;
  const filtered = EXPERTS.filter((expert) => {
    const haystack = JSON.stringify(expert).toLowerCase();
    return (!category || expert.categories.includes(category)) && (!search || haystack.includes(search));
  });
  renderDirectory(filtered);
}

function fillFromLinkedIn() {
  const linkedinUrl = $("#linkedin").value.trim();
  const pasted = $("#profileText").value.trim();
  if (!linkedinUrl && !pasted) {
    toast("Add a public LinkedIn URL or paste profile text first");
    $("#linkedin").focus();
    return;
  }
  const imported = parseProfileText(pasted);
  if (!$("#expertName").value && imported.name) $("#expertName").value = imported.name;
  if (!$("#headline").value && imported.headline) $("#headline").value = imported.headline;
  if (!$("#expertBio").value && imported.bio) $("#expertBio").value = imported.bio;
  if (!$("#expertTopics").value && imported.topics.length) $("#expertTopics").value = imported.topics.join(", ");
  if (!$("#website").value && imported.website) $("#website").value = imported.website;
  if (linkedinUrl) {
    queueEvidence({
      category: "Claimed profile",
      proposedValue: `Public LinkedIn profile supplied: ${profileSlug(linkedinUrl)}`,
      sourceType: "LinkedIn URL",
      sourceUrl: linkedinUrl,
      sourceTitle: "Public LinkedIn profile",
      confidence: pasted ? "Medium" : "Low",
      distinction: "Claimed Expertise"
    });
  }
  imported.evidence.forEach(queueEvidence);
  renderEvidenceReview();
  renderDueDiligence();
  updateProfileReadiness();
  toast("Imported profile candidates queued for review");
}

async function enrichFromPublicSources() {
  const name = $("#expertName").value.trim();
  const topics = tags($("#expertTopics").value);
  const linkedinUrl = $("#linkedin").value.trim();
  const website = $("#website").value.trim();
  const profileText = $("#profileText").value.trim();
  const githubUrl = extractUrl([linkedinUrl, website, profileText].find((value) => /github\.com/i.test(value || "")) || "");
  if (!name && !linkedinUrl && !website && !topics.length) {
    toast("Add a name, website, LinkedIn URL, or topics before enrichment");
    return;
  }
  $("#enrichPublic").disabled = true;
  try {
    const result = await postJson("/api/experts/enrich-public", {
      name,
      location: $("#expertLocation").value.trim(),
      expertise: topics,
      linkedinUrl,
      website,
      githubUrl
    });
    if (!result.ok) throw new Error(result.error || "Public enrichment failed");
    (result.evidence || []).forEach(queueEvidence);
    renderEvidenceReview();
    renderDueDiligence();
    updateProfileReadiness();
    toast(result.evidence?.length ? `Queued ${result.evidence.length} public evidence results` : "No reliable public evidence found");
  } catch (error) {
    toast(error.message || "Public enrichment failed");
  } finally {
    $("#enrichPublic").disabled = false;
  }
}

async function handleFiles(files) {
  for (const file of files) {
    let text = "";
    let status = "Queued for credential extraction";
    if (/text|json|csv|markdown|html/.test(file.type) || /\.(txt|md|csv|json|html)$/i.test(file.name)) {
      try {
        text = (await file.text()).slice(0, 150000);
        status = "Parsed locally";
      } catch {
        status = "Queued";
      }
    } else if (/\.pdf$/i.test(file.name)) {
      status = "PDF reference attached";
    } else if (/\.docx?$/i.test(file.name)) {
      status = "Document reference attached";
    }
    state.profileSources.push({ name: file.name, size: file.size, type: file.type, status, text });
    queueEvidence({
      category: file.name.match(/linkedin/i) ? "LinkedIn PDF export" : "CV / resume",
      proposedValue: `${file.name} attached as expert-supplied profile evidence.`,
      sourceType: file.type || "Uploaded file",
      sourceUrl: "",
      sourceTitle: file.name,
      confidence: text ? "Medium" : "Low",
      distinction: "Claimed Expertise"
    });
    parseProfileText(text).evidence.forEach(queueEvidence);
  }
  renderSources();
  renderEvidenceReview();
  renderDueDiligence();
  updateProfileReadiness();
  toast(`${files.length} source${files.length === 1 ? "" : "s"} attached`);
}

function parseProfileText(text = "") {
  const lines = String(text).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstSentence = lines.find((line) => line.length > 24) || "";
  const url = extractUrl(text);
  const topics = [
    "AI governance", "cybersecurity", "data centers", "Solana", "USDC", "healthcare AI",
    "Canadian soccer", "media", "sustainability", "enterprise AI"
  ].filter((topic) => new RegExp(topic.replace(/\s+/g, "\\s+"), "i").test(text));
  const evidence = [];
  lines.filter((line) => /speaker|conference|podcast|interview|publication|research|award|certification|board|advisor/i.test(line))
    .slice(0, 8)
    .forEach((line) => {
      evidence.push({
        category: categorizeEvidence(line),
        proposedValue: line.slice(0, 220),
        sourceType: "Pasted profile text",
        sourceUrl: url,
        sourceTitle: "Expert-supplied profile text",
        confidence: "Medium",
        distinction: /publication|speaker|conference|podcast|interview/i.test(line) ? "Source-Confirmed Evidence" : "Claimed Expertise"
      });
    });
  return {
    name: lines.find((line) => /^[A-Z][a-z]+(?:\s+[A-Z][a-z.'-]+){1,3}$/.test(line)) || "",
    headline: lines.find((line) => /advisor|engineer|researcher|founder|journalist|speaker|operator|consultant|director/i.test(line)) || "",
    bio: firstSentence,
    website: url || "",
    topics,
    evidence
  };
}

function queueEvidence(item) {
  const proposedValue = String(item.proposedValue || "").trim();
  if (!proposedValue) return;
  const sourceUrl = String(item.sourceUrl || "").trim();
  const normalizedValue = normalizeEvidence(proposedValue);
  const duplicate = state.profileEvidence.find((evidence) =>
    evidence.normalizedValue === normalizedValue &&
    evidence.category === item.category &&
    evidence.status !== EVIDENCE_STATUSES.REJECTED
  );
  if (duplicate) {
    const source = {
      sourceType: item.sourceType || duplicate.sourceType,
      sourceUrl,
      sourceTitle: item.sourceTitle || duplicate.sourceTitle,
      sourceDate: item.sourceDate || ""
    };
    duplicate.sources = dedupeSources([...(duplicate.sources || []), source]);
    duplicate.confidence = confidenceRank(item.confidence) > confidenceRank(duplicate.confidence) ? item.confidence : duplicate.confidence;
    return;
  }
  const now = new Date().toISOString();
  state.profileEvidence.push({
    id: createId("ev"),
    expertId: null,
    field: evidenceField(item.category),
    category: item.category || "Professional footprint",
    proposedValue,
    normalizedValue,
    sourceType: item.sourceType || "Public source",
    sourceUrl,
    sourceTitle: item.sourceTitle || "",
    sourceDate: item.sourceDate || "",
    discoveredAt: now,
    confidence: item.confidence || "Low",
    status: EVIDENCE_STATUSES.PROPOSED,
    sourceConfirmationState: item.sourceConfirmationState || (item.distinction === "Source-Confirmed Evidence" ? "SOURCE_CONFIRMED" : "CLAIMED"),
    userEdited: false,
    approvedAt: null,
    distinction: item.distinction || "Claimed Expertise",
    sources: dedupeSources([{
      sourceType: item.sourceType || "Public source",
      sourceUrl,
      sourceTitle: item.sourceTitle || "",
      sourceDate: item.sourceDate || ""
    }])
  });
}

function renderEvidenceReview() {
  const list = $("#evidenceReviewList");
  if (!list) return;
  if (!state.profileEvidence.length) {
    list.innerHTML = '<div class="empty">No evidence queued yet. Import a profile, upload a CV, or run public enrichment.</div>';
    return;
  }
  list.innerHTML = state.profileEvidence.map((item) => `
    <article class="evidence-review-card" data-status="${escapeHtml(item.status)}">
      <div>
        <small>${escapeHtml(item.distinction || "Claimed Expertise")} · ${escapeHtml(item.category)}</small>
        <strong>${escapeHtml(item.proposedValue)}</strong>
        <span>${escapeHtml(item.sourceTitle || item.sourceType)}${item.sourceUrl ? ` · ${escapeHtml(item.sourceUrl)}` : ""}</span>
      </div>
      <dl>
        <div><dt>Found</dt><dd>${escapeHtml(formatDate(item.discoveredAt))}</dd></div>
        <div><dt>Confidence</dt><dd>${escapeHtml(item.confidence)}</dd></div>
        <div><dt>Status</dt><dd>${escapeHtml(item.status)}</dd></div>
      </dl>
      <div class="evidence-actions">
        <button class="expert-btn secondary" type="button" data-action="keep" data-id="${item.id}">Keep</button>
        <button class="expert-btn secondary" type="button" data-action="edit" data-id="${item.id}">Edit</button>
        <button class="expert-btn secondary" type="button" data-action="delete" data-id="${item.id}">Delete</button>
        ${item.sourceUrl ? `<a class="expert-btn secondary" href="${escapeHtml(item.sourceUrl)}" target="_blank" rel="noreferrer">View Source</a>` : ""}
      </div>
    </article>
  `).join("");
}

function handleEvidenceAction(event) {
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const item = state.profileEvidence.find((evidence) => evidence.id === control.dataset.id);
  if (!item) return;
  if (control.dataset.action === "keep") approveEvidence(item);
  if (control.dataset.action === "delete") item.status = EVIDENCE_STATUSES.REJECTED;
  if (control.dataset.action === "edit") {
    const edited = prompt("Edit proposed profile evidence", item.proposedValue);
    if (edited && edited.trim()) {
      item.proposedValue = edited.trim();
      item.normalizedValue = normalizeEvidence(edited);
      item.status = EVIDENCE_STATUSES.EDITED;
      item.userEdited = true;
      item.approvedAt = new Date().toISOString();
      applyEvidenceToProfile(item);
    }
  }
  renderEvidenceReview();
  renderDueDiligence();
  updateProfileReadiness();
}

function approveEvidence(item) {
  item.status = EVIDENCE_STATUSES.APPROVED;
  item.approvedAt = new Date().toISOString();
  applyEvidenceToProfile(item);
}

function bulkEvidence(status) {
  state.profileEvidence
    .filter((item) => item.status === EVIDENCE_STATUSES.PROPOSED && (status === EVIDENCE_STATUSES.REJECTED || confidenceRank(item.confidence) >= confidenceRank("Medium")))
    .forEach((item) => {
      if (status === EVIDENCE_STATUSES.APPROVED) approveEvidence(item);
      else item.status = EVIDENCE_STATUSES.REJECTED;
    });
  renderEvidenceReview();
  renderDueDiligence();
  updateProfileReadiness();
  toast(status === EVIDENCE_STATUSES.APPROVED ? "Kept medium/high confidence evidence" : "Deleted proposed evidence");
}

function applyEvidenceToProfile(item) {
  const value = item.proposedValue;
  if (/topic|expertise|project|publication|speaking|media/i.test(item.category)) {
    const current = tags($("#expertTopics").value);
    const candidate = item.category.replace(/^(Public|Claimed)\s+/i, "").toLowerCase();
    $("#expertTopics").value = [...new Set([...current, candidate])].filter(Boolean).join(", ");
  }
  if (/professional bio|profile/i.test(item.category) && !$("#expertBio").value) $("#expertBio").value = value;
}

function renderDueDiligence() {
  const grid = $("#diligenceGrid");
  if (!grid) return;
  const approved = state.profileEvidence.filter((item) => [EVIDENCE_STATUSES.APPROVED, EVIDENCE_STATUSES.EDITED].includes(item.status));
  const proposed = state.profileEvidence.filter((item) => item.status === EVIDENCE_STATUSES.PROPOSED);
  const sourceConfirmed = approved.filter((item) => item.distinction === "Source-Confirmed Evidence");
  const summary = [
    ["Identity/profile completeness", $("#expertName").value && $("#headline").value ? "Ready" : "Needs review"],
    ["Source-backed credentials", `${sourceConfirmed.filter((item) => /credential|certification|award/i.test(item.category)).length} approved`],
    ["Professional footprint", `${approved.filter((item) => /profile|footprint|bio|project/i.test(item.category)).length} approved`],
    ["Speaking/media evidence", `${approved.filter((item) => /speaking|media|podcast|interview/i.test(item.category)).length} approved`],
    ["Publication/research evidence", `${approved.filter((item) => /publication|research/i.test(item.category)).length} approved`],
    ["Demonstrated expertise", "Starts after Studio tasks and bookings"],
    ["Unresolved claims", `${proposed.length} pending`]
  ];
  grid.innerHTML = summary.map(([label, value]) => `<article><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></article>`).join("");
}

function saveProfileDraft() {
  const draft = {
    name: $("#expertName").value.trim(),
    headline: $("#headline").value.trim(),
    location: $("#expertLocation").value.trim(),
    languages: tags($("#expertLanguages").value),
    linkedinUrl: $("#linkedin").value.trim(),
    website: $("#website").value.trim(),
    bio: $("#expertBio").value.trim(),
    topics: tags($("#expertTopics").value),
    hourlyPrice: Number($("#hourlyPrice").value || 0),
    availability: $("#availability").value.trim(),
    preferredEngagementTypes: tags($("#preferredEngagements").value),
    verificationState: $("#verificationState").value,
    pastedProfileText: $("#profileText").value.trim(),
    sources: state.profileSources,
    profileEvidence: state.profileEvidence
  };
  localStorage.setItem(PROFILE_STORAGE, JSON.stringify(draft));
  renderEvidenceReview();
  renderDueDiligence();
  updateProfileReadiness();
  toast("Expert profile draft saved locally");
}

function loadProfileDraft() {
  const draft = safeJson(localStorage.getItem(PROFILE_STORAGE), {});
  $("#expertName").value = draft.name || "";
  $("#headline").value = draft.headline || "";
  $("#expertLocation").value = draft.location || "";
  $("#expertLanguages").value = (draft.languages || []).join(", ");
  $("#linkedin").value = draft.linkedinUrl || "";
  $("#website").value = draft.website || "";
  $("#expertBio").value = draft.bio || "";
  $("#expertTopics").value = (draft.topics || []).join(", ");
  $("#hourlyPrice").value = draft.hourlyPrice || 350;
  $("#availability").value = draft.availability || "";
  $("#preferredEngagements").value = (draft.preferredEngagementTypes || []).join(", ");
  $("#verificationState").value = draft.verificationState || "Profile reviewed";
  $("#profileText").value = draft.pastedProfileText || "";
  state.profileSources = draft.sources || [];
  state.profileEvidence = draft.profileEvidence || [];
  renderSources();
  renderEvidenceReview();
  renderDueDiligence();
  updateProfileReadiness();
}

function renderSources() {
  $("#sourceList").innerHTML = state.profileSources.length
    ? state.profileSources.map((source) => `<div class="source-row"><b>${escapeHtml(source.name)}</b><span>${escapeHtml(source.status)}</span></div>`).join("")
    : '<div class="empty">No files attached yet.</div>';
}

function updateProfileReadiness() {
  const approvedEvidence = state.profileEvidence.filter((item) => [EVIDENCE_STATUSES.APPROVED, EVIDENCE_STATUSES.EDITED].includes(item.status));
  const sourceConfirmed = approvedEvidence.filter((item) => item.distinction === "Source-Confirmed Evidence");
  const checks = [
    ["Identity", $("#expertName").value && $("#headline").value ? 95 : 30],
    ["Public footprint", $("#linkedin").value || $("#website").value ? 88 : 35],
    ["Topic structure", tags($("#expertTopics").value).length >= 3 ? 90 : 38],
    ["Availability and price", $("#availability").value && Number($("#hourlyPrice").value) > 0 ? 92 : 34],
    ["Evidence sources", state.profileSources.length || approvedEvidence.length ? 86 : 28],
    ["Source confirmed", sourceConfirmed.length ? clamp(55 + sourceConfirmed.length * 10, 55, 95) : 25]
  ];
  const readiness = Math.round(checks.reduce((sum, item) => sum + item[1], 0) / checks.length);
  $("#doubleReady").textContent = `${readiness}%`;
  $("#coverage").innerHTML = checks.map(([label, value]) => `
    <div class="coverage-row">
      <span>${escapeHtml(label)}</span>
      <div class="bar"><i style="width:${value}%"></i></div>
      <b>${value}%</b>
    </div>
  `).join("");
}

function renderApiDocs() {
  const sample = readRequestForm();
  $("#apiFind").textContent = JSON.stringify({ request: sample, response: { candidates: ["expert", "score", "matchReasons", "confidence"] } }, null, 2);
  $("#apiRequest").textContent = JSON.stringify({
    requester: "agent:toasty-production",
    expertId: "exp-nadia-maclean",
    scope: "45-minute podcast guest about CPL growth",
    price: 425,
    currency: "USDC",
    state: "Sent"
  }, null, 2);
  $("#apiPayment").textContent = JSON.stringify({
    target: "Negotiated booking settlement",
    source: "Studio Commerce",
    network: "solana-devnet",
    token: "USDC",
    paymentKinds: ["EXPERT_DISCOVERY", "HUMAN_JUDGMENT_SETTLEMENT", "BOOKING_AUTHORIZATION", "BOOKING_SETTLEMENT", "REFUND", "CANCELLATION"],
    lifecycle: ["PAYMENT_REQUIRED", "PAYMENT_AUTHORIZED", "PAYMENT_SUBMITTED", "PAYMENT_CONFIRMED", "PAYMENT_RELEASED"],
    persisted: ["paymentKind", "transactionSignature", "network", "payer", "recipient", "amount", "currency", "timestamp", "engagementId", "status"]
  }, null, 2);
  $("#apiX402").textContent = JSON.stringify({
    source: "Studio Commerce x402 handler",
    requirement: createX402PaymentRequirement("find-experts", 0.001)
  }, null, 2);
}

function readRequestForm() {
  return normalizeRequest({
    topic: $("#topic")?.value,
    description: $("#description")?.value,
    expertiseRequired: $("#expertiseRequired")?.value,
    locationPreference: $("#locationPreference")?.value,
    language: $("#language")?.value,
    budget: $("#budget")?.value,
    engagementType: $("#engagementType")?.value,
    durationMinutes: $("#durationMinutes")?.value,
    additionalConstraints: $("#constraints")?.value
  });
}

function persistWorkspace() {
  localStorage.setItem(WORKSPACE_STORAGE, JSON.stringify({
    request: state.request,
    engagement: state.engagement,
    discoveryPayment: state.discoveryPayment,
    payment: state.payment,
    review: state.review,
    judgmentTask: state.judgmentTask,
    judgmentResponse: state.judgmentResponse,
    judgmentPayment: state.judgmentPayment,
    selectedExpertId: state.selectedExpert?.id || null
  }));
}

function createId(prefix) {
  const random = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID().slice(0, 8) : Math.random().toString(16).slice(2, 10);
  return `${prefix}_${random}`;
}

function makeDemoSignature(seed) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), Date.now());
  let out = "";
  for (let i = 0; i < 88; i += 1) {
    value = (value * 48271 + i) % 2147483647;
    out += alphabet[value % alphabet.length];
  }
  return out;
}

function tags(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function profileSlug(url) {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split("/").filter(Boolean).pop()?.replace(/-/g, " ") || parsed.hostname;
  } catch {
    return String(url || "").replace(/^https?:\/\//, "");
  }
}

function extractUrl(value = "") {
  return String(value).match(/https?:\/\/[^\s)]+/i)?.[0] || "";
}

function categorizeEvidence(value = "") {
  if (/speaker|conference|panel|webinar/i.test(value)) return "Speaking";
  if (/podcast|interview|media|press/i.test(value)) return "Media appearance";
  if (/publication|published|paper|research|journal|scholar/i.test(value)) return "Publication / research";
  if (/certification|certificate|credential|award/i.test(value)) return "Credential";
  if (/board|advisor|advisory/i.test(value)) return "Board / advisory role";
  if (/github|project|repository/i.test(value)) return "Public project work";
  return "Professional footprint";
}

function evidenceField(category = "") {
  if (/speaking|media|publication|research|credential/i.test(category)) return "credentials";
  if (/project|topic|expertise/i.test(category)) return "topics";
  return "profile";
}

function normalizeEvidence(value = "") {
  return String(value).toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(the|and|for|with|from|profile|public)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function dedupeSources(sources) {
  const seen = new Set();
  return sources.filter((source) => {
    const key = `${source.sourceType}|${source.sourceUrl}|${source.sourceTitle}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function confidenceRank(value = "Low") {
  return { Low: 1, Medium: 2, High: 3 }[value] || 1;
}

function formatDate(value) {
  if (!value) return "Today";
  try {
    return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
  } catch {
    return value;
  }
}

function tokenize(value = "") {
  return new Set(String(value).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((term) => term.length > 2));
}

function includesLoose(items, needle) {
  const target = String(needle || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  if (!target) return false;
  return items.some((item) => {
    const value = String(item).toLowerCase();
    return value.includes(target) || target.includes(value) || target.split(/\s+/).some((part) => part.length > 2 && value.includes(part));
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value) || fallback;
  } catch {
    return fallback;
  }
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed with HTTP ${response.status}`);
  return body;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  })[char]);
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.hidden = false;
  clearTimeout(window.__toastyExpertsToast);
  window.__toastyExpertsToast = setTimeout(() => { element.hidden = true; }, 2800);
}
