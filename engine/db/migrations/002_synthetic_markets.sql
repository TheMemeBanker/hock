-- Synthetic markets: devnet/localnet only. On those clusters no coin has a
-- DexScreener pair or a Jupiter route, so the gate and the attestor can never
-- see a market. When SYNTHETIC_MARKETS=true (the engine refuses that flag on
-- mainnet-beta at boot) both loops read this table instead of the live sources.
-- The holders check and the extension audit stay real; the chain still enforces
-- every program-side gate. Rows are written by scripts/synthetic-market.mjs.
CREATE TABLE IF NOT EXISTS synthetic_markets (
  mint                     text PRIMARY KEY REFERENCES mints(mint) ON DELETE CASCADE,
  price_lamports_per_whole numeric(30,0) NOT NULL CHECK (price_lamports_per_whole > 0),
  liquidity_usd            numeric(20,2) NOT NULL DEFAULT 0,
  volume_24h_usd           numeric(20,2) NOT NULL DEFAULT 0,
  volume_1h_usd            numeric(20,2) NOT NULL DEFAULT 0,
  route_ok                 boolean NOT NULL DEFAULT true,
  route_impact_bps         integer NOT NULL DEFAULT 0,
  holders_pct_override     numeric(6,2),          -- NULL = grade holders from chain
  drift_bps_per_tick       integer NOT NULL DEFAULT 0, -- optional random walk so TWAP tests see motion
  note                     text,
  updated_at               timestamptz NOT NULL DEFAULT now()
);
