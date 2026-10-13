#!/usr/bin/env node
// Example agent client for the Base x402 rail: signs an EIP-3009 transferWithAuthorization for a Peeps request's
// introduction fee and sends it as the PAYMENT-SIGNATURE header. Uses a THROWAWAY Base Sepolia key holding test USDC
// (https://faucet.circle.com). `viem` is only needed here, not by the app:  npm i --no-save viem
//
//   BASE_PRIVATE_KEY=0x… PEEPS_COOKIE='toasty_session=…' node scripts/base-x402-pay-example.mjs <requestId> <candidateId> [--send]
//
// Without --send it prints the header only. Never use a mainnet key with funds you can't lose.
import { randomBytes } from "node:crypto";
const API = (process.env.PEEPS_API || "https://render.toasty.media").replace(/\/$/, "");
const [requestId, candidateId, flag] = process.argv.slice(2);
if (!requestId || !candidateId || !process.env.BASE_PRIVATE_KEY) { console.error("usage: BASE_PRIVATE_KEY=0x… PEEPS_COOKIE=… node scripts/base-x402-pay-example.mjs <requestId> <candidateId> [--send]"); process.exit(2); }
const { privateKeyToAccount } = await import("viem/accounts").catch(() => { console.error("Install viem first: npm i --no-save viem"); process.exit(2); });
const headers = { origin: "https://toasty.media", "x-toasty-csrf": "1", ...(process.env.PEEPS_COOKIE ? { cookie: process.env.PEEPS_COOKIE } : {}) };
const requirement = (await (await fetch(`${API}/api/peeps/requests/${requestId}/payment-requirement`, { headers })).json()).requirement;
const accepted = requirement.accepts.find((a) => String(a.network).startsWith("eip155"));
if (!accepted) { console.error("This deployment does not offer a Base payment option (BASE_X402_PAY_TO is not set)."); process.exit(1); }
const account = privateKeyToAccount(process.env.BASE_PRIVATE_KEY);
const authorization = { from: account.address, to: accepted.payTo, value: accepted.amount, validAfter: "0", validBefore: String(Math.floor(Date.now() / 1000) + 300), nonce: `0x${randomBytes(32).toString("hex")}` };
const signature = await account.signTypedData({
  domain: { name: accepted.extra.name, version: accepted.extra.version, chainId: Number(accepted.network.split(":")[1]), verifyingContract: accepted.asset },
  types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
  primaryType: "TransferWithAuthorization",
  message: { ...authorization, value: BigInt(authorization.value), validAfter: 0n, validBefore: BigInt(authorization.validBefore) }
});
const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted, payload: { signature, authorization } })).toString("base64");
if (flag !== "--send") { console.log(header); process.exit(0); }
const res = await fetch(`${API}/api/peeps/requests/${requestId}/authorize`, { method: "POST", headers: { ...headers, "content-type": "application/json", "payment-signature": header }, body: JSON.stringify({ candidates: [{ candidateId }] }) });
const data = await res.json();
console.log(res.status, JSON.stringify(data.payment || data, null, 2));
