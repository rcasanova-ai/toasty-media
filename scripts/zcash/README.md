# Zcash regtest harness (development only)

Disposable local Zcash **regtest** chain (no value, no network access) used to prove genuine *shielded* Orchard
transfers between two throwaway wallets and to drive the Peeps confidential-settlement lifecycle end to end.

Stack (all open source, built from source): **Zebra** (validator + internal miner), **Zaino** (indexer, lightwalletd gRPC),
**zingo-cli** (wallet). Nothing here holds real funds; wallet seeds live only under `.zcash-regtest/` (git-ignored).

```bash
# 1. Toolchain + binaries (once; ~20-40 min to compile). Needs rustup, cmake and protoc.
cargo install zebrad --features internal-miner --locked --root .zcash-regtest
cargo install --git https://github.com/zingolabs/zaino --locked zainod --root .zcash-regtest
cargo install --git https://github.com/zingolabs/zingolib --branch stable --locked zingo-cli --root .zcash-regtest

# 2. Start the chain and two wallets (requester + recipient)
node scripts/zcash/regtest.mjs start      # prints status; leaves zebrad + zainod running
node scripts/zcash/regtest.mjs status
node scripts/zcash/regtest.mjs stop

# 3. The real end-to-end Peeps proof (requires the chain above)
node scripts/zcash-regtest-e2e.mjs
```

Notes that cost time to find: Zebra's regtest activation heights must match zingo's defaults (everything at height 1,
including NU6.1 and **NU6.2**), otherwise transactions fail with "incorrect consensus branch id". Zebra accepts a
unified address as `miner_address`, which makes coinbase outputs shielded (Orchard) so the requester wallet is funded
without any transparent step.
