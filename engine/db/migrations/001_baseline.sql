-- HOCK baseline schema. The chain is the source of truth for pools and loans;
-- these tables index chain state and hold the off-chain-only lifecycle
-- (gate grades, limit-close orders, attestation log, canaries, outbox).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version      TEXT PRIMARY KEY,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mints (
  mint            TEXT PRIMARY KEY,
  symbol          TEXT NOT NULL,
  name            TEXT NOT NULL,
  decimals        SMALLINT NOT NULL,
  token_program   TEXT NOT NULL,
  metadata_uri    TEXT,
  image_url       TEXT,
  launched_here   BOOLEAN NOT NULL DEFAULT false,
  launch_sig      TEXT,
  launcher        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TYPE gate_verdict AS ENUM ('launched', 'grading', 'collateral_ready', 'delisted');

CREATE TABLE IF NOT EXISTS gate_state (
  mint                 TEXT PRIMARY KEY REFERENCES mints(mint),
  verdict              gate_verdict NOT NULL DEFAULT 'launched',
  liquidity_ok         BOOLEAN NOT NULL DEFAULT false,
  velocity_ok          BOOLEAN NOT NULL DEFAULT false,
  routability_ok       BOOLEAN NOT NULL DEFAULT false,
  holders_ok           BOOLEAN NOT NULL DEFAULT false,
  extensions_ok        BOOLEAN NOT NULL DEFAULT false,
  consecutive_passes   SMALLINT NOT NULL DEFAULT 0,
  liquidity_usd        NUMERIC(20,2),
  volume_24h_usd       NUMERIC(20,2),
  volume_1h_usd        NUMERIC(20,2),
  route_quote_sol      NUMERIC(20,9),
  top10_holder_pct     NUMERIC(6,3),
  reason               TEXT,
  graded_at            TIMESTAMPTZ,
  promoted_at          TIMESTAMPTZ,
  delisted_at          TIMESTAMPTZ,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS gate_passes (
  id           BIGSERIAL PRIMARY KEY,
  mint         TEXT NOT NULL REFERENCES mints(mint),
  verdict      gate_verdict NOT NULL,
  checks       JSONB NOT NULL,
  graded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS gate_passes_mint_time ON gate_passes (mint, graded_at DESC);

CREATE TABLE IF NOT EXISTS attestations (
  id              BIGSERIAL PRIMARY KEY,
  mint            TEXT NOT NULL REFERENCES mints(mint),
  price_lamports  NUMERIC(30,0) NOT NULL,
  source_mix      JSONB NOT NULL,
  tx_sig          TEXT,
  accepted        BOOLEAN,
  error           TEXT,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attestations_mint_time ON attestations (mint, submitted_at DESC);

CREATE TYPE loan_status AS ENUM ('open', 'repaid', 'converted', 'liquidated', 'unknown');

CREATE TABLE IF NOT EXISTS loans (
  loan_pda            TEXT PRIMARY KEY,
  borrower            TEXT NOT NULL,
  mint                TEXT NOT NULL REFERENCES mints(mint),
  pool_pda            TEXT NOT NULL,
  tier                SMALLINT NOT NULL,
  principal_lamports  NUMERIC(30,0) NOT NULL,
  fee_lamports        NUMERIC(30,0) NOT NULL,
  collateral_amount   NUMERIC(40,0) NOT NULL,
  opened_slot         BIGINT NOT NULL,
  due_at              TIMESTAMPTZ NOT NULL,
  status              loan_status NOT NULL DEFAULT 'open',
  open_sig            TEXT,
  close_sig           TEXT,
  last_chain_check    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loans_borrower ON loans (borrower);
CREATE INDEX IF NOT EXISTS loans_status_due ON loans (status, due_at);

CREATE TYPE order_status AS ENUM ('armed', 'firing', 'filled', 'partial', 'disarmed', 'failed', 'expired', 'awaiting_user');

CREATE TABLE IF NOT EXISTS limit_close_orders (
  id                  BIGSERIAL PRIMARY KEY,
  loan_pda            TEXT NOT NULL REFERENCES loans(loan_pda),
  borrower            TEXT NOT NULL,
  trigger_price       NUMERIC(30,0) NOT NULL,
  direction           TEXT NOT NULL CHECK (direction IN ('take_profit', 'stop_loss')),
  min_sol_out         NUMERIC(30,0) NOT NULL,
  status              order_status NOT NULL DEFAULT 'armed',
  armed_sig           TEXT,
  armed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at          TIMESTAMPTZ,
  claimed_by          TEXT,
  fired_at            TIMESTAMPTZ,
  fill_sigs           TEXT[] NOT NULL DEFAULT '{}',
  sol_out_lamports    NUMERIC(30,0) NOT NULL DEFAULT 0,
  attempts            INT NOT NULL DEFAULT 0,
  last_error          TEXT,
  valid_until_height  BIGINT,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lco_status ON limit_close_orders (status);
CREATE UNIQUE INDEX IF NOT EXISTS lco_one_live_per_loan ON limit_close_orders (loan_pda) WHERE status IN ('armed','firing');

CREATE TABLE IF NOT EXISTS conversion_events (
  id              BIGSERIAL PRIMARY KEY,
  order_id        BIGINT REFERENCES limit_close_orders(id),
  loan_pda        TEXT NOT NULL,
  slice_index     INT NOT NULL,
  tokens_in       NUMERIC(40,0) NOT NULL,
  sol_out         NUMERIC(30,0) NOT NULL,
  router          TEXT NOT NULL,
  tx_sig          TEXT NOT NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pool_snapshots (
  id                 BIGSERIAL PRIMARY KEY,
  pool_pda           TEXT NOT NULL,
  total_deposits     NUMERIC(30,0) NOT NULL,
  total_borrowed     NUMERIC(30,0) NOT NULL,
  total_shares       NUMERIC(30,0) NOT NULL,
  accrued_fees       NUMERIC(30,0) NOT NULL,
  slot               BIGINT NOT NULL,
  at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pool_snapshots_pool_time ON pool_snapshots (pool_pda, at DESC);

CREATE TABLE IF NOT EXISTS canary_runs (
  id          BIGSERIAL PRIMARY KEY,
  cluster     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  ok          BOOLEAN NOT NULL,
  detail      JSONB,
  tx_sig      TEXT,
  ran_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications_outbox (
  id          BIGSERIAL PRIMARY KEY,
  wallet      TEXT NOT NULL,
  kind        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS outbox_undelivered ON notifications_outbox (delivered_at) WHERE delivered_at IS NULL;

INSERT INTO schema_migrations (version) VALUES ('001_baseline') ON CONFLICT DO NOTHING;
