/**
 * Pricing utilities — gets current price for a token, computes its MC,
 * and provides the canonical "is this trigger hit?" comparison.
 *
 * Price sources, in fallback order:
 *   1. Jupiter price API (most accurate, accounts for liquidity-weighted
 *      execution price)
 *   2. Jupiter quote API (sell 1 token for SOL/USDC — equivalent and
 *      explicit about execution)
 *
 * MC is a derived value: price_usd × on_chain_supply (adjusted for
 * decimals). Supply is read from the mint account; cached briefly to
 * avoid hammering RPC.
 *
 * All price/MC values internally use BigInt micros (1e6 USD or 1e9 SOL)
 * to match the trigger_value_micro storage in limit_close_orders.
 * Integer math everywhere — no float comparison surprises at the
 * threshold.
 */
import { PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const JUPITER_API = process.env.JUPITER_API || "https://lite-api.jup.ag/swap/v1";
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = process.env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Cache mint supply + decimals briefly. Memecoin supply does change
// (new mints/burns), so don't cache too long. 60s is plenty.
const _supplyCache = new Map(); // mint → { supply: BigInt, decimals: number, expiresAt: ms }
const SUPPLY_CACHE_MS = 60_000;

async function getMintInfo(connection, mintStr) {
  const now = Date.now();
  const cached = _supplyCache.get(mintStr);
  if (cached && cached.expiresAt > now) return cached;
  const pk = new PublicKey(mintStr);
  const info = await connection.getAccountInfo(pk);
  if (!info) throw new Error(`mint ${mintStr.slice(0, 8)}… not found`);
  // Try both token programs; getMint will throw if the program-owner mismatches.
  const programId = info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const m = await getMint(connection, pk, "confirmed", programId);
  const entry = {
    supply: BigInt(m.supply.toString()),
    decimals: m.decimals,
    expiresAt: now + SUPPLY_CACHE_MS,
  };
  _supplyCache.set(mintStr, entry);
  return entry;
}

/**
 * Quote: sell `amountRaw` of input mint for SOL or USDC.
 * Returns { outAmountLamports: BigInt, route, slippageBps: requested }.
 *
 * Uses Jupiter v6 quote endpoint. We don't submit yet — pure read-only
 * for trigger evaluation + pre-flight gating. Slippage tolerance is
 * passed through to the quote so the returned out amount is the
 * worst-case execution we'd accept.
 */
export async function jupiterQuote({ inputMint, outputMint, amountRaw, slippageBps, excludeDexes }) {
  // T13 (2026-06-16): `excludeDexes` lets the executeOnChainConvertSlice
  // V4 fire path retry against a different route family when the inner
  // Jupiter program errored on a structural route fault (Custom 6025
  // InvalidTokenAccount, dead pool, Pump.fun Amm with non-pump source,
  // etc). Optional — when undefined, normal best-route quote.
  const params = new URLSearchParams({
    inputMint, outputMint, amount: String(amountRaw),
    slippageBps: String(slippageBps), swapMode: "ExactIn",
    onlyDirectRoutes: "false", maxAccounts: "20",
  });
  if (Array.isArray(excludeDexes) && excludeDexes.length > 0) {
    params.set("excludeDexes", excludeDexes.join(","));
  }
  const url = `${JUPITER_API}/quote?${params.toString()}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) {
    throw new Error(`jupiter_quote_http_${res.status}`);
  }
  const body = await res.json();
  if (!body?.outAmount) {
    throw new Error("jupiter_quote_no_route");
  }
  return {
    outAmountLamports: BigInt(body.outAmount),
    route: body,
    slippageBps,
  };
}

/**
 * Current "price" of a token in lamports per raw-unit, computed by
 * quoting a SMALL sale against SOL. We use 1 raw unit (or up to 1
 * displayed unit if 1 raw is below Jupiter's min) so the quote is
 * the best representation of clean mid-execution price without
 * slippage-induced bias.
 *
 * Returns { priceLamportsPerRaw: number, priceUsdMicrosPerRaw: number, info }.
 *
 * priceLamportsPerRaw can be fractional (a memecoin trades for
 * 0.000001234 SOL per token). We expose it as a Number for the MC
 * computation; the trigger comparison itself uses BigInt micros to
 * avoid float drift at the threshold.
 */
/**
 * DexScreener cross-check — returns the deepest-liquidity priceUsd for
 * the mint and for SOL on DexScreener so we can derive priceLamportsPerRaw
 * the same way Jupiter does. Throws if either is missing.
 */
async function dexscreenerPriceLamports(mintStr, decimals) {
  const res = await fetch(
    `https://api.dexscreener.com/tokens/v1/solana/${mintStr},${SOL_MINT}`,
    { signal: AbortSignal.timeout(7_000) },
  );
  if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`);
  const data = await res.json().catch(() => null);
  const pairs = Array.isArray(data) ? data : [];
  let bestToken = null, bestSol = null;
  for (const p of pairs) {
    const addr = p?.baseToken?.address;
    const liq = Number(p?.liquidity?.usd ?? 0);
    const priceUsd = parseFloat(p?.priceUsd ?? 0);
    if (!addr || !priceUsd) continue;
    if (addr === mintStr && (!bestToken || liq > bestToken.liq)) {
      bestToken = { priceUsd, liq };
    } else if (addr === SOL_MINT && (!bestSol || liq > bestSol.liq)) {
      bestSol = { priceUsd, liq };
    }
  }
  if (!bestToken) throw new Error("DexScreener missing price for mint");
  if (!bestSol) throw new Error("DexScreener missing price for SOL");
  // SECURITY (2026-06-28 audit): liquidity floor. The deepest DexScreener pool
  // for the mint must clear a minimum USD liquidity, else its price is too
  // cheap to manipulate (a few hundred $ of wash trades can spike a thin pool).
  // Since this read drives trigger detection + the trailing-stop peak ratchet,
  // a manipulable price could force premature/under-value fires. On a thin
  // pool we throw so the caller falls back to Jupiter (aggregated, far harder
  // to move). Tunable; default $5k.
  const DEX_MIN_LIQ_USD = Number(process.env.DEX_MIN_LIQUIDITY_USD) || 5000;
  if (bestToken.liq < DEX_MIN_LIQ_USD) {
    throw new Error(`DexScreener pool too thin ($${Math.round(bestToken.liq)} < $${DEX_MIN_LIQ_USD}) — untrusted for price`);
  }
  // priceLamportsPerRaw = (priceUsd / solUsd) / 10^decimals * 10^9
  const priceLamportsPerWhole = (bestToken.priceUsd / bestSol.priceUsd) * 1e9;
  const priceLamportsPerRaw = priceLamportsPerWhole / Math.pow(10, decimals);
  return { priceLamportsPerRaw, solUsd: bestSol.priceUsd };
}

/**
 * Cross-source agreement gate. Returns the agreed price or null when
 * sources disagree above MAX_DIVERGENCE. Mirrors the bot's
 * agreeOnPrice helper from src/services/price.js so engine + bot apply
 * the same fail-closed posture.
 */
const PRICE_MAX_DIVERGENCE = Number(process.env.PRICE_MAX_DIVERGENCE) || 0.05;
function agreeOnPrice(sources) {
  const valid = sources.filter((s) => s.price != null && s.price > 0);
  if (valid.length <= 1) return null;
  if (valid.length === 2) {
    const [a, b] = valid;
    const div = Math.abs(a.price - b.price) / Math.min(a.price, b.price);
    if (div <= PRICE_MAX_DIVERGENCE) {
      return { price: (a.price + b.price) / 2, agreed: [a.name, b.name], outlier: null };
    }
    return null;
  }
  const pairs = [
    [valid[0], valid[1]],
    [valid[0], valid[2]],
    [valid[1], valid[2]],
  ].map(([a, b]) => ({ a, b, div: Math.abs(a.price - b.price) / Math.min(a.price, b.price) }));
  pairs.sort((x, y) => x.div - y.div);
  const best = pairs[0];
  if (best.div > PRICE_MAX_DIVERGENCE) return null;
  const outlier = valid.find((s) => s.name !== best.a.name && s.name !== best.b.name);
  return {
    price: (best.a.price + best.b.price) / 2,
    agreed: [best.a.name, best.b.name],
    outlier: outlier?.name ?? null,
  };
}

// ── On-chain V4 TWAP fallback for the single-source case ──────────────────────
// V4-reliability (2026-06-21, operator-mandated). When DexScreener has NO pair
// for a thin memecoin, the fire previously hard-deferred forever — the user's
// armed exit never fired. Instead, cross-validate the LIVE Jupiter price against
// the ON-CHAIN V4 TWAP: a sudden single-source pump diverges from the lagged
// on-chain average, so we STILL never fire into a single-source pump (the exact
// $FATHER protection). Threshold matches the on-chain MAX_SPOT_VS_TWAP_PUMP_BPS
// guard. We reuse the BOT's already-verified /v4/twap decoder rather than
// re-implementing the on-chain ring-buffer layout here (the engine's own
// staleness watcher and the bot disagree on the offset — re-decoding on the
// fire path would be unsafe). Fully fail-safe: ANY gap (no HOCK_API_URL, bot
// unreachable, TWAP not warm, bad numbers, divergence too large) → defer.
const V4_TWAP_FALLBACK_MAX_DIVERGENCE =
  Number(process.env.V4_TWAP_FALLBACK_MAX_DIVERGENCE) || 0.15; // 15% ≈ on-chain MAX_SPOT_VS_TWAP_PUMP_BPS

async function validateJupiterAgainstOnChainV4Twap(mintStr, decimals, jupPriceLamportsPerRaw) {
  const botApi = process.env.HOCK_API_URL;
  if (!botApi) return { ok: false, reason: "no_bot_api_url" };
  let body;
  try {
    const res = await fetch(
      `${botApi}/api/v1/v4/twap?mint=${encodeURIComponent(mintStr)}&decimals=${decimals}`,
      { signal: AbortSignal.timeout(4000) },
    );
    if (!res.ok) return { ok: false, reason: `bot_twap_http_${res.status}` };
    body = await res.json();
  } catch (e) {
    return { ok: false, reason: `bot_twap_unreachable: ${(e?.message || "").slice(0, 60)}` };
  }
  if (!body || body.recommendation !== "use_precise_value") {
    return { ok: false, reason: `twap_not_ready: ${body?.recommendation ?? "?"}` };
  }
  const twapPerWhole = Number(body.twap_lamports_per_whole_token);
  if (!Number.isFinite(twapPerWhole) || twapPerWhole <= 0) {
    return { ok: false, reason: "twap_invalid" };
  }
  const twapPerRaw = twapPerWhole / Math.pow(10, decimals);
  if (!Number.isFinite(twapPerRaw) || twapPerRaw <= 0) {
    return { ok: false, reason: "twap_per_raw_invalid" };
  }
  const div = Math.abs(jupPriceLamportsPerRaw - twapPerRaw) / twapPerRaw;
  if (!Number.isFinite(div) || div > V4_TWAP_FALLBACK_MAX_DIVERGENCE) {
    return {
      ok: false,
      reason: `jupiter_vs_onchain_twap_div_${Number.isFinite(div) ? (div * 100).toFixed(1) : "NaN"}pct`,
    };
  }
  return { ok: true, twapPerRaw, divergence: div };
}

/**
 * Cross-sourced current-price read for the fire-time trigger check.
 *
 * Same fail-closed posture as the bot's getPriceInSolCrossSourced
 * (src/services/price.js). Runs Jupiter and DexScreener in parallel;
 * requires both to respond AND to agree within MAX_DIVERGENCE.
 *
 * On single-source response: throws UNLESS
 * ALLOW_SINGLE_SOURCE_PRICING=true. The watcher catches the throw,
 * leaves the order armed (firing deferred), and the next tick re-tries.
 *
 * On sources disagree: throws. The $FATHER incident showed that one
 * pumped DEX is enough to extract value if we accept it standalone —
 * firing into a pump on a single-source signal hands attackers an exit.
 *
 * Returns the same shape as the original getCurrentPrice for drop-in
 * replacement. The MC computation downstream uses solUsd from Jupiter
 * (the DexScreener path also returns solUsd; we prefer Jupiter's where
 * available because the existing MC calc was tuned against it).
 */

/**
 * Build the USD price fields carried on every currentPrice object.
 *
 * CRITICAL precision note (the $ANSEM missed-fire class, 2026-06-28):
 * the legacy `priceUsdMicrosPerRaw` rounds the per-RAW-unit USD price to
 * an integer number of micros. For ANY sub-$1 token with ≥6 decimals
 * that underflows to 0 — e.g. a 6-decimal memecoin at $0.083/whole has a
 * per-raw price of 8.3e-8 USD → ×1e6 = 0.083 micros → Math.round → 0.
 * Once that is 0, `computeMcMicros = 0 × supply = 0`, so market-cap reads
 * $0 and EVERY `mc_usd` take-profit / stop-loss trigger is un-fireable
 * (it can never satisfy `mc >= 32.3M`). This silently broke auto-sell
 * exits for essentially the entire memecoin book.
 *
 * Fix: additionally carry the per-WHOLE-token price (both float and
 * integer-micros). The whole-token price is ~10^decimals larger, so it
 * never underflows for realistic collateral, and MC/price triggers are
 * computed from it. The legacy per-raw field is retained for any external
 * consumer but is no longer used for trigger math.
 */
function usdPriceFields(priceLamportsPerRaw, solUsd, decimals) {
  const priceUsdPerRaw = (priceLamportsPerRaw * solUsd) / 1e9;
  const priceUsdPerWhole = priceUsdPerRaw * Math.pow(10, decimals);
  return {
    priceUsdMicrosPerRaw: Math.round(priceUsdPerRaw * 1e6), // legacy (lossy for cheap tokens)
    priceUsdPerWhole, // precise float, per displayed unit
    priceUsdMicrosPerWhole: Math.round(priceUsdPerWhole * 1e6), // precise int, per displayed unit
  };
}

export async function getCurrentPriceCrossSourced(connection, mintStr) {
  const info = await getMintInfo(connection, mintStr);

  // Jupiter (existing path)
  const jupiterPromise = (async () => {
    const sampleRaw = 10n ** BigInt(info.decimals);
    const solQuote = await jupiterQuote({
      inputMint: mintStr,
      outputMint: SOL_MINT,
      amountRaw: sampleRaw.toString(),
      slippageBps: 100,
    });
    const priceLamportsPerRaw = Number(solQuote.outAmountLamports) / Number(sampleRaw);
    const solUsdc = await jupiterQuote({
      inputMint: SOL_MINT,
      outputMint: USDC_MINT,
      amountRaw: (10n ** 9n).toString(),
      slippageBps: 50,
    });
    const solUsd = Number(solUsdc.outAmountLamports) / 1e6;
    return { priceLamportsPerRaw, solUsd };
  })();

  // DexScreener path
  const dexPromise = dexscreenerPriceLamports(mintStr, info.decimals);

  const [jupRes, dexRes] = await Promise.allSettled([jupiterPromise, dexPromise]);
  const jup = jupRes.status === "fulfilled" ? jupRes.value : null;
  const dex = dexRes.status === "fulfilled" ? dexRes.value : null;
  const jupErr = jupRes.status === "rejected" ? jupRes.reason?.message?.slice(0, 80) : null;
  const dexErr = dexRes.status === "rejected" ? dexRes.reason?.message?.slice(0, 80) : null;

  const respondingCount = (jup ? 1 : 0) + (dex ? 1 : 0);
  if (respondingCount === 0) {
    throw new Error(`No fire-time price data for ${mintStr.slice(0, 8)} (jup=${jupErr ?? "n/a"}; dex=${dexErr ?? "n/a"})`);
  }
  if (respondingCount === 1) {
    const survivor = jup ?? dex;
    const survivorName = jup ? "Jupiter" : "DexScreener";
    const downName = jup ? "DexScreener" : "Jupiter";
    if (process.env.ALLOW_SINGLE_SOURCE_PRICING === "true") {
      console.warn(`[pricing] SINGLE-SOURCE fire allowed for ${mintStr.slice(0, 8)} via ${survivorName} (${downName} down). Security posture degraded.`);
      return {
        priceLamportsPerRaw: survivor.priceLamportsPerRaw,
        ...usdPriceFields(survivor.priceLamportsPerRaw, survivor.solUsd, info.decimals),
        solUsd: survivor.solUsd,
        info,
        crossSource: { single: survivorName, missing: downName },
      };
    }
    // V4-reliability (2026-06-21): DexScreener missing (Jupiter survived) — do
    // NOT hard-defer forever. Validate live Jupiter against the on-chain V4 TWAP
    // (manipulation-resistant). If it agrees within the pump threshold, fire;
    // otherwise defer. We never fire on a single UNVALIDATED source. (Only the
    // Jupiter-survives direction: if Jupiter is the one down, the attestor that
    // fills the TWAP is Jupiter-based too, so the TWAP would be stale — defer.)
    if (jup && !dex) {
      const twap = await validateJupiterAgainstOnChainV4Twap(mintStr, info.decimals, jup.priceLamportsPerRaw);
      if (twap.ok) {
        console.warn(
          `[pricing] ${mintStr.slice(0, 8)} DexScreener missing — firing via Jupiter ` +
            `validated by on-chain V4 TWAP (div=${(twap.divergence * 100).toFixed(1)}% ≤ ${(V4_TWAP_FALLBACK_MAX_DIVERGENCE * 100).toFixed(0)}%)`,
        );
        return {
          priceLamportsPerRaw: jup.priceLamportsPerRaw,
          ...usdPriceFields(jup.priceLamportsPerRaw, jup.solUsd, info.decimals),
          solUsd: jup.solUsd,
          info,
          crossSource: { single: "Jupiter", missing: "DexScreener", validatedBy: "onchain_v4_twap", twapDivergence: twap.divergence },
        };
      }
      throw new Error(
        `Fire-time single-source: only Jupiter responded (DexScreener missing) and on-chain V4 TWAP validation failed (${twap.reason}) — deferring fire.`,
      );
    }
    throw new Error(`Fire-time price single-source — only ${survivorName} responded (${downName} down). Defer until both available.`);
  }

  // Both responded — agreement check
  const agreed = agreeOnPrice([
    { name: "Jupiter",     price: jup.priceLamportsPerRaw },
    { name: "DexScreener", price: dex.priceLamportsPerRaw },
  ]);
  if (!agreed) {
    const jupP = jup.priceLamportsPerRaw.toExponential(4);
    const dexP = dex.priceLamportsPerRaw.toExponential(4);
    throw new Error(`Fire-time price sources disagree for ${mintStr.slice(0, 8)} (jup=${jupP}, dex=${dexP}). Above ${(PRICE_MAX_DIVERGENCE * 100).toFixed(0)}% threshold — deferring fire.`);
  }
  // Both agreed. Use the agreed avg as the price. SOL/USD prefer Jupiter
  // (consistent with how the original MC calc was tuned).
  const priceLamportsPerRaw = agreed.price;
  const solUsd = jup.solUsd;
  return {
    priceLamportsPerRaw,
    ...usdPriceFields(priceLamportsPerRaw, solUsd, info.decimals),
    solUsd,
    info,
    crossSource: { agreed: agreed.agreed.join("+"), outlier: agreed.outlier },
  };
}

export async function getCurrentPrice(connection, mintStr) {
  const info = await getMintInfo(connection, mintStr);

  // ── TRIGGER-DETECTION read: DexScreener PRIMARY, Jupiter FALLBACK ──
  // (2026-06-28, the $ANSEM 87.2M live-fire incident.) The watcher polls
  // EVERY armed order EVERY tick through this function. Routing those
  // high-frequency reads through Jupiter's FREE tier (single host egress
  // IP, no API key) 429-starved the read path: 99.9% of armed-order
  // evaluations (146,496/146,600 in 24h) errored on Jupiter 429, so the
  // watcher could not read a price to detect a crossing — an armed order
  // whose mc trigger was already MET silently never fired. DexScreener has
  // far more generous limits AND returns the same liquidity-weighted price
  // the user sees as "market cap" when they arm. Using it for DETECTION
  // also FREES Jupiter's quota for the actual fire (the swap CPI + the
  // strict cross-source re-check still run via getCurrentPriceCrossSourced
  // in execution.js before any sell — detection here never sells on a
  // single source). Jupiter remains the fallback when DexScreener has no
  // pair for the mint.
  try {
    const dex = await dexscreenerPriceLamports(mintStr, info.decimals); // { priceLamportsPerRaw, solUsd }
    if (Number.isFinite(dex.priceLamportsPerRaw) && dex.priceLamportsPerRaw > 0) {
      return {
        priceLamportsPerRaw: dex.priceLamportsPerRaw,
        ...usdPriceFields(dex.priceLamportsPerRaw, dex.solUsd, info.decimals),
        solUsd: dex.solUsd,
        info,
        source: "dexscreener",
      };
    }
  } catch (_dexErr) {
    // fall through to Jupiter
  }

  // FALLBACK: Jupiter (DexScreener had no pair / returned a bad price).
  const sampleRaw = 10n ** BigInt(info.decimals);
  const solQuote = await jupiterQuote({
    inputMint: mintStr,
    outputMint: SOL_MINT,
    amountRaw: sampleRaw.toString(),
    slippageBps: 100,
  });
  const priceLamportsPerRaw = Number(solQuote.outAmountLamports) / Number(sampleRaw);
  const solUsdc = await jupiterQuote({
    inputMint: SOL_MINT,
    outputMint: USDC_MINT,
    amountRaw: (10n ** 9n).toString(),
    slippageBps: 50,
  });
  const solUsd = Number(solUsdc.outAmountLamports) / 1e6;
  return {
    priceLamportsPerRaw,
    ...usdPriceFields(priceLamportsPerRaw, solUsd, info.decimals),
    solUsd,
    info,
    source: "jupiter_fallback",
  };
}

/**
 * Compute current market cap in USD micros.
 *
 * MC = price_per_displayed_token × total_supply_in_displayed_units.
 *
 * PRECISION (the $ANSEM missed-fire class, 2026-06-28): the original
 * implementation used `priceUsdMicrosPerRaw × supply`. Because
 * `priceUsdMicrosPerRaw` rounds the per-RAW-unit price to integer micros,
 * it underflows to 0 for any sub-$1 token (see `usdPriceFields`), making
 * MC read $0 and every `mc_usd` trigger un-fireable. We now compute MC
 * from the per-WHOLE-token price, which never underflows:
 *
 *   MC_usd      = priceUsdPerWhole × (supply / 10^decimals)
 *   MC_micros   = round(MC_usd × 1e6)
 *
 * The per-whole price is the precise float carried on currentPrice. The
 * legacy per-raw path is kept only as a defensive fallback for any caller
 * that hasn't been migrated; it must never be the silent default.
 */
export function computeMcMicros({ priceUsdPerWhole, priceUsdMicrosPerRaw, supply, decimals }) {
  if (
    typeof priceUsdPerWhole === "number" &&
    Number.isFinite(priceUsdPerWhole) &&
    priceUsdPerWhole > 0 &&
    decimals != null
  ) {
    const wholeSupply = Number(supply) / Math.pow(10, Number(decimals));
    const mcUsd = priceUsdPerWhole * wholeSupply;
    if (Number.isFinite(mcUsd) && mcUsd >= 0) {
      return BigInt(Math.round(mcUsd * 1e6));
    }
  }
  // Legacy fallback (lossy for cheap tokens). Reached only if the precise
  // per-whole price is absent — should not happen post-migration.
  return BigInt(priceUsdMicrosPerRaw || 0) * supply;
}

/**
 * Trigger evaluation — pure function.
 * Returns true if the trigger condition is currently met.
 *
 * trigger_kind:
 *   'mc_usd'    — MC vs trigger_value (in USD micros)
 *   'price_usd' — price vs trigger_value (in USD micros per displayed unit)
 *   'price_sol' — price vs trigger_value (in lamports per displayed unit)
 *
 * trigger_direction:
 *   'above' (default, take-profit) — fires when current >= trigger
 *   'below' (stop-loss)            — fires when current <= trigger
 *
 * Direction is read from the limit_close_orders row (defaults 'above'
 * via an earlier migration, preserving prior take-profit
 * semantics for all pre-migration rows). 1% protocol fee applies in
 * both directions — computed on PROCEEDS in execution.js, so already
 * direction-agnostic; no fee code changes here.
 */
/**
 * Compute the CURRENT price in the same micro-units the trigger uses.
 *
 * Trailing-stop logic needs to compare current price to a moving peak —
 * isTriggerHit already does this internally but it returns a boolean.
 * For trailing we also need to STORE the peak in micro-units, so we
 * expose the units-conversion via this helper. Returns null for the
 * price_sol kind (the SOL denominator moves so trailing on price_sol
 * is brittle and not worth the surface area).
 */
export function currentPriceMicros(trigger_kind, currentPrice) {
  if (!currentPrice) return null;
  if (trigger_kind === "mc_usd") {
    return computeMcMicros({
      priceUsdPerWhole: currentPrice.priceUsdPerWhole,
      priceUsdMicrosPerRaw: currentPrice.priceUsdMicrosPerRaw,
      supply: currentPrice.info.supply,
      decimals: currentPrice.info.decimals,
    });
  }
  if (trigger_kind === "price_usd") {
    // priceUsdMicrosPerWhole is already per displayed unit in USD micros —
    // the precise field. Fall back to the legacy per-raw conversion only
    // if it's absent.
    if (currentPrice.priceUsdMicrosPerWhole != null) {
      return BigInt(currentPrice.priceUsdMicrosPerWhole);
    }
    return BigInt(currentPrice.priceUsdMicrosPerRaw) * (10n ** BigInt(currentPrice.info.decimals));
  }
  // price_sol intentionally unsupported for trailing.
  return null;
}

export function isTriggerHit({ trigger_kind, trigger_value_micro, trigger_direction = "above", currentPrice }) {
  const tv = BigInt(trigger_value_micro);
  const cmp = (current) => trigger_direction === "below" ? current <= tv : current >= tv;
  if (trigger_kind === "mc_usd") {
    const mc = computeMcMicros({
      priceUsdPerWhole: currentPrice.priceUsdPerWhole,
      priceUsdMicrosPerRaw: currentPrice.priceUsdMicrosPerRaw,
      supply: currentPrice.info.supply,
      decimals: currentPrice.info.decimals,
    });
    return cmp(mc);
  }
  if (trigger_kind === "price_usd") {
    // Trigger is per displayed unit in USD micros. priceUsdMicrosPerWhole
    // is exactly that (precise). Fall back to the legacy per-raw × 10^dec
    // conversion only when the precise field is absent.
    const priceMicrosPerDisplayed =
      currentPrice.priceUsdMicrosPerWhole != null
        ? BigInt(currentPrice.priceUsdMicrosPerWhole)
        : BigInt(currentPrice.priceUsdMicrosPerRaw) * (10n ** BigInt(currentPrice.info.decimals));
    return cmp(priceMicrosPerDisplayed);
  }
  if (trigger_kind === "price_sol") {
    // priceLamportsPerRaw × 10^decimals = lamports per displayed unit.
    // Use Math here because priceLamportsPerRaw can be fractional.
    const priceLamportsPerDisplayed = currentPrice.priceLamportsPerRaw * (10 ** currentPrice.info.decimals);
    return cmp(BigInt(Math.round(priceLamportsPerDisplayed)));
  }
  // Unknown trigger kind — fail closed (never fire).
  return false;
}
