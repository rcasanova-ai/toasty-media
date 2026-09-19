// Structured research for Host FIND directives.
// Returns candidates Hottie can propose as ProgramAssets. Never fabricates sources. Never takes
// anything live — ProgramController.takeAsset is the only approval path.
//
// Live path uses Wikipedia's CORS-open APIs (Toasty-controlled card afterwards, not an iframe).
// Seeded path is deterministic for solo tests and demo, using real published URLs/titles/excerpts.

import { ProgramAssetType, hostnameFromUrl, sanitizeBroadcastText } from "./program-asset.js";

export const THAILAND_DATA_CENTER_CANDIDATES = Object.freeze([
  {
    title: "AWS Launches Infrastructure Region in Thailand",
    sourceName: "Amazon",
    sourceUrl: "https://press.aboutamazon.com/2025/1/aws-launches-infrastructure-region-in-thailand",
    excerpt: "AWS announced the Asia Pacific (Thailand) Region, giving customers local data centers and planning more than $5 billion of investment in Thailand.",
    type: ProgramAssetType.ARTICLE,
    retrievedAt: Date.parse("2025-01-07T00:00:00Z")
  },
  {
    title: "Google to invest $1 billion in Thai data centre, cloud infrastructure",
    sourceName: "Reuters",
    sourceUrl: "https://www.reuters.com/technology/google-invest-1-billion-thai-data-centre-cloud-infrastructure-2024-09-30/",
    excerpt: "Alphabet's Google said it would invest $1 billion in Thailand to build a data centre and cloud region to meet growing cloud demand and support AI adoption.",
    type: ProgramAssetType.ARTICLE,
    retrievedAt: Date.parse("2024-09-30T00:00:00Z")
  },
  {
    title: "Microsoft to open first regional data centre in Thailand",
    sourceName: "Reuters",
    sourceUrl: "https://www.reuters.com/technology/microsoft-open-first-regional-data-centre-thailand-2024-05-01/",
    excerpt: "Microsoft said it will open its first regional data centre in Thailand to expand hyperscale cloud and AI infrastructure availability.",
    type: ProgramAssetType.ARTICLE,
    retrievedAt: Date.parse("2024-05-01T00:00:00Z")
  }
]);

function tokenize(text) {
  return new Set(String(text || "").toLowerCase().match(/[a-z0-9]{4,}/g) || []);
}

function queryMatchesThailandDataCenters(query) {
  const q = String(query || "").toLowerCase();
  return /thailand|thai/.test(q) && /data[\s-]*cent/.test(q);
}

export function normalizeResearchCandidate(raw = {}) {
  const sourceUrl = String(raw.sourceUrl || "").trim();
  if (!/^https:\/\//i.test(sourceUrl)) return null;
  const title = sanitizeBroadcastText(raw.title, 180);
  const excerpt = sanitizeBroadcastText(raw.excerpt, 280);
  if (!title) return null;
  return {
    title,
    sourceName: sanitizeBroadcastText(raw.sourceName || hostnameFromUrl(sourceUrl) || "Source", 80),
    sourceUrl,
    excerpt,
    imageUrl: raw.imageUrl || null,
    type: raw.type || ProgramAssetType.ARTICLE,
    retrievedAt: raw.retrievedAt || Date.now(),
    attribution: sanitizeBroadcastText(raw.attribution || raw.sourceName || hostnameFromUrl(sourceUrl), 80)
  };
}

export class SeededResearchProvider {
  constructor(candidates = THAILAND_DATA_CENTER_CANDIDATES) {
    this.candidates = candidates.map((item) => normalizeResearchCandidate(item)).filter(Boolean);
  }

  async search(query) {
    if (!queryMatchesThailandDataCenters(query)) return [];
    return this.candidates.slice();
  }
}

export class EmptyResearchProvider {
  async search() {
    return [];
  }
}

export class WikipediaResearchProvider {
  constructor({ fetchImpl } = {}) {
    this.fetchImpl = fetchImpl || (typeof fetch === "function" ? fetch.bind(globalThis) : null);
  }

  async search(query) {
    const fetchImpl = this.fetchImpl;
    const q = String(query || "").trim();
    if (!fetchImpl || !q) return [];
    const searchUrl = new URL("https://en.wikipedia.org/w/api.php");
    searchUrl.searchParams.set("action", "query");
    searchUrl.searchParams.set("list", "search");
    searchUrl.searchParams.set("srsearch", q.slice(0, 180));
    searchUrl.searchParams.set("srlimit", "5");
    searchUrl.searchParams.set("format", "json");
    searchUrl.searchParams.set("origin", "*");
    const searchRes = await fetchImpl(searchUrl, { headers: { Accept: "application/json" } });
    if (!searchRes.ok) throw new Error("wikipedia-search-failed");
    const payload = await searchRes.json();
    const hits = payload?.query?.search || [];
    const wanted = tokenize(q);
    const candidates = [];
    for (const hit of hits.slice(0, 5)) {
      const title = String(hit.title || "").trim();
      if (!title) continue;
      const summary = await fetchWikipediaSummary(fetchImpl, title);
      if (!summary) continue;
      if (wanted.size && !isRelevant(`${summary.title} ${summary.excerpt}`, wanted)) continue;
      candidates.push(summary);
    }
    return candidates;
  }
}

async function fetchWikipediaSummary(fetchImpl, title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const response = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!response.ok) return null;
  const json = await response.json();
  if (json?.type === "disambiguation") return null;
  return normalizeResearchCandidate({
    title: json.title || title,
    sourceName: "Wikipedia",
    sourceUrl: json.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    excerpt: json.extract || json.description || "",
    imageUrl: json.thumbnail?.source || null,
    type: ProgramAssetType.ARTICLE,
    attribution: "Wikipedia"
  });
}

function isRelevant(text, wanted) {
  const have = tokenize(text);
  let hit = 0;
  wanted.forEach((word) => { if (have.has(word)) hit += 1; });
  return hit / wanted.size >= 0.3;
}

export class CompositeResearchProvider {
  constructor({ fetchImpl, seeded = new SeededResearchProvider() } = {}) {
    this.wikipedia = new WikipediaResearchProvider({ fetchImpl });
    this.seeded = seeded;
  }

  async search(query) {
    try {
      const live = await this.wikipedia.search(query);
      if (live.length) return live;
    } catch (_) {
      // Fail open to seeded real sources for the known demo query; otherwise the caller shows
      // the graceful empty state. Never invent a URL here.
    }
    return this.seeded.search(query);
  }
}

export function createResearchProvider({ preferSeeded = false, searchFn = null, fetchImpl } = {}) {
  if (typeof searchFn === "function") return { search: searchFn };
  if (preferSeeded) return new SeededResearchProvider();
  return new CompositeResearchProvider({ fetchImpl });
}
