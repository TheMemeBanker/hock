# Deploying hock.fun

HOCK is three deployables and one database. Nothing here needs a container on your laptop: the host builds from the repo.

| Piece | What it is | Where it runs |
| --- | --- | --- |
| `web/` | Next.js app (pages, RPC proxy, mint registry, upload relay) | Railway service `hock-web`, custom domain `hock.fun` |
| `engine/` | attestor, gate, watcher, reconciler, canary, health, co-sign | Railway service `hock-engine`, one public port |
| Postgres | gate state, loans index, snapshots, uploads | Railway Postgres in the same project (or a Neon project named for HOCK) |
| program | `hock_lending` on devnet | deployed once from a laptop with `scripts/devnet-up.sh` |

Everything lives in a **new Railway workspace** used for nothing else. Never reuse a workspace, token or database from another product.

## 0. One-time, on the laptop

1. Fund the devnet deployer `yfkQ4U3TSgYodUFdSr6McmabQkfLaR9SL5PdhKT5YYd` with about 5 SOL at https://faucet.solana.com.
2. `bash scripts/devnet-up.sh` deploys the program, initialises the pool and prints `PROGRAM_ID` and `POOL_PDA`. Keep the printed values; the host needs them.
3. `railway login` (opens a browser), then `railway init` from the repo root to create the project `hock` in the new workspace.

## 1. Database

`railway add --database postgres` inside the project. Railway injects `DATABASE_URL` into services you link it to. The engine applies its migrations on boot, so no manual step.

## 2. Engine service

Create the service from the GitHub repo with **root directory `engine/`**. `engine/railway.json` sets the build and start commands and the `/health` check. Variables:

```
HOCK_CLUSTER=devnet
ENGINE_INSTANCE_ID=engine-devnet
PROGRAM_ID=<from devnet-up>
POOL_PDA=<from devnet-up>
SOLANA_RPC_URL=https://api.devnet.solana.com
DATABASE_URL=${{Postgres.DATABASE_URL}}
SYNTHETIC_MARKETS=true
HEALTH_PORT=${{PORT}}
COSIGN_PORT=${{PORT}}
HOCK_ALLOWED_ORIGINS=https://hock.fun,https://www.hock.fun
GATE_INTERVAL_SECONDS=20
FEED_TARGET_INTERVAL_SECONDS=30
WATCHER_INTERVAL_SECONDS=5
RECONCILER_INTERVAL_SECONDS=30
ENGINE_AUTHORITY_KEYPAIR_PATH=<contents of ~/hock-keys/hock-devnet-engine.json, the JSON byte array>
ENGINE_GAS_KEYPAIR_PATH=<contents of ~/hock-keys/hock-devnet-gas.json>
POOL_AUTHORITY_KEYPAIR_PATH=<contents of ~/hock-keys/hock-devnet-pool-authority.json>
```

The `*_KEYPAIR_PATH` variables accept either a file path or the JSON byte array itself; on a host, paste the array. When `COSIGN_PORT` equals `HEALTH_PORT` the co-sign endpoint is served on the same port as `/health`, which is what a single public port needs. Generate a public domain for the service (`railway domain`); that URL is the site's `NEXT_PUBLIC_COSIGN_URL`.

These are **devnet** keys that hold faucet SOL only. Mainnet keys never go into a host's variables without the key-handling plan in the runbook being signed off.

## 3. Web service

Create the service from the same repo with **root directory `web/`**. `web/railway.json` builds with `npm run build` and starts `next start` on the injected `PORT`. Variables:

```
NEXT_PUBLIC_HOCK_CLUSTER=devnet
NEXT_PUBLIC_PROGRAM_ID=<same as engine>
NEXT_PUBLIC_POOL_PDA=<same as engine>
NEXT_PUBLIC_COSIGN_URL=https://<engine service domain>
NEXT_PUBLIC_SITE_URL=https://hock.fun
NEXT_PUBLIC_DEMO_WALLET=false
DATABASE_URL=${{Postgres.DATABASE_URL}}
RPC_PROXY_UPSTREAM=https://api.devnet.solana.com
SOLANA_RPC_URL=https://api.devnet.solana.com
```

`NEXT_PUBLIC_*` values are baked in at build time; change one and redeploy. Add the custom domain in the service settings: `hock.fun` and `www.hock.fun`.

## 4. DNS at GoDaddy

Railway hands you a CNAME target per domain. GoDaddy cannot CNAME the bare apex, so either:

- **Simplest:** CNAME `www` → the Railway target, and set GoDaddy *Domain Forwarding* for `hock.fun` → `https://www.hock.fun` (301). Add both names to the web service.
- **Cleaner:** move the nameservers to Cloudflare (free), then CNAME both `@` and `www` to the Railway target; Cloudflare flattens the apex. Keep the Cloudflare proxy off until the Railway certificate is issued.

Certificates are issued by Railway automatically once DNS resolves.

## 5. Verify

```
curl -s https://<engine domain>/health | head -c 200       # ok:true, cluster devnet
curl -s -o /dev/null -w '%{http_code}\n' https://hock.fun/  # 200
```

Then the real test: with Phantom on devnet, launch a test coin on `/launch`, set its synthetic market from the laptop (`node engine/scripts/synthetic-market.mjs set <mint> --price-sol 0.000002 --mcap 60000 --liq 5000 --v24 8000 --v1 500 --holders 12 --impact 80` against the hosted `DATABASE_URL`), watch it clear the $50k line on its coin page, and borrow.

## Redeploys

Push to `main`; Railway rebuilds both services. The engine restarts cleanly (its loops are idempotent and the reconciler re-mirrors chain state). Database migrations run on engine boot; never edit an applied migration, add a new file.
