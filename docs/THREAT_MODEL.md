# HOCK threat model

Assets: lender SOL in pools, borrower collateral in vaults, the engine authority key, the pool authority key, the attestation feed, and user trust in the numbers the site shows.

## Attackers and what they want

| Actor | Goal | Primary controls |
|---|---|---|
| Borrower | Over-borrow against an inflated or unsellable coin, then walk | Attested price capped by TWAP; pump guard 1500 bps; gate requires routability at loan size; LTV 30 percent max; short terms |
| Launcher | Launch, pump, borrow, dump (self-rug) | Gate needs two consecutive passes with real volume and liquidity; holder concentration check; delisting stops new loans; limit-close converts in slices inside the vault |
| Outside trader | Manipulate a thin pool at attestation time | TWAP over 30 minutes with minimum history; per-update factor cap; attestor refuses out-of-band prices; cross-sourced feeds with breaker |
| Compromised engine key | Drain vaults through conversions | Program enforces oracle floor on min SOL out, router allowlist, slippage cap; engine cannot withdraw deposits or move collateral except through conversion or liquidation paths; spend lock and sign guard on the engine host |
| Compromised pool authority | Change fee destination, pause, admin-withdraw | admin_withdraw limited to accrued fees; set_pool_config emits events the site surfaces; authority kept on hardware; timelock considered for version two |
| RPC provider | Serve stale state (HTTP 200, old slot) | Failover across providers; slot-advance check before any fire; staleness window on chain |
| Token-2022 extension abuse | Transfer hooks, permanent delegate, confidential transfers | PermanentDelegate refused on chain; extension audit in the gate; transfer-hook mints refused in the gate |
| Address poisoning / impersonation | Trick users with lookalike mints or addresses | Mint registry from launches only; impersonation check against known symbols; site never shows truncated addresses without the full copyable value |
| Phishing site | Clone the UI | Program id and IDL hash on the security page; token address published on the site first; no custodial actions to phish |
| Operator error | Deploy wrong binary, wrong config | Reproducible build hash published; config read from chain state; canaries fail loudly on mismatch |

## Non-goals in version one

Protection against a complete collapse of Solana liquidity for a collateral coin inside the TWAP window. Mitigated by low LTV, short terms and slicing, not eliminated. Disclosed on the risk page.

## Operational rules

- No mainnet deploy, pool seeding or live borrow without an audit of the shipped source and an explicit operator go.
- Every privileged key lives outside the repo, backed up, and is never one previously used by another product.
- Secrets are referenced by name only in docs and logs.
- A limit-close or liquidation never fires without the slot-advance check, the feed freshness check and a successful simulation of the exact transaction.
- Any public claim on the site about size, yield or safety is computed from chain state at render time.
