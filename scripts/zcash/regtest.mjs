#!/usr/bin/env node
// Starts/stops a disposable Zcash REGTEST chain (Zebra + Zaino) and two zingo-cli wallets. Development only.
//   node scripts/zcash/regtest.mjs start|stop|status        (binaries in .zcash-regtest/bin, or ZEC_REGTEST_DIR)
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DIR = resolve(process.env.ZEC_REGTEST_DIR || join(ROOT, ".zcash-regtest"));
export const BIN = (name) => join(DIR, "bin", name);
export const RPC = "http://127.0.0.1:18232";
export const GRPC = "127.0.0.1:8137";
const BOOTSTRAP_MINER = "tmBsTi2xWTjUdEXnuTceL7fecEQKeWaPDJd"; // throwaway regtest transparent address, only used before the wallets exist

export function wallet(name, args, { timeout = 240000 } = {}) {
  const r = spawnSync(BIN("zingo-cli"), ["--chain", "regtest", "--server", GRPC, "--data-dir", join(DIR, `w-${name}`), ...args], { encoding: "utf8", timeout });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
export function walletJson(name, args) {
  const { out } = wallet(name, args);
  const start = out.search(/^[\[{]/m);
  const end = Math.max(out.lastIndexOf("}"), out.lastIndexOf("]"));
  if (start < 0 || end < start) throw new Error(`no JSON from zingo-cli ${args[0]}: ${out.slice(-300)}`);
  return JSON.parse(out.slice(start, end + 1));
}
export async function height() {
  try { return (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getblockcount", params: [] }) })).json()).result; } catch { return null; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const t = Date.now(); while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await sleep(1000); } throw new Error(`timed out waiting for ${what}`); }

function zebraConfig(miner) {
  return `[mining]\nminer_address = "${miner}"\ninternal_miner = true\n\n[network]\nnetwork = "Regtest"\nlisten_addr = "127.0.0.1:18344"\ninitial_mainnet_peers = []\ninitial_testnet_peers = []\nmax_connections_per_ip = 1\n\n[network.testnet_parameters.activation_heights]\nOverwinter = 1\nSapling = 1\nBlossom = 1\nHeartwood = 1\nCanopy = 1\nNU5 = 1\nNU6 = 1\n"NU6.1" = 1\n"NU6.2" = 1\n\n[rpc]\nlisten_addr = "127.0.0.1:18232"\nenable_cookie_auth = false\n\n[state]\ncache_dir = "${DIR}/zebra-state"\n\n[tracing]\nuse_color = false\n`;
}
function zainoConfig() {
  const r = spawnSync(BIN("zainod"), ["generate-config", "-o", join(DIR, "zainod.default.toml")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("zainod generate-config failed");
  return readFileSync(join(DIR, "zainod.default.toml"), "utf8")
    .replace(/network = "[A-Za-z]+"/, 'network = "Regtest"').replace(/zebra_db_path = ".*"/, `zebra_db_path = "${DIR}/zebra-state"`)
    .replace(/path = ".*zaino.*"/, `path = "${DIR}/zaino-db"`).replace(/validator_user = ".*"/, 'validator_user = ""').replace(/validator_password = ".*"/, 'validator_password = ""');
}
function launch(name, cmd, args) {
  const log = join(DIR, `${name}.log`);
  const child = spawn("sh", ["-c", `exec "${cmd}" ${args.map((a) => `"${a}"`).join(" ")} > "${log}" 2>&1`], { detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(join(DIR, `${name}.pid`), String(child.pid));
}
function killAll() {
  for (const name of ["zainod", "zebrad"]) { const f = join(DIR, `${name}.pid`); if (existsSync(f)) { try { process.kill(Number(readFileSync(f, "utf8")), "SIGTERM"); } catch { /* already gone */ } rmSync(f); } }
  spawnSync("pkill", ["-f", join(DIR, "bin")]);
}
async function startChain(miner) {
  mkdirSync(join(DIR, "zaino-db"), { recursive: true });
  writeFileSync(join(DIR, "zebra.toml"), zebraConfig(miner));
  writeFileSync(join(DIR, "zainod.toml"), zainoConfig());
  launch("zebrad", BIN("zebrad"), ["-c", join(DIR, "zebra.toml"), "start"]);
  await until(async () => (await height()) !== null, 60000, "zebrad RPC");
  launch("zainod", BIN("zainod"), ["start", "-c", join(DIR, "zainod.toml")]);
  await until(() => spawnSync("nc", ["-z", "127.0.0.1", "8137"]).status === 0, 90000, "zainod gRPC");
}
const addrOf = (name) => walletJson(name, ["--nosync", "addresses"])[0].encoded_address;

async function start() {
  for (const b of ["zebrad", "zainod", "zingo-cli"]) if (!existsSync(BIN(b))) throw new Error(`missing ${BIN(b)}. See scripts/zcash/README.md`);
  killAll(); for (const d of ["zebra-state", "zaino-db"]) rmSync(join(DIR, d), { recursive: true, force: true });
  // 1. Bootstrap chain so the wallets can be created, 2. restart a fresh chain that mines SHIELDED coinbase straight to the requester.
  await startChain(BOOTSTRAP_MINER);
  mkdirSync(join(DIR, "w-req"), { recursive: true }); mkdirSync(join(DIR, "w-rec"), { recursive: true });
  const reqAddr = addrOf("req"), recAddr = addrOf("rec");
  killAll(); for (const d of ["zebra-state", "zaino-db"]) rmSync(join(DIR, d), { recursive: true, force: true });
  await startChain(reqAddr);
  await until(async () => (await height()) >= 12, 180000, "12 blocks");
  for (const w of ["req", "rec"]) wallet(w, ["--waitsync", "rescan"]);
  writeFileSync(join(DIR, "addresses.json"), JSON.stringify({ requester: reqAddr, recipient: recAddr }));
  console.log(`Zcash REGTEST chain up (height ${await height()}). Wallets: requester + recipient. Addresses in ${join(DIR, "addresses.json")}.`);
}
const cmd = process.argv[2];
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (cmd === "start") await start();
  else if (cmd === "stop") { killAll(); console.log("stopped"); }
  else if (cmd === "status") console.log(JSON.stringify({ dir: DIR, height: await height(), zainod: spawnSync("nc", ["-z", "127.0.0.1", "8137"]).status === 0 }));
  else { console.error("usage: regtest.mjs start|stop|status"); process.exit(1); }
}
