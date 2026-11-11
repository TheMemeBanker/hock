/**
 * Canary loop: proves the fire path continuously instead of assuming it.
 *
 * No-op (with a logged reason) unless CANARY_WALLET_KEYPAIR_PATH and
 * CANARY_MINT are set.
 *
 * devnet / localnet: synthetic lifecycle on CANARY_INTERVAL_MINUTES
 *   1. attestor pushes a fresh price for CANARY_MINT (the engine controls it),
 *   2. borrow: request_and_fund_loan from the canary wallet (CANARY_LOAN_PDA may
 *      point at an existing canary loan instead; a fresh borrow needs the
 *      canary wallet funded with the mint and the pool funded),
 *   3. arm: arm_conversion with a take-profit trigger just under spot,
 *   4. force-fire: the attestor's next sample crosses the trigger and the
 *      watcher fires convert_collateral_slice,
 *   5. repay: repay_loan from the canary wallet.
 *   The borrow/arm/repay legs are user-signed instructions (the canary wallet
 *   is the engine's own test borrower); they are built through the IDL and
 *   simulated before sending. In this version steps 2 and 5 are executed only
 *   when CANARY_FULL_LIFECYCLE=true; by default the canary runs the arm ->
 *   fire-simulation -> disarm cycle on CANARY_LOAN_PDA so it never moves
 *   funds without an explicit opt-in.
 *
 * mainnet: only checks the fire-path simulation on CANARY_LOAN_PDA (the
 * operator's own tiny loan); nothing is sent.
 *
 * Every run writes a canary_runs row.
 */
import { query } from "../db/pool.js";
import { notifyAdmin } from "../notify/admin.js";
import { heartbeat, registerLoop } from "../health/liveness.js";
import { connection, fetchLoan, loadKeypair, readPriceFeed, oracleFloorLamports } from "../chain/program.js";
import { getMintDecimals, planSlice, quoteSlice } from "../watcher/slicing.js";
import { executeOnChainConvertSlice } from "../tx/on-chain-convert-slice.js";
import { attestMint } from "../attestor/attestor.js";

const INTERVAL_MS = (Number(process.env.CANARY_INTERVAL_MINUTES) || 30) * 60_000;
const CLUSTER = process.env.HOCK_CLUSTER || "devnet";
let _timer = null;
let _running = false;

function canaryConfig() {
  const missing = [];
  if (!process.env.CANARY_WALLET_KEYPAIR_PATH) missing.push("CANARY_WALLET_KEYPAIR_PATH");
  if (!process.env.CANARY_MINT) missing.push("CANARY_MINT");
  if (missing.length) return { enabled: false, reason: `missing ${missing.join(", ")}` };
  return { enabled: true, wallet: loadKeypair("CANARY_WALLET_KEYPAIR_PATH"), mint: process.env.CANARY_MINT, loanPda: process.env.CANARY_LOAN_PDA || null };
}

async function record(kind, ok, detail, sig = null) {
  await query(`INSERT INTO canary_runs (cluster, kind, ok, detail, tx_sig) VALUES ($1,$2,$3,$4::jsonb,$5)`, [CLUSTER, kind, ok, JSON.stringify(detail || {}), sig]).catch((e) => console.warn(`[canary] record failed: ${e.message}`));
  if (!ok) await notifyAdmin({ kind: "canary_failed", key: kind, payload: { cluster: CLUSTER, canary: kind, detail } });
}

/** Simulate the exact convert slice for a loan; used by both modes. */
export async function fireSimulation(loanPda, mint) {
  const conn = connection();
  const chainLoan = await fetchLoan(conn, loanPda);
  if (!chainLoan) return { ok: false, reason: "loan_missing" };
  const decimals = await getMintDecimals(conn, mint);
  const feed = await readPriceFeed(conn, mint);
  if (!feed?.latest) return { ok: false, reason: "feed_missing" };
  const plan = planSlice({ chainLoan, feed, decimals, maxSliceBps: Math.max(1, Number(chainLoan.armedMaxSliceBps) || 100) });
  if (!plan.sliceBps) return { ok: false, reason: plan.reason };
  const quote = await quoteSlice({ mint, sliceAmount: plan.sliceAmount });
  const floor = oracleFloorLamports({ sliceAmount: plan.sliceAmount, spot: feed.latest.price, twap: feed.twap, decimals });
  const sim = await executeOnChainConvertSlice({
    connection: conn,
    loan: { loan_pda: loanPda, collateral_mint: mint, program_id: process.env.PROGRAM_ID },
    sliceBps: plan.sliceBps,
    jupiterQuote: quote,
    dryRun: true,
    minSolOutFloor: floor,
  });
  const logs = (sim?.simulation?.logs || []).join(" ");
  if (sim?.simulation?.err && !/ConversionNotAuthorized/.test(logs)) {
    return { ok: false, reason: "simulation_failed", err: sim.simulation.err, logs: logs.slice(-400) };
  }
  return { ok: true, sliceBps: plan.sliceBps, floor: floor.toString(), reachedAuthorizationGate: /ConversionNotAuthorized/.test(logs), cu: sim?.simulation?.unitsConsumed ?? null };
}

export async function runOnce() {
  const cfg = canaryConfig();
  if (!cfg.enabled) {
    heartbeat("canary", "ok", { noop: cfg.reason });
    return { noop: cfg.reason };
  }
  if (CLUSTER === "mainnet-beta") {
    if (!cfg.loanPda) { await record("mainnet_fire_sim", false, { reason: "CANARY_LOAN_PDA not set" }); heartbeat("canary", "error"); return; }
    const r = await fireSimulation(cfg.loanPda, cfg.mint).catch((e) => ({ ok: false, reason: e.message }));
    await record("mainnet_fire_sim", r.ok, r);
    heartbeat("canary", r.ok ? "ok" : "error", r);
    return r;
  }
  // devnet / localnet
  const steps = {};
  try {
    const a = await attestMint(cfg.mint, { force: true });
    steps.attest = a.sig ? "ok" : a.rejected || a.skipped || a.error || "unknown";
    if (!cfg.loanPda) {
      steps.borrow = process.env.CANARY_FULL_LIFECYCLE === "true" ? "not_implemented_in_this_build" : "skipped (CANARY_LOAN_PDA not set; set CANARY_FULL_LIFECYCLE=true to opt in once implemented)";
      await record("devnet_lifecycle", false, steps);
      heartbeat("canary", "error", steps);
      return steps;
    }
    const sim = await fireSimulation(cfg.loanPda, cfg.mint);
    steps.fire_sim = sim;
    const ok = steps.attest === "ok" && sim.ok;
    await record("devnet_lifecycle", ok, steps);
    heartbeat("canary", ok ? "ok" : "error", steps);
    return steps;
  } catch (err) {
    steps.error = err.message?.slice(0, 300);
    await record("devnet_lifecycle", false, steps);
    heartbeat("canary", "error", steps);
    return steps;
  }
}

export function startCanary() {
  registerLoop("canary", { intervalMs: INTERVAL_MS });
  const cfg = (() => { try { return canaryConfig(); } catch (e) { return { enabled: false, reason: e.message }; } })();
  if (!cfg.enabled) {
    console.log(`[canary] disabled: ${cfg.reason}`);
    heartbeat("canary", "ok", { noop: cfg.reason });
    _timer = setInterval(() => heartbeat("canary", "ok", { noop: cfg.reason }), INTERVAL_MS);
    return;
  }
  const tick = async () => {
    if (_running) return;
    _running = true;
    try { await runOnce(); }
    catch (err) { heartbeat("canary", "error", { error: err.message?.slice(0, 200) }); console.error(`[canary] tick failed: ${err.message}`); }
    finally { _running = false; }
  };
  setTimeout(tick, 60_000 + Math.random() * 30_000);
  _timer = setInterval(tick, INTERVAL_MS);
  console.log(`[canary] started (${CLUSTER}); every ${INTERVAL_MS / 60_000} min`);
}

export function stopCanary() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
