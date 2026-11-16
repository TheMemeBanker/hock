# HOCK architecture

Launch it. Hock it. A Solana launchpad where every coin is born collateral.

This document is the contract between the three parts of the system. Anything a reader cannot verify on chain or in this repo is a bug in this document.

## 1. Principles

1. **Non-custodial.** Users sign every borrow, repay, extend, limit-close arm and launch in their own wallet. No server ever holds, derives or decrypts a user key. The engine signs only instructions the program authorises for its own authority key.
2. **In-vault.** Collateral is transferred into a program-owned vault at borrow time and never leaves it until repay, liquidation or a limit-close conversion executed by the program. Exits swap inside the program through an allowlist of routers.
3. **Computed, never hard-coded.** Every number the site shows (pool size, APY, LTV, borrowable, TWAP, gate status) is read from chain state or derived from it at request time. There are no static marketing figures.
4. **Fails closed.** A coin that cannot prove it is sellable is not collateral. A price that is stale is not a price. An engine that cannot verify a pre-condition does not fire.
5. **One program version.** One program id, one IDL, no routing table. Upgrades are migrations, not forks.

## 2. Components

```
                 +---------------------+
   user wallet   |  web  (Next.js)     |   read: RPC proxy, DB (read replica)
   -------------->  launch / board /  |-------------------------------------+
   signs txs     |  borrow / lend /    |                                     |
                 |  docs               |                                     v
                 +----------+----------+                          +----------+----------+
                            | PumpPortal (create)                 |  Postgres           |
                            | Irys (metadata)                     |  loans, orders,     |
                            | program ixs (borrow, repay, arm)    |  mints, gate state, |
                            v                                     |  events, outbox     |
                 +---------------------+                          +----------+----------+
                 |  Solana             |                                     ^
                 |  hock_lending       |<------------------------------------+
                 |  program (Anchor)   |   engine writes state it observes;  |
                 +----------+----------+   never the source of truth        |
                            ^                                                |
                            | update_price (attestor authority)              |
                            | convert_collateral_slice / liquidate (engine)  |
                 +----------+----------+                                     |
                 |  engine  (Node)     |-------------------------------------+
                 |  attestor, gate,    |
                 |  watcher, canaries  |
                 +---------------------+
```

### 2.1 Program (`program/`)

Anchor program `hock_lending`. Ported from a prior audited in-vault lending program with these changes only: brand and constant names, and the engine authority plus fee destination moved from compile-time constants into `LendingPool` state, settable by the pool authority through `set_pool_config`.

Accounts

- `LendingPool` — authority, engine_authority, fee_destination, SOL vault, totals (deposits, shares, borrowed), fee bps, keeper reward bps, paused flag.
- `DepositorPosition` — shares per lender per pool.
- `PriceFeed` / `PriceHistory` — per collateral mint: latest attested price, 32-sample ring buffer, TWAP over 1800 s with minimum 8 samples and 300 s of history.
- `Loan` — borrower, mint, collateral vault, principal, fee, start and due slots, tier, armed limit-close fields (trigger price, min SOL out, consent flag), proceeds vault, accrued pool fees.

Instructions (user-signed): `deposit`, `withdraw`, `repay_loan`, `partial_repay`, `add_collateral`, `extend_loan` (healthy loans; an unhealthy loan needs the pool authority to co-sign), `arm_conversion`, `disarm_conversion`.
Instructions (user-signed AND pool-authority co-signed): `request_and_fund_loan`. The program requires the pool authority on every borrow. That signature is the lender's admission control: the engine's co-sign endpoint re-checks the gate verdict, feed freshness, tier caps and pool liquidity, then signs. The borrower's keys are never involved beyond their own signature; this is not custody.
Instructions (engine authority): `convert_collateral_slice`, `liquidate_loan`.
Instructions (pool authority): `initialize_pool`, `initialize_price_feed`, `update_price` (the attestor therefore runs with the pool authority key), `set_paused`, `set_keeper_reward`, `set_pool_config`, `admin_withdraw` (fees only), `recover_liquidated_collateral`.

Gates enforced on chain

| Gate | Value |
|---|---|
| Price staleness | 120 s |
| TWAP window / min samples / min history | 1800 s / 8 / 300 s |
| Spot vs TWAP pump guard | 1500 bps |
| Max per-update price factor | 100x |
| Conversion min SOL out | oracle floor, never below TWAP-derived value minus slippage |
| Router allowlist | Jupiter v6, Orca Whirlpool |
| Max protocol slippage | 1500 bps |
| Token-2022 | allowed; PermanentDelegate mints refused |

Tiers (memecoin): LTV 30 / 25 / 20 percent at 2 / 3 / 7 days, fees 3 / 2 / 1.5 percent of principal. Fees are paid up front into the pool; a configurable share goes to the fee destination.

### 2.2 Engine (`engine/`)

Node 20 ESM service. One process, several loops, one health endpoint.

- **Attestor** — reads cross-sourced prices (Jupiter price API primary, Jupiter quote and DexScreener fallbacks, Pyth where listed; coalesced requests, rate budget, circuit breaker) and submits `update_price` for every collateral-eligible mint on a cadence that keeps the on-chain feed inside the 120 s staleness window with margin. Refuses to push a price that moves more than the chain allows; logs and alerts instead.
- **Gate** — continuously grades every HOCK-launched mint: pooled liquidity, 24 h and 1 h volume, routability on Jupiter at the loan size, top-holder concentration, Token-2022 extension audit, impersonation check. Writes `gate_state` rows with the checks and a verdict. Promotes to `collateral_ready` only when all pass twice in a row; demotes the moment one fails. A demotion stops new borrows against the mint; existing loans continue to their term.
- **Watcher** — polls armed limit-close orders and open loans. When a trigger condition holds and the safety gates pass (fresh feed, TWAP sane, simulated conversion returns at least the floor), it submits `convert_collateral_slice` in TWAP-sized chunks, then `liquidate_loan` for loans past due. It claims an order atomically (`armed` to `firing`) in the DB before sending, recovers stuck `firing` orders on boot, and never retries a failed fire without re-running the gates.
- **Canaries** — a synthetic loan on devnet, and on mainnet a tiny real loan owned by the operator, armed and fired on a schedule, so the fire path is proven continuously, not assumed.
- **Health** — `/health` with per-loop heartbeat, feed staleness per mint, RPC failover state, and a stuck-order count. The site reads it to show "engine online" honestly.

Keys the engine holds: the pool authority (attestation, borrow co-sign, feed initialisation) and the engine authority (conversions, liquidations), each on its own keypair, plus a gas wallet. It holds no user keys. The pool authority on the engine host is the one privileged key in the system; the sign guard and spend lock wrap every use of it, and `set_pool_config` lets a compromised engine authority be rotated without a redeploy.

### 2.3 Web (`web/`)

Next.js app, static where possible, server routes only for: the RPC proxy (keeps the provider key off the client), DB reads, and the Irys/Pinata upload relay.

Flows

- **Launch** — form with live preview; metadata pinned to Arweave through Irys (user signs one message) or Pinata via relay; mint keypair generated in the browser (optional vanity suffix); PumpPortal `trade-local` builds the create transaction; the site simulates it, shows the exact fee, the user signs, the site rebroadcasts with a dynamic priority fee until confirmed. The new mint is registered with the gate immediately.
- **The board** — every HOCK-launched coin with age, market cap, liquidity, gate status, LTV and borrowable amount, all from the gate rows and chain reads. Rows are never hard-coded.
- **Borrow** — pick a collateral-ready coin you hold, choose a tier, see the attested price, TWAP, LTV, fee, due date and the exact trigger; sign `request_and_fund_loan`. Then repay, partial repay, add collateral, extend, arm or disarm a limit-close from the loan card. Each action shows the simulated outcome before the signature.
- **Lend** — deposit SOL into a pool, see shares, utilisation and realised fee yield computed from pool state; withdraw subject to utilisation.
- **Docs** — whitepaper, how it works, fees, security, risk, terms, privacy. Program id, IDL hash and build hash published on the security page at deploy time.

### 2.4 Database

Postgres. The chain is the source of truth for loans and pools; the DB indexes it and holds the off-chain-only state: gate grades, limit-close orders and their lifecycle, attestation log, canary runs, notification outbox. Fresh baseline migration set; a reconciler compares DB loans to chain accounts every few minutes and repairs drift.

## 3. Lifecycle of a coin

1. Launched on HOCK (or imported by address later, same gate).
2. `launched` — on the board, not collateral.
3. Gate grades it every cycle; progress shown live. **The headline rule is one number:** market cap at or above `GATE_MIN_MARKET_CAP_USD` (default $50,000), read from the coin's best pair (`marketCap`, `fdv` fallback) or, before graduation, its bonding curve. Underneath that line sits the sellability floor (liquidity, velocity, routability at loan size, holder concentration, Token-2022 extensions), sized for a bonding-curve coin and there only to refuse a coin the vault could not sell.
4. `collateral_ready` after two consecutive full passes. Price feed initialised and attested.
5. Holders borrow against it. Loans run to term; limit-closes fire if armed and triggered.
6. If any check fails, `delisted`: no new loans; existing loans run out; the reason is shown.

## 4. Lifecycle of a loan

borrow (user) → attested, in-vault → optional arm (user consent on chain) → either repay / extend / partial repay / add collateral (user), or trigger reached → engine converts slices inside the vault until principal plus fee is covered → remainder returned to borrower → or term passes unpaid → engine liquidates → lender made whole first, keeper reward, remainder recoverable by borrower.

Borrowers are warned before a trigger: the site and the outbox notify at 10 percent and 5 percent above the trigger price.

## 5. Fee model

- Launch: free. An optional initial buy pays only the router's own fee.
- Borrow: tier fee on principal, charged at origination into the pool. Split: pool share to lenders, protocol share to the fee destination. Both percentages live in pool state and are shown on the fees page from chain.
- Limit-close and liquidation: a keeper reward in bps from pool state, paid from proceeds.
- Lenders: pro-rata share of pool fees by shares held; no lock-up beyond utilisation.

## 6. Environments

- `localnet` — matrix harness, unit tests, CI.
- `devnet` — full stack live for testing; canaries run continuously; this is the gate for the audit.
- `mainnet` — only after the audit and an explicit operator go; soft launch with per-loan and per-pool caps.

## 7. What is deliberately not here

No Telegram bot. No custodial wallets. No multi-wallet launch tooling. No auto-sell on behalf of launchers. No referral or points system in version one. No RWA tiers in version one.
