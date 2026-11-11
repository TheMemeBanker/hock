# hock-engine RUNBOOK

## Start on a host

1. Node 20+. `cd engine && npm install`.
2. Put the keypair files outside the repo and point env at them by name only:
   `ENGINE_AUTHORITY_KEYPAIR_PATH`, `ENGINE_GAS_KEYPAIR_PATH`, optionally
   `POOL_AUTHORITY_KEYPAIR_PATH` (see "update_price signer" below).
3. Set `PROGRAM_ID`, `POOL_PDA`, `SOLANA_RPC_URL` (+ `_BACKUP`), `DATABASE_URL`
   (+ `_READONLY`), `HOCK_CLUSTER`, `HEALTH_PORT`, `ENGINE_INSTANCE_ID`. Every
   other knob has a default listed in `../.env.example`.
4. `npm run boot-check` runs migrations (when `DATABASE_URL` is set) and the
   preflight, then exits 0/1. Fix every FAIL before `npm start`.
5. `npm start`. Run it under a supervisor that restarts on exit: the stall
   detector exits 1 on purpose when no loop makes progress for `ENGINE_STALL_MS`.
6. `curl :3001/health` shows per-loop `lastTickAgeMs`, `stalled`, the gauges
   (`feed_age_seconds.<mint>`, `orders_armed`, `orders_firing`, `stuck_orders`,
   `loans_overdue`, `loans_on_chain`), RPC primary health and DB latency.

Kill switch: `LIMIT_CLOSE_DISABLED=true` pauses every fire and liquidation
(orders stay armed; the watcher logs `engine_kill_switch_on`).

## update_price signer

The program's `UpdatePrice` context requires `pool.authority` as signer
(`has_one = authority` and `price_feed.authority == authority`), and
`set_pool_config` refuses `engine_authority == pool.authority`. So the engine
authority key cannot sign `update_price` as the program stands. The attestor
therefore signs with `POOL_AUTHORITY_KEYPAIR_PATH` when it is configured. When it
is not, it tries the engine key, detects the mismatch against the pool account,
records every attempt in `attestations` with `accepted=false` and raises one
`attestor_signer_mismatch` alert per 30 minutes. Decide one of:

- run the attestor with the pool authority key on the host (hot pool authority), or
- change the program so `update_price` accepts `pool.engine_authority`.

## Alerts (outbox rows with wallet = 'admin')

| kind | meaning | action |
| --- | --- | --- |
| `engine_preflight_failed` | boot refused; payload lists failing checks | fix env / keys / RPC / DB, restart |
| `engine_stall_restart` | no loop progressed for `ENGINE_STALL_MS`; process exited | check RPC + DB, read last logs |
| `price_feed_needs_init` | a collateral_ready mint has no PriceHistory PDA and no pool authority key is configured | run `initialize_price_feed` with the pool authority, or configure the key |
| `attestor_price_rejected` | fewer than `ATTESTOR_MIN_SOURCES` sources agreed within `ATTESTOR_MAX_DIVERGENCE_PCT` | check DexScreener / Jupiter / Pyth for the mint; feed goes stale if it persists |
| `attestor_update_out_of_bound` | new price outside [prev/100, prev*100]; NOT submitted | verify sources; if real, the feed must be walked in several updates by hand |
| `attestor_pump_guard` | spot > TWAP by more than 15 percent; feed still updated, borrows refused by program | informational |
| `attestor_signer_mismatch` | see "update_price signer" | configure `POOL_AUTHORITY_KEYPAIR_PATH` |
| `attestor_send_failed` | update_price tx failed | check gas, RPC, feed authority |
| `armed_order_probe_failed` | an armed order would fail at fire time (phase in payload) | fix before the trigger hits |
| `limit_close_fire_failed` | claimed order sent nothing; status failed | inspect `last_error`, re-arm with the borrower |
| `stuck_firing_recovered` | order found in `firing` > 10 min at boot; now `awaiting_user` | verify `fill_sigs` on chain, reconcile by hand |
| `liquidation_simulation_failed` | liquidate_loan simulation rejected | read logs in payload (LoanNotDue, OracleStale, missing ATA) |
| `loan_missing_on_chain` | DB loan `open` but account absent under PROGRAM_ID; set `unknown` | check signature history; never set `repaid` without a chain receipt |
| `canary_failed` | synthetic lifecycle or mainnet fire simulation failed | treat as fire path broken until explained |

Borrower-facing outbox kinds: `gate_promoted`, `gate_delisted`,
`stop_loss_proximity` (10 and 5 percent bands, once each per order),
`limit_close_filled|partial|failed|awaiting_user`, `loan_liquidated`.

## Rotate the engine authority (set_pool_config)

1. Generate the new key outside the repo; fund it with gas.
2. With the POOL AUTHORITY key (cold), send `set_pool_config(engine_authority = NEW_PUBKEY)`
   with accounts `pool = POOL_PDA`, `authority = pool authority (signer)`,
   `fee_wallet = current pool.fee_wallet` (pass the same account to leave it
   unchanged). The program emits `PoolConfigUpdated` with old and new values.
3. Point `ENGINE_AUTHORITY_KEYPAIR_PATH` at the new file and restart. Preflight
   `pool_account` verifies `pool.engine_authority == engine key`; the old key can
   no longer call `convert_collateral_slice`.
4. The engine's collateral ATAs are per key; the first convert with the new key
   creates them idempotently.

## Local test

```
solana-test-validator --reset --bpf-program <PROGRAM_ID> program/target/deploy/hock_lending.so
PROGRAM_ID=... POOL_PDA=... SOLANA_RPC_URL=http://127.0.0.1:8899 \
ENGINE_AUTHORITY_KEYPAIR_PATH=... npm run boot-check
```
Without a pool initialised the `pool_account` check fails by design; initialise
the pool with the pool authority first, airdrop gas to the gas key, then re-run.
