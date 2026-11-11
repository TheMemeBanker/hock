/**
 * Synthetic markets (devnet/localnet only).
 *
 * SYNTHETIC_MARKETS=true makes the gate and the attestor read synthetic_markets
 * rows instead of DexScreener and Jupiter. It exists so the whole lifecycle
 * (launch -> gate -> feed -> borrow -> fire -> liquidate) can be driven on a
 * cluster with no real markets. assertSyntheticAllowed() is called at boot and
 * on every use; it throws on mainnet-beta so the flag can never leak into
 * production through a copied .env.
 */
import { query } from "../db/pool.js";

export function syntheticEnabled() {
  return String(process.env.SYNTHETIC_MARKETS || "").toLowerCase() === "true";
}

export function assertSyntheticAllowed() {
  if (!syntheticEnabled()) return;
  const cluster = String(process.env.HOCK_CLUSTER || "");
  if (cluster === "mainnet-beta" || cluster === "") {
    throw new Error(`SYNTHETIC_MARKETS=true is refused on cluster "${cluster || "unset"}"; devnet and localnet only`);
  }
}

/** Returns the synthetic row for a mint, or null when synthetic mode is off or no row exists. */
export async function syntheticMarket(mint) {
  if (!syntheticEnabled()) return null;
  assertSyntheticAllowed();
  const { rows } = await query(`SELECT * FROM synthetic_markets WHERE mint = $1`, [mint]);
  const r = rows[0];
  if (!r) return null;
  return {
    mint: r.mint,
    priceLamports: BigInt(r.price_lamports_per_whole),
    liquidityUsd: Number(r.liquidity_usd),
    volume24hUsd: Number(r.volume_24h_usd),
    volume1hUsd: Number(r.volume_1h_usd),
    routeOk: !!r.route_ok,
    routeImpactBps: Number(r.route_impact_bps),
    holdersPctOverride: r.holders_pct_override == null ? null : Number(r.holders_pct_override),
    driftBpsPerTick: Number(r.drift_bps_per_tick) || 0,
    note: r.note || null,
  };
}

/** Random walk inside +/- drift bps so TWAP and pump-guard paths see realistic motion; persisted so the walk is continuous. */
export async function syntheticTickPrice(row) {
  if (!row.driftBpsPerTick) return row.priceLamports;
  const bps = BigInt(Math.round((Math.random() * 2 - 1) * row.driftBpsPerTick));
  let next = row.priceLamports + (row.priceLamports * bps) / 10_000n;
  if (next < 1n) next = 1n;
  await query(`UPDATE synthetic_markets SET price_lamports_per_whole = $2, updated_at = now() WHERE mint = $1`, [row.mint, next.toString()]);
  return next;
}
