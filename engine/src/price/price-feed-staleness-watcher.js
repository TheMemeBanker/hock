/**
 * Per-mint price feed staleness watcher.
 *
 * Mandated by [[feedback_v4_security_relentless]] + [[feedback_focus_on_v4_flawless]].
 *
 * Mission: catch a degraded price-attestor BEFORE users hit
 * "StalePriceAttestation" errors. The bot's price-attestor pushes
 * fresh samples to each mint's on-chain PriceHistory PDA on a
 * cadence; if that service degrades (Jupiter rate-limit, RPC fail,
 * crash, network blip), feeds go stale silently — and the next
 * user borrow / V4 fire fails the on-chain freshness check.
 *
 * What this watcher does (purely observational):
 *   1. Every PRICE_FEED_STALENESS_INTERVAL_MS (default 5 min):
 *      enumerate all enabled supported_mints rows.
 *   2. For each mint, derive the PriceHistory PDA on V1/V2/V3/V4 pools
 *      and fetch the latest on-chain sample's timestamp.
 *   3. Compute age = now - sample.timestamp.
 *   4. If age > WARN_AGE (5 min): log warning.
 *   5. If age > ALERT_AGE (10 min): enqueue operator DM.
 *   6. If age > P0_AGE (30 min): enqueue P0 operator DM.
 *
 * Does NOT block fires or borrows — those have their own pre-flight
 * stale-oracle checks. This is a proactive observability layer so
 * the operator sees degradation in real time, not after first failure.
 */
import { query } from "../TODO-hock/db.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { makeConnection } from "../rpc/rpc.js";

// 2026-06-17 — operator-mandated urgency tightening
// (feedback_time_triggers_aggressive_urgency.md). 5 min was too slow
// for a watcher that gates V4 fires: a stale oracle for 5 min could
// span a full memecoin trigger crossing. Drop to 2 min. RPC load:
// ~10 mints × 4 program PDAs × getAccountInfo = 40 calls / 2 min =
// 20/min — well within budget.
const PRICE_FEED_STALENESS_INTERVAL_MS = Number(
  process.env.PRICE_FEED_STALENESS_INTERVAL_MS || 2 * 60 * 1000,
);
const PRICE_FEED_WARN_AGE_SECONDS = Number(
  process.env.PRICE_FEED_WARN_AGE_SECONDS || 5 * 60,
);
const PRICE_FEED_ALERT_AGE_SECONDS = Number(
  process.env.PRICE_FEED_ALERT_AGE_SECONDS || 10 * 60,
);
const PRICE_FEED_P0_AGE_SECONDS = Number(
  process.env.PRICE_FEED_P0_AGE_SECONDS || 30 * 60,
);

let _timer = null;
let _alerted = new Map(); // mint -> last_alert_ts (to throttle DMs)
const ALERT_THROTTLE_MS = 30 * 60 * 1000; // re-alert at most every 30 min per mint

export function startPriceFeedStalenessWatcher() {
  if (_timer) return;
  // First run after 3 min so the boot storm settles.
  setTimeout(() => {
    runOnce().catch((e) =>
      console.warn(`[price-feed-staleness] first run failed: ${e.message?.slice(0, 160)}`),
    );
    _timer = setInterval(() => {
      runOnce().catch((e) =>
        console.warn(`[price-feed-staleness] tick failed: ${e.message?.slice(0, 160)}`),
      );
    }, PRICE_FEED_STALENESS_INTERVAL_MS);
  }, 180_000);
  console.log(
    `[price-feed-staleness] armed — first run in 180s, then every ${Math.round(PRICE_FEED_STALENESS_INTERVAL_MS / 1000)}s`,
  );
}

export function stopPriceFeedStalenessWatcher() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

async function runOnce() {
  const connection = makeConnection(
    process.env.HELIUS_RPC_URL || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  );

  // Enabled mints, sorted by most-recently borrowed first (those matter
  // most for active loans).
  const { rows: mints } = await query(
    `SELECT mint, symbol
       FROM supported_mints
      WHERE enabled = true
      LIMIT 100`,
  );

  // Resolve which programs each mint has a price feed under. The price
  // feed PDA seeds are `[b"price_v3", mint, pool]`. We probe V4 first
  // (most active path); fall back to V3, V2, V1.
  const PROGRAMS_TO_PROBE = [
    process.env.PROGRAM_ID_V4,
    process.env.PROGRAM_ID_V3,
    process.env.PROGRAM_ID_V2,
    process.env.PROGRAM_ID,
  ].filter(Boolean);

  if (PROGRAMS_TO_PROBE.length === 0) return;

  const LENDER = new PublicKey(process.env.LENDER_PUBKEY);

  const now = Math.floor(Date.now() / 1000);
  const stale = [];

  for (const m of mints) {
    let mintPk;
    try {
      mintPk = new PublicKey(m.mint);
    } catch {
      continue;
    }
    let latestTs = 0;
    for (const progIdStr of PROGRAMS_TO_PROBE) {
      try {
        const progId = new PublicKey(progIdStr);
        const [pool] = PublicKey.findProgramAddressSync(
          [Buffer.from("pool"), LENDER.toBuffer()],
          progId,
        );
        const [priceFeed] = PublicKey.findProgramAddressSync(
          [Buffer.from("price_v3"), mintPk.toBuffer(), pool.toBuffer()],
          progId,
        );
        const acc = await connection.getAccountInfo(priceFeed);
        if (!acc?.data || acc.data.length < 200) continue;
        // PriceHistory layout (see the lending program lib.rs):
        //   8 disc + 32 mint + 32 pool + 32 auth + 1 head + 1 count
        //   + 6 padding + samples[10] (16 bytes each = 160) + 1 bump
        // = 273. The latest sample lives at samples[(head-1+10)%10].
        const buf = acc.data;
        // AUTHORITATIVE layout (lending program lib.rs `PriceHistory`):
        //   8 disc + mint(32) + pool(32) + authority(32)
        //   + head_index u8 @104 + count u8 @105 + _padding[6]
        //   + samples[PRICE_HISTORY_CAPACITY=32] @112 (PriceSample = 16 bytes).
        //   Newest sample = samples[(head_index - 1 + 32) % 32].
        // The previous code read head/count at @112/@113 (actually the first
        // sample's price bytes) over a 10-slot ring — BOTH wrong. It therefore
        // mis-read the timestamp of a stale/empty slot and produced FALSE-POSITIVE
        // staleness (flagged PUMP as stale while the bot's verified /v4/twap
        // decoder reported it fresh). Now matches that verified decoder.
        const CAP = 32;
        const headIndex = buf[104];
        const count = buf[105];
        if (count === 0) continue;
        const idx = (headIndex - 1 + CAP) % CAP;
        const sampleOffset = 8 + 32 + 32 + 32 + 1 + 1 + 6 + idx * 16; // = 112 + idx*16
        if (sampleOffset + 16 > buf.length) continue;
        // PriceSample: price_lamports u64 (8) + timestamp i64 (8)
        const ts = Number(buf.readBigInt64LE(sampleOffset + 8));
        if (ts > latestTs) latestTs = ts;
      } catch {
        /* swallow — try next program */
      }
    }
    if (latestTs === 0) continue;
    const age = now - latestTs;
    if (age > PRICE_FEED_WARN_AGE_SECONDS) {
      stale.push({ mint: m.mint, symbol: m.symbol, age_seconds: age });
    }
  }

  if (stale.length === 0) return;

  console.warn(
    `[price-feed-staleness] ${stale.length} mints with stale feeds: ` +
      stale
        .slice(0, 8)
        .map((s) => `${s.symbol || s.mint.slice(0, 6)}=${s.age_seconds}s`)
        .join(" "),
  );

  // DM operator for ALERT and P0 levels, throttled per-mint.
  // These are OPERATOR (feed-level) alerts, not per-user DMs. pending_notifications
  // .user_id is NOT NULL, so userId:null failed the insert EVERY tick — the
  // operator never received a stale-feed alert and the logs spammed
  // "null value in column user_id" (V4-reliability fix 2026-06-21). Route to the
  // operator's user_id exactly like preflight.js does; if it isn't configured,
  // log the alert instead of attempting an insert that can never satisfy the
  // constraint.
  const { enqueueNotification } = await import("../TODO-hock/notifications.js");
  const operatorUserId = Number(process.env.OPERATOR_USER_ID);
  const operatorConfigured = Number.isFinite(operatorUserId) && operatorUserId > 0;

  // RELEVANCE FILTER (V4-reliability 2026-06-21): only DM the operator for feeds
  // that actually matter to THIS engine — those backing an armed/firing V4 exit.
  // A cold enabled mint nobody is borrowing has a deliberately-stale feed (warmed
  // JIT at borrow time), so DM-ing all ~70 of them is pure noise. The WARN log
  // above still lists EVERY stale feed for attestor-health visibility; only the
  // operator DM is scoped. If the relevance query fails we fall back to alerting
  // on all (better noisy than a missed real alert).
  let relevantMints = null;
  try {
    const { rows: rel } = await query(
      `SELECT DISTINCT l.collateral_mint
         FROM loans l
         JOIN limit_close_orders lc ON lc.loan_id = l.id
        WHERE lc.status IN ('armed', 'firing', 'twap_in_progress')`,
    );
    relevantMints = new Set(rel.map((r) => r.collateral_mint));
  } catch (e) {
    console.warn(`[price-feed-staleness] relevance query failed (${e.message?.slice(0, 80)}) — alerting on all stale feeds this tick`);
  }

  for (const s of stale) {
    if (s.age_seconds <= PRICE_FEED_ALERT_AGE_SECONDS) continue;
    // Skip the operator DM for feeds backing no armed/firing exit — cold mints
    // warmed on demand, not a live execution risk for this engine.
    if (relevantMints && !relevantMints.has(s.mint)) continue;
    const lastAlertTs = _alerted.get(s.mint) || 0;
    if (Date.now() - lastAlertTs < ALERT_THROTTLE_MS) continue;
    const level = s.age_seconds > PRICE_FEED_P0_AGE_SECONDS ? "p0" : "alert";
    if (!operatorConfigured) {
      console.warn(
        `[price-feed-staleness] OPERATOR_USER_ID not set — ${level.toUpperCase()} stale feed ` +
          `${s.symbol || s.mint.slice(0, 8)} age=${s.age_seconds}s (no DM sent; set OPERATOR_USER_ID to receive alerts)`,
      );
      _alerted.set(s.mint, Date.now());
      continue;
    }
    try {
      await enqueueNotification({
        userId: operatorUserId,
        kind: "price_feed_staleness",
        payload: {
          mint: s.mint,
          symbol: s.symbol,
          age_seconds: s.age_seconds,
          level,
          remedy:
            "check price-attestor logs (bot service). If down, restart; if up, check Jupiter/DexScreener rate limit + RPC health.",
        },
      });
      _alerted.set(s.mint, Date.now());
    } catch (e) {
      console.warn(`[price-feed-staleness] DM enqueue failed for ${s.mint}: ${e.message?.slice(0, 100)}`);
    }
  }
}
