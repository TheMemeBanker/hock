# HOCK

Launch it. Hock it.

A Solana launchpad with built-in lending. Every coin launched on HOCK is born collateral: launch in one signature, clear the gate, borrow SOL against your coin from pooled lender capital, in-vault and non-custodial.

- `program/` — the Anchor lending program (in-vault collateral, attested prices, TWAP gate, limit-close conversion).
- `engine/` — the off-chain engine: price attestor, gate, exit watcher, canaries, health.
- `web/` — the site: launch flow, the board, borrow / repay / extend / limit-close, lender pools, docs.
- `docs/` — architecture, threat model, fee model, runbooks.

Status: pre-devnet build. Nothing here is deployed. No mainnet program id, pool or token exists yet; anything claiming otherwise is an impostor.
