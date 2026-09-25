#!/usr/bin/env node
// Pure-logic tests for js/integrations.js.
import { INTEGRATIONS, getIntegration, isConnectable, IntegrationStatus, SANTATI_FUTURE_SYNC_RECORD_TYPES } from "../js/integrations.js";

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

console.log("Integration registry is honest and extensible");
{
  const santati = getIntegration("santati");
  assert(santati, "Santati is registered");
  assert(santati.status === IntegrationStatus.COMING_SOON, "Santati is coming_soon, not falsely connected");
  assert(!isConnectable(santati), "a coming_soon integration is never reported as connectable");
  assert(typeof santati.learnMoreUrl === "string" && santati.learnMoreUrl.startsWith("https://"), "Santati has a real Learn More URL");
  assert(santati.description.toLowerCase().includes("crm"), "Santati's description matches its stated role");
  assert(!("connectedAt" in santati) && !("apiKey" in santati), "no fake connectivity fields exist on a coming_soon entry");

  for (const integration of INTEGRATIONS) {
    assert(integration.id && integration.name && integration.description, `${integration.id || "?"} has the minimum required card fields`);
  }

  assert(getIntegration("does-not-exist") === null, "unknown integration id returns null, not a crash");
  assert(SANTATI_FUTURE_SYNC_RECORD_TYPES.includes("attendee"), "future sync contract documents attendee records");
  assert(SANTATI_FUTURE_SYNC_RECORD_TYPES.includes("peeps_identity_reference"), "future sync contract documents Peeps identity linkage");
}

console.log("\nAll integrations registry tests passed.");
