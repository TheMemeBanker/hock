/**
 * Notification outbox. The engine never delivers messages itself; it writes a
 * row into notifications_outbox keyed by wallet and a delivery worker (site,
 * email relay, whatever the operator wires later) drains it.
 *
 * `enqueueNotification({ userId, kind, payload })` is kept as a compatibility
 * shape for lifted modules: userId is treated as the wallet string.
 */
import { query } from "../db/pool.js";

export async function enqueueOutbox({ wallet, kind, payload = {} }) {
  if (!wallet || !kind) throw new Error("enqueueOutbox: wallet and kind are required");
  const body = { ...payload, enqueued_at: new Date().toISOString(), instance: process.env.ENGINE_INSTANCE_ID || "engine" };
  try {
    const { rows } = await query(
      `INSERT INTO notifications_outbox (wallet, kind, payload) VALUES ($1, $2, $3::jsonb) RETURNING id`,
      [String(wallet), String(kind), JSON.stringify(body)],
    );
    return rows[0]?.id ?? null;
  } catch (err) {
    console.error(`[outbox] enqueue failed wallet=${String(wallet).slice(0, 8)} kind=${kind}: ${err.message}`);
    return null;
  }
}

export async function enqueueNotification({ userId, wallet, kind, payload }) {
  return enqueueOutbox({ wallet: wallet || (userId != null ? String(userId) : "admin"), kind, payload });
}

/** Undelivered count for /health. */
export async function outboxBacklog() {
  try {
    const { rows } = await query(`SELECT count(*)::int AS n FROM notifications_outbox WHERE delivered_at IS NULL`);
    return rows[0]?.n ?? 0;
  } catch {
    return null;
  }
}
