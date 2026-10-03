#!/usr/bin/env node
import { MoxieAnticipationEngine } from "../js/moxie-anticipation.js";
import { ProducerFeed, ProducerEntryType } from "../js/ai-producer.js";
import { ProgramAssetCatalog } from "../js/program-asset.js";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok - ${message}`);
}

const candidate = {
  title: "Acme funding update",
  sourceName: "Example",
  sourceUrl: "https://example.com/acme",
  excerpt: "Acme announced a new funding round.",
  type: "article",
  retrievedAt: Date.now()
};

const session = {
  policy: { canAiProcess: () => true },
  guestSeats: [{ displayName: "Jane Doe", title: "CEO", company: "Acme" }],
  runOfShow: {
    current: () => ({ id: "t1", title: "Acme growth", notes: "funding and valuation" }),
    next: () => ({ id: "t2", title: "Market outlook", notes: "competition" })
  },
  researchContext: null,
  aiProducerFeed: new ProducerFeed(),
  assets: new ProgramAssetCatalog(),
  showMemory: { rememberResearch() {} }
};

const researchProvider = { search: async () => [candidate] };
const engine = new MoxieAnticipationEngine(session, { researchProvider });

console.log("Pre-Jam anticipation");
const seeds = engine.seedAndFire();
assert(seeds.length >= 2, "builds a pre-Jam plan from guest and run of show");
await new Promise((resolve) => setTimeout(resolve, 0));
assert(session.aiProducerFeed.entries.some((e) => e.type === ProducerEntryType.ASSET_PROPOSAL && e.bucket === "ready"), "fires prep jobs and produces ready assets");
assert(session.aiProducerFeed.entries.some((e) => e.proposal?.requiresApproval === true), "ready assets still require producer approval");
assert(session.assets.proposed().length > 0, "prepared asset is stored as proposed, not live");

console.log("Live anticipation");
engine.lastLiveAt = 0;
engine.observe({
  role: "guest",
  speaker: "Jane Doe",
  text: "Our latest valuation is two billion and there was an article about the funding round."
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert(session.aiProducerFeed.entries.some((e) => e.anticipation?.reason === "live"), "live conversation fires an anticipation job");
assert(!session.assets.live(), "anticipation never takes an asset live");

console.log("\nMoxie anticipation checks passed.");
