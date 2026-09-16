const SOLANA_DEVNET = "solana-devnet";
const USDC = "USDC";

export const PAYMENT_KINDS = Object.freeze({
  EXPERT_DISCOVERY: "EXPERT_DISCOVERY",
  BOOKING_AUTHORIZATION: "BOOKING_AUTHORIZATION",
  BOOKING_SETTLEMENT: "BOOKING_SETTLEMENT",
  HUMAN_JUDGMENT_SETTLEMENT: "HUMAN_JUDGMENT_SETTLEMENT",
  REFUND: "REFUND",
  CANCELLATION: "CANCELLATION"
});

export const PAYMENT_STATUSES = Object.freeze({
  PAYMENT_REQUIRED: "PAYMENT_REQUIRED",
  PAYMENT_AUTHORIZED: "PAYMENT_AUTHORIZED",
  PAYMENT_VERIFIED: "PAYMENT_VERIFIED",
  PAYMENT_SUBMITTED: "PAYMENT_SUBMITTED",
  PAYMENT_CONFIRMED: "PAYMENT_CONFIRMED",
  PAYMENT_RELEASED: "PAYMENT_RELEASED",
  PAYMENT_FAILED: "PAYMENT_FAILED",
  PAYMENT_REFUNDED: "PAYMENT_REFUNDED"
});

export function toastyCommerceConfig() {
  const runtimeConfig = typeof window !== "undefined" ? window.TOASTY_COMMERCE_CONFIG : null;
  return {
    x402Recipient: runtimeConfig?.x402Recipient || "<configured SVM_PAY_TO>",
    network: runtimeConfig?.network || SOLANA_DEVNET
  };
}

export function createExpertDiscoveryRequirement({ action = "find-experts", amount = 0.001, recipient, network } = {}) {
  const config = toastyCommerceConfig();
  return {
    status: 402,
    error: "Payment Required",
    action,
    provider: "toasty-experts",
    paymentKind: PAYMENT_KINDS.EXPERT_DISCOVERY,
    purpose: "expert discovery and candidate ranking",
    accepts: [{
      scheme: "exact",
      network: network || config.network,
      asset: USDC,
      amount: amount.toFixed(3),
      payTo: recipient || config.x402Recipient
    }],
    submitProofTo: "/api/agent/payments/proof",
    continueWith: `/api/agent/${action}`
  };
}

export function authorizeExpertDiscoveryPayment({ request, idFactory, signatureFactory, now = new Date().toISOString() }) {
  const requirement = createExpertDiscoveryRequirement();
  const signature = signatureFactory(`EXPERT_DISCOVERY:${request.topic || request.description || now}`);
  return {
    id: idFactory("x402"),
    paymentKind: PAYMENT_KINDS.EXPERT_DISCOVERY,
    purpose: "expert-discovery",
    action: "findExperts",
    status: PAYMENT_STATUSES.PAYMENT_VERIFIED,
    rail: "x402-solana-usdc",
    provider: "toasty-experts",
    amount: 0.001,
    currency: USDC,
    network: requirement.accepts[0].network,
    recipientWallet: requirement.accepts[0].payTo,
    transactionSignature: signature,
    paymentRequirement: requirement,
    verificationStatus: "VERIFIED",
    policyDecision: "APPROVED",
    approvalSource: "POLICY",
    createdAt: now,
    updatedAt: now
  };
}

export function authorizeBookingPayment({ engagement, idFactory, now = new Date().toISOString() }) {
  return {
    id: idFactory("pay"),
    engagementId: engagement.id,
    paymentKind: PAYMENT_KINDS.BOOKING_AUTHORIZATION,
    purpose: "negotiated-booking-authorization",
    status: PAYMENT_STATUSES.PAYMENT_AUTHORIZED,
    lifecycle: [
      PAYMENT_STATUSES.PAYMENT_REQUIRED,
      PAYMENT_STATUSES.PAYMENT_AUTHORIZED
    ],
    rail: "x402-solana-usdc",
    provider: "toasty-experts",
    network: toastyCommerceConfig().network,
    amount: engagement.price,
    currency: engagement.currency || USDC,
    token: USDC,
    payeeWallet: null,
    transactionSignature: null,
    authorizationReference: idFactory("auth"),
    releaseCondition: "ENGAGEMENT_COMPLETED",
    verificationStatus: "AUTHORIZED",
    policyDecision: "APPROVED",
    approvalSource: "REQUESTER",
    createdAt: now,
    updatedAt: now
  };
}

export function settleBookingPayment({ payment, signatureFactory, now = new Date().toISOString() }) {
  const signature = signatureFactory(`BOOKING_SETTLEMENT:${payment.engagementId}`);
  return {
    ...payment,
    paymentKind: PAYMENT_KINDS.BOOKING_SETTLEMENT,
    purpose: "negotiated-booking-settlement",
    status: PAYMENT_STATUSES.PAYMENT_RELEASED,
    lifecycle: [
      PAYMENT_STATUSES.PAYMENT_REQUIRED,
      PAYMENT_STATUSES.PAYMENT_AUTHORIZED,
      PAYMENT_STATUSES.PAYMENT_SUBMITTED,
      PAYMENT_STATUSES.PAYMENT_CONFIRMED,
      PAYMENT_STATUSES.PAYMENT_RELEASED
    ],
    transactionSignature: signature,
    verificationStatus: "VERIFIED",
    settledAt: now,
    updatedAt: now
  };
}

export function displayPaymentStatus(status) {
  return String(status || "").toLowerCase().replace(/_/g, " ").replace(/^\w/, (char) => char.toUpperCase());
}
