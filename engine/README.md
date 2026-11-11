# hock-engine

Off-chain engine for HOCK (Solana launchpad with built-in lending). Node 20+, ESM.
Every module below was lifted from proven production code and rebranded; logic is unchanged.

## Configuration (env)

| Var | Purpose |
| --- | --- |
| `SOLANA_RPC_URL` | primary RPC (required) |
| `SOLANA_RPC_URL_BACKUP` | comma-separated backups for read failover |
| `DATABASE_URL` | Postgres (required by `TODO-hock/db.js`) |
| `PROGRAM_ID` | lending program id (required; no fallback is compiled in) |
| `PROGRAM_ID_V2` / `_V3` / `_V4` / `_V4_1` | optional additional program lanes |
| `LENDER_PUBKEY` | pool authority pubkey |
| `FEE_DESTINATION` | optional protocol-fee destination |
| `ENGINE_AUTHORITY_KEYPAIR_PATH` or `ENGINE_AUTHORITY_PRIVATE_KEY` | V4 engine signer (file path, or bs58) |
| `JUPITER_API`, `JUPITER_API_KEY` (or `JUPITER_KEY`) | Jupiter swap/price endpoint + Pro key |
| `PYTH_API_KEY`, `PYTH_HERMES_URL` | Pyth Hermes |
| `HOCK_API_URL` | engine -> API base for TWAP fallback / preflight |
| `HOCK_ADMIN_ID`, `OPERATOR_USER_ID` | operator alert targets (see TODO-hock stubs) |

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
- `on-chain-convert-slice.js` — builds/simulates/fires `convert_collateral_slice` through Jupiter via Anchor. Expects IDLs at `src/tx/idl/hock_lending_v4.json` and `hock_lending_v4_1.json` (not included; the bundled `address` is overridden from env).
- `tx-error-translator.js` — maps Solana/Anchor errors to user-facing copy (+ action keyboard via `TODO-hock/keyboard.js`).

### src/safety
- `privileged-sign-guard.js` — sign + simulate + audit for any privileged keypair; rejects undeclared balance decreases.
- `lender-spend-lock.js` — one session-pinned Postgres advisory lock for every lender-key spender.
- `safety.js` — pre-fire gates for limit-close orders.
- `preflight.js` — boot-time checks (DB, schema, RPC, Jupiter, env pubkeys, keypairs, balances).
- `liquidation-safety-watchdog.js` — read-only canary: alerts when overdue loans are not being liquidated.
- `arming-caps.js` — per-fire / total authorization cap math for exit ladders (dependency-free).

### src/orders
- `v4-arm-conversion.js` — builds arm/disarm conversion instructions (V4.1 lane, requires `PROGRAM_ID_V4_1`).
- `auto-extend-core.js` — pure auto-extend decision logic.
- `loan-tier-resolver.js` — LTV/term/fee tiers per collateral category (DB-tunable RWA tiers).
- `armed-order-health-probe.js` — dry-runs every armed order on a cadence and alerts on would-fail.
- `fill-watchdog.js` — detects stalled fills after a trigger hit.

### src/health
- `health-server.js` — `/health` HTTP endpoint + stall detector (exit 1 on stall).
- `liveness.js` — tick/progress bookkeeping used by the health server.

### src/TODO-hock (stubs, not lifted)
- `db.js` — minimal `pg` pool: `query`, `getClient`, `pool`.
- `notifications.js` — `enqueueNotification()` logs; no delivery channel yet.
- `admin-notify.js` — `getAdminId()` / `notifyAdmin()` log; no operator channel yet.
- `execution.js` — `dryRunArmedOrder()` returns a not-wired failure until the fire path exists.
- `keyboard.js` — chainable `InlineKeyboard` stand-in for the chat-bot keyboard class.

### db
- `migrations-runner.js` — applies `db/migrations/*.sql` in order under an advisory lock, tracking `schema_migrations` with checksums.
