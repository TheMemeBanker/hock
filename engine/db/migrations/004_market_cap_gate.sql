-- The headline gate rule: a coin becomes collateral once its market cap clears
-- GATE_MIN_MARKET_CAP_USD (default $50,000). The older checks (liquidity, velocity,
-- routability, holders, extensions) remain as the sellability floor underneath it.
ALTER TABLE gate_state ADD COLUMN IF NOT EXISTS market_cap_ok  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE gate_state ADD COLUMN IF NOT EXISTS market_cap_usd NUMERIC(20,2);
ALTER TABLE gate_state ADD COLUMN IF NOT EXISTS min_market_cap_usd NUMERIC(20,2);
ALTER TABLE synthetic_markets ADD COLUMN IF NOT EXISTS market_cap_usd NUMERIC(20,2) NOT NULL DEFAULT 0;
