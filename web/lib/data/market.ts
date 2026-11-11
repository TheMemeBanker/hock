/**
 * Live market data from DexScreener, read server-side at request time and
 * cached for 10 s by Next. Never a fallback figure: when there is no pair
 * (every devnet coin, and any mainnet coin before its first pool) the caller
 * gets null and renders a dash. Market cap is DexScreener's marketCap when
 * present, else fdv (identical for fixed-supply pump coins).
 */
const BASE = process.env.DEXSCREENER_URL || "https://api.dexscreener.com";
const SOL = "So11111111111111111111111111111111111111112";

export type Market = {
  priceUsd: number | null;
  priceSol: number | null;
  marketCapUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  change24hPct: number | null;
  dex: string | null;
  pairUrl: string | null;
  pairs: number;
};

type Pair = {
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceUsd?: string;
  priceNative?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  dexId?: string;
  url?: string;
};

function summarise(mint: string, raw: unknown): Market | null {
  const pairs = (Array.isArray(raw) ? raw : []).filter((p: Pair) => p?.baseToken?.address === mint) as Pair[];
  if (!pairs.length) return null;
  let best: Pair | null = null;
  let liq = 0, vol = 0;
  for (const p of pairs) {
    liq += Number(p.liquidity?.usd ?? 0);
    vol += Number(p.volume?.h24 ?? 0);
    if (!best || Number(p.liquidity?.usd ?? 0) > Number(best.liquidity?.usd ?? 0)) best = p;
  }
  if (!best) return null;
  const n = (x: unknown) => { const v = Number(x); return Number.isFinite(v) && v > 0 ? v : null; };
  return {
    priceUsd: n(best.priceUsd),
    priceSol: best.quoteToken?.address === SOL ? n(best.priceNative) : null,
    marketCapUsd: n(best.marketCap) ?? n(best.fdv),
    liquidityUsd: liq > 0 ? liq : null,
    volume24hUsd: vol > 0 ? vol : null,
    change24hPct: best.priceChange?.h24 == null ? null : Number(best.priceChange.h24),
    dex: best.dexId ?? null,
    pairUrl: best.url ?? null,
    pairs: pairs.length,
  };
}

export async function getMarket(mint: string): Promise<Market | null> {
  try {
    const r = await fetch(`${BASE}/token-pairs/v1/solana/${mint}`, { next: { revalidate: 10 }, headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return summarise(mint, await r.json());
  } catch {
    return null;
  }
}

/** Up to 30 mints per DexScreener call; returns a map mint -> Market|null. */
export async function getMarkets(mints: string[]): Promise<Map<string, Market | null>> {
  const out = new Map<string, Market | null>();
  const uniq = [...new Set(mints)];
  for (let i = 0; i < uniq.length; i += 30) {
    const chunk = uniq.slice(i, i + 30);
    try {
      const r = await fetch(`${BASE}/tokens/v1/solana/${chunk.join(",")}`, { next: { revalidate: 10 }, headers: { accept: "application/json" } });
      const raw = r.ok ? await r.json() : [];
      for (const m of chunk) out.set(m, summarise(m, raw));
    } catch {
      for (const m of chunk) out.set(m, null);
    }
  }
  return out;
}
