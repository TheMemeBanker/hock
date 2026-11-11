/**
 * Dry-run of an armed order against the real convert path.
 *
 * dryRunArmedOrder(orderId) loads the order + loan, sizes the first slice the
 * watcher would send, fetches a Jupiter quote for exactly that amount and
 * simulates the exact convert_collateral_slice transaction (min_sol_out at
 * least the oracle floor). Returns { ok, phase, reason, detail, action }.
 *
 * It never sends. The armed-order health probe runs it on a cadence so a
 * fire that WOULD fail is known before the trigger hits.
 */
import { query } from "../db/pool.js";
import { connection, fetchLoan, readPriceFeed, oracleFloorLamports } from "../chain/program.js";
import { getMintDecimals, planSlice, quoteSlice } from "../watcher/slicing.js";
import { executeOnChainConvertSlice } from "../tx/on-chain-convert-slice.js";

export async function dryRunArmedOrder(orderId) {
  let order, loanRow;
  try {
    const { rows } = await query(
      `SELECT o.*, l.mint, l.borrower AS loan_borrower, l.status AS loan_status
         FROM limit_close_orders o JOIN loans l ON l.loan_pda = o.loan_pda
        WHERE o.id = $1`,
      [orderId],
    );
    order = rows[0];
    if (!order) return { ok: false, phase: "load_context", reason: "order_not_found" };
    loanRow = { loan_pda: order.loan_pda, mint: order.mint, borrower: order.loan_borrower, status: order.loan_status };
  } catch (err) {
    return { ok: false, phase: "load_context", reason: "db_error", detail: err.message };
  }

  const conn = connection();
  let chainLoan;
  try {
    chainLoan = await fetchLoan(conn, loanRow.loan_pda);
  } catch (err) {
    return { ok: false, phase: "chain_read", reason: "rpc_error", detail: err.message };
  }
  if (!chainLoan) return { ok: false, phase: "chain_read", reason: "loan_missing_on_chain", action: "cancel" };
  const statusKey = (Object.keys(chainLoan.status || {})[0] || "").toLowerCase();
  if (statusKey !== "active") return { ok: false, phase: "preflight_gates", reason: "loan_no_longer_active", action: "cancel", detail: statusKey };
  if (BigInt(chainLoan.repayAmount.toString()) === 0n) return { ok: false, phase: "preflight_gates", reason: "loan_already_fully_repaid", action: "cancel" };
  if (BigInt(chainLoan.armedTriggerPrice.toString()) === 0n) {
    return { ok: false, phase: "preflight_gates", reason: "not_armed_on_chain", detail: "DB order armed but loan.armed_trigger_price == 0" };
  }

  let decimals, feed;
  try {
    decimals = await getMintDecimals(conn, loanRow.mint);
    feed = await readPriceFeed(conn, loanRow.mint);
  } catch (err) {
    return { ok: false, phase: "feed_read", reason: "rpc_error", detail: err.message };
  }
  if (!feed?.latest) return { ok: false, phase: "feed_read", reason: "feed_missing" };
  if (!feed.fresh) return { ok: false, phase: "feed_read", reason: "feed_stale", detail: `${feed.ageSeconds}s` };
  if (!feed.twapReady) return { ok: false, phase: "feed_read", reason: "twap_not_ready", detail: `${feed.samplesInWindow} samples` };

  const plan = planSlice({ chainLoan, feed, decimals });
  if (!plan.sliceBps) return { ok: false, phase: "plan_slice", reason: plan.reason || "no_slice" };

  let quote;
  try {
    quote = await quoteSlice({ mint: loanRow.mint, sliceAmount: plan.sliceAmount });
  } catch (err) {
    return { ok: false, phase: "jupiter_quote", reason: "quote_failed", detail: err.message?.slice(0, 160) };
  }
  const floor = oracleFloorLamports({ sliceAmount: plan.sliceAmount, spot: feed.latest.price, twap: feed.twap, decimals });
  if (BigInt(quote.otherAmountThreshold) < floor) {
    return { ok: false, phase: "oracle_floor", reason: "quote_below_oracle_floor", detail: `quote ${quote.otherAmountThreshold} < floor ${floor}` };
  }

  try {
    const sim = await executeOnChainConvertSlice({
      connection: conn,
      loan: { loan_pda: loanRow.loan_pda, collateral_mint: loanRow.mint, program_id: process.env.PROGRAM_ID },
      sliceBps: plan.sliceBps,
      jupiterQuote: quote,
      dryRun: true,
      minSolOutFloor: floor,
    });
    if (sim?.simulation?.err) {
      // The program refuses conversions whose trigger has not been reached; for a
      // dry run that is the expected answer and still proves the account wiring.
      const logs = (sim.simulation.logs || []).join(" ");
      if (/ConversionNotAuthorized/.test(logs)) {
        return { ok: true, phase: "simulate", reason: "trigger_not_reached_wiring_ok", detail: "program reached the authorization gate" };
      }
      return { ok: false, phase: "simulate", reason: "simulation_failed", detail: `${JSON.stringify(sim.simulation.err)} ${logs.slice(-300)}` };
    }
    return { ok: true, phase: "simulate", detail: `cu=${sim?.simulation?.unitsConsumed ?? "?"}` };
  } catch (err) {
    return { ok: false, phase: "simulate", reason: "simulation_threw", detail: err.message?.slice(0, 200) };
  }
}
