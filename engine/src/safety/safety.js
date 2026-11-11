/**
 * Pre-flight safety gates that run AT FIRE TIME, after a trigger has
 * been deemed hit but BEFORE any on-chain action. Each gate's failure
 * mode is documented: cancel vs. fail vs. retry.
 *
 * Defense in depth — the schema and command handlers already enforce
 * many of these at arm time, but the engine re-checks at fire time
 * because state can change between arm and fire (the operator might
 * have flipped the site-global pause, the token might have been
 * disabled by the screener, the loan might have been partially
 * repaid such that the math no longer works, etc.).
 *
 * Gate failure semantics:
 *   - 'cancel'  — the order can never legitimately fire (e.g. loan no
 *                 longer active). Mark cancelled with the reason.
 *   - 'retry'   — transient condition (e.g. site is paused). Leave
 *                 order armed; next tick will re-evaluate.
 *   - 'fail'    — unexpected error. Mark failed with details for ops.
 */
import { query } from "../TODO-hock/db.js";

/**
 * Run all gates against (order, loan, mintRow). Returns
 *   { ok: true } if everything passes,
 *   { ok: false, action: 'cancel'|'retry'|'fail', reason, detail? } otherwise.
 */
export async function runPreFlightGates({ order, loan, mintRow }) {
  // 1. Loan still active? (User may have repaid or been liquidated.)
  if (loan.status !== "active") {
    return {
      ok: false,
      action: "cancel",
      reason: "loan_no_longer_active",
      detail: `loan is now ${loan.status}`,
    };
  }

  // 2. Owed amount is real (positive). Defensive against weird DB state.
  if (BigInt(loan.owed_lamports) <= 0n) {
    return {
      ok: false,
      action: "cancel",
      reason: "loan_already_fully_repaid",
    };
  }

  // 3. Site-global pause respected.
  const { rows } = await query(
    `SELECT disabled, reason FROM site_global_state LIMIT 1`,
  ).catch(() => ({ rows: [] }));
  if (rows[0]?.disabled === true) {
    return {
      ok: false,
      action: "retry",
      reason: "site_globally_paused",
      detail: rows[0]?.reason || "",
    };
  }

  // 4. Collateral token still enabled. The screener can disable mid-life
  //    (e.g. token flagged scammy via /disabletoken).
  if (!mintRow?.enabled) {
    return {
      ok: false,
      action: "cancel",
      reason: "collateral_disabled",
      detail: `mint ${order.collateral_mint?.slice(0, 8)}… no longer enabled`,
    };
  }

  // 5. Token wasn't reclassified into an RWA category since arm time.
  //    For V1 this is a real gate: V1's Jupiter swap path can't handle
  //    RWA Token-2022 with ScaledUiAmount + transfer hook concerns.
  //    For V4 this gate IS WRONG and must NEVER cancel — V4's
  //    convert_collateral_slice path explicitly handles Token-2022
  //    routing via Pattern B CPI and the in-vault sol_proceeds_vault
  //    PDA. SPCX is category=stock; operator's V4 SPCX loan 826 /
  //    order 21 hit $210 trigger, but this gate auto-cancelled the
  //    fire on 2026-06-17 13:15:22 even though the V4 fire path was
  //    designed for exactly this case. PERMANENT RULE: V4 loans
  //    bypass this check.
  //    See feedback_engine_safety_dont_auto_cancel_v4_loans_on_rwa_reclassification.md.
  const isV4Loan = !!process.env.PROGRAM_ID_V4 &&
                   loan.program_id === process.env.PROGRAM_ID_V4;
  if (!isV4Loan && ["stock", "etf", "metal"].includes(mintRow.category)) {
    return {
      ok: false,
      action: "cancel",
      reason: "collateral_reclassified_to_rwa",
      detail: `mint is now category=${mintRow.category}; limit-close on RWAs is v1.1+`,
    };
  }

  // 6. Engine kill switch (separate from site-global — operator may want
  //    to pause limit-close specifically while leaving borrows running).
  if (process.env.LIMIT_CLOSE_DISABLED === "true") {
    return {
      ok: false,
      action: "retry",
      reason: "engine_kill_switch_on",
    };
  }

  // 7. Order hasn't expired. (V1/V2/V3 only — P0-4.) A V4 in-vault exit whose
  //    trigger is met must keep attempting until the loan is repaid or the
  //    order is cancelled; the expires_at clock must NEVER terminally cancel a
  //    live V4 exit. Mirrors the gate-5 V4 bypass above and the expireOldOrders
  //    P0-3 carve-out. isV4Loan is already in scope from line 83.
  if (!isV4Loan && order.expires_at && new Date(order.expires_at) <= new Date()) {
    return {
      ok: false,
      action: "cancel",
      reason: "order_expired",
    };
  }

  return { ok: true };
}

/**
 * Slippage / proceeds sanity check — runs AFTER the Jupiter quote is
 * fetched at fire time. Verifies the user actually nets positive (or
 * acceptable) value AFTER fees and the loan repay.
 *
 * Returns { ok: true } or { ok: false, action: 'cancel'|'retry', reason }.
 */
export function runProceedsSanityCheck({ expectedProceedsLamports, loanOwedLamports, protocolFeeBps, minProceedsLamports, triggerDirection = "above" }) {
  const fee = (expectedProceedsLamports * BigInt(protocolFeeBps)) / 10_000n;
  const afterFee = expectedProceedsLamports - fee;
  const netToUser = afterFee - loanOwedLamports;

  // Direction-aware safety floor.
  //
  // For take-profit ('above'): the user is selling AT A GAIN. The 0.005 SOL
  // floor catches transient price misses (small slippage, fee-edge cases)
  // so the engine retries instead of firing into a near-zero net.
  //
  // For stop-loss ('below'): cutting losses is exactly the case where the
  // user EXPECTS to net little/nothing — that is the trade. A high floor
  // would block the very fires the user armed the order for. We replace
  // the 0.005 SOL gain floor with a much looser solvency floor: the user
  // must still come out non-negative (the on-chain repay would otherwise
  // fail). The user-set minProceedsLamports is still honored as an
  // explicit downside cap if they set one.
  //
  // The 1% protocol fee applies in BOTH directions — operator rule
  // 2026-06-12 — and is already deducted above via the fee calc.
  if (triggerDirection === "below") {
    // Stop-loss: only require the user doesn't go negative outright.
    // Net could be 0 (everything goes to repay + fee) and that's an
    // intended outcome for someone cutting losses near the liquidation edge.
    if (netToUser < 0n) {
      return {
        ok: false,
        action: "retry",
        reason: "proceeds_insolvent_stop_loss",
        detail: `net=${netToUser} below zero; collateral cannot cover repay + 1% fee. Retry next tick.`,
      };
    }
  } else {
    // Take-profit: hard floor catches transient gain misses.
    const SAFETY_MARGIN = 5_000_000n; // 0.005 SOL
    if (netToUser < SAFETY_MARGIN) {
      return {
        ok: false,
        action: "retry",
        reason: "proceeds_below_safety_floor",
        detail: `net=${netToUser} below safety ${SAFETY_MARGIN}; price may not have risen enough`,
      };
    }
  }

  // Optional user-set minimum proceeds — honored in both directions.
  if (minProceedsLamports && netToUser < BigInt(minProceedsLamports)) {
    return {
      ok: false,
      action: "retry",
      reason: "user_min_proceeds_not_met",
      detail: `net=${netToUser} below user min ${minProceedsLamports}`,
    };
  }

  return { ok: true, expectedFee: fee, expectedNetToUser: netToUser };
}
