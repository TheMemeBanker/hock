# hock-engine

Off-chain engine for HOCK (Solana launchpad with built-in lending). Node 20+, ESM.
Every module below was lifted from proven production code and rebranded; logic is unchanged.

## Configuration (env)

| Var | Purpose |
| --- | --- |
| `SOLANA_RPC_URL` | primary RPC (required) |
| `SOLANA_RPC_URL_BACKUP` | comma-separated backups for read failover |
| `DATABASE_URL` / `DATABASE_URL_READONLY` | Postgres (reads fail over to the read-only URL) |
| `PROGRAM_ID` | lending program id (required; no fallback is compiled in) |
| `POOL_PDA` | the single live pool |
| `POOL_AUTHORITY_KEYPAIR_PATH` | optional; signs `update_price` / `initialize_price_feed` (see RUNBOOK) |
| `FEE_DESTINATION` | optional protocol-fee destination |
| `ENGINE_AUTHORITY_KEYPAIR_PATH` or `ENGINE_AUTHORITY_PRIVATE_KEY` | V4 engine signer (file path, or bs58) |
| `JUPITER_API`, `JUPITER_API_KEY` (or `JUPITER_KEY`) | Jupiter swap/price endpoint + Pro key |
| `PYTH_API_KEY`, `PYTH_HERMES_URL` | Pyth Hermes |
| `HOCK_API_URL` | engine -> API base for TWAP fallback / preflight |
| `FEED_TARGET_INTERVAL_SECONDS`, `GATE_INTERVAL_SECONDS`, `WATCHER_INTERVAL_SECONDS`, `CANARY_INTERVAL_MINUTES`, `HEALTH_PORT`, `ENGINE_INSTANCE_ID`, `HOCK_CLUSTER` | loop cadence and identity; every gate/attestor/watcher threshold is listed in `../.env.example` |

## Modules

### src/rpc
- `connection.js` — primary Connection + backup pool with `withRpcFailover()` for reads.
- `rpc.js` — `makeConnection()` / `getFailoverConnection()`: per-method read failover to a backup RPC, fetch timeouts, confirm timeouts.
- `simulate-compat.js` — simulate legacy and versioned transactions with one call shape.

### src/price
- `jupiter-price-client.js` — coalescing, rate-budgeted Jupiter price client (paid + lite tiers, omission = reject).
- `dexscreener-breaker.js` — circuit breaker around DexScreener.
- `http-cache.js` — TTL HTTP GET cache wired to the DexScreener breaker.
- `pyth-price.js` — Pyth Hermes price fetch.
- `pricing.js` — cross-sourced current price (Jupiter primary, DexScreener, TWAP fallback), divergence guard, trigger evaluation.
- `twap.js` — DB-backed TWAP sampling and reads.
- `jupiter.js` — quote + swap-instructions helpers for the fire path.
- `jupiter-config.js` — shared Jupiter base URL and auth headers.
- `jupiter-budget.js` — per-second Jupiter request budget with DB-visible accounting.
- `price-feed-staleness-watcher.js` — reads on-chain PriceHistory accounts and alerts on stale feeds.

### src/tx
- `priority-fee.js` — dynamic compute-unit price (RPC estimate, floor/cap/multiplier, cache).
- `tx-send.js` — send + confirm with rebroadcast and blockhash expiry handling.
- `on-chain-convert-slice.js` — builds/simulates/fires `convert_collateral_slice` through Jupiter via Anchor against `src/tx/idl/hock_lending.json` at `PROGRAM_ID`; pool from `POOL_PDA`, fee wallet read from the pool account; `dryRun` and `minSolOutFloor` options.
- `tx-error-translator.js` — maps Solana/Anchor errors to user-facing copy (plain `errorActions()` list; no chat keyboard).

### src/safety
- `privileged-sign-guard.js` — sign + simulate + audit for any privileged keypair; rejects undeclared balance decreases.
- `lender-spend-lock.js` — one session-pinned Postgres advisory lock for every lender-key spender.
- `safety.js` — `runPreFlightGates` + `runFireGates` (feed fresh, slot advance, exact-tx simulation at or above the oracle floor).
- `preflight.js` — boot-time checks (PROGRAM_ID/POOL_PDA, keys, DB + tables, RPC slot advancing, program executable, pool.engine_authority == engine key, gas balance, Jupiter warn-only).
- `liquidation-safety-watchdog.js` — read-only canary: alerts when overdue loans are not being liquidated.
- `arming-caps.js` — per-fire / total authorization cap math for exit ladders (dependency-free).

### src/orders
- `v4-arm-conversion.js` — builds arm/disarm conversion instructions (V4.1 lane, requires `PROGRAM_ID_V4_1`).
- `auto-extend-core.js` — pure auto-extend decision logic.
- `loan-tier-resolver.js` — LTV/term/fee tiers per collateral category (DB-tunable RWA tiers).
- `armed-order-health-probe.js` — dry-runs every armed order on a cadence and alerts on would-fail.
- `fill-watchdog.js` — detects stalled fills after a trigger hit.

### src/health
- `health-server.js` — `/health` with per-loop heartbeat, gauges (feed staleness per mint, stuck counts), RPC/DB state; stall detector exits 1.
- `liveness.js` — tick/progress bookkeeping used by the health server.

### Loops (src/index.js boots them in this order after migrations + preflight)

- **src/attestor/attestor.js** -- for every `gate_state.verdict = collateral_ready` mint plus mints with open loans: cross-sourced price (Jupiter price API, Jupiter quote, DexScreener via the breaker cache, Pyth when a feed id exists) in lamports per whole token; rejects when fewer than `ATTESTOR_MIN_SOURCES` agree within `ATTESTOR_MAX_DIVERGENCE_PCT`; checks the program's per-update factor (100x) client-side and alerts instead of sending; submits `update_price` whenever the feed is older than `FEED_TARGET_INTERVAL_SECONDS`; `initialize_price_feed` for promoted mints without a feed when the pool authority key is configured, else an admin outbox item; one `attestations` row per attempt. Signer: see RUNBOOK (`update_price` is bound to `pool.authority` by the program).
- **src/gate/gate.js** -- grades every `mints.launched_here` mint each `GATE_INTERVAL_SECONDS`: liquidity (sum of DexScreener pairs), 24h/1h volume, routability (Jupiter quote selling `GATE_REFERENCE_SELL_SOL` worth under `GATE_MAX_IMPACT_BPS`), holders (top-10 non-pool holders under `GATE_MAX_TOP10_PCT`, pool/vault accounts excluded by pair address and off-curve owner), Token-2022 extension audit. Verdict machine launched -> grading -> collateral_ready after `GATE_PASSES_TO_PROMOTE` consecutive passes; any failure resets the streak and delists a ready mint. `gate_passes` every cycle, `gate_state` upsert, launcher outbox on promote/delist.
- **src/watcher/watcher.js** (+ `slicing.js`) -- armed `limit_close_orders` and overdue loans every `WATCHER_INTERVAL_SECONDS`. Trigger evaluated on the on-chain latest sample by direction; borrower warned at 10 and 5 percent above a stop-loss trigger; atomic claim (`UPDATE ... WHERE status='armed' RETURNING`); gates from `src/safety/safety.js` (feed fresh, slot advancing across two reads, exact `convert_collateral_slice` simulation with `min_sol_out >= oracle floor`); fires through `src/tx/on-chain-convert-slice.js` in slices sized to cover `repay_amount - sol_proceeds` under the armed caps and `WATCHER_MAX_SLICE_BPS`; `conversion_events` per slice; filled/partial/failed; stuck `firing` older than 10 minutes becomes `awaiting_user` at boot. Loans past `due_at` go through `liquidate_loan` (engine key as keeper) with the same feed/slot/simulation gates.
- **src/reconciler/reconciler.js** -- every `RECONCILER_INTERVAL_SECONDS` (180): `getProgramAccounts` with the Loan discriminator -> upsert `loans`; DB-open loans missing on chain -> `unknown` + alert; one `pool_snapshots` row from the LendingPool account.
- **src/canary/canary.js** -- no-op with a logged reason unless `CANARY_WALLET_KEYPAIR_PATH` and `CANARY_MINT` are set. devnet/localnet: forced attestation + exact fire simulation on `CANARY_LOAN_PDA` (the full borrow -> arm -> fire -> repay legs are behind `CANARY_FULL_LIFECYCLE` and not yet implemented). mainnet: fire-path simulation on the operator loan only. `canary_runs` row per run.
- **src/orders/armed-order-health-probe.js** -- dry-runs every armed order through `src/execution/dry-run.js` (real quote + real simulation) and alerts when a fire would fail.

### src/db, src/notify, src/execution, src/chain
- `db/pool.js` -- lazy pg pool, `queryRead` fails over to `DATABASE_URL_READONLY`, `dbPing`.
- `notify/outbox.js` -- `enqueueOutbox({ wallet, kind, payload })` into `notifications_outbox`; no delivery channel in the engine.
- `notify/admin.js` -- `notifyAdmin` logs and enqueues under wallet `admin`, throttled per kind/key.
- `execution/dry-run.js` -- `dryRunArmedOrder(orderId)` simulates the exact convert slice; returns ok/phase/reason.
- `chain/program.js` -- PROGRAM_ID (required), IDL, keypairs, PDAs, account decoding, `readPriceFeed` (latest + TWAP exactly as the program computes), `assertSlotAdvancing`, `oracleFloorLamports`.

### db
- `migrations-runner.js` — applies `db/migrations/*.sql` in order under an advisory lock, tracking `schema_migrations` with checksums.

## Scripts
- `npm start` -- migrations, preflight, loops, health server.
- `npm run boot-check` -- migrations (if DATABASE_URL) + preflight, exit 0/1.
- `npm run migrate` -- apply pending migrations only.
- `npm run check` -- `node --check` every file.

See RUNBOOK.md for host start, alert meanings and engine-authority rotation.
