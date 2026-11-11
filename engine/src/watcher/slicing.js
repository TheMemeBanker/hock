/**
 * Slice sizing and quoting shared by the watcher, the dry-run probe and the
 * canary. Pure arithmetic in BigInt plus one Jupiter quote call.
 *
 * planSlice decides how many bps of ORIGINAL collateral the next
 * convert_collateral_slice should take:
 *   - enough to cover (repay_amount - sol_proceeds_amount) after the 1%
 *     protocol skim and the protocol slippage ceiling,
 *   - never more than armed_max_slice_bps (single-fire cap),
 *   - never more than armed_total_bps - armed_converted_bps (aggregate cap),
 *   - never more than the remaining collateral,
 *   - at most WATCHER_MAX_SLICE_BPS per fire (TWAP-sized chunks, default 2500).
 */
import { PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { jupiterQuote } from "../price/pricing.js";
import { BPS_DENOM, MAX_PROTOCOL_SLIPPAGE_BPS, PROTOCOL_FEE_BPS_AUTOSELL, mintTokenProgram } from "../chain/program.js";

export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const WATCHER_MAX_SLICE_BPS = Number(process.env.WATCHER_MAX_SLICE_BPS) || 2_500;
export const WATCHER_SLIPPAGE_BPS = Number(process.env.WATCHER_SLIPPAGE_BPS) || 300;

const _dec = new Map();
export async function getMintDecimals(conn, mint) {
  const key = String(mint);
  if (_dec.has(key)) return _dec.get(key);
  const program = await mintTokenProgram(conn, key);
  const m = await getMint(conn, new PublicKey(key), "confirmed", program);
  _dec.set(key, m.decimals);
  return m.decimals;
}

export function bigint(v) {
  return BigInt(typeof v === "object" && v !== null && v.toString ? v.toString() : v);
}

export function planSlice({ chainLoan, feed, decimals, maxSliceBps = WATCHER_MAX_SLICE_BPS }) {
  const collateral = bigint(chainLoan.collateralAmount);
  const remaining = bigint(chainLoan.currentCollateralAmount);
  const owed = bigint(chainLoan.repayAmount);
  const proceeds = bigint(chainLoan.solProceedsAmount);
  const armedMax = Number(chainLoan.armedMaxSliceBps);
  const armedTotal = Number(chainLoan.armedTotalBps);
  const converted = Number(chainLoan.armedConvertedBps);
  const overdue = Math.floor(Date.now() / 1000) > Number(chainLoan.dueTimestamp);

  if (collateral === 0n || remaining === 0n) return { sliceBps: 0, reason: "collateral_exhausted" };
  const needed = owed > proceeds ? owed - proceeds : 0n;
  if (needed === 0n) return { sliceBps: 0, reason: "principal_covered" };

  // Conservative valuation (same as the program floor): min(spot, twap).
  const spot = feed.latest.price;
  const price = feed.twap != null && feed.twap < spot ? feed.twap : spot;
  if (price === 0n) return { sliceBps: 0, reason: "zero_price" };

  // Gross SOL needed so that net-of-fee, worst-case-slippage output still covers `needed`.
  const gross = (needed * BPS_DENOM * BPS_DENOM) / ((BPS_DENOM - PROTOCOL_FEE_BPS_AUTOSELL) * (BPS_DENOM - MAX_PROTOCOL_SLIPPAGE_BPS)) + 1n;
  const tokensNeeded = (gross * 10n ** BigInt(decimals)) / price + 1n;
  let bps = Number((tokensNeeded * BPS_DENOM) / collateral + 1n);

  const remainingBps = Number((remaining * BPS_DENOM) / collateral);
  bps = Math.min(bps, remainingBps, maxSliceBps);
  if (!overdue) {
    const aggregateLeft = Math.max(0, armedTotal - converted);
    bps = Math.min(bps, armedMax, aggregateLeft);
  }
  bps = Math.max(0, Math.floor(bps));
  if (bps <= 0) return { sliceBps: 0, reason: overdue ? "nothing_left" : "armed_caps_exhausted" };
  const sliceAmount = (collateral * BigInt(bps)) / BPS_DENOM;
  if (sliceAmount === 0n) return { sliceBps: 0, reason: "slice_too_small" };
  return { sliceBps: bps, sliceAmount, needed, price, overdue };
}

export async function quoteSlice({ mint, sliceAmount, slippageBps = WATCHER_SLIPPAGE_BPS }) {
  const q = await jupiterQuote({ inputMint: String(mint), outputMint: SOL_MINT, amountRaw: sliceAmount.toString(), slippageBps });
  return q.route; // raw Jupiter quote body (outAmount, otherAmountThreshold, routePlan, ...)
}

export { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID };
