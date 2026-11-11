/**
 * Server-side reads for the site. Everything shown to users comes from here:
 * the gate rows in Postgres (written by the engine) and pool state on chain.
 * Nothing in this file returns a hard-coded figure; when a source is
 * unavailable the caller renders a dash, never a made-up number.
 */
import { Pool } from "pg";
import { pgSsl } from "@/lib/data/pg-ssl";

type BoardRow = {
  mint: string;
  name: string;
  symbol: string;
  age: string;
  marketCap: string | null;
  liquidity: string | null;
  verdictClass: "ready" | "grading" | "launched" | "delisted";
  verdictLabel: string;
  ltv: string | null;
  borrowable: string | null;
};

let pool: Pool | null = null;
function db(): Pool | null {
  const url = process.env.DATABASE_URL_READONLY || process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) pool = new Pool({ connectionString: url, max: 4, ssl: pgSsl(url) });
  return pool;
}

const TIERS = [
  { label: "2-day pool", fee: "3%", ltv: "30%" },
  { label: "3-day pool", fee: "2%", ltv: "25%" },
  { label: "7-day pool", fee: "1.5%", ltv: "20%" },
];

export function ago(d: Date): string {
  const s = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

function usd(n: number | string | null | undefined): string | null {
  if (n === null || n === undefined) return null;
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

export async function getBoard(limit = 50): Promise<BoardRow[]> {
  const p = db();
  if (!p) return [];
  try {
    const { rows } = await p.query(
      `SELECT m.mint, m.name, m.symbol, m.created_at, g.verdict, g.liquidity_ok, g.velocity_ok, g.routability_ok, g.holders_ok, g.extensions_ok,
              g.liquidity_usd, g.volume_24h_usd, g.route_quote_sol
         FROM mints m LEFT JOIN gate_state g ON g.mint = m.mint
        WHERE m.launched_here = true
        ORDER BY m.created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map((r) => {
      const checks = [r.liquidity_ok, r.velocity_ok, r.routability_ok, r.holders_ok, r.extensions_ok].filter(Boolean).length;
      const verdict: string = r.verdict ?? "launched";
      const map: Record<string, [BoardRow["verdictClass"], string]> = {
        collateral_ready: ["ready", "Collateral ready"],
        grading: ["grading", `Gate ${checks} of 5`],
        launched: ["launched", "Launched"],
        delisted: ["delisted", "Delisted"],
      };
      const [verdictClass, verdictLabel] = map[verdict] ?? map.launched;
      return {
        mint: r.mint,
        name: r.name,
        symbol: r.symbol,
        age: ago(new Date(r.created_at)),
        marketCap: null, // filled by the coin page from DexScreener at request time
        liquidity: usd(r.liquidity_usd),
        verdictClass,
        verdictLabel,
        ltv: verdictClass === "ready" ? "30%" : null,
        borrowable: verdictClass === "ready" && r.route_quote_sol ? `${(Number(r.route_quote_sol) * 0.3).toFixed(2)} SOL` : null,
      };
    });
  } catch {
    return [];
  }
}

export async function getPoolSummary(): Promise<{ tiers: { label: string; fee: string; ltv: string; apy: string | null }[]; totalSol: string | null }> {
  const p = db();
  let totalSol: string | null = null;
  const apy: (string | null)[] = [null, null, null];
  if (p) {
    try {
      const { rows } = await p.query(
        `SELECT total_deposits, total_borrowed, accrued_fees, at FROM pool_snapshots ORDER BY at DESC LIMIT 1`,
      );
      if (rows[0]) {
        totalSol = `${(Number(rows[0].total_deposits) / 1e9).toFixed(2)} SOL`;
        // Realised yield: fees accrued over the trailing 30 days annualised against deposits. Computed, never typed.
        const { rows: hist } = await p.query(
          `SELECT accrued_fees, total_deposits, at FROM pool_snapshots WHERE at > now() - interval '30 days' ORDER BY at ASC LIMIT 1`,
        );
        if (hist[0] && Number(rows[0].total_deposits) > 0) {
          const days = Math.max(1, (new Date(rows[0].at).getTime() - new Date(hist[0].at).getTime()) / 86400000);
          const fees = Number(rows[0].accrued_fees) - Number(hist[0].accrued_fees);
          const yr = (fees / Number(rows[0].total_deposits)) * (365 / days) * 100;
          const s = `${yr.toFixed(1)}%`;
          apy[0] = apy[1] = apy[2] = s; // single pool in v1; per-tier split arrives with per-tier pools
        }
      }
    } catch {
      /* render dashes */
    }
  }
  return { tiers: TIERS.map((t, i) => ({ ...t, apy: apy[i] })), totalSol };
}

// ---------------------------------------------------------------------------
// Coin page + lend page reads (added with the borrow/lend build).
// ---------------------------------------------------------------------------

export type GateCheck = { key: string; label: string; ok: boolean; detail: string | null };

export type CoinRow = {
  mint: string;
  name: string;
  symbol: string;
  decimals: number;
  tokenProgram: string;
  imageUrl: string | null;
  createdAt: string;
  launchedHere: boolean;
  verdict: "launched" | "grading" | "collateral_ready" | "delisted";
  verdictClass: BoardRow["verdictClass"];
  verdictLabel: string;
  checks: GateCheck[];
  consecutivePasses: number;
  reason: string | null;
  gradedAt: string | null;
  liquidity: string | null;
  volume24h: string | null;
  routeQuoteSol: string | null;
};

export async function getCoin(mint: string): Promise<CoinRow | null> {
  const p = db();
  if (!p) return null;
  try {
    const { rows } = await p.query(
      `SELECT m.mint, m.name, m.symbol, m.decimals, m.token_program, m.image_url, m.created_at, m.launched_here,
              g.verdict, g.liquidity_ok, g.velocity_ok, g.routability_ok, g.holders_ok, g.extensions_ok, g.consecutive_passes,
              g.liquidity_usd, g.volume_24h_usd, g.volume_1h_usd, g.route_quote_sol, g.top10_holder_pct, g.reason, g.graded_at
         FROM mints m LEFT JOIN gate_state g ON g.mint = m.mint
        WHERE m.mint = $1`,
      [mint],
    );
    const r = rows[0];
    if (!r) return null;
    const verdict: CoinRow["verdict"] = r.verdict ?? "launched";
    const cls: Record<CoinRow["verdict"], [BoardRow["verdictClass"], string]> = {
      collateral_ready: ["ready", "Collateral ready"],
      grading: ["grading", "Grading"],
      launched: ["launched", "Launched"],
      delisted: ["delisted", "Delisted"],
    };
    const [verdictClass, verdictLabel] = cls[verdict];
    const checks: GateCheck[] = [
      { key: "liquidity", label: "Pooled liquidity", ok: !!r.liquidity_ok, detail: usd(r.liquidity_usd) },
      { key: "velocity", label: "Trading velocity", ok: !!r.velocity_ok, detail: r.volume_24h_usd != null ? `${usd(r.volume_24h_usd)} / 24h` : null },
      { key: "routability", label: "Routability at loan size", ok: !!r.routability_ok, detail: r.route_quote_sol != null ? `${Number(r.route_quote_sol).toFixed(3)} SOL quote` : null },
      { key: "holders", label: "Holder concentration", ok: !!r.holders_ok, detail: r.top10_holder_pct != null ? `top 10 hold ${Number(r.top10_holder_pct).toFixed(1)}%` : null },
      { key: "extensions", label: "Token program extensions", ok: !!r.extensions_ok, detail: r.token_program === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" ? "Token-2022" : "SPL Token" },
    ];
    return {
      mint: r.mint,
      name: r.name,
      symbol: r.symbol,
      decimals: Number(r.decimals),
      tokenProgram: r.token_program,
      imageUrl: r.image_url ?? null,
      createdAt: new Date(r.created_at).toISOString(),
      launchedHere: !!r.launched_here,
      verdict,
      verdictClass,
      verdictLabel,
      checks,
      consecutivePasses: Number(r.consecutive_passes ?? 0),
      reason: r.reason ?? null,
      gradedAt: r.graded_at ? new Date(r.graded_at).toISOString() : null,
      liquidity: usd(r.liquidity_usd),
      volume24h: usd(r.volume_24h_usd),
      routeQuoteSol: r.route_quote_sol != null ? Number(r.route_quote_sol).toFixed(3) : null,
    };
  } catch {
    return null;
  }
}

/** Collateral-ready mints (for matching against a wallet's token accounts). */
export async function getCollateralReadyMints(): Promise<{ mint: string; name: string; symbol: string; decimals: number }[]> {
  const p = db();
  if (!p) return [];
  try {
    const { rows } = await p.query(
      `SELECT m.mint, m.name, m.symbol, m.decimals FROM mints m JOIN gate_state g ON g.mint = m.mint WHERE g.verdict = 'collateral_ready' ORDER BY g.promoted_at DESC NULLS LAST LIMIT 500`,
    );
    return rows.map((r) => ({ mint: r.mint, name: r.name, symbol: r.symbol, decimals: Number(r.decimals) }));
  } catch {
    return [];
  }
}

export type PoolYield = {
  /** Annualised realised fee yield over the trailing window, as a percent string, or null. */
  apy: string | null;
  windowDays: number | null;
  feesLamports: string | null;
  snapshotAt: string | null;
  points: { at: string; deposits: string; borrowed: string }[];
};

/** Realised yield from pool_snapshots (engine-written); null fields when there is no history. */
export async function getPoolYield(poolPda?: string | null): Promise<PoolYield> {
  const empty: PoolYield = { apy: null, windowDays: null, feesLamports: null, snapshotAt: null, points: [] };
  const p = db();
  if (!p) return empty;
  try {
    const where = poolPda ? `WHERE pool_pda = $1` : ``;
    const args = poolPda ? [poolPda] : [];
    const { rows: latest } = await p.query(`SELECT total_deposits, total_borrowed, accrued_fees, at FROM pool_snapshots ${where} ORDER BY at DESC LIMIT 1`, args);
    if (!latest[0]) return empty;
    const { rows: first } = await p.query(
      `SELECT total_deposits, accrued_fees, at FROM pool_snapshots ${where ? where + " AND" : "WHERE"} at > now() - interval '30 days' ORDER BY at ASC LIMIT 1`,
      args,
    );
    const { rows: pts } = await p.query(
      `SELECT total_deposits, total_borrowed, at FROM pool_snapshots ${where ? where + " AND" : "WHERE"} at > now() - interval '30 days' ORDER BY at ASC LIMIT 2000`,
      args,
    );
    const points = pts.map((r) => ({ at: new Date(r.at).toISOString(), deposits: String(r.total_deposits), borrowed: String(r.total_borrowed) }));
    let apy: string | null = null;
    let windowDays: number | null = null;
    let fees: string | null = null;
    if (first[0] && Number(latest[0].total_deposits) > 0) {
      const days = Math.max(1 / 24, (new Date(latest[0].at).getTime() - new Date(first[0].at).getTime()) / 86400000);
      const f = Number(latest[0].accrued_fees) - Number(first[0].accrued_fees);
      if (f >= 0 && days >= 1) {
        apy = `${((f / Number(latest[0].total_deposits)) * (365 / days) * 100).toFixed(2)}%`;
        windowDays = Math.round(days);
        fees = String(f);
      }
    }
    return { apy, windowDays, feesLamports: fees, snapshotAt: new Date(latest[0].at).toISOString(), points };
  } catch {
    return empty;
  }
}
