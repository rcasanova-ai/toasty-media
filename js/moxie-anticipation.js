// Moxie anticipation engine: plans likely production needs before the Jam,
// then prepares likely assets as the conversation develops. It never takes
// anything live. ProgramController remains the only path to Program Output.

import { ProducerEntryType } from "./ai-producer.js";
import { createResearchProvider } from "./hottie-research.js";
import { programAssetFromCandidate, ProgramAssetStatus } from "./program-asset.js";

const MAX_PLANNED = 8;
const MAX_LIVE_QUEUE = 6;
const LIVE_COOLDOWN_MS = 5000;
const STALE_AFTER_MS = 90000;

const CUE_PATTERNS = [
  /\b(latest|news|article|report|source|headline)\b/i,
  /\b(valuation|funding|raised|revenue|market cap|worth)\b/i,
  /\b(company|startup|product|website|logo)\b/i,
  /\b(chart|graph|numbers?|percent|percentage|million|billion)\b/i,
  /\b(who is|profile|bio|founder|ceo|cto|cio|president)\b/i
];

function cleanQuery(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/^[^a-z0-9]+/i, "")
    .trim()
    .slice(0, 180);
}

function fingerprint(value) {
  return cleanQuery(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function planSeeds(session) {
  const seeds = [];
  const guests = session?.guestSeats?.filter(Boolean) || [];
  guests.forEach((guest) => {
    const label = [guest.displayName || guest.label, guest.title, guest.company].filter(Boolean).join(" ");
    if (label) seeds.push({ reason: "guest", query: label, label: guest.displayName || guest.label || guest.company });
  });

  const run = session?.runOfShow;
  const current = run?.current?.();
  const next = run?.next?.();
  [current, next].filter(Boolean).forEach((topic) => {
    const query = cleanQuery([topic.title, topic.notes].filter(Boolean).join(" "));
    if (query) seeds.push({ reason: "run_of_show", query, label: topic.title });
  });

  const research = session?.researchContext;
  if (research?.title || research?.objective) {
    seeds.push({
      reason: "research",
      query: cleanQuery([research.title, research.objective].filter(Boolean).join(" ")),
      label: research.title || "Research objective"
    });
  }

  return seeds.slice(0, MAX_PLANNED);
}

function liveSeedFromLine(line) {
  const text = cleanQuery(line?.text);
  if (!text || text.length < 12) return null;
  if (!CUE_PATTERNS.some((pattern) => pattern.test(text))) return null;
  return {
    reason: "live",
    query: text,
    label: text.length > 72 ? `${text.slice(0, 69)}...` : text
  };
}

export class MoxieAnticipationEngine {
  constructor(session, { researchProvider } = {}) {
    this.session = session;
    this.research = researchProvider || createResearchProvider();
    this.jobs = new Map();
    this.lastLiveAt = 0;
    this.seeded = false;
  }

  reset() {
    this.jobs.clear();
    this.lastLiveAt = 0;
    this.seeded = false;
  }

  seedAndFire() {
    if (this.seeded || !this.session?.policy?.canAiProcess?.()) return [];
    this.seeded = true;
    const seeds = planSeeds(this.session);
    seeds.forEach((seed) => this.queue(seed, { bucket: "planned" }));
    // Fire the highest-value prep immediately. Remaining planned items stay cheap and lazy.
    seeds.slice(0, 3).forEach((seed) => { void this.prepare(seed); });
    return seeds;
  }

  observe(line) {
    this.expireStale();
    if (!this.session?.policy?.canAiProcess?.()) return null;
    if (!this.seeded) this.seedAndFire();

    const seed = liveSeedFromLine(line);
    if (!seed) return null;

    const now = Date.now();
    if (now - this.lastLiveAt < LIVE_COOLDOWN_MS) return null;
    this.lastLiveAt = now;

    const key = fingerprint(seed.query);
    if (!key || this.jobs.has(key)) return null;
    if ([...this.jobs.values()].filter((job) => job.reason === "live" && job.status !== "stale").length >= MAX_LIVE_QUEUE) return null;

    this.queue(seed, { bucket: "building" });
    void this.prepare(seed);
    return seed;
  }

  queue(seed, { bucket = "planned" } = {}) {
    const key = fingerprint(seed.query);
    if (!key || this.jobs.has(key)) return this.jobs.get(key) || null;

    const job = {
      key,
      ...seed,
      status: bucket === "building" ? "building" : "planned",
      createdAt: Date.now(),
      feedId: null,
      assetId: null
    };

    const entry = this.session?.aiProducerFeed?.push?.({
      type: ProducerEntryType.RESEARCH,
      title: seed.reason === "live" ? "Moxie is preparing this" : "Planned production prep",
      summary: seed.label || seed.query,
      instruction: seed.query,
      bucket,
      anticipation: {
        reason: seed.reason,
        status: job.status,
        expiresAt: job.createdAt + STALE_AFTER_MS
      },
      items: [{ text: seed.reason === "live" ? "Anticipated from the live conversation." : "Prepared from the pre-Jam plan." }]
    });

    job.feedId = entry?.id || null;
    this.jobs.set(key, job);
    return job;
  }

  async prepare(seed) {
    const key = fingerprint(seed.query);
    const job = this.jobs.get(key) || this.queue(seed, { bucket: "building" });
    if (!job || job.status === "ready" || job.status === "stale") return job;

    job.status = "building";
    this.patchFeed(job, {
      bucket: "building",
      anticipation: { reason: job.reason, status: "building", expiresAt: job.createdAt + STALE_AFTER_MS }
    });

    try {
      const candidates = await this.research.search(seed.query);
      const candidate = candidates?.[0];
      if (!candidate) {
        job.status = "stale";
        this.patchFeed(job, {
          title: "No useful asset found",
          bucket: "stale",
          anticipation: { reason: job.reason, status: "stale" }
        });
        return job;
      }

      const asset = this.session?.assets?.add?.(programAssetFromCandidate(candidate, {
        createdBy: "moxie-anticipation",
        status: ProgramAssetStatus.PROPOSED
      }));

      if (!asset) {
        job.status = "stale";
        return job;
      }

      job.status = "ready";
      job.assetId = asset.id;
      this.session?.showMemory?.rememberResearch?.({
        query: seed.query,
        title: candidate.title,
        sourceUrl: candidate.sourceUrl,
        sourceName: candidate.sourceName,
        timestamp: Date.now()
      });

      this.patchFeed(job, {
        type: ProducerEntryType.ASSET_PROPOSAL,
        title: candidate.title,
        summary: candidate.excerpt || seed.label || seed.query,
        bucket: "ready",
        proposal: {
          assetId: asset.id,
          asset,
          anticipated: true,
          reason: job.reason
        },
        sources: [candidate.sourceUrl].filter(Boolean),
        anticipation: {
          reason: job.reason,
          status: "ready",
          expiresAt: job.createdAt + STALE_AFTER_MS
        },
        items: [
          { text: job.reason === "live" ? "Ready before you asked for it." : "Prepared before the Jam." },
          { text: "Producer approval is still required before TAKE." }
        ]
      });
      return job;
    } catch (error) {
      job.status = "stale";
      this.patchFeed(job, {
        title: "Anticipation prep failed",
        summary: String(error?.message || error || "research failed"),
        bucket: "stale",
        anticipation: { reason: job.reason, status: "stale" }
      });
      return job;
    }
  }

  expireStale(now = Date.now()) {
    this.jobs.forEach((job) => {
      if (job.status === "ready" || job.status === "stale") return;
      if (now - job.createdAt < STALE_AFTER_MS) return;
      job.status = "stale";
      this.patchFeed(job, {
        bucket: "stale",
        anticipation: { reason: job.reason, status: "stale" }
      });
    });
  }

  patchFeed(job, patch) {
    if (!job?.feedId) return;
    this.session?.aiProducerFeed?.replace?.(job.feedId, patch);
  }
}

export function createMoxieAnticipationEngine(session, options = {}) {
  return new MoxieAnticipationEngine(session, options);
}
