/**
 * Reconciler loop (every 3 minutes): the chain is the source of truth.
 *
 *   - getProgramAccounts(PROGRAM_ID, memcmp Loan discriminator) -> upsert every
 *     loan into `loans` (status from the chain enum; missing mints rows are
 *     stubbed from the mint account so the FK holds).
 *   - DB loans that are 'open' but absent on chain -> 'unknown' + admin alert.
 *     Never 'repaid' on DB evidence alone.
 *   - one pool_snapshots row from the LendingPool account at POOL_PDA.
 */
import { PublicKey } from "@solana/web3.js";
import { getMint } from "@solana/spl-token";
import bs58 from "bs58";
import { query } from "../db/pool.js";
import { notifyAdmin } from "../notify/admin.js";
import { heartbeat, registerLoop, setGauge } from "../health/liveness.js";
import { connection, decodeAccount, discriminator, fetchPool, loanStatusName, mintTokenProgram, poolPda, programId } from "../chain/program.js";

const INTERVAL_MS = (Number(process.env.RECONCILER_INTERVAL_SECONDS) || 180) * 1000;
let _timer = null;
let _running = false;

function tierIndex(loan) {
  const d = Number(loan.durationDays);
  const ladder = Number(loan.category) === 1 ? [7, 15, 30] : [2, 3, 7];
  const i = ladder.indexOf(d);
  return i >= 0 ? i : 0;
}

async function ensureMintRow(conn, mint) {
  const { rows } = await query(`SELECT 1 FROM mints WHERE mint = $1`, [mint]);
  if (rows.length) return;
  const program = await mintTokenProgram(conn, mint);
  const m = await getMint(conn, new PublicKey(mint), "confirmed", program);
  await query(
    `INSERT INTO mints (mint, symbol, name, decimals, token_program, launched_here) VALUES ($1, $2, $3, $4, $5, false) ON CONFLICT DO NOTHING`,
    [mint, mint.slice(0, 6), `unregistered ${mint.slice(0, 8)}`, m.decimals, program.toBase58()],
  );
}

export async function fetchAllLoans(conn = connection()) {
  const encode = bs58.encode || bs58.default?.encode;
  const accounts = await conn.getProgramAccounts(programId(), {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: encode(discriminator("Loan")) } }],
  });
  return accounts.map((a) => ({ pubkey: a.pubkey.toBase58(), loan: decodeAccount("Loan", a.account.data) }));
}

export async function runOnce() {
  const conn = connection();
  const slot = await conn.getSlot("confirmed");
  const onChain = await fetchAllLoans(conn);
  const seen = new Set();
  let upserts = 0;
  for (const { pubkey, loan } of onChain) {
    if (loan.pool.toBase58() !== poolPda().toBase58()) continue;
    seen.add(pubkey);
    const mint = loan.collateralMint.toBase58();
    await ensureMintRow(conn, mint);
    await query(
      `INSERT INTO loans (loan_pda, borrower, mint, pool_pda, tier, principal_lamports, fee_lamports, collateral_amount, opened_slot, due_at, status, last_chain_check)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),$11::loan_status,now())
       ON CONFLICT (loan_pda) DO UPDATE SET
         status = CASE WHEN loans.status = 'converted' AND EXCLUDED.status = 'open' THEN loans.status ELSE EXCLUDED.status END,
         collateral_amount = EXCLUDED.collateral_amount, due_at = EXCLUDED.due_at, last_chain_check = now(), updated_at = now()`,
      [pubkey, loan.borrower.toBase58(), mint, loan.pool.toBase58(), tierIndex(loan), loan.loanAmount.toString(), loan.transactionFee.toString(),
        loan.collateralAmount.toString(), 0, Number(loan.startTimestamp) > 0 ? Number(loan.startTimestamp) : 0, loanStatusName(loan.status)],
    );
    // opened_slot is not stored on chain; keep the first value we recorded.
    upserts++;
  }

  const { rows: missing } = await query(
    `UPDATE loans SET status = 'unknown', last_chain_check = now(), updated_at = now()
      WHERE status = 'open' AND pool_pda = $1 AND NOT (loan_pda = ANY($2::text[])) RETURNING loan_pda, borrower`,
    [poolPda().toBase58(), [...seen]],
  );
  for (const m of missing) {
    await notifyAdmin({ kind: "loan_missing_on_chain", key: m.loan_pda, payload: { loan_pda: m.loan_pda, borrower: m.borrower, remedy: "Loan account not found under PROGRAM_ID. Status set to unknown; verify by signature history before any manual change." } });
  }

  const pool = await fetchPool(conn, { maxAgeMs: 0 });
  await query(
    `INSERT INTO pool_snapshots (pool_pda, total_deposits, total_borrowed, total_shares, accrued_fees, slot) VALUES ($1,$2,$3,$4,$5,$6)`,
    [poolPda().toBase58(), pool.totalDeposits.toString(), pool.totalBorrowed.toString(), pool.totalShares.toString(), pool.totalFeesEarned.toString(), slot],
  );
  setGauge("loans_on_chain", seen.size);
  setGauge("pool_total_borrowed", pool.totalBorrowed.toString());
  heartbeat("reconciler", "ok", { on_chain: seen.size, upserts, marked_unknown: missing.length, slot });
}

export function startReconciler() {
  registerLoop("reconciler", { intervalMs: INTERVAL_MS });
  const tick = async () => {
    if (_running) return;
    _running = true;
    try { await runOnce(); }
    catch (err) { heartbeat("reconciler", "error", { error: err.message?.slice(0, 200) }); console.error(`[reconciler] tick failed: ${err.message}`); }
    finally { _running = false; }
  };
  setTimeout(tick, 3_000 + Math.random() * 5_000);
  _timer = setInterval(tick, INTERVAL_MS);
  console.log(`[reconciler] started; every ${INTERVAL_MS / 1000}s`);
}

export function stopReconciler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}
