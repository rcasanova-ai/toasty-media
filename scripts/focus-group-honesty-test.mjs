#!/usr/bin/env node
// Focus Group Insight Pack honesty — the pack must never invent quotes, timestamps, or findings.
// When no transcript exists it must say so explicitly, not silently render empty sections.
//
// Run: node scripts/focus-group-honesty-test.mjs
import { analyzeFocusGroupTranscript, buildFocusGroupDeliveryPack } from "../js/focus-group.js";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("Focus group honesty — no transcript");
{
  const context = { objective: "Validate onboarding flow", researchQuestions: ["Is signup clear?"] };
  const pack = buildFocusGroupDeliveryPack([], context);
  assert(pack.transcriptAvailable === false, "transcriptAvailable is false with no transcript");
  assert(pack.evidence.length === 0, "no evidence quotes are fabricated with no transcript");
  assert(pack.pointsOfAgreement.length === 0, "no agreement points are fabricated with no transcript");
  assert(pack.pointsOfDisagreement.length === 0, "no disagreement points are fabricated with no transcript");
  assert(pack.keyFindings.length === 0, "no key findings are fabricated with no transcript");
  assert(/unavailable/i.test(pack.executiveSummary.headline), "executive summary explicitly says unavailable, not silently empty");
  assert(/no session transcript/i.test(pack.executiveSummary.note), "summary note explicitly states nothing is inferred or invented");
  assert(pack.unansweredQuestions.length === 1 && pack.unansweredQuestions[0].question === "Is signup clear?", "unanswered questions reflect real research questions, not invented ones");
}

console.log("Focus group honesty — real transcript");
{
  const context = { objective: "Validate onboarding flow", researchQuestions: ["Is signup clear?"] };
  const lines = [
    { speaker: "Participant A", text: "The signup flow was confusing, I didn't understand the second step.", timestamp: 1000 },
    { speaker: "Participant B", text: "I actually liked how easy the signup was, very clear.", timestamp: 4000 },
    { speaker: "Participant A", text: "Pricing felt expensive compared to what I expected.", timestamp: 8000 }
  ];
  const pack = buildFocusGroupDeliveryPack(lines, context);
  assert(pack.transcriptAvailable === true, "transcriptAvailable is true once real transcript lines exist");
  assert(pack.evidence.length > 0, "evidence quotes are produced from real transcript");
  for (const quote of pack.evidence) {
    const sourceLine = lines.find((l) => l.text === quote.quote && l.speaker === quote.speaker);
    assert(Boolean(sourceLine), `evidence quote "${quote.quote}" traces back to an actual transcript line`);
    assert(quote.timestamp === sourceLine.timestamp, "evidence quote timestamp matches the real transcript line's timestamp, not invented");
  }
  assert(!/unavailable/i.test(pack.executiveSummary.headline), "executive summary does not claim unavailability once real transcript exists");

  const analysis = analyzeFocusGroupTranscript(lines, context);
  assert(analysis.transcriptAvailable === true, "analysis-level transcriptAvailable matches pack-level flag");
}

console.log("\nAll focus group honesty checks passed.");
