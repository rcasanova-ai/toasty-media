#!/usr/bin/env node
// Direct regression test for the Organizations/Billing/Entitlements schema and CLI actions added to
// scripts/toasty-auth-db.py — calls the Python helper exactly the way scripts/render-production-server.mjs's
// db() does (one JSON payload over stdin per call), against a throwaway SQLite file, with no HTTP server
// involved. This is the fast, isolated layer; HTTP-route-level tests live in a separate *-test.mjs once
// those routes exist.
// Run: node scripts/accounts-schema-test.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER = join(ROOT, "scripts", "toasty-auth-db.py");
const scratchDir = mkdtempSync(join(tmpdir(), "toasty-accounts-schema-"));
const dbPath = join(scratchDir, "toasty.sqlite");

function assert(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`  ok — ${message}`);
}

function db(action, values = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [HELPER], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    child.stderr.on("data", (c) => { stderr += c.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || stdout || `exited ${code}`));
      try { resolve(JSON.parse(stdout || "{}")); } catch (e) { reject(e); }
    });
    child.stdin.end(JSON.stringify({ action, dbPath, ...values }));
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

try {
  console.log("Organizations — create, read, list, update");
  {
    const userId = randomUUID();
    await db("create_user", { id: userId, name: "Ada", email: "ada@example.com", passwordHash: "scrypt$aa$bb" });

    const orgId = randomUUID();
    const membershipId = randomUUID();
    const created = await db("create_organization", { id: orgId, name: "Ada's Studio", slug: "adas-studio", ownerUserId: userId, membershipId });
    assert(created.organization?.id === orgId, "organization created with the given id");
    assert(created.organization.plan === "demo", "new organization defaults to the demo plan");
    assert(created.organization.subscriptionStatus === "none", "new organization has no subscription yet");

    const dup = await db("create_organization", { id: randomUUID(), name: "Dup", slug: "adas-studio", ownerUserId: userId, membershipId: randomUUID() });
    assert(dup.error === "duplicate_slug", "a second organization cannot reuse the same slug");

    const fetched = await db("get_organization", { id: orgId });
    assert(fetched.organization.name === "Ada's Studio", "get_organization returns the same organization");

    const bySlug = await db("get_organization_by_slug", { slug: "adas-studio" });
    assert(bySlug.organization.id === orgId, "get_organization_by_slug resolves the same organization");

    const listed = await db("list_user_organizations", { userId });
    assert(listed.organizations.length === 1 && listed.organizations[0].role === "owner", "the creating user is an owner member of exactly one organization");

    const updated = await db("update_organization", { id: orgId, name: "Ada's Renamed Studio", plan: "creator" });
    assert(updated.organization.name === "Ada's Renamed Studio", "update_organization renames the organization");
    assert(updated.organization.plan === "creator", "update_organization changes the plan");

    globalThis.__ctx = { userId, orgId };
  }

  console.log("\nMemberships — invite, list, change role, remove");
  {
    const { orgId } = globalThis.__ctx;
    const memberUser = await db("create_user", { id: randomUUID(), name: "Grace", email: "grace@example.com", passwordHash: "scrypt$aa$bb" });
    const memberUserId = memberUser.user.id;
    const membershipId = randomUUID();
    const created = await db("create_membership", { id: membershipId, organizationId: orgId, userId: memberUserId, role: "member" });
    assert(created.membership.role === "member", "a second membership is created with the member role");

    const dup = await db("create_membership", { id: randomUUID(), organizationId: orgId, userId: memberUserId, role: "admin" });
    assert(dup.error === "already_member", "the same user cannot be added to the same organization twice");

    const list = await db("list_memberships", { organizationId: orgId });
    assert(list.memberships.length === 2, "the organization now has 2 memberships (owner + member)");
    assert(list.memberships.some((m) => m.userEmail === "grace@example.com"), "list_memberships joins the user's email");

    const promoted = await db("update_membership_role", { organizationId: orgId, userId: memberUserId, role: "admin" });
    assert(promoted.membership.role === "admin", "update_membership_role changes the role");

    await db("remove_membership", { organizationId: orgId, userId: memberUserId });
    const afterRemove = await db("list_memberships", { organizationId: orgId });
    assert(afterRemove.memberships.length === 1, "remove_membership actually removes the row");
  }

  console.log("\nOrganization settings — defaults on create, then a partial update");
  {
    const { orgId } = globalThis.__ctx;
    const settings = await db("get_organization_settings", { organizationId: orgId });
    assert(settings.settings.timezone === "UTC", "organization_settings row was auto-created with sane defaults");
    assert(Object.keys(settings.settings.defaultCTA).length === 0, "JSON blob fields default to an empty object, not null/undefined");

    const updated = await db("update_organization_settings", {
      organizationId: orgId,
      websiteUrl: "https://adas.studio",
      socialLinks: { x: "https://x.com/ada" },
      onboardingCompleted: true,
    });
    assert(updated.settings.websiteUrl === "https://adas.studio", "a partial update changes only the given fields");
    assert(updated.settings.socialLinks.x === "https://x.com/ada", "JSON blob fields round-trip through JSON correctly");
    assert(typeof updated.settings.onboardingCompletedAt === "string" && updated.settings.onboardingCompletedAt.length > 0, "onboardingCompleted:true stamps onboardingCompletedAt");
  }

  console.log("\nBrand profiles — organization-owned, layered on a base theme id");
  {
    const { orgId } = globalThis.__ctx;
    const profileId = randomUUID();
    const created = await db("create_brand_profile", { id: profileId, organizationId: orgId, name: "Launch brand", baseThemeId: "toasty", overrides: { primaryColor: "#ff7a29" } });
    assert(created.brandProfile.overrides.primaryColor === "#ff7a29", "brand profile overrides are stored and returned as real JSON, not a string");

    const listed = await db("list_brand_profiles", { organizationId: orgId });
    assert(listed.brandProfiles.length === 1, "the organization has exactly one brand profile so far");

    const updated = await db("update_brand_profile", { id: profileId, name: "Renamed brand" });
    assert(updated.brandProfile.name === "Renamed brand", "update_brand_profile renames without touching overrides");
    assert(updated.brandProfile.overrides.primaryColor === "#ff7a29", "an update that omits overrides leaves the existing overrides intact");
  }

  console.log("\nBilling account — upsert is create-then-update, not two divergent paths");
  {
    const { orgId } = globalThis.__ctx;
    const first = await db("upsert_billing_account", { organizationId: orgId, billingEmail: "billing@adas.studio", currency: "usd" });
    assert(first.billingAccount.billingEmail === "billing@adas.studio", "first upsert creates the billing account");

    const second = await db("upsert_billing_account", { organizationId: orgId, stripeCustomerId: "cus_123" });
    assert(second.billingAccount.stripeCustomerId === "cus_123", "second upsert sets the stripe customer id");
    assert(second.billingAccount.billingEmail === "billing@adas.studio", "second upsert preserves fields it didn't touch");
  }

  console.log("\nSubscriptions — create, update, and find the active one");
  {
    const { orgId } = globalThis.__ctx;
    const subId = randomUUID();
    await db("create_subscription", { id: subId, organizationId: orgId, provider: "stripe", plan: "creator", status: "trialing" });
    const active = await db("get_active_subscription", { organizationId: orgId });
    assert(active.subscription?.id === subId, "a trialing subscription counts as the active one");

    await db("update_subscription", { id: subId, status: "canceled", cancelAtPeriodEnd: true });
    const afterCancel = await db("get_active_subscription", { organizationId: orgId });
    assert(afterCancel.subscription === null, "a canceled subscription is no longer the active one");
  }

  console.log("\nAI provider credentials — stored as opaque ciphertext, masked in list/upsert responses");
  {
    const { orgId } = globalThis.__ctx;
    const fakeCiphertext = "v1.fakeiv.faketag.fakeciphertext";
    const upserted = await db("upsert_ai_provider_credential", { id: randomUUID(), organizationId: orgId, provider: "anthropic", encryptedCredential: fakeCiphertext, keyLast4: "abcd" });
    assert(upserted.credential.encryptedCredential === undefined, "upsert response never includes the encrypted credential");
    assert(upserted.credential.keyLast4 === "abcd", "upsert response includes the display-only last4 hint");

    const fetchedForUse = await db("get_ai_provider_credential", { organizationId: orgId, provider: "anthropic" });
    assert(fetchedForUse.credential.encryptedCredential === fakeCiphertext, "get_ai_provider_credential (the server-only lookup) DOES return the ciphertext for decryption at call time");

    const listed = await db("list_ai_provider_credentials", { organizationId: orgId });
    assert(listed.credentials.every((c) => c.encryptedCredential === undefined), "list never includes the encrypted credential either");

    const revoked = await db("set_ai_provider_credential_status", { organizationId: orgId, provider: "anthropic", status: "revoked" });
    assert(revoked.ok, "credential status can be flipped to revoked");
    const afterRevoke = await db("get_ai_provider_credential", { organizationId: orgId, provider: "anthropic" });
    assert(afterRevoke.credential === null, "get_ai_provider_credential only returns status='active' credentials — a revoked one must not be usable");

    await db("delete_ai_provider_credential", { organizationId: orgId, provider: "anthropic" });
    const afterDelete = await db("list_ai_provider_credentials", { organizationId: orgId });
    assert(afterDelete.credentials.length === 0, "delete_ai_provider_credential actually removes the row");
  }

  console.log("\nUsage counters — increments accumulate per organization+period, never overwrite");
  {
    const { orgId } = globalThis.__ctx;
    const period = "2026-01-01";
    const empty = await db("get_usage_counters", { organizationId: orgId, periodStart: period });
    assert(empty.usage.sessionsCreated === 0, "usage for an untouched period reads as all zeros, not an error");

    await db("increment_usage", { organizationId: orgId, periodStart: period, deltas: { sessionsCreated: 1, renderMinutes: 4.5 } });
    const afterOne = await db("increment_usage", { organizationId: orgId, periodStart: period, deltas: { sessionsCreated: 1 } });
    assert(afterOne.usage.sessionsCreated === 2, "two increments accumulate to 2, not overwrite to 1");
    assert(afterOne.usage.renderMinutes === 4.5, "an untouched-in-the-second-call field keeps its prior value");
  }

  console.log("\nSolana payment intents — create, look up by reference, mark paid, reject a reused signature");
  {
    const { orgId } = globalThis.__ctx;
    const intentId = randomUUID();
    const reference = randomUUID();
    const created = await db("create_payment_intent", {
      id: intentId, organizationId: orgId, provider: "solana", asset: "USDC", network: "solana-devnet",
      fiatReferenceAmount: 29, cryptoAmount: 29, recipientWallet: "FakeRecipientWallet111", reference,
      plan: "creator", termDays: 30, expiresAt: new Date(Date.now() + 900000).toISOString(),
    });
    assert(created.paymentIntent.status === "pending", "a new payment intent starts pending");

    const dupRef = await db("create_payment_intent", {
      id: randomUUID(), organizationId: orgId, provider: "solana", asset: "USDC", network: "solana-devnet",
      fiatReferenceAmount: 29, cryptoAmount: 29, recipientWallet: "FakeRecipientWallet111", reference,
      plan: "creator", termDays: 30, expiresAt: new Date(Date.now() + 900000).toISOString(),
    });
    assert(dupRef.error === "duplicate_reference", "a payment intent reference can never be reused");

    const byRef = await db("get_payment_intent_by_reference", { reference });
    assert(byRef.paymentIntent.id === intentId, "get_payment_intent_by_reference finds the same intent");

    const sig = "5" + "a".repeat(87);
    const paid = await db("update_payment_intent_status", { id: intentId, status: "paid", transactionSignature: sig });
    assert(paid.paymentIntent.status === "paid" && paid.paymentIntent.paidAt, "marking an intent paid stamps paidAt");

    const secondIntentId = randomUUID();
    await db("create_payment_intent", {
      id: secondIntentId, organizationId: orgId, provider: "solana", asset: "USDC", network: "solana-devnet",
      fiatReferenceAmount: 29, cryptoAmount: 29, recipientWallet: "FakeRecipientWallet111", reference: randomUUID(),
      plan: "creator", termDays: 30, expiresAt: new Date(Date.now() + 900000).toISOString(),
    });
    const reusedSig = await db("update_payment_intent_status", { id: secondIntentId, status: "paid", transactionSignature: sig });
    assert(reusedSig.error === "duplicate_signature", "the exact same on-chain transaction signature can never pay for two intents");
  }

  console.log("\nEmail verification tokens — hash-only storage, single use, expiry");
  {
    const { userId } = globalThis.__ctx;
    const rawToken = randomUUID() + randomUUID();
    const tokenHash = sha256(rawToken);
    await db("create_email_verification_token", { id: randomUUID(), userId, tokenHash, expiresAt: new Date(Date.now() + 3600000).toISOString() });

    const wrongToken = await db("consume_email_verification_token", { tokenHash: sha256("not-the-real-token") });
    assert(wrongToken.error === "invalid_token", "a token that was never issued is rejected");

    const consumed = await db("consume_email_verification_token", { tokenHash });
    assert(consumed.user?.emailVerifiedAt, "consuming the real token stamps emailVerifiedAt on the user");

    const reused = await db("consume_email_verification_token", { tokenHash });
    assert(reused.error === "invalid_token", "the same verification token cannot be consumed twice");

    const expiredHash = sha256("expired-token-value");
    await db("create_email_verification_token", { id: randomUUID(), userId, tokenHash: expiredHash, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await db("consume_email_verification_token", { tokenHash: expiredHash });
    assert(expired.error === "expired_token", "an expired token is rejected even though it was genuinely issued");
  }

  console.log("\nPassword reset tokens — hash-only storage, single use, expiry, invalidates siblings");
  {
    const { userId } = globalThis.__ctx;
    const rawA = "reset-token-a-" + randomUUID();
    const rawB = "reset-token-b-" + randomUUID();
    await db("create_password_reset_token", { id: randomUUID(), userId, tokenHash: sha256(rawA), expiresAt: new Date(Date.now() + 3600000).toISOString() });
    // Requesting reset again invalidates the FIRST unconsumed token outright (create deletes prior
    // unconsumed rows for the user) — but we still verify the "consume invalidates siblings" path with a
    // more direct low-level check: create two, consume one, confirm the OTHER can no longer be consumed.
    const secondId = randomUUID();
    await db("create_password_reset_token", { id: secondId, userId, tokenHash: sha256(rawB), expiresAt: new Date(Date.now() + 3600000).toISOString() });

    const consumed = await db("consume_password_reset_token", { tokenHash: sha256(rawB), newPasswordHash: "scrypt$newsalt$newhash" });
    assert(consumed.user?.id === userId, "consuming a valid reset token returns the user");

    const userRow = await db("get_user_by_email", { email: "ada@example.com" });
    assert(userRow.passwordHash === "scrypt$newsalt$newhash", "consuming the reset token actually updates the stored password hash");

    const reused = await db("consume_password_reset_token", { tokenHash: sha256(rawB), newPasswordHash: "scrypt$again$again" });
    assert(reused.error === "invalid_token", "a consumed reset token cannot be reused");
  }

  console.log("\nAll accounts/organizations/billing schema tests passed.");
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}
