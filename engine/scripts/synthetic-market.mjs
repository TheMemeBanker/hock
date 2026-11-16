#!/usr/bin/env node
/**
 * Upsert / list / delete synthetic market rows (devnet and localnet only).
 *
 *   node scripts/synthetic-market.mjs set <mint> --price-sol 0.000002 --mcap 60000 --liq 50000 --v24 120000 --v1 6000 [--holders 12] [--impact 80] [--drift 25] [--note "..."]
 *   node scripts/synthetic-market.mjs list
 *   node scripts/synthetic-market.mjs rm <mint>
 *
 * --price-sol is SOL per WHOLE token; stored as lamports per whole token.
 * --holders overrides the top-10 holder percentage (omit to grade holders from chain).
 */
import "dotenv/config";
import { PublicKey } from "@solana/web3.js";
import { query, closeDb } from "../src/db/pool.js";
import { assertSyntheticAllowed } from "../src/synthetic/synthetic.js";

const [cmd, ...rest] = process.argv.slice(2);
const flags = {};
for (let i = 0; i < rest.length; i++) if (rest[i].startsWith("--")) { flags[rest[i].slice(2)] = rest[i + 1]; i++; }
const positional = rest.filter((a, i) => !a.startsWith("--") && !(i > 0 && rest[i - 1].startsWith("--")));

const cluster = process.env.HOCK_CLUSTER || "";
if (cluster === "mainnet-beta" || cluster === "") { console.error(`refused on cluster "${cluster || "unset"}"`); process.exit(2); }
process.env.SYNTHETIC_MARKETS = "true";
assertSyntheticAllowed();

try {
  if (cmd === "list") {
    const { rows } = await query(`SELECT s.*, m.symbol FROM synthetic_markets s JOIN mints m USING (mint) ORDER BY updated_at DESC`);
    for (const r of rows) console.log(`${r.mint}  ${r.symbol.padEnd(8)} ${Number(r.price_lamports_per_whole) / 1e9} SOL  liq $${r.liquidity_usd}  v24 $${r.volume_24h_usd}  v1 $${r.volume_1h_usd}  route=${r.route_ok}/${r.route_impact_bps}bps  holders=${r.holders_pct_override ?? "chain"}  drift=${r.drift_bps_per_tick}`);
    if (!rows.length) console.log("(no synthetic markets)");
  } else if (cmd === "rm") {
    const mint = new PublicKey(positional[0]).toBase58();
    const r = await query(`DELETE FROM synthetic_markets WHERE mint = $1`, [mint]);
    console.log(`removed ${r.rowCount} row(s) for ${mint}`);
  } else if (cmd === "set") {
    const mint = new PublicKey(positional[0]).toBase58();
    const priceSol = Number(flags["price-sol"]);
    if (!(priceSol > 0)) throw new Error("--price-sol must be > 0");
    const { rows: m } = await query(`SELECT mint FROM mints WHERE mint = $1`, [mint]);
    if (!m.length) throw new Error(`mint ${mint} is not registered in mints (launch it on the site or POST /api/mints/register first)`);
    const lamports = BigInt(Math.round(priceSol * 1e9)).toString();
    await query(
      `INSERT INTO synthetic_markets (mint, price_lamports_per_whole, liquidity_usd, volume_24h_usd, volume_1h_usd, route_ok, route_impact_bps, holders_pct_override, drift_bps_per_tick, note, market_cap_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (mint) DO UPDATE SET price_lamports_per_whole = EXCLUDED.price_lamports_per_whole, liquidity_usd = EXCLUDED.liquidity_usd, market_cap_usd = EXCLUDED.market_cap_usd,
         volume_24h_usd = EXCLUDED.volume_24h_usd, volume_1h_usd = EXCLUDED.volume_1h_usd, route_ok = EXCLUDED.route_ok,
         route_impact_bps = EXCLUDED.route_impact_bps, holders_pct_override = EXCLUDED.holders_pct_override,
         drift_bps_per_tick = EXCLUDED.drift_bps_per_tick, note = EXCLUDED.note, updated_at = now()`,
      [mint, lamports, Number(flags.liq ?? 0), Number(flags.v24 ?? 0), Number(flags.v1 ?? 0), flags.route !== "false", Number(flags.impact ?? 0),
       flags.holders == null ? null : Number(flags.holders), Number(flags.drift ?? 0), flags.note ?? null, Number(flags.mcap ?? 0)],
    );
    console.log(`set ${mint}: ${lamports} lamports/whole (${priceSol} SOL), liq $${flags.liq ?? 0}, v24 $${flags.v24 ?? 0}, v1 $${flags.v1 ?? 0}`);
  } else {
    console.error("usage: synthetic-market.mjs set <mint> --price-sol X [--mcap --liq --v24 --v1 --holders --impact --drift --route false --note] | list | rm <mint>");
    process.exit(1);
  }
} finally {
  await closeDb().catch(() => {});
}
