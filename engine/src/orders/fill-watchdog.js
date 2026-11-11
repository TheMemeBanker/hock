/**
 * Fill-success watchdog — alerts when a limit order is TRIGGERED but UNFILLED.
 *
 * Complements armed-order-health-probe (which catches "this order WOULD FAIL at
 * fire time"). This catches the opposite, and the scarier, class: a fire that
 * SHOULD already have happened but hasn't — the trigger condition is met yet the
 * order is still sitting 'armed' (dead-watcher / detection gap / stuck price
 * read) OR it's been grinding in 'firing' past the stuck-recovery window without
 * ever reaching 'fired'. That is the exact silent-stall the operator wants
 * surfaced in seconds, not discovered from a user asking "why didn't my order
 * fill?"
 *
 * It measures ABSOLUTE time-since-first-triggered in memory, so an order that
 * oscillates armed↔firing during recovery (firing_started_at keeps resetting)
 * still trips the alarm if it never actually FILLS within the window.
 *
 * PURELY OBSERVATIONAL — never fires, claims, mutates, or sends anything. Reads
 * + alerts only. Bails soft on any error. The engine's own fire/recovery path is
 * the actuator; this is just the smoke detector.
 *
 * Mandated 2026-06-29 (operator): "a fill-success watchdog that alerts if any
 * armed order is triggered-but-unfilled past N minutes."
 */
import { query } from "../db/pool.js";
import { enqueueNotification } from "../notify/outbox.js";
import { getFailoverConnection } from "../rpc/rpc.js";
import { getCurrentPrice, isTriggerHit } from "../price/pricing.js";

const INTERVAL_MS = Number(process.env.FILL_WATCHDOG_INTERVAL_MS || 90_000); // 90s
// How long an order may be TRIGGERED-but-unfilled before we alarm. Set well
// past the 5-min stuck-firing recovery window so a single healthy recovery
// (like today's SPCX re-fire at +5min) never trips it — only a genuine stall.
const STALL_MS = Number(process.env.FILL_WATCHDOG_STALL_MS || 6 * 60 * 1000); // 6 min
const ALERT_THROTTLE_MS = Number(process.env.FILL_WATCHDOG_THROTTLE_MS || 30 * 60 * 1000); // 30 min/order

let _timer = null;
let _firstTriggeredAt = new Map(); // orderId -> ms when first seen triggered-unfilled
let _alertedAt = new Map(); // orderId -> last alert ms

export function startFillWatchdog() {
  if (_timer) return;
  if (/^(1|true|yes|on)$/i.test(process.env.FILL_WATCHDOG_DISABLED || "")) {
    console.log("[fill-watchdog] DISABLED via FILL_WATCHDOG_DISABLED");
    return;
  }
  // First run after 2 min so the boot storm + initial fires settle.
  setTimeout(() => {
    runOnce().catch((e) => console.warn(`[fill-watchdog] first run: ${e.message?.slice(0, 160)}`));
    _timer = setInterval(() => {
      runOnce().catch((e) => console.warn(`[fill-watchdog] tick: ${e.message?.slice(0, 160)}`));
    }, INTERVAL_MS);
  }, 120_000);
  console.log(
    `[fill-watchdog] armed — first run in 2min, then every ${INTERVAL_MS / 1000}s; alarm if triggered-unfilled > ${STALL_MS / 60000}min`,
  );
}

export function stopFillWatchdog() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

async function runOnce() {
  // Armed + firing orders on still-active loans. A firing order is by
  // definition already triggered; an armed order we price-check below.
  const { rows: orders } = await query(
    `SELECT o.id, o.loan_id, o.status, o.trigger_kind, o.trigger_value_micro,
            o.trigger_direction, o.firing_started_at, o.failure_count,
            o.tx_signature_swap, l.user_id, l.collateral_mint,
            l.loan_id::text AS chain_loan_id, l.borrower_wallet
       FROM limit_close_orders o
       JOIN loans l ON l.id = o.loan_id
      WHERE o.status IN ('armed', 'firing')
        AND l.status = 'active'
      ORDER BY o.id
      LIMIT 1000`,
  );
  // Coverage guard (audit 2026-06-29 #3): the armed/firing set on active loans
  // is normally tiny, but if it ever exceeds the cap, orders beyond it go
  // unwatched — so make that loud rather than silent.
  if (orders.length >= 1000) {
    console.error(`[fill-watchdog] WARNING: hit the 1000-order cap — some armed/firing orders may be UNWATCHED this tick.`);
  }

  const liveIds = new Set();
  let connection = null;
  const now = Date.now();

  for (const o of orders) {
    liveIds.add(o.id);

    // Is this order currently TRIGGERED (i.e. should be filling/filled)?
    let triggered = false;
    if (o.status === "firing") {
      triggered = true; // mid-execution → definitionally triggered
    } else {
      // armed → price-check the trigger (read-only). Skip on any price error
      // so a transient price blip never produces a false stall alarm.
      try {
        if (!connection) connection = getFailoverConnection();
        const currentPrice = await getCurrentPrice(connection, o.collateral_mint);
        if (currentPrice != null) {
          triggered = isTriggerHit({
            trigger_kind: o.trigger_kind,
            trigger_value_micro: o.trigger_value_micro,
            trigger_direction: o.trigger_direction,
            currentPrice,
          });
        }
      } catch {
        triggered = false; // can't tell → don't alarm
      }
    }

    if (!triggered) {
      // Not currently triggered (e.g. trailing stop not hit, price pulled back).
      // Reset its clock — the "triggered" timer only counts continuous triggered time.
      _firstTriggeredAt.delete(o.id);
      continue;
    }

    // Triggered. Start/keep the absolute clock. Set ONCE then persist — it must
    // NOT reset on each armed↔firing oscillation (firing_started_at resets on
    // every re-fire, so a perpetually-recovering order would otherwise never
    // trip the alarm). On the FIRST sighting of a row that is ALREADY firing,
    // anchor to its on-chain firing_started_at if that's older than now, so the
    // measured stall survives a watchdog/engine restart (audit 2026-06-29 #4).
    if (!_firstTriggeredAt.has(o.id)) {
      let anchor = now;
      if (o.status === "firing" && o.firing_started_at) {
        const t = new Date(o.firing_started_at).getTime();
        if (Number.isFinite(t) && t > 0 && t <= now) anchor = t;
      }
      _firstTriggeredAt.set(o.id, anchor);
    }
    const triggeredMs = now - _firstTriggeredAt.get(o.id);
    if (triggeredMs < STALL_MS) continue;

    // Stalled past the window. Alert (throttled per order).
    const lastAlert = _alertedAt.get(o.id) || 0;
    if (now - lastAlert < ALERT_THROTTLE_MS) continue;

    const minutes = Math.floor(triggeredMs / 60000);
    console.error(
      `[fill-watchdog] STALL — order ${o.id} (loan ${o.chain_loan_id}) TRIGGERED but UNFILLED for ~${minutes}min ` +
        `(status=${o.status}, failure_count=${o.failure_count}, firing_started_at=${o.firing_started_at || "—"})`,
    );
    try {
      await enqueueNotification({
        userId: o.user_id, // bot routes admin kinds to the operator channel
        kind: "fill_watchdog_stall",
        payload: {
          order_id: o.id,
          loan_db_id: o.loan_id,
          chain_loan_id: o.chain_loan_id,
          borrower_wallet: o.borrower_wallet,
          collateral_mint: o.collateral_mint,
          status: o.status,
          minutes_triggered_unfilled: minutes,
          failure_count: o.failure_count,
          firing_started_at: o.firing_started_at ? new Date(o.firing_started_at).toISOString() : null,
          last_tx_signature_swap: o.tx_signature_swap || null,
          trigger_kind: o.trigger_kind,
          trigger_value_micro: String(o.trigger_value_micro),
          trigger_direction: o.trigger_direction,
          detected_at: new Date(now).toISOString(),
          remedy:
            "An order's trigger is met but it has not FILLED. Check engine liveness + RPC health + " +
            "Jupiter route depth for this mint; if 'firing', verify the stuck-firing recovery is " +
            "progressing (failure_count + firing_started_at). The order is NOT auto-cancelled — it keeps retrying.",
        },
      });
      _alertedAt.set(o.id, now);
    } catch (e) {
      console.warn(`[fill-watchdog] alert enqueue failed for order ${o.id}: ${e.message?.slice(0, 100)}`);
    }
  }

  // GC in-memory state for orders no longer armed/firing (fired/cancelled/repaid).
  for (const id of _firstTriggeredAt.keys()) if (!liveIds.has(id)) _firstTriggeredAt.delete(id);
  for (const id of _alertedAt.keys()) if (!liveIds.has(id)) _alertedAt.delete(id);
}
