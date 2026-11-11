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
