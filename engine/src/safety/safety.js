/**
 * Pre-fire safety gates for limit-close orders and liquidations.
 *
 * Two layers:
 *   runPreFlightGates  -- cheap DB/state checks (order still armed, loan still
 *                         open on chain, kill switch off).
 *   runFireGates       -- the three operational rules from THREAT_MODEL.md:
 *                         feed freshness, slot advance across two reads, and a
 *                         simulation of the exact convert_collateral_slice tx
 *                         whose min_sol_out is at least the oracle floor.
 *
 * Every result is { ok, action: 'cancel'|'retry'|'fire', reason, detail }.
 * Callers never fire on anything but ok === true, and never retry a failed
 * fire without calling both layers again.
 */
import { query } from "../db/pool.js";
import {
  assertSlotAdvancing,
  readPriceFeed,
  oracleFloorLamports,
  MAX_PRICE_STALENESS_SECONDS,
} from "../chain/program.js";
import { executeOnChainConvertSlice } from "../tx/on-chain-convert-slice.js";

export const FEED_MAX_AGE_SECONDS = Number(process.env.WATCHER_FEED_MAX_AGE_SECONDS) || 90;

export async function runPreFlightGates({ order, loan, chainLoan }) {
  if (order && order.status !== "armed" && order.status !== "firing") {
    return { ok: false, action: "cancel", reason: "order_not_armed", detail: `order is ${order.status}` };
  }
  if (!chainLoan) {
    return { ok: false, action: "cancel", reason: "loan_missing_on_chain" };
  }
  const statusKey = (Object.keys(chainLoan.status || {})[0] || "").toLowerCase();
  if (statusKey !== "active") {
    return { ok: false, action: "cancel", reason: "loan_no_longer_active", detail: `loan is ${statusKey}` };
  }
  if (BigInt(chainLoan.repayAmount.toString()) <= 0n) {
    return { ok: false, action: "cancel", reason: "loan_already_fully_repaid" };
  }
  if (loan && loan.status !== "open") {
    return { ok: false, action: "retry", reason: "db_loan_not_open", detail: `db says ${loan.status}; reconciler will repair` };
  }
  if (process.env.LIMIT_CLOSE_DISABLED === "true") {
    return { ok: false, action: "retry", reason: "engine_kill_switch_on" };
  }
  if (order) {
    const { rows } = await query(`SELECT status FROM limit_close_orders WHERE id = $1`, [order.id]);
    if (!rows[0] || !["armed", "firing"].includes(rows[0].status)) {
      return { ok: false, action: "cancel", reason: "order_state_changed", detail: rows[0]?.status || "missing" };
    }
  }
  return { ok: true, action: "fire" };
}

/**
 * Fire-time gates for one convert slice.
 * @param connection   RPC connection
 * @param loanRow      { loan_pda, mint, ... } (DB shape; program_id optional)
 * @param chainLoan    decoded Loan account
 * @param decimals     collateral decimals
 * @param sliceBps     slice to convert
 * @param jupiterQuote Jupiter quote body for exactly the slice amount
 */
export async function runFireGates({ connection, loanRow, chainLoan, decimals, sliceBps, jupiterQuote }) {
  const nowTs = Math.floor(Date.now() / 1000);
  const feed = await readPriceFeed(connection, loanRow.mint, nowTs);
  if (!feed || !feed.latest) {
    return { ok: false, action: "retry", reason: "feed_missing", detail: "no price feed sample for mint" };
  }
  if (feed.ageSeconds > Math.min(FEED_MAX_AGE_SECONDS, MAX_PRICE_STALENESS_SECONDS)) {
    return { ok: false, action: "retry", reason: "feed_stale", detail: `latest sample ${feed.ageSeconds}s old` };
  }
  if (!feed.twapReady) {
    return { ok: false, action: "retry", reason: "twap_not_ready", detail: `${feed.samplesInWindow} samples, oldest ${feed.oldestAgeSeconds}s` };
  }

  try {
    await assertSlotAdvancing(connection);
  } catch (err) {
    return { ok: false, action: "retry", reason: "slot_not_advancing", detail: err.message };
  }

  const collateral = BigInt(chainLoan.collateralAmount.toString());
  const sliceAmount = (collateral * BigInt(sliceBps)) / 10_000n;
  const floor = oracleFloorLamports({ sliceAmount, spot: feed.latest.price, twap: feed.twap, decimals });
  const quoted = BigInt(jupiterQuote.otherAmountThreshold || 0);
  if (quoted < floor) {
    return {
      ok: false,
      action: "retry",
      reason: "quote_below_oracle_floor",
      detail: `quote min out ${quoted} < floor ${floor} (spot ${feed.latest.price}, twap ${feed.twap})`,
      floor,
    };
  }

  let sim;
  try {
    sim = await executeOnChainConvertSlice({
      connection,
      loan: { loan_pda: loanRow.loan_pda, collateral_mint: loanRow.mint, program_id: process.env.PROGRAM_ID },
      sliceBps,
      jupiterQuote,
      dryRun: true,
      minSolOutFloor: floor,
    });
  } catch (err) {
    return { ok: false, action: "retry", reason: "simulation_threw", detail: err.message?.slice(0, 200) };
  }
  if (sim?.simulation?.err) {
    return {
      ok: false,
      action: "retry",
      reason: "simulation_failed",
      detail: `${JSON.stringify(sim.simulation.err)} ${(sim.simulation.logs || []).slice(-4).join(" | ")}`.slice(0, 400),
      floor,
    };
  }
  return { ok: true, action: "fire", floor, feed, unitsConsumed: sim?.simulation?.unitsConsumed ?? null };
}

export function runProceedsSanityCheck({ expectedProceedsLamports, loanOwedLamports, protocolFeeBps, minProceedsLamports, triggerDirection = "above" }) {
  const fee = (expectedProceedsLamports * BigInt(protocolFeeBps)) / 10_000n;
  const afterFee = expectedProceedsLamports - fee;
  const netToUser = afterFee - loanOwedLamports;
  if (triggerDirection === "below") {
    if (netToUser < 0n) {
      return { ok: false, action: "retry", reason: "proceeds_insolvent_stop_loss", detail: `net=${netToUser} below zero` };
    }
  } else {
    const SAFETY_MARGIN = 5_000_000n;
    if (netToUser < SAFETY_MARGIN) {
      return { ok: false, action: "retry", reason: "proceeds_below_safety_floor", detail: `net=${netToUser} below ${SAFETY_MARGIN}` };
    }
  }
  if (minProceedsLamports && netToUser < BigInt(minProceedsLamports)) {
    return { ok: false, action: "retry", reason: "user_min_proceeds_not_met", detail: `net=${netToUser} below user min ${minProceedsLamports}` };
  }
  return { ok: true, expectedFee: fee, expectedNetToUser: netToUser };
}
