#!/usr/bin/env bash
# HOCK devnet bring-up. Run once the deployer has ~5 SOL on devnet.
#   bash scripts/devnet-up.sh            (from ~/hock)
# Steps: deploy program -> initialise pool (+ seed) -> write engine/web devnet env -> restart engine + web (prod build on :3010).
# Never touches mainnet; keys come from ~/hock-keys only.
set -euo pipefail
cd "$(dirname "$0")/.."
RPC=${DEVNET_RPC:-https://api.devnet.solana.com}
KEYS=$HOME/hock-keys
PROGRAM_KP=$KEYS/hock_lending-program.json
DEPLOYER=$KEYS/hock-devnet-deployer.json
PROGRAM_ID=$(solana-keygen pubkey "$PROGRAM_KP")
SEED_SOL=${SEED_SOL:-2}

bal=$(solana balance "$(solana-keygen pubkey "$DEPLOYER")" -u "$RPC" | awk '{print $1}')
echo "deployer balance: $bal SOL (needs ~5 for the first deploy)"
awk -v b="$bal" 'BEGIN{ if (b+0 < 4.8) { print "not enough SOL on the deployer; fund it at faucet.solana.com and rerun"; exit 1 } }'

# 1. deploy (idempotent: upgrades in place when already deployed)
echo "deploying $PROGRAM_ID to devnet"
solana program deploy program/target/deploy/hock_lending.so --program-id "$PROGRAM_KP" --keypair "$DEPLOYER" --upgrade-authority "$DEPLOYER" -u "$RPC" --max-sign-attempts 60 --with-compute-unit-price 1000

# 2. fund the pool authority, engine and gas keys from the deployer if they are empty (0.3 SOL each)
for k in pool-authority engine gas fee; do
  pk=$(solana-keygen pubkey "$KEYS/hock-devnet-$k.json")
  b=$(solana balance "$pk" -u "$RPC" | awk '{print $1}')
  if awk -v b="$b" 'BEGIN{exit !(b+0 < 0.2)}'; then solana transfer "$pk" 0.3 --allow-unfunded-recipient --keypair "$DEPLOYER" -u "$RPC" >/dev/null && echo "funded $k 0.3 SOL"; fi
done
# the pool authority also seeds the pool
solana transfer "$(solana-keygen pubkey "$KEYS/hock-devnet-pool-authority.json")" "$SEED_SOL" --allow-unfunded-recipient --keypair "$DEPLOYER" -u "$RPC" >/dev/null || true

# 3. initialise the pool (idempotent) and capture POOL_PDA
POOL_PDA=$(cd program && SOLANA_RPC_URL="$RPC" PROGRAM_ID="$PROGRAM_ID" POOL_AUTHORITY_KEYPAIR_PATH="$KEYS/hock-devnet-pool-authority.json" ENGINE_AUTHORITY_KEYPAIR_PATH="$KEYS/hock-devnet-engine.json" FEE_KEYPAIR_PATH="$KEYS/hock-devnet-fee.json" node scripts/init-pool.mjs --seed-sol "$SEED_SOL" | tee /dev/stderr | awk -F= '/^POOL_PDA=/{print $2}')
echo "POOL_PDA=$POOL_PDA"

# 4. env files (gitignored)
DB=${DATABASE_URL:-postgres://hock:hock@127.0.0.1:5432/hock}
cat > engine/.env <<ENV
HOCK_CLUSTER=devnet
ENGINE_INSTANCE_ID=engine-devnet
PROGRAM_ID=$PROGRAM_ID
POOL_PDA=$POOL_PDA
SOLANA_RPC_URL=$RPC
ENGINE_AUTHORITY_KEYPAIR_PATH=$KEYS/hock-devnet-engine.json
ENGINE_GAS_KEYPAIR_PATH=$KEYS/hock-devnet-gas.json
POOL_AUTHORITY_KEYPAIR_PATH=$KEYS/hock-devnet-pool-authority.json
DATABASE_URL=$DB
SYNTHETIC_MARKETS=true
GATE_INTERVAL_SECONDS=20
FEED_TARGET_INTERVAL_SECONDS=30
WATCHER_INTERVAL_SECONDS=5
RECONCILER_INTERVAL_SECONDS=30
HEALTH_PORT=3001
COSIGN_PORT=3002
HOCK_ALLOWED_ORIGINS=http://127.0.0.1:3010,http://localhost:3010
ENV
cat > web/.env.local <<ENV
NEXT_PUBLIC_HOCK_CLUSTER=devnet
NEXT_PUBLIC_PROGRAM_ID=$PROGRAM_ID
NEXT_PUBLIC_POOL_PDA=$POOL_PDA
NEXT_PUBLIC_COSIGN_URL=http://127.0.0.1:3002
NEXT_PUBLIC_SITE_URL=http://localhost:3010
NEXT_PUBLIC_DEMO_WALLET=false
DATABASE_URL=$DB
RPC_PROXY_UPSTREAM=$RPC
SOLANA_RPC_URL=$RPC
ENV

# 5. fresh database for the new cluster (a local Postgres is throwaway; the engine re-applies its migrations on boot)
if [[ "$DB" == *127.0.0.1:5432* ]]; then bash scripts/local-pg.sh up >/dev/null && bash scripts/local-pg.sh reset; fi

# 6. restart engine and web
pkill -f "node src/index.js" || true; pkill -f "next start" || true; sleep 1
# the engine exits 1 on a stall so a supervisor can restart it; this loop is that supervisor for a laptop
(cd engine && nohup sh -c 'until node src/index.js; do echo "[supervisor] engine exited $?; restarting in 3s"; sleep 3; done' > /tmp/hock-engine.out 2>&1 &)
(cd web && npx next build > /tmp/hock-web-build.log 2>&1 && nohup npx next start -p 3010 > /tmp/hock-web-prod.out 2>&1 &)
sleep 12; grep -E "preflight\] FAIL|all loops started" /tmp/hock-engine.out || true
echo "devnet up: program $PROGRAM_ID pool $POOL_PDA site http://localhost:3010 (open it with Phantom set to devnet)"
