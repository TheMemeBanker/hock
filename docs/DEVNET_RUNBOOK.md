# Devnet runbook

The order of operations to stand HOCK up on devnet. Nothing here touches mainnet. Every command that signs uses a keypair under `~/hock-keys/` and never a keypair from any other project.

## 0. Keys (once)

```
ls ~/hock-keys/
# hock_lending-program.json   program id Cr61UnyT3EmbZLMawbwQksX6QgTrSgEWMxAWUbaYpgNb
# hock-devnet-deployer.json   upgrade authority + payer on devnet
solana-keygen new --no-bip39-passphrase -o ~/hock-keys/hock-devnet-pool-authority.json
solana-keygen new --no-bip39-passphrase -o ~/hock-keys/hock-devnet-engine.json
solana-keygen new --no-bip39-passphrase -o ~/hock-keys/hock-devnet-gas.json
solana-keygen new --no-bip39-passphrase -o ~/hock-keys/hock-devnet-fee.json
chmod 600 ~/hock-keys/*.json
```

## 1. Fund (devnet faucet, no real value)

```
for k in deployer pool-authority engine gas fee; do solana airdrop 2 $(solana-keygen pubkey ~/hock-keys/hock-devnet-$k.json) -u devnet; done
```
The deployer needs about 5 SOL for the program account; repeat the airdrop or use faucet.solana.com.

## 2. Deploy the program

```
cd ~/hock/program
anchor build
solana program deploy target/deploy/hock_lending.so \
  --program-id ~/hock-keys/hock_lending-program.json \
  --keypair ~/hock-keys/hock-devnet-deployer.json \
  --upgrade-authority ~/hock-keys/hock-devnet-deployer.json \
  -u devnet
solana program show Cr61UnyT3EmbZLMawbwQksX6QgTrSgEWMxAWUbaYpgNb -u devnet
```
Record the deployed slot and the `.so` sha256 in `docs/DEPLOYMENTS.md`.

## 3. Initialise the pool

`initialize_pool(protocol_fee_bps, keeper_reward_bps, engine_authority)` signed by the pool authority, with `fee_wallet` = the fee keypair's wSOL token account (create it first). The pool PDA is `["pool", authority]`. Use `program/scripts/init-pool.mjs` (to be added by the engine work) or the matrix harness's init path. Then `set_paused(false)` is not needed; pools start live. Deposit a few devnet SOL so loans can fund.

## 4. Database

Create a Postgres database (local or a free Neon project named for HOCK, never shared with another product). `cd engine && npm install && DATABASE_URL=... npm run migrate`.

## 5. Engine

Fill `.env` from `.env.example` with the devnet values (PROGRAM_ID, POOL_PDA, keypair paths, RPC URLs, DATABASE_URL). `npm start`. Check `curl localhost:3001/health`. Expect: attestor idle (no collateral-ready mints yet), gate idle, watcher idle, reconciler writing a pool snapshot.

## 6. Web

`cd web && npm install && NEXT_PUBLIC_HOCK_CLUSTER=devnet NEXT_PUBLIC_PROGRAM_ID=... NEXT_PUBLIC_POOL_PDA=... RPC_PROXY_UPSTREAM=... DATABASE_URL=... npm run dev`. Launch a test coin on devnet through the site (PumpPortal only serves mainnet; on devnet use the test-mint path in the launch form, which creates a plain SPL mint and a seeded test pool so the gate has something to grade).

## 7. Lifecycle check

Launch → coin on the board → attestor initialises and updates its feed → gate promotes after two passes → borrow from the site → arm a limit-close → force the price through the trigger with the devnet test oracle → watcher fires, conversion events recorded → repay the remainder → position closes. Canary runs this on a schedule.

## 8. Gate to mainnet

Audit of the shipped source, reproducible build hash matching the deployed binary, canaries green for 48 hours, and an explicit go.

## Synthetic markets (devnet and localnet only)

Devnet has no DexScreener pairs and no Jupiter routes, so without help the gate can never pass and the attestor can never price a coin. The engine therefore has a synthetic-market mode:

- `SYNTHETIC_MARKETS=true` in the engine env. The engine exits at boot if this is set while `HOCK_CLUSTER=mainnet-beta` (or unset), and the module re-checks on every use.
- Rows live in `synthetic_markets` (migration 002). The gate reads liquidity, volume and routability from the row; the holders check and the Token-2022 extension audit stay real (set `--holders` to override the holder percentage, since a fresh test mint is 100 percent held by its launcher). The attestor uses the row's price as its single source and walks it by `--drift` bps per tick when asked, so TWAP and pump-guard paths see motion.
- Everything on chain is unchanged: staleness, TWAP minimums, the pump guard, the valuation tolerance and the conversion floors are all still enforced by the program.

```
cd engine
node scripts/synthetic-market.mjs set <mint> --price-sol 0.000002 --liq 50000 --v24 120000 --v1 6000 --holders 12 --drift 25
node scripts/synthetic-market.mjs list
node scripts/synthetic-market.mjs rm <mint>
```

The mint must already be in `mints` (launch it on the site, or POST `/api/mints/register`). Two gate cycles later it is `collateral_ready`, the attestor initialises and fills the feed (8 samples over at least 300 s), and the borrow panel opens.

## Launching on devnet

PumpPortal and the pump.fun curve are mainnet-only. On a test cluster the launch form takes the same inputs and creates a Token-2022 test mint instead: MetadataPointer plus TokenMetadata extensions carrying name, symbol and the Irys/Pinata URI, 1,000,000,000 supply minted to the launcher, mint authority revoked. The transaction is simulated against `/api/rpc` before the wallet is asked to sign. The mainnet path now simulates the PumpPortal transaction the same way before signing.
