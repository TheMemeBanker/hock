#!/usr/bin/env bash
# Wire the $HOCK mint into hock.fun: verify on-chain, set lib/token.ts, commit, push (Pages deploys main), poll live.
set -euo pipefail
LINK="${1:?usage: scripts/wire-hock.sh <pump.fun link or mint>}"
MINT=$(echo "$LINK" | grep -oE '[1-9A-HJ-NP-Za-km-z]{32,44}' | tail -1)
echo "mint: $MINT"
INFO=$(curl -s -m 20 https://api.mainnet-beta.solana.com -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$MINT\",{\"encoding\":\"jsonParsed\"}]}")
echo "$INFO" | python3 -c 'import sys,json;v=json.load(sys.stdin)["result"]["value"]; assert v and v["data"]["parsed"]["type"]=="mint", "not a mint"; i=v["data"]["parsed"]["info"]; print("owner",v["owner"][:12],"decimals",i["decimals"],"supply",i["supply"],"mintAuthority",i.get("mintAuthority"),"freezeAuthority",i.get("freezeAuthority"))'
DEX=$(curl -s -m 20 "https://api.dexscreener.com/latest/dex/tokens/$MINT")
echo "$DEX" | python3 -c 'import sys,json;d=json.load(sys.stdin);ps=d.get("pairs") or [];print("dexscreener pairs:",len(ps)); [print(" ",p["dexId"],p["baseToken"]["symbol"],p["baseToken"]["name"],"mc",p.get("marketCap"),"liq",(p.get("liquidity") or {}).get("usd")) for p in ps[:3]]'
read -r -p "Wire this mint into hock.fun? [y/N] " ok; [ "$ok" = "y" ] || { echo "aborted"; exit 1; }
cd "$(dirname "$0")/.." && git pull -q --rebase origin main
sed -i '' -E "s|^export const HOCK_CA = \"[^\"]*\";|export const HOCK_CA = \"$MINT\";|" web/lib/token.ts
grep -n "HOCK_CA = " web/lib/token.ts
git add web/lib/token.ts && git commit -q -m "Wire \$HOCK: $MINT

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>" && git push -q origin main && echo pushed
for i in $(seq 1 40); do sleep 15; curl -s -m 15 "https://hock.fun/?$(date +%s)" | grep -q "$MINT" && { echo "live after $((i*15))s"; exit 0; }; done
echo "not live yet; check the pages workflow: gh run list -R TheMemeBanker/hock -w pages.yml -L 3"
