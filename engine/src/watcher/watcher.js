/**
 * Watcher loop: armed limit-close orders and overdue loans.
 *
 * Every WATCHER_INTERVAL_SECONDS:
 *   - for each armed order: read the feed (latest + TWAP), evaluate the trigger
 *     by direction against the latest spot (as the program does), warn the
 *     borrower at 10% and 5% above a stop-loss trigger (once per band), then
 *     when the trigger holds: pre-flight gates, atomic claim
 *     (UPDATE ... WHERE status='armed' RETURNING), fire gates (feed fresh,
 *     slot advancing, exact-tx simulation at or above the oracle floor), and
 *     convert_collateral_slice in TWAP-sized slices until principal + fee are
 *     covered, the armed caps are used up, or collateral is exhausted.
 *     conversion_events row per slice; final status filled/partial/failed.
 *   - for each open loan past due_at: liquidate_loan with the same gates
 *     (feed, slot, simulation), signed by the engine key as keeper.
 *   - on boot: orders stuck in 'firing' for > 10 minutes -> awaiting_user + alert.
 * A failed fire is never retried without re-running every gate on the next tick.
 */
import { PublicKey, Transaction, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { query } from "../db/pool.js";
import { enqueueOutbox } from "../notify/outbox.js";
import { notifyAdmin } from "../notify/admin.js";
import { heartbeat, registerLoop, setGauge } from "../health/liveness.js";
import { runFireGates, runPreFlightGates } from "../safety/safety.js";
import { executeOnChainConvertSlice } from "../tx/on-chain-convert-slice.js";
import { sendWithPriorityAndConfirm } from "../tx/tx-send.js";
import {
  assertSlotAdvancing,
  collateralVaultPda,
  connection,
  engineKeypair,
  fetchLoan,
  fetchPool,
  loanTokenVaultPda,
  mintTokenProgram,
  poolPda,
  programFor,
  readPriceFeed,
  solProceedsVaultPda,
} from "../chain/program.js";
import { getMintDecimals, planSlice, quoteSlice } from "./slicing.js";

const INTERVAL_MS = (Number(process.env.WATCHER_INTERVAL_SECONDS) || 5) * 1000;
const MAX_SLICES_PER_FIRE = Number(process.env.WATCHER_MAX_SLICES_PER_FIRE) || 8;
const STUCK_FIRING_MS = 10 * 60_000;
const INSTANCE = process.env.ENGINE_INSTANCE_ID || "engine";
const WARN_BANDS = [10, 5];
const _warned = new Map(); // `${orderId}:${band}` -> true

let _timer = null;
let _running = false;

// ---- trigger evaluation -------------------------------------------------------------
export function triggerHit(direction, triggerPrice, spot) {
  const t = BigInt(triggerPrice);
  return direction === "take_profit" ? spot >= t : spot <= t;
}

async function warnBands(order, spot) {
  if (order.direction !== "stop_loss") return;
  const t = BigInt(order.trigger_price);
  if (t === 0n) return;
  const abovePct = Number(((spot - t) * 10_000n) / t) / 100;
  for (const band of WARN_BANDS) {
    const key = `${order.id}:${band}`;
    if (_warned.has(key)) continue;
    if (abovePct <= band && abovePct > 0) {
      _warned.set(key, true);
      await enqueueOutbox({ wallet: order.borrower, kind: "stop_loss_proximity", payload: { order_id: order.id, loan_pda: order.loan_pda, band_pct: band, spot: spot.toString(), trigger_price: t.toString() } });
    }
  }
}

// ---- claim / finalize ---------------------------------------------------------------------
async function claimOrder(id) {
  const { rows } = await query(
    `UPDATE limit_close_orders SET status = 'firing', claimed_at = now(), claimed_by = $2, attempts = attempts + 1, updated_at = now()
      WHERE id = $1 AND status = 'armed' RETURNING *`,
    [id, INSTANCE],
  );
  return rows[0] || null;
}

async function finishOrder(id, status, { error = null, sigs = [], solOut = 0n } = {}) {
  await query(
    `UPDATE limit_close_orders SET status = $2::order_status, last_error = $3, fill_sigs = fill_sigs || $4::text[],
        sol_out_lamports = sol_out_lamports + $5, fired_at = COALESCE(fired_at, CASE WHEN $4::text[] <> '{}' THEN now() END), updated_at = now()
      WHERE id = $1`,
    [id, status, error ? String(error).slice(0, 500) : null, sigs, solOut.toString()],
  );
}

async function releaseToArmed(id, error) {
  await query(`UPDATE limit_close_orders SET status = 'armed', last_error = $2, claimed_at = NULL, claimed_by = NULL, updated_at = now() WHERE id = $1 AND status = 'firing'`, [id, String(error).slice(0, 500)]);
}

// ---- fire -------------------------------------------------------------------------------------
async function fireOrder(order, loanRow) {
  const conn = connection();
  const sigs = [];
  let solOut = 0n;
  let sliceIndex = 0;
  let lastError = null;
  const decimals = await getMintDecimals(conn, loanRow.mint);

  for (; sliceIndex < MAX_SLICES_PER_FIRE; sliceIndex++) {
    const chainLoan = await fetchLoan(conn, order.loan_pda);
    const pre = await runPreFlightGates({ order: { ...order, status: "firing" }, loan: loanRow, chainLoan });
    if (!pre.ok) { lastError = pre.reason; break; }
    const feed = await readPriceFeed(conn, loanRow.mint);
    if (!feed?.latest) { lastError = "feed_missing"; break; }
    if (!triggerHit(order.direction, order.trigger_price, feed.latest.price)) { lastError = sliceIndex ? null : "trigger_no_longer_holds"; break; }
    const plan = planSlice({ chainLoan, feed, decimals });
    if (!plan.sliceBps) { lastError = plan.reason === "principal_covered" ? null : plan.reason; break; }
    let quote;
    try { quote = await quoteSlice({ mint: loanRow.mint, sliceAmount: plan.sliceAmount }); }
    catch (err) { lastError = `quote_failed: ${err.message?.slice(0, 120)}`; break; }
    const gates = await runFireGates({ connection: conn, loanRow, chainLoan, decimals, sliceBps: plan.sliceBps, jupiterQuote: quote });
    if (!gates.ok) { lastError = `${gates.reason}: ${gates.detail || ""}`; break; }
    try {
      const r = await executeOnChainConvertSlice({
        connection: conn,
        loan: { loan_pda: order.loan_pda, collateral_mint: loanRow.mint, program_id: process.env.PROGRAM_ID },
        sliceBps: plan.sliceBps,
        jupiterQuote: quote,
        minSolOutFloor: gates.floor,
        onSignature: async (sig) => { await query(`UPDATE limit_close_orders SET fill_sigs = fill_sigs || $2::text[], updated_at = now() WHERE id = $1`, [order.id, [sig]]); },
      });
      sigs.push(r.signature);
      const net = BigInt(r.solReceivedNet || "0");
      solOut += net;
      await query(
        `INSERT INTO conversion_events (order_id, loan_pda, slice_index, tokens_in, sol_out, router, tx_sig) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [order.id, order.loan_pda, sliceIndex, String(r.sliceAmountSold || plan.sliceAmount), net.toString(), "jupiter_v6", r.signature],
      );
      console.log(`[watcher] order ${order.id} slice ${sliceIndex} ${plan.sliceBps}bps -> ${net} lamports sig=${r.signature.slice(0, 12)}`);
    } catch (err) {
      lastError = `fire_failed: ${err.message?.slice(0, 200)}`;
      break;
    }
  }

  const chainLoan = await fetchLoan(conn, order.loan_pda).catch(() => null);
  const covered = chainLoan ? BigInt(chainLoan.solProceedsAmount.toString()) >= BigInt(chainLoan.repayAmount.toString()) : false;
  let status;
  if (sigs.length === 0) status = "failed";
  else if (covered) status = "filled";
  else status = "partial";
  // A fire that never sent anything goes back to armed only when the reason is transient.
  if (sigs.length === 0 && lastError && !/trigger_no_longer_holds|loan_no_longer_active|loan_already_fully_repaid|loan_missing_on_chain|order_state_changed|armed_caps_exhausted/.test(lastError)) {
    await releaseToArmed(order.id, lastError);
    status = "armed";
  } else if (sigs.length === 0 && (!lastError || /trigger_no_longer_holds/.test(lastError))) {
    await releaseToArmed(order.id, lastError || "trigger_no_longer_holds");
    status = "armed";
  } else {
    await finishOrder(order.id, status, { error: lastError, sigs, solOut });
  }
  await enqueueOutbox({ wallet: order.borrower, kind: `limit_close_${status}`, payload: { order_id: order.id, loan_pda: order.loan_pda, slices: sigs.length, sol_out_lamports: solOut.toString(), error: lastError, sigs } });
  if (status === "failed") await notifyAdmin({ kind: "limit_close_fire_failed", key: String(order.id), payload: { order_id: order.id, loan_pda: order.loan_pda, error: lastError } });
  return { status, sigs, solOut, lastError };
}

// ---- liquidation ----------------------------------------------------------------------------
async function liquidateLoan(loanRow) {
  const conn = connection();
  const engine = engineKeypair();
  const chainLoan = await fetchLoan(conn, loanRow.loan_pda);
  const pre = await runPreFlightGates({ order: null, loan: loanRow, chainLoan });
  if (!pre.ok) return { skipped: pre.reason };
  if (Math.floor(Date.now() / 1000) <= Number(chainLoan.dueTimestamp)) return { skipped: "not_due_on_chain" };
  const feed = await readPriceFeed(conn, loanRow.mint);
  if (!feed?.fresh) return { skipped: "feed_stale" };
  try { await assertSlotAdvancing(conn); } catch (e) { return { skipped: e.message }; }

  const pool = await fetchPool(conn);
  const pid = programFor(engine);
  const mintPk = new PublicKey(loanRow.mint);
  const loanPk = new PublicKey(loanRow.loan_pda);
  const tokenProgram = await mintTokenProgram(conn, loanRow.mint);
  const keeperColl = getAssociatedTokenAddressSync(mintPk, engine.publicKey, false, tokenProgram);
  const authColl = getAssociatedTokenAddressSync(mintPk, pool.authority, false, tokenProgram);
  const keeperWsol = getAssociatedTokenAddressSync(NATIVE_MINT, engine.publicKey, false, TOKEN_PROGRAM_ID);
  const authWsol = getAssociatedTokenAddressSync(NATIVE_MINT, pool.authority, false, TOKEN_PROGRAM_ID);
  const ix = await pid.methods.liquidateLoan().accountsStrict({
    pool: poolPda(),
    loanTokenVault: loanTokenVaultPda(),
    loan: loanPk,
    collateralMint: mintPk,
    collateralVault: collateralVaultPda(loanPk),
    keeperCollateralAccount: keeperColl,
    authorityCollateralAccount: authColl,
    solProceedsVault: solProceedsVaultPda(loanPk),
    keeperLoanTokenAccount: keeperWsol,
    authorityLoanTokenAccount: authWsol,
    keeper: engine.publicKey,
    wsolMint: NATIVE_MINT,
    tokenProgram,
    loanTokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    rent: SYSVAR_RENT_PUBKEY,
  }).instruction();
  const tx = new Transaction()
    .add(createAssociatedTokenAccountIdempotentInstruction(engine.publicKey, keeperColl, engine.publicKey, mintPk, tokenProgram))
    .add(createAssociatedTokenAccountIdempotentInstruction(engine.publicKey, authColl, pool.authority, mintPk, tokenProgram))
    .add(createAssociatedTokenAccountIdempotentInstruction(engine.publicKey, keeperWsol, engine.publicKey, NATIVE_MINT, TOKEN_PROGRAM_ID))
    .add(createAssociatedTokenAccountIdempotentInstruction(engine.publicKey, authWsol, pool.authority, NATIVE_MINT, TOKEN_PROGRAM_ID))
    .add(ix);
  tx.feePayer = engine.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  const sim = await conn.simulateTransaction(tx, [engine]);
  if (sim.value.err) {
    const detail = `${JSON.stringify(sim.value.err)} ${(sim.value.logs || []).slice(-4).join(" | ")}`.slice(0, 400);
    await notifyAdmin({ kind: "liquidation_simulation_failed", key: loanRow.loan_pda, payload: { loan_pda: loanRow.loan_pda, detail } });
    return { skipped: `simulation_failed: ${detail}` };
  }
  const sig = await sendWithPriorityAndConfirm(tx, [engine], { connection: conn, cuLimit: 400_000, label: `liquidate ${loanRow.loan_pda.slice(0, 6)}` });
  await query(`UPDATE loans SET status = 'liquidated', close_sig = $2, updated_at = now() WHERE loan_pda = $1`, [loanRow.loan_pda, sig]);
  await query(`UPDATE limit_close_orders SET status = 'expired', last_error = 'loan_liquidated', updated_at = now() WHERE loan_pda = $1 AND status IN ('armed','firing')`, [loanRow.loan_pda]);
  await enqueueOutbox({ wallet: loanRow.borrower, kind: "loan_liquidated", payload: { loan_pda: loanRow.loan_pda, sig } });
  console.log(`[watcher] liquidated ${loanRow.loan_pda.slice(0, 8)} sig=${sig.slice(0, 12)}`);
  return { sig };
}

// ---- boot recovery ----------------------------------------------------------------------------
export async function recoverStuckFiring() {
  const { rows } = await query(
    `UPDATE limit_close_orders SET status = 'awaiting_user', last_error = COALESCE(last_error,'') || ' | stuck_firing_recovered_on_boot', updated_at = now()
      WHERE status = 'firing' AND claimed_at < now() - ($1 || ' milliseconds')::interval RETURNING id, loan_pda, borrower, fill_sigs`,
    [String(STUCK_FIRING_MS)],
  );
  for (const o of rows) {
    await enqueueOutbox({ wallet: o.borrower, kind: "limit_close_awaiting_user", payload: { order_id: o.id, loan_pda: o.loan_pda, fill_sigs: o.fill_sigs } });
    await notifyAdmin({ kind: "stuck_firing_recovered", key: String(o.id), throttleMs: 0, payload: { order_id: o.id, loan_pda: o.loan_pda, fill_sigs: o.fill_sigs, remedy: "Verify fill_sigs on chain; re-arm or close by hand with the borrower." } });
  }
  if (rows.length) console.warn(`[watcher] recovered ${rows.length} stuck firing order(s) -> awaiting_user`);
  return rows.length;
}

// ---- tick ---------------------------------------------------------------------------------------
export async function runOnce() {
  const conn = connection();
  const { rows: orders } = await query(
    `SELECT o.*, o.trigger_price::text AS trigger_price, l.mint, l.status AS loan_status, l.borrower AS loan_borrower
       FROM limit_close_orders o JOIN loans l ON l.loan_pda = o.loan_pda
      WHERE o.status = 'armed' ORDER BY o.id LIMIT 500`,
  );
  let fired = 0, hits = 0, errors = 0;
  for (const order of orders) {
    try {
      const feed = await readPriceFeed(conn, order.mint);
      if (!feed?.latest) continue;
      await warnBands(order, feed.latest.price);
      if (!triggerHit(order.direction, order.trigger_price, feed.latest.price)) continue;
      hits++;
      const loanRow = { loan_pda: order.loan_pda, mint: order.mint, borrower: order.loan_borrower, status: order.loan_status };
      const chainLoan = await fetchLoan(conn, order.loan_pda);
      const pre = await runPreFlightGates({ order, loan: loanRow, chainLoan });
      if (!pre.ok) {
        if (pre.action === "cancel") await finishOrder(order.id, "expired", { error: pre.reason });
        continue;
      }
      const claimed = await claimOrder(order.id);
      if (!claimed) continue;
      const r = await fireOrder({ ...claimed, trigger_price: order.trigger_price }, loanRow);
      if (r.sigs.length) fired++;
    } catch (err) {
      errors++;
      console.error(`[watcher] order ${order.id}: ${err.message?.slice(0, 200)}`);
      await releaseToArmed(order.id, err.message).catch(() => {});
    }
  }

  const { rows: overdue } = await query(`SELECT loan_pda, borrower, mint FROM loans WHERE status = 'open' AND due_at < now() ORDER BY due_at LIMIT 100`);
  let liquidated = 0;
  for (const loan of overdue) {
    try { const r = await liquidateLoan(loan); if (r.sig) liquidated++; }
    catch (err) { errors++; console.error(`[watcher] liquidate ${loan.loan_pda.slice(0, 8)}: ${err.message?.slice(0, 200)}`); }
  }

  const { rows: counts } = await query(`SELECT status, count(*)::int AS n FROM limit_close_orders WHERE status IN ('armed','firing','awaiting_user') GROUP BY status`);
  const byStatus = Object.fromEntries(counts.map((c) => [c.status, c.n]));
  setGauge("orders_armed", byStatus.armed || 0);
  setGauge("orders_firing", byStatus.firing || 0);
  setGauge("stuck_orders", byStatus.awaiting_user || 0);
  setGauge("loans_overdue", overdue.length);
  heartbeat("watcher", errors && !fired ? "error" : "ok", { armed: orders.length, trigger_hits: hits, fired, overdue: overdue.length, liquidated, errors });
}

export function startWatcher() {
  registerLoop("watcher", { intervalMs: INTERVAL_MS });
  const tick = async () => {
    if (_running) return;
    _running = true;
    try { await runOnce(); }
    catch (err) { heartbeat("watcher", "error", { error: err.message?.slice(0, 200) }); console.error(`[watcher] tick failed: ${err.message}`); }
    finally { _running = false; }
  };
  recoverStuckFiring().catch((e) => console.error(`[watcher] stuck recovery failed: ${e.message}`));
  setTimeout(tick, 500 + Math.random() * 2_000);
  _timer = setInterval(tick, INTERVAL_MS);
  console.log(`[watcher] started; every ${INTERVAL_MS / 1000}s`);
}

export function stopWatcher() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
