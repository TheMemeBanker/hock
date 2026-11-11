/**
 * Per-armed-order pre-fire DRY-RUN health probe.
 *
 * The single strongest defense against order-21-class failures
 * (feedback_order_21_class_must_never_recur.md). Every 30 seconds —
 * same cadence as the trigger-detection poll — this watcher runs
 * `dryRunArmedOrder()` against EVERY armed V4 order. The dry-run
 * exercises the EXACT flow a real fire would run (loadOrderContext
 * SELECT, runPreFlightGates evaluation) without any on-chain action,
 * state mutation, or DM side-effect.
 *
 * If ANY phase fails (column does not exist, gate would cancel,
 * schema drift, V1 logic leaking into V4), the operator gets an
 * admin DM IMMEDIATELY with:
 *   - the order id and loan id
 *   - the exact failing phase ('load_context' | 'preflight_gates')
 *   - the exact reason string
 *   - any detail the dry-run captured
 *
 * Throttle: alert at most once per (order_id, reason) pair per hour.
 * If the same order keeps failing with the same reason, we don't
 * spam — but a NEW failure mode (different reason) re-alerts
 * immediately.
 *
 * The operator finds out their order is broken BEFORE the price
 * hits the trigger. No more silent kills. Order 22 will be safe
 * because we exercise it every 30s.
 *
 * Mandated by [[feedback_order_21_class_must_never_recur]] +
 * [[feedback_ladder_trigger_must_execute]].
 */
import { query } from "../TODO-hock/db.js";
import { dryRunArmedOrder } from "../TODO-hock/execution.js";
import { enqueueNotification } from "../TODO-hock/notifications.js";

// 15s — BEATS the 30s trigger-poll cadence so we catch a broken order
// before the engine even gets to evaluate the trigger. Crypto moves
// fast; a 30s probe could miss a stuck order whose trigger hits in
// the same window. See feedback_time_triggers_aggressive_urgency.md.
const PROBE_INTERVAL_MS = Number(
  process.env.ARMED_ORDER_HEALTH_PROBE_INTERVAL_MS || 15_000,
);
const ALERT_THROTTLE_MS = 60 * 60 * 1000; // 1h per (order_id, reason)

let _timer = null;
let _alerted = new Map(); // key: `${order_id}:${reason}` -> last_alert_ts

export function startArmedOrderHealthProbe() {
  if (_timer) return;
  // First run after 60s so the boot storm settles and the engine's
  // own preflight has already passed.
  setTimeout(() => {
    runOnce().catch((e) =>
      console.warn(`[armed-order-probe] first run failed: ${e.message?.slice(0, 160)}`),
    );
    _timer = setInterval(() => {
      runOnce().catch((e) =>
        console.warn(`[armed-order-probe] tick failed: ${e.message?.slice(0, 160)}`),
      );
    }, PROBE_INTERVAL_MS);
  }, 60_000);
  console.log(`[armed-order-probe] armed — first run in 60s, then every ${PROBE_INTERVAL_MS / 1000}s`);
}

// Reasons the probe should NOT alert on. These are legitimate
// cancellations the engine will perform correctly on the next tick:
// the loan was repaid by the borrower, fully discharged, or the
// operator disabled the token. Catching them in the probe would
// just be noise. The probe only alarms on UNEXPECTED failures —
// schema drift, V1-gate-leaking-into-V4, etc.
const LEGITIMATE_CANCEL_REASONS = new Set([
  "loan_no_longer_active",
  "loan_already_fully_repaid",
  "collateral_disabled",
]);

async function runOnce() {
  const v4ProgramId = process.env.PROGRAM_ID_V4;
  if (!v4ProgramId) return; // V4 disabled — nothing to probe

  // Pull every armed order on a V4 loan whose loan is ALSO still
  // active. Orders on repaid/liquidated loans are auto-cancelled by
  // the engine on next tick and don't need probing. Cap at 200.
  const { rows: orders } = await query(
    `SELECT o.id, o.loan_id, l.loan_id::text AS chain_loan_id,
            o.trigger_kind, o.trigger_value_micro, o.trigger_direction,
            o.source, l.user_id, l.collateral_mint, l.borrower_wallet
       FROM limit_close_orders o
       JOIN loans l ON l.id = o.loan_id
      WHERE o.status = 'armed'
        AND l.program_id = $1
        AND l.status = 'active'
      ORDER BY o.id
      LIMIT 200`,
    [v4ProgramId],
  );

  if (orders.length === 0) return;

  let failures = 0;
  for (const o of orders) {
    let result;
    try {
      result = await dryRunArmedOrder(o.id);
    } catch (err) {
      result = {
        ok: false,
        phase: "probe_itself_threw",
        reason: "uncaught_exception",
        detail: err.message?.slice(0, 200) || String(err).slice(0, 200),
      };
    }
    if (result.ok) continue;
    if (result.action === "cancel" && LEGITIMATE_CANCEL_REASONS.has(result.reason)) {
      // Engine will correctly auto-cancel this on its next trigger
      // evaluation; not a probe-actionable signal.
      continue;
    }
    failures += 1;

    // Log the reason BEFORE attempting the DM so we always have
    // visibility even if the notification flow is itself broken.
    console.warn(
      `[armed-order-probe] order ${o.id} (loan ${o.chain_loan_id}) WOULD FAIL at ${result.phase}: ${result.reason}` +
        (result.detail ? ` — ${String(result.detail).slice(0, 120)}` : ""),
    );

    const reasonKey = `${o.id}:${result.reason || "unknown"}`;
    const lastAlertTs = _alerted.get(reasonKey) || 0;
    if (Date.now() - lastAlertTs < ALERT_THROTTLE_MS) continue;

    // The bot's notifications table requires user_id NOT NULL. For
    // operator-only alerts, route to the loan's borrower (operator
    // is the borrower on his own loans) and tag the kind so the bot's
    // notification-sender forwards to the admin channel.
    try {
      await enqueueNotification({
        userId: o.user_id, // borrower user — bot routes admin kinds to operator chat
        kind: "armed_order_probe_failed",
        payload: {
          order_id: o.id,
          loan_db_id: o.loan_id,
          chain_loan_id: o.chain_loan_id,
          borrower_wallet: o.borrower_wallet,
          collateral_mint: o.collateral_mint,
          trigger_kind: o.trigger_kind,
          trigger_value_micro: String(o.trigger_value_micro),
          trigger_direction: o.trigger_direction,
          phase: result.phase,
          action: result.action || null,
          reason: result.reason,
          detail: result.detail || null,
          probed_at: new Date().toISOString(),
          remedy:
            result.phase === "load_context"
              ? "schema drift — check execution.js loadOrderContext SELECT against actual table columns. Fire path will fail on every attempt until fixed."
              : result.phase === "preflight_gates" && result.action === "cancel"
                ? "safety gate would auto-cancel this V4 order. Verify the gate has a V4 bypass (see feedback_engine_safety_dont_auto_cancel_v4_loans_on_rwa_reclassification)."
                : "investigate the failing phase; fire WILL fail when trigger hits.",
        },
      });
      _alerted.set(reasonKey, Date.now());
    } catch (e) {
      console.warn(`[armed-order-probe] DM enqueue failed for order ${o.id}: ${e.message?.slice(0, 100)}`);
    }
  }

  if (failures > 0) {
    console.warn(`[armed-order-probe] tick: ${failures}/${orders.length} armed V4 orders WOULD FAIL at fire time (excluding legitimate auto-cancels)`);
  }
}
