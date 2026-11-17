#!/usr/bin/env bash
# Build the static (cosmetic) copy of the HOCK site for GitHub Pages.
# Works in place: the server-only parts (API routes, the /borrow redirect, ISR revalidation) are set aside,
# `next build` runs with STATIC_EXPORT=1, and the tree is restored on exit. Output: <outdir> (default ./out-static)
#   bash scripts/static-export.sh [outdir]          (from web/)
set -euo pipefail
cd "$(dirname "$0")/.."
OUT="${1:-./out-static}"
SAVE="$(mktemp -d)"
restore() {
  [ -d "$SAVE/api" ] && rm -rf app/api && mv "$SAVE/api" app/api
  [ -d "$SAVE/borrow" ] && rm -rf app/borrow && mv "$SAVE/borrow" app/borrow
  [ -d "$SAVE/coin" ] && rm -rf app/coin && mv "$SAVE/coin" app/coin
  [ -f "$SAVE/.env.local" ] && mv "$SAVE/.env.local" .env.local
  if [ -f "$SAVE/files.txt" ]; then while IFS= read -r f; do cp "$SAVE/files/$f" "$f"; done < "$SAVE/files.txt"; fi
  rm -rf "$SAVE"
}
trap restore EXIT
if sed --version >/dev/null 2>&1; then SEDI=(sed -i); else SEDI=(sed -i ''); fi
# coin pages are rendered per mint from the database; the static copy has no database, so it ships none
mv app/api "$SAVE/api"; mv app/borrow "$SAVE/borrow"; mv app/coin "$SAVE/coin"
# a laptop's .env.local would leak a local database into the static build
[ -f .env.local ] && mv .env.local "$SAVE/.env.local"
mkdir -p "$SAVE/files"; : > "$SAVE/files.txt"
while IFS= read -r f; do
  mkdir -p "$SAVE/files/$(dirname "$f")"; cp "$f" "$SAVE/files/$f"; echo "$f" >> "$SAVE/files.txt"
  "${SEDI[@]}" -E '/^export const revalidate = [0-9]+;$/d' "$f"
done < <(grep -rl -E '^export const revalidate = [0-9]+;$' app --include='page.tsx' || true)
export STATIC_EXPORT=1
export NEXT_PUBLIC_HOCK_CLUSTER="${NEXT_PUBLIC_HOCK_CLUSTER:-devnet}"
export NEXT_PUBLIC_SITE_URL="${NEXT_PUBLIC_SITE_URL:-https://hock.fun}"
export NEXT_PUBLIC_PROGRAM_ID="${NEXT_PUBLIC_PROGRAM_ID:-Cr61UnyT3EmbZLMawbwQksX6QgTrSgEWMxAWUbaYpgNb}"
export NEXT_PUBLIC_POOL_PDA="${NEXT_PUBLIC_POOL_PDA:-CtM7TjXbtLkM9rVLDcPdu4M4GFGXzu16ZrnF5jpsVbqb}"
export NEXT_PUBLIC_RPC_URL="${NEXT_PUBLIC_RPC_URL:-https://api.devnet.solana.com}"
export NEXT_PUBLIC_DEMO_WALLET=false
export NEXT_PUBLIC_BASE_PATH="${NEXT_PUBLIC_BASE_PATH:-}"
unset DATABASE_URL SOLANA_RPC_URL RPC_PROXY_UPSTREAM
rm -rf out .next
npx next build
rm -rf "$OUT" && mv out "$OUT"
touch "$OUT/.nojekyll"
[ -n "${PAGES_CNAME:-}" ] && echo "$PAGES_CNAME" > "$OUT/CNAME"
echo "static site at $OUT (basePath '${NEXT_PUBLIC_BASE_PATH}')"
