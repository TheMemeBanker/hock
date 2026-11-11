/**
 * Armed-order health probe.
 *
 * Every ARMED_ORDER_HEALTH_PROBE_INTERVAL_MS it dry-runs each armed order
 * through the real convert path (execution/dry-run.js) and raises an outbox
 * alert when a fire WOULD fail, throttled per (order, reason) to one per hour.
 * Legitimate auto-cancel reasons are not alerts.
 */
import { query } from "../db/pool.js";
import { dryRunArmedOrder } from "../execution/dry-run.js";
import { notifyAdmin } from "../notify/admin.js";
import { heartbeat, registerLoop } from "../health/liveness.js";

const PROBE_INTERVAL_MS = Number(process.env.ARMED_ORDER_HEALTH_PROBE_INTERVAL_MS || 60_000);
const ALERT_THROTTLE_MS = 60 * 60 * 1000;
let _timer = null;
const _alerted = new Map();

const LEGITIMATE_CANCEL_REASONS = new Set(["loan_no_longer_active", "loan_already_fully_repaid", "loan_missing_on_chain"]);

export function startArmedOrderHealthProbe() {
  if (_timer) return;
  registerLoop("armed_order_probe", { intervalMs: PROBE_INTERVAL_MS });
  setTimeout(() => {
    runOnce().catch((e) => console.warn(`[armed-order-probe] first run failed: ${e.message?.slice(0, 160)}`));
    _timer = setInterval(() => {
      runOnce().catch((e) => console.warn(`[armed-order-probe] tick failed: ${e.message?.slice(0, 160)}`));
    }, PROBE_INTERVAL_MS);
  }, 45_000);
  console.log(`[armed-order-probe] armed; first run in 45s, then every ${PROBE_INTERVAL_MS / 1000}s`);
}

export function stopArmedOrderHealthProbe() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

export async function runOnce() {
  const { rows: orders } = await query(
    `SELECT o.id, o.loan_pda, o.borrower, o.direction, o.trigger_price::text AS trigger_price, l.mint
       FROM limit_close_orders o JOIN loans l ON l.loan_pda = o.loan_pda
      WHERE o.status = 'armed' AND l.status = 'open'
      ORDER BY o.id LIMIT 200`,
  );
  let failures = 0;
  for (const o of orders) {
    let result;
    try {
      result = await dryRunArmedOrder(o.id);
    } catch (err) {
      result = { ok: false, phase: "probe_itself_threw", reason: "uncaught_exception", detail: err.message?.slice(0, 200) };
    }
    if (result.ok) continue;
    if (result.action === "cancel" && LEGITIMATE_CANCEL_REASONS.has(result.reason)) continue;
    failures += 1;
    console.warn(`[armed-order-probe] order ${o.id} (${o.loan_pda.slice(0, 8)}) WOULD FAIL at ${result.phase}: ${result.reason}${result.detail ? ` -- ${String(result.detail).slice(0, 120)}` : ""}`);
    const key = `${o.id}:${result.reason || "unknown"}`;
    if (Date.now() - (_alerted.get(key) || 0) < ALERT_THROTTLE_MS) continue;
    _alerted.set(key, Date.now());
    await notifyAdmin({
      kind: "armed_order_probe_failed",
      key,
      throttleMs: 0,
      payload: {
        order_id: o.id,
        loan_pda: o.loan_pda,
        borrower: o.borrower,
        mint: o.mint,
        direction: o.direction,
        trigger_price: o.trigger_price,
        phase: result.phase,
        reason: result.reason,
        detail: result.detail || null,
        remedy: "Fire will fail when the trigger hits. Investigate the failing phase (feed, quote, floor, simulation) before the price gets there.",
      },
    });
  }
  heartbeat("armed_order_probe", "ok", { orders: orders.length, would_fail: failures });
  if (failures > 0) console.warn(`[armed-order-probe] ${failures}/${orders.length} armed orders would fail at fire time`);
}
