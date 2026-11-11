/**
 * Operator alerts: always logged, and written to the outbox under wallet
 * 'admin' so the delivery worker can route them. Throttled per (kind, key)
 * so a persistent condition produces one row per window, not one per tick.
 */
import { enqueueOutbox } from "./outbox.js";

export const ADMIN_WALLET = "admin";
const DEFAULT_THROTTLE_MS = Number(process.env.ADMIN_ALERT_THROTTLE_MS) || 15 * 60_000;
const _last = new Map();

export function getAdminId() {
  return ADMIN_WALLET;
}

/**
 * notifyAdmin(text) or notifyAdmin({ kind, key, payload, throttleMs }).
 * The first positional form matches the lifted watchdog's `notifyAdmin(bot, text)`.
 */
export async function notifyAdmin(a, b) {
  let spec;
  if (typeof a === "string") spec = { kind: "admin_alert", payload: { text: a } };
  else if (a && typeof a === "object" && a.kind) spec = a;
  else if (typeof b === "string") spec = { kind: "admin_alert", payload: { text: b } };
  else spec = { kind: "admin_alert", payload: { text: String(b ?? a) } };

  const { kind, key = "", payload = {}, throttleMs = DEFAULT_THROTTLE_MS } = spec;
  const text = payload.text || JSON.stringify(payload).slice(0, 300);
  console.warn(`[admin] ${kind}${key ? ` (${key})` : ""}: ${text}`);

  const tkey = `${kind}:${key}`;
  const now = Date.now();
  if (throttleMs > 0 && now - (_last.get(tkey) || 0) < throttleMs) return null;
  _last.set(tkey, now);
  return enqueueOutbox({ wallet: ADMIN_WALLET, kind, payload: { key, ...payload } });
}
