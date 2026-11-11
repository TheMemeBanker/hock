/**
 * Gate loop: grades every HOCK-launched mint each GATE_INTERVAL_SECONDS.
 *
 * Checks
 *   liquidity_ok   sum(liquidity.usd) over DexScreener pairs >= GATE_MIN_LIQUIDITY_USD
 *   velocity_ok    volume.h24 >= GATE_MIN_VOLUME_24H_USD and volume.h1 >= GATE_MIN_VOLUME_1H_USD
 *   routability_ok Jupiter quote selling GATE_REFERENCE_SELL_SOL worth of the token
 *                  succeeds with priceImpactPct*1e4 <= GATE_MAX_IMPACT_BPS
 *   holders_ok     top-10 non-pool holders (getTokenLargestAccounts, excluding
 *                  pair addresses, off-curve owners i.e. PDAs/vaults, and
 *                  GATE_EXCLUDED_HOLDERS) hold <= GATE_MAX_TOP10_PCT of supply
 *   extensions_ok  Token-2022 extensions contain none of PermanentDelegate,
 *                  TransferHook, NonTransferable, DefaultAccountState=frozen;
 *                  plain SPL passes.
 *
 * Verdict machine
 *   launched -> grading on first grade
 *   grading/delisted -> collateral_ready after two consecutive full passes
 *   any failure -> consecutive_passes = 0; collateral_ready -> delisted (reason)
 * Every cycle writes gate_passes and updates gate_state; promote/delist enqueue
 * an outbox item for the launcher wallet.
 */
import { PublicKey } from "@solana/web3.js";
import {
  AccountState,
  ExtensionType,
  getDefaultAccountState,
  getExtensionTypes,
  getMint,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { query } from "../db/pool.js";
import { enqueueOutbox } from "../notify/outbox.js";
import { heartbeat, registerLoop, setGauge } from "../health/liveness.js";
import { cachedJson } from "../price/http-cache.js";
import { jupiterQuote } from "../price/pricing.js";
import { connection, mintTokenProgram } from "../chain/program.js";

const INTERVAL_MS = (Number(process.env.GATE_INTERVAL_SECONDS) || 60) * 1000;
const MIN_LIQ = Number(process.env.GATE_MIN_LIQUIDITY_USD) || 15_000;
const MIN_V24 = Number(process.env.GATE_MIN_VOLUME_24H_USD) || 25_000;
const MIN_V1 = Number(process.env.GATE_MIN_VOLUME_1H_USD) || 1_000;
const REF_SELL_SOL = Number(process.env.GATE_REFERENCE_SELL_SOL) || 1;
const MAX_IMPACT_BPS = Number(process.env.GATE_MAX_IMPACT_BPS) || 500;
const MAX_TOP10_PCT = Number(process.env.GATE_MAX_TOP10_PCT) || 40;
const PASSES_TO_PROMOTE = Number(process.env.GATE_PASSES_TO_PROMOTE) || 2;
const EXCLUDED = new Set((process.env.GATE_EXCLUDED_HOLDERS || "").split(",").map((s) => s.trim()).filter(Boolean));
const DEXSCREENER_URL = process.env.DEXSCREENER_URL || "https://api.dexscreener.com";
const SOL_MINT = "So11111111111111111111111111111111111111112";

let _timer = null;
let _running = false;

async function dexPairs(mint) {
  const data = await cachedJson(`${DEXSCREENER_URL}/token-pairs/v1/solana/${mint}`, { ttlMs: 20_000 });
  return Array.isArray(data) ? data.filter((p) => p?.baseToken?.address === mint) : [];
}

export function gradeMarket(pairs) {
  let liq = 0, v24 = 0, v1 = 0, priceNative = 0, bestLiq = -1;
  const pairAddresses = [];
  for (const p of pairs) {
    liq += Number(p?.liquidity?.usd ?? 0);
    v24 += Number(p?.volume?.h24 ?? 0);
    v1 += Number(p?.volume?.h1 ?? 0);
    if (p?.pairAddress) pairAddresses.push(p.pairAddress);
    const l = Number(p?.liquidity?.usd ?? 0);
    if (l > bestLiq && parseFloat(p?.priceNative ?? 0) > 0) { bestLiq = l; priceNative = parseFloat(p.priceNative); }
  }
  return { liquidity_usd: liq, volume_24h_usd: v24, volume_1h_usd: v1, price_sol_per_whole: priceNative, pairAddresses };
}

async function checkRoutability(mint, decimals, priceSolPerWhole) {
  if (!(priceSolPerWhole > 0)) return { ok: false, detail: "no_price_for_sizing" };
  const tokens = REF_SELL_SOL / priceSolPerWhole;
  const amountRaw = BigInt(Math.floor(tokens * 10 ** decimals));
  if (amountRaw <= 0n) return { ok: false, detail: "reference_size_rounds_to_zero" };
  try {
    const q = await jupiterQuote({ inputMint: mint, outputMint: SOL_MINT, amountRaw: amountRaw.toString(), slippageBps: 300 });
    const impactBps = Math.round(Number(q.route?.priceImpactPct ?? 0) * 10_000);
    const outSol = Number(q.outAmountLamports) / 1e9;
    return { ok: impactBps <= MAX_IMPACT_BPS, impact_bps: impactBps, route_quote_sol: outSol, detail: impactBps > MAX_IMPACT_BPS ? `impact ${impactBps}bps > ${MAX_IMPACT_BPS}` : null };
  } catch (err) {
    return { ok: false, detail: `quote_failed: ${err.message?.slice(0, 80)}` };
  }
}

async function checkHolders(conn, mint, supply, pairAddresses) {
  const largest = await conn.getTokenLargestAccounts(new PublicKey(mint), "confirmed");
  const accounts = largest.value || [];
  if (accounts.length === 0) return { ok: false, pct: 100, detail: "no_holders" };
  const infos = await conn.getMultipleParsedAccounts(accounts.map((a) => a.address), { commitment: "confirmed" });
  const excluded = new Set([...EXCLUDED, ...pairAddresses]);
  let top = 0n, counted = 0;
  for (let i = 0; i < accounts.length && counted < 10; i++) {
    const parsed = infos.value[i]?.data?.parsed?.info;
    const owner = parsed?.owner;
    if (!owner) continue;
    if (excluded.has(owner)) continue;
    let onCurve = true;
    try { onCurve = PublicKey.isOnCurve(new PublicKey(owner).toBytes()); } catch { onCurve = true; }
    if (!onCurve) continue; // PDA-owned = pool / vault / program custody
    top += BigInt(accounts[i].amount);
    counted++;
  }
  const pct = supply > 0n ? Number((top * 100_000n) / supply) / 1000 : 100;
  return { ok: pct <= MAX_TOP10_PCT, pct, detail: pct > MAX_TOP10_PCT ? `top10 ${pct.toFixed(2)}% > ${MAX_TOP10_PCT}%` : null };
}

export function auditExtensions(mintInfo, tokenProgram) {
  if (!tokenProgram.equals(TOKEN_2022_PROGRAM_ID)) return { ok: true, extensions: [] };
  const types = getExtensionTypes(mintInfo.tlvData);
  const names = types.map((t) => ExtensionType[t] ?? String(t));
  const bad = [];
  if (types.includes(ExtensionType.PermanentDelegate)) bad.push("PermanentDelegate");
  if (types.includes(ExtensionType.TransferHook)) bad.push("TransferHook");
  if (types.includes(ExtensionType.NonTransferable)) bad.push("NonTransferable");
  if (types.includes(ExtensionType.DefaultAccountState)) {
    const st = getDefaultAccountState(mintInfo);
    if (st && st.state === AccountState.Frozen) bad.push("DefaultAccountState=frozen");
  }
  return { ok: bad.length === 0, extensions: names, detail: bad.length ? bad.join(",") : null };
}

export async function gradeMint(conn, mintRow) {
  const mint = mintRow.mint;
  const tokenProgram = await mintTokenProgram(conn, mint);
  const mintInfo = await getMint(conn, new PublicKey(mint), "confirmed", tokenProgram);
  const pairs = await dexPairs(mint).catch(() => []);
  const market = gradeMarket(pairs);
  const [route, holders] = await Promise.all([
    checkRoutability(mint, mintInfo.decimals, market.price_sol_per_whole),
    checkHolders(conn, mint, BigInt(mintInfo.supply.toString()), market.pairAddresses).catch((e) => ({ ok: false, pct: null, detail: `holders_failed: ${e.message?.slice(0, 60)}` })),
  ]);
  const ext = auditExtensions(mintInfo, tokenProgram);
  const checks = {
    liquidity_ok: market.liquidity_usd >= MIN_LIQ,
    velocity_ok: market.volume_24h_usd >= MIN_V24 && market.volume_1h_usd >= MIN_V1,
    routability_ok: route.ok,
    holders_ok: holders.ok,
    extensions_ok: ext.ok,
    liquidity_usd: market.liquidity_usd,
    volume_24h_usd: market.volume_24h_usd,
    volume_1h_usd: market.volume_1h_usd,
    route_quote_sol: route.route_quote_sol ?? null,
    route_impact_bps: route.impact_bps ?? null,
    top10_holder_pct: holders.pct,
    extensions: ext.extensions,
    pairs: pairs.length,
    thresholds: { MIN_LIQ, MIN_V24, MIN_V1, REF_SELL_SOL, MAX_IMPACT_BPS, MAX_TOP10_PCT },
  };
  const failures = [];
  if (!checks.liquidity_ok) failures.push(`liquidity ${Math.round(market.liquidity_usd)} < ${MIN_LIQ}`);
  if (!checks.velocity_ok) failures.push(`volume 24h ${Math.round(market.volume_24h_usd)} / 1h ${Math.round(market.volume_1h_usd)} below ${MIN_V24}/${MIN_V1}`);
  if (!checks.routability_ok) failures.push(`routability: ${route.detail}`);
  if (!checks.holders_ok) failures.push(`holders: ${holders.detail}`);
  if (!checks.extensions_ok) failures.push(`extensions: ${ext.detail}`);
  return { checks, pass: failures.length === 0, reason: failures.join("; ") || null };
}

export function nextVerdict(current, consecutive, pass) {
  if (pass) {
    const n = consecutive + 1;
    if (n >= PASSES_TO_PROMOTE) return { verdict: "collateral_ready", consecutive: n };
    return { verdict: current === "collateral_ready" ? "collateral_ready" : current === "launched" ? "grading" : current, consecutive: n };
  }
  if (current === "collateral_ready") return { verdict: "delisted", consecutive: 0 };
  if (current === "launched") return { verdict: "grading", consecutive: 0 };
  return { verdict: current, consecutive: 0 };
}

async function persist(mintRow, state, grade, verdict) {
  const c = grade.checks;
  await query(
    `INSERT INTO gate_state (mint, verdict, liquidity_ok, velocity_ok, routability_ok, holders_ok, extensions_ok, consecutive_passes,
        liquidity_usd, volume_24h_usd, volume_1h_usd, route_quote_sol, top10_holder_pct, reason, graded_at, promoted_at, delisted_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now(),
        CASE WHEN $2 = 'collateral_ready' AND $15 <> 'collateral_ready' THEN now() ELSE NULL END,
        CASE WHEN $2 = 'delisted' THEN now() ELSE NULL END, now())
     ON CONFLICT (mint) DO UPDATE SET
        verdict = EXCLUDED.verdict, liquidity_ok = EXCLUDED.liquidity_ok, velocity_ok = EXCLUDED.velocity_ok,
        routability_ok = EXCLUDED.routability_ok, holders_ok = EXCLUDED.holders_ok, extensions_ok = EXCLUDED.extensions_ok,
        consecutive_passes = EXCLUDED.consecutive_passes, liquidity_usd = EXCLUDED.liquidity_usd,
        volume_24h_usd = EXCLUDED.volume_24h_usd, volume_1h_usd = EXCLUDED.volume_1h_usd,
        route_quote_sol = EXCLUDED.route_quote_sol, top10_holder_pct = EXCLUDED.top10_holder_pct,
        reason = EXCLUDED.reason, graded_at = now(),
        promoted_at = CASE WHEN EXCLUDED.verdict = 'collateral_ready' AND gate_state.verdict <> 'collateral_ready' THEN now() ELSE gate_state.promoted_at END,
        delisted_at = CASE WHEN EXCLUDED.verdict = 'delisted' AND gate_state.verdict <> 'delisted' THEN now() ELSE gate_state.delisted_at END,
        updated_at = now()`,
    [mintRow.mint, verdict.verdict, c.liquidity_ok, c.velocity_ok, c.routability_ok, c.holders_ok, c.extensions_ok, verdict.consecutive,
      c.liquidity_usd, c.volume_24h_usd, c.volume_1h_usd, c.route_quote_sol, c.top10_holder_pct, grade.reason, state.verdict],
  );
  await query(`INSERT INTO gate_passes (mint, verdict, checks) VALUES ($1,$2,$3::jsonb)`, [mintRow.mint, verdict.verdict, JSON.stringify({ ...c, pass: grade.pass, reason: grade.reason })]);
}

export async function runOnce() {
  const conn = connection();
  const { rows } = await query(
    `SELECT m.mint, m.symbol, m.launcher, COALESCE(g.verdict, 'launched') AS verdict, COALESCE(g.consecutive_passes, 0) AS consecutive_passes
       FROM mints m LEFT JOIN gate_state g ON g.mint = m.mint
      WHERE m.launched_here = true ORDER BY m.created_at`,
  );
  let promoted = 0, delisted = 0, failed = 0;
  for (const row of rows) {
    try {
      const grade = await gradeMint(conn, row);
      const verdict = nextVerdict(row.verdict, Number(row.consecutive_passes), grade.pass);
      await persist(row, row, grade, verdict);
      if (verdict.verdict === "collateral_ready" && row.verdict !== "collateral_ready") {
        promoted++;
        if (row.launcher) await enqueueOutbox({ wallet: row.launcher, kind: "gate_promoted", payload: { mint: row.mint, symbol: row.symbol, checks: grade.checks } });
      } else if (verdict.verdict === "delisted" && row.verdict !== "delisted") {
        delisted++;
        if (row.launcher) await enqueueOutbox({ wallet: row.launcher, kind: "gate_delisted", payload: { mint: row.mint, symbol: row.symbol, reason: grade.reason } });
      }
    } catch (err) {
      failed++;
      console.warn(`[gate] ${row.mint.slice(0, 8)} grade failed: ${err.message?.slice(0, 160)}`);
    }
  }
  setGauge("gate_mints", rows.length);
  heartbeat("gate", failed === rows.length && rows.length > 0 ? "error" : "ok", { mints: rows.length, promoted, delisted, failed });
}

export function startGate() {
  registerLoop("gate", { intervalMs: INTERVAL_MS });
  const tick = async () => {
    if (_running) return;
    _running = true;
    try { await runOnce(); }
    catch (err) { heartbeat("gate", "error", { error: err.message?.slice(0, 200) }); console.error(`[gate] tick failed: ${err.message}`); }
    finally { _running = false; }
  };
  setTimeout(tick, 2_000 + Math.random() * 5_000);
  _timer = setInterval(tick, INTERVAL_MS);
  console.log(`[gate] started; every ${INTERVAL_MS / 1000}s; thresholds liq>=${MIN_LIQ} v24>=${MIN_V24} v1>=${MIN_V1} impact<=${MAX_IMPACT_BPS}bps top10<=${MAX_TOP10_PCT}%`);
}

export function stopGate() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
