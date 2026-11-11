/**
 * Shared Jupiter API config + auth headers for the whole engine.
 *
 * PROVISIONING THE PAID "PRO" TIER (operator-authorized 2026-06-28 to kill
 * the 429-starvation risk on the fire path — see
 * feedback_every_limit_order_must_execute.md):
 *   1. Create an API key at https://portal.jup.ag (operator account + billing).
 *   2. In the host environment, set BOTH:
 *        JUPITER_API = https://api.jup.ag/swap/v1
 *        JUPITER_KEY = <the portal.jup.ag api key>
 *   3. Redeploy. Every Jupiter call (quote + swap-instructions on the fire
 *      path, plus pricing/probes) then sends the `x-api-key` header and hits
 *      the high-rate Pro endpoint.
 *
 * With neither var set, the engine keeps using the free lite-api.jup.ag
 * (current behavior) — so this is strictly additive and safe to ship before
 * the key exists. The key is read live from the env on every call so a
 * host variable change takes effect on the next request after redeploy.
 */
export const JUPITER_API =
  process.env.JUPITER_API || "https://lite-api.jup.ag/swap/v1";

/**
 * Build fetch headers for any Jupiter request. Adds the Pro `x-api-key`
 * header when JUPITER_KEY (or JUPITER_API_KEY) is set; otherwise returns
 * just the caller's extra headers unchanged. Never logs or returns the key.
 */
export function jupiterHeaders(extra = {}) {
  const key = process.env.JUPITER_KEY || process.env.JUPITER_API_KEY || "";
  return key ? { ...extra, "x-api-key": key } : { ...extra };
}

/** True when a paid Jupiter key is configured — for telemetry/health only. */
export function jupiterProEnabled() {
  return !!(process.env.JUPITER_KEY || process.env.JUPITER_API_KEY);
}
