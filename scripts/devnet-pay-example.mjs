#!/usr/bin/env node
// OPTIONAL helper for the Solana DEVNET walkthrough in peeps/README.md. Sends a real devnet USDC transfer that
// carries a Peeps request's payment reference, then prints the signature to paste into /peeps/app/golden-path.html.
// The server never trusts the signature: it re-reads the transaction from Solana and verifies it.
//
//   npm install --no-save @solana/web3.js @solana/spl-token
//   SOLANA_KEYPAIR=~/.config/solana/id.json node scripts/devnet-pay-example.mjs <recipient> <usdcMint> <reference> [amount=0.25]
//
// The keypair file is read locally by this process only. It is never sent anywhere or printed. Use a throwaway devnet
// wallet funded from a devnet faucet (SOL for fees + devnet USDC from https://faucet.circle.com), never a mainnet key.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

let web3, token;
try { web3 = await import("@solana/web3.js"); token = await import("@solana/spl-token"); }
catch { console.error("Run first: npm install --no-save @solana/web3.js @solana/spl-token"); process.exit(1); }

const [recipientArg, mintArg, referenceArg, amountArg = "0.25"] = process.argv.slice(2);
if (!recipientArg || !mintArg || !referenceArg || !process.env.SOLANA_KEYPAIR) {
  console.error("Usage: SOLANA_KEYPAIR=<path> node scripts/devnet-pay-example.mjs <recipient> <usdcMint> <reference> [amount]");
  process.exit(1);
}
const { Connection, Keypair, PublicKey, Transaction } = web3;
const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(process.env.SOLANA_KEYPAIR.replace(/^~/, homedir()), "utf8"))));
const connection = new Connection(process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com", "confirmed");
const mint = new PublicKey(mintArg);
const raw = BigInt(Math.round(Number(amountArg) * 1e6)); // USDC has 6 decimals
const source = token.getAssociatedTokenAddressSync(mint, payer.publicKey);
const destination = token.getAssociatedTokenAddressSync(mint, new PublicKey(recipientArg));
const transfer = token.createTransferCheckedInstruction(source, mint, destination, payer.publicKey, raw, 6);
transfer.keys.push({ pubkey: new PublicKey(referenceArg), isSigner: false, isWritable: false }); // Solana Pay reference
const tx = new Transaction().add(transfer);
tx.feePayer = payer.publicKey;
const signature = await connection.sendTransaction(tx, [payer]);
await connection.confirmTransaction(signature, "confirmed");
console.log(`Confirmed on devnet.\nSignature: ${signature}\nExplorer:  https://explorer.solana.com/tx/${signature}?cluster=devnet`);
