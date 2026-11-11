-- Test-cluster storage for launch art and metadata. On mainnet the launch
-- flow stores on Arweave through Irys; on devnet/localnet the site stores the
-- bytes here and serves them from /api/upload/<id>. The route refuses to
-- write when the cluster is mainnet-beta.
CREATE TABLE IF NOT EXISTS uploads (
  id            text PRIMARY KEY,
  content_type  text NOT NULL,
  bytes         bytea NOT NULL,
  size          integer NOT NULL,
  launcher      text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
