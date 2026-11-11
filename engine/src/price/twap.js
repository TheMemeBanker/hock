/**
 * TWAP slicing fallback for limit-close orders.
 *
 * When a single-block sell can't clear within the borrower's slippage
 * cap, the engine slices the position into N chunks and processes them
 * over time. Each chunk has less price impact than the full position
 * → each chunk clears within the cap → the whole order eventually
 * fills. Total window is ~2 minutes (4 chunks × 30s) by default.
 *
 * State machine for a TWAP order:
 *
 *   firing
 *     → (single-block fails at cap) → twap_in_progress (chunks_completed=0)
 *       → (each chunk swap) → twap_in_progress (chunks_completed++)
 *         → (final chunk done) → fired
 *         → (chunk retry exhausted OR no route)
 *             → awaiting_user (if user_intervention available)
 *             → partial_fired (if any proceeds landed)
 *             → failed (if zero proceeds)
 *
 * Resilience:
 *   - State persisted in DB so a crash mid-TWAP is recoverable. On
 *     restart, the watcher reads twap_in_progress orders and resumes
 *     from twap_chunks_completed + the user's actual ATA balance.
 *   - Each chunk transition is a single atomic UPDATE with
 *     CHECK-constrained columns. No way to land in an inconsistent
 *     intermediate state via partial writes.
 *   - The repay tx happens BEFORE TWAP starts. After repay the
 *     collateral is in the user's ATA — we never need to "undo" a
 *     repay if TWAP fails midway. Worst case: user has partial SOL
 *     + remaining collateral in their wallet.
 *
 * Security:
 *   - Chunk count + interval are server-side constants. The order's
 *     borrower-set slippage cap (max_slippage_bps_cap) is the actual
 *     guarantee — the engine never widens it for TWAP. If individual
 *     chunks don't fit at the cap either, we transition to
 *     awaiting_user (Layer 3), never silently expand the cap.
 *   - MEV exposure is real for multi-tx execution. Mitigation: cap is
 *     still load-bearing per chunk, so an MEV bot can't push beyond
 *     the borrower's stated worst-case-acceptable-price. Smaller
 *     chunks also mean smaller individual MEV targets.
 */
import { query } from "../TODO-hock/db.js";

// Server-side constants. Not borrower-configurable in v1 — TWAP is
// the engine's automatic recovery, not a knob.
export const TWAP_DEFAULT_CHUNKS = 4;
export const TWAP_CHUNK_INTERVAL_MS = 30_000;
export const TWAP_MAX_CHUNK_RETRIES = 2;
export const TWAP_WINDOW_MAX_MS = 10 * 60_000; // entire TWAP must finish within 10 min

/**
 * Begin a TWAP for an order that just got past single-block but
 * couldn't clear the proceeds check at the cap. Sets up the
 * twap_chunks_total, twap_started_at, status='twap_in_progress'.
 *
 * Atomic: only flips firing → twap_in_progress when current status
 * IS 'firing'. A concurrent revert or cancel would lose the race
 * here and the TWAP setup becomes a no-op.
 *
 * Returns { ok: true, chunks } on a successful start; { ok: false,
 * reason } if the race was lost or input invalid.
 */
export async function startTwap(orderId, opts = {}) {
  const chunks = Number.isInteger(opts.chunks) && opts.chunks > 0
    ? Math.min(opts.chunks, 10)
    : TWAP_DEFAULT_CHUNKS;

  const r = await query(
    `UPDATE limit_close_orders
        SET status = 'twap_in_progress',
            twap_chunks_total = $2,
            twap_chunks_completed = 0,
            twap_started_at = NOW(),
            twap_last_chunk_at = NULL,
            twap_proceeds_accumulated_lamports = 0,
            twap_tx_signatures = ARRAY[]::TEXT[]
      WHERE id = $1
        AND status = 'firing'
        AND twap_chunks_completed = 0
      RETURNING id, twap_chunks_total`,
    [orderId, chunks],
  );
  if (r.rows.length === 0) {
    return { ok: false, reason: "race_lost_or_not_firing" };
  }
  return { ok: true, chunks: r.rows[0].twap_chunks_total };
}

/**
 * Atomically record the result of a single chunk's swap.
 *
 * Increments twap_chunks_completed, appends the tx signature, adds
 * to twap_proceeds_accumulated_lamports, and sets twap_last_chunk_at
 * to NOW so the watcher knows when the next chunk is due.
 *
 * The WHERE clause requires the row to still be twap_in_progress
 * AND the chunks_completed to match the caller's prior_count — this
 * is the lost-update guard so two ticks can't double-credit the
 * same chunk.
 *
 * Returns { ok: true, chunks_completed_now, total } or { ok: false }.
 */
export async function recordChunk({
  orderId,
  priorCount,
  swapSignature,
  proceedsLamports,
}) {
  // Reset twap_consecutive_failures on success — the counter is
  // 'consecutive failures since last successful chunk', so a chunk
  // that lands clears the streak.
  const r = await query(
    `UPDATE limit_close_orders
        SET twap_chunks_completed = twap_chunks_completed + 1,
            twap_proceeds_accumulated_lamports =
              twap_proceeds_accumulated_lamports + $3::numeric,
            twap_tx_signatures =
              array_append(COALESCE(twap_tx_signatures, ARRAY[]::TEXT[]), $4),
            twap_last_chunk_at = NOW(),
            twap_consecutive_failures = 0
      WHERE id = $1
        AND status = 'twap_in_progress'
        AND twap_chunks_completed = $2
      RETURNING twap_chunks_completed, twap_chunks_total`,
    [orderId, priorCount, proceedsLamports.toString(), swapSignature],
  );
  if (r.rows.length === 0) return { ok: false, reason: "lost_update" };
  return {
    ok: true,
    chunks_completed_now: r.rows[0].twap_chunks_completed,
    total: r.rows[0].twap_chunks_total,
  };
}

/**
 * Compute the chunk size for the NEXT chunk based on what's still
 * in the user's ATA. We don't divide by twap_chunks_total once and
 * cache the chunk size, because:
 *
 *   1. ScaledUiAmount mints + transfer-fee mints can shrink balances
 *      between chunks; reading actual ATA balance each time keeps us
 *      honest.
 *   2. If a chunk failed and we retry, the size of what's "next"
 *      depends on what's "remaining" not "originally planned."
 *
 * remaining_balance / (total - completed) = next chunk size
 */
export function computeNextChunkSize({ remainingBalance, chunksTotal, chunksCompleted }) {
  if (chunksCompleted >= chunksTotal) return 0n;
  const slotsLeft = BigInt(chunksTotal - chunksCompleted);
  return remainingBalance / slotsLeft;
}

/**
 * Basis points of ORIGINAL collateral to sell on the CURRENT V4 TWAP chunk.
 *
 * Splits `slicePct` (total bps to sell across the whole order, e.g. 10000 =
 * 100%) across `total` chunks so the chunks sum to EXACTLY `slicePct`: every
 * chunk gets floor(slicePct / total), and the LAST chunk (done === total - 1)
 * takes the remainder so rounding never loses or gains bps. `done` is the count
 * of chunks already completed (0-indexed index of the current chunk); returns 0
 * once done >= total. Callers (execution.js processV4Chunk) additionally cap the
 * fire count at `total` via the completed counter, so the order can never sell
 * more than slicePct. See MF-5.
 */
export function chunkBpsForV4(slicePct, total, done) {
  const s = Math.max(0, Math.floor(Number(slicePct) || 0));
  const t = Math.max(1, Math.floor(Number(total) || 1));
  const d = Math.max(0, Math.floor(Number(done) || 0));
  if (d >= t) return 0;
  const base = Math.floor(s / t);
  // Last chunk absorbs the rounding remainder so the chunks sum to exactly s.
  return d === t - 1 ? s - base * (t - 1) : base;
}

/**
 * Decide if a TWAP order is due for its next chunk based on
 * twap_last_chunk_at + the interval. First chunk fires immediately
 * (twap_last_chunk_at is NULL right after startTwap).
 */
export function isChunkDue(row, nowMs = Date.now()) {
  if (!row.twap_last_chunk_at) return true; // first chunk
  const last = new Date(row.twap_last_chunk_at).getTime();
  return nowMs - last >= TWAP_CHUNK_INTERVAL_MS;
}

/**
 * Mark TWAP as finished — all chunks done. Transitions to 'fired'
 * if any proceeds landed; otherwise 'failed'. Sets the standard
 * post-fire columns (tx_signature_swap = first chunk's sig as the
 * "anchor" tx, proceeds_lamports = accumulated total).
 *
 * Atomic on status='twap_in_progress' so a concurrent cancel /
 * intervention can't lose data here.
 */
export async function finalizeTwap({
  orderId,
  repaySig,
  txSignatures,
  totalProceedsLamports,
  protocolFeeLamports,
  netToUserLamports,
  loanOwedLamports,
  allChunksFilled,
}) {
  const newStatus = totalProceedsLamports === 0n
    ? "failed"
    : allChunksFilled ? "fired" : "partial_fired";

  const r = await query(
    `UPDATE limit_close_orders
        SET status = $2,
            fired_at = NOW(),
            tx_signature_repay = $3,
            tx_signature_swap = $4,
            proceeds_lamports = $5::numeric,
            protocol_fee_lamports = $6::numeric,
            net_to_user_lamports = $7::numeric,
            loan_owed_at_fire_lamports = $8::numeric
      WHERE id = $1
        AND status = 'twap_in_progress'
      RETURNING id`,
    [orderId, newStatus, repaySig, txSignatures[0] || null,
     totalProceedsLamports.toString(),
     protocolFeeLamports.toString(),
     netToUserLamports.toString(),
     loanOwedLamports.toString()],
  );
  return { ok: r.rows.length > 0, status: newStatus };
}

/**
 * Fetch in-flight TWAP orders for the watcher to process.
 * Picks rows that are due for their next chunk per isChunkDue.
 */
export async function fetchTwapInProgress() {
  const { rows } = await query(
    `SELECT id, loan_id, slippage_bps, sell_destination,
            protocol_fee_bps, source, source_agent_pubkey,
            tx_signature_repay,
            twap_chunks_total, twap_chunks_completed,
            twap_proceeds_accumulated_lamports::text AS twap_proceeds_acc,
            twap_last_chunk_at, twap_started_at,
            twap_tx_signatures,
            max_slippage_bps_cap,
            engine_topup_lamports::text AS engine_topup_lamports
       FROM limit_close_orders
      WHERE status = 'twap_in_progress'
      ORDER BY twap_last_chunk_at NULLS FIRST`,
  );
  return rows;
}

/**
 * Abort TWAP — used by the watcher when a chunk repeatedly fails to
 * fit at the cap (Layer 3 condition: needs user intervention) OR
 * when the global TWAP window has elapsed.
 *
 * If any proceeds have accumulated, status → partial_fired so the
 * user gets credit for what landed. Otherwise status → failed.
 *
 * The two cases use different reasons so post-mortem inspection is
 * unambiguous.
 */
export async function abortTwap({ orderId, reason, accumulated }) {
  const newStatus = accumulated > 0n ? "partial_fired" : "failed";
  await query(
    `UPDATE limit_close_orders
        SET status = $2,
            failure_reason = $3
      WHERE id = $1
        AND status = 'twap_in_progress'`,
    [orderId, newStatus, reason],
  );
  return { newStatus };
}
