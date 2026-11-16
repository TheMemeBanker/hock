#!/usr/bin/env node
/**
 * End-to-end lifecycle on a test cluster with the engine and the web app running:
 *   launch (Token-2022 test mint) -> register with the gate (web API) -> synthetic market
 *   -> gate promotes -> attestor fills the feed -> borrow via the co-sign relay
 *   -> reconciler mirrors the loan -> arm a stop-loss -> price drops -> watcher attempts the fire
 *   (on localnet/devnet the swap router is absent, so the fire must fail CLEANLY and the order
 *   must return to armed/awaiting_user, never stuck in firing) -> disarm -> repay -> collateral back.
 *
 *   node scripts/lifecycle-localnet.mjs            (reads engine/.env; WEB_URL default http://127.0.0.1:3000)
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  AuthorityType, ExtensionType, LENGTH_SIZE, NATIVE_MINT, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction, createInitializeMetadataPointerInstruction, createInitializeMintInstruction,
  createMintToInstruction, createSetAuthorityInstruction, createSyncNativeInstruction, getAccount, getAssociatedTokenAddressSync, getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, pack } from "@solana/spl-token-metadata";
import { query, closeDb } from "../src/db/pool.js";
import { connection, programId, poolPda, priceFeedPda, collateralVaultPda, solProceedsVaultPda, loanTokenVaultPda, fetchLoan, fetchPool, readPriceFeed, getIdl, loanStatusName } from "../src/chain/program.js";

const WEB = process.env.WEB_URL || "http://127.0.0.1:3000";
const COSIGN = process.env.COSIGN_URL || `http://127.0.0.1:${process.env.COSIGN_PORT || 3002}`;
const SCRATCH = process.env.LIFECYCLE_DIR || path.join(process.env.TMPDIR || "/tmp", "hock-lifecycle");
fs.mkdirSync(SCRATCH, { recursive: true });
const conn = connection();
const PROGRAM = programId();
const POOL = poolPda();
const idl = getIdl();
const IX = Object.fromEntries(idl.instructions.map((i) => [i.name, i]));
const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
function enc(name, args) {
  const bufs = [disc(name)];
  for (const a of IX[name].args) {
    const v = args[a.name];
    if (v === undefined) throw new Error(`${name}: missing ${a.name}`);
    if (a.type === "u8") bufs.push(Buffer.from([Number(v)]));
    else if (a.type === "u16") { const b = Buffer.alloc(2); b.writeUInt16LE(Number(v)); bufs.push(b); }
    else if (a.type === "u64") { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); bufs.push(b); }
    else if (a.type === "pubkey") bufs.push(new PublicKey(v).toBuffer());
    else throw new Error(`${name}: unhandled ${a.type}`);
  }
  return Buffer.concat(bufs);
}
const ix = (name, args, map) => new TransactionInstruction({ programId: PROGRAM, data: enc(name, args), keys: IX[name].accounts.map((a) => { if (!map[a.name]) throw new Error(`${name}: unresolved ${a.name}`); return { pubkey: map[a.name], isSigner: !!a.signer, isWritable: !!a.writable }; }) });
const results = [];
const ok = (id, m) => { results.push([true, id, m]); console.log(`PASS ${id} ${m}`); };
const bad = (id, m) => { results.push([false, id, m]); console.error(`FAIL ${id} ${m}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(label, fn, { timeoutMs, everyMs = 5000 }) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label} after ${Math.round(timeoutMs / 1000)}s`);
    await sleep(everyMs);
  }
}

// ---- actor ---------------------------------------------------------------------------
const kpFile = path.join(SCRATCH, "borrower.json");
const borrower = fs.existsSync(kpFile) ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(kpFile)))) : (() => { const k = Keypair.generate(); fs.writeFileSync(kpFile, JSON.stringify([...k.secretKey])); return k; })();
if ((await conn.getBalance(borrower.publicKey)) < 10 * LAMPORTS_PER_SOL) {
  const sig = await conn.requestAirdrop(borrower.publicKey, 50 * LAMPORTS_PER_SOL);
  await conn.confirmTransaction(sig, "confirmed");
}
console.log(`borrower ${borrower.publicKey.toBase58()}  pool ${POOL.toBase58()}  program ${PROGRAM.toBase58()}`);

try {
  // ---- 1. launch: Token-2022 test mint with on-chain metadata (mirrors web/lib/launch/devnet-launch.ts) ----
  const mint = Keypair.generate();
  const meta = { mint: mint.publicKey, name: "Local Lifecycle", symbol: "LCL", uri: "https://example.invalid/lcl.json", additionalMetadata: [["launchpad", "hock"]] };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metaLen = TYPE_SIZE + LENGTH_SIZE + pack(meta).length;
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metaLen);
  const ataCol = getAssociatedTokenAddressSync(mint.publicKey, borrower.publicKey, false, TOKEN_2022_PROGRAM_ID);
  const DEC = 6, SUPPLY = 1_000_000_000n * 10n ** 6n;
  const launchSig = await sendAndConfirmTransaction(conn, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: borrower.publicKey, newAccountPubkey: mint.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint.publicKey, borrower.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, DEC, borrower.publicKey, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, mint: mint.publicKey, metadata: mint.publicKey, name: meta.name, symbol: meta.symbol, uri: meta.uri, mintAuthority: borrower.publicKey, updateAuthority: borrower.publicKey }),
    createAssociatedTokenAccountIdempotentInstruction(borrower.publicKey, ataCol, borrower.publicKey, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, ataCol, borrower.publicKey, SUPPLY, [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint.publicKey, borrower.publicKey, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  ), [borrower, mint], { commitment: "confirmed" });
  ok("L1", `launched ${mint.publicKey.toBase58()} (Token-2022 + metadata) sig ${launchSig.slice(0, 12)}`);
  const MINT = mint.publicKey.toBase58();

  // ---- 2. register with the gate through the real web route ----
  const reg = await fetch(`${WEB}/api/mints/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mint: MINT, name: meta.name, symbol: meta.symbol, sig: launchSig, launcher: borrower.publicKey.toBase58(), metadataUri: meta.uri }) });
  const regJson = await reg.json().catch(() => ({}));
  if (reg.ok && regJson.ok) ok("L2", "web /api/mints/register verified the launch on chain and inserted the mint"); else throw new Error(`register failed ${reg.status} ${JSON.stringify(regJson)}`);

  // ---- 3. synthetic market ----
  const PRICE = 2_000n; // lamports per whole token (0.000002 SOL)
  await query(`INSERT INTO synthetic_markets (mint, price_lamports_per_whole, liquidity_usd, volume_24h_usd, volume_1h_usd, route_ok, route_impact_bps, holders_pct_override, drift_bps_per_tick, note, market_cap_usd)
               VALUES ($1,$2,50000,120000,6000,true,80,12,10,'lifecycle driver',75000) ON CONFLICT (mint) DO UPDATE SET price_lamports_per_whole = EXCLUDED.price_lamports_per_whole, updated_at = now()`, [MINT, PRICE.toString()]);
  ok("L3", "synthetic market row set (mcap $75k, liq $50k, v24 $120k, v1 $6k, holders 12%, impact 80 bps)");

  // ---- 4. gate promotes ----
  const gate = await until("collateral_ready", async () => { const { rows } = await query(`SELECT verdict, consecutive_passes, reason FROM gate_state WHERE mint = $1`, [MINT]); return rows[0]?.verdict === "collateral_ready" ? rows[0] : (rows[0] ? (console.log(`   gate: ${rows[0].verdict} passes=${rows[0].consecutive_passes} ${rows[0].reason ?? ""}`), null) : null); }, { timeoutMs: 180_000, everyMs: 5000 });
  ok("L4", `gate promoted to collateral_ready after ${gate.consecutive_passes} consecutive passes`);

  // ---- 5. attestor fills the feed ----
  const feed = await until("feed twapReady+fresh", async () => { const f = await readPriceFeed(conn, MINT).catch(() => null); if (f) console.log(`   feed: samples=${f.count ?? "?"} age=${f.ageSeconds}s twapReady=${f.twapReady} spot=${f.latest?.price}`); return f?.twapReady && f.fresh ? f : null; }, { timeoutMs: 600_000, everyMs: 15_000 });
  ok("L5", `feed ready: spot ${feed.latest.price} twap ${feed.twap} age ${feed.ageSeconds}s`);

  // ---- 6. borrow through the co-sign relay ----
  const loanId = BigInt(Date.now());
  const idBuf = Buffer.alloc(8); idBuf.writeBigUInt64LE(loanId);
  const loanPda = PublicKey.findProgramAddressSync([Buffer.from("loan"), borrower.publicKey.toBuffer(), idBuf], PROGRAM)[0];
  const pool = await fetchPool(conn, { maxAgeMs: 0 });
  const feeWallet = new PublicKey(pool.fee_wallet.toBase58());
  const amountWhole = 10_000_000n; // 1% of supply
  const amountRaw = amountWhole * 10n ** 6n;
  const px = feed.twap && feed.twap < feed.latest.price ? feed.twap : feed.latest.price;
  const collateralValue = (amountWhole * BigInt(px) * 995n) / 1000n; // lamports
  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, borrower.publicKey, true);
  const borrowTx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(borrower.publicKey, wsolAta, borrower.publicKey, NATIVE_MINT),
    ix("request_and_fund_loan", { collateral_amount: amountRaw, loan_option: 0, collateral_value: collateralValue, loan_id: loanId, category: 0 }, {
      pool: POOL, loan_token_vault: loanTokenVaultPda(), loan: loanPda, collateral_vault: collateralVaultPda(loanPda), collateral_mint: mint.publicKey,
      borrower_collateral_account: ataCol, borrower_loan_token_account: wsolAta, fee_wallet_token_account: feeWallet,
      borrower: borrower.publicKey, authority: new PublicKey(pool.authority.toBase58()), price_feed: priceFeedPda(mint.publicKey),
      system_program: SystemProgram.programId, token_program: TOKEN_2022_PROGRAM_ID, loan_token_program: TOKEN_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }),
  );
  borrowTx.feePayer = borrower.publicKey;
  borrowTx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  borrowTx.partialSign(borrower);
  const cs = await fetch(`${COSIGN}/cosign/borrow`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tx: borrowTx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64") }) });
  const csJson = await cs.json().catch(() => ({}));
  if (!cs.ok || !csJson.ok) throw new Error(`cosign refused ${cs.status}: ${JSON.stringify(csJson).slice(0, 400)}`);
  const coSigned = Transaction.from(Buffer.from(csJson.tx, "base64"));
  const borrowSig = await conn.sendRawTransaction(coSigned.serialize(), { skipPreflight: false });
  await conn.confirmTransaction(borrowSig, "confirmed");
  const loan = await fetchLoan(conn, loanPda);
  if (!loan || loanStatusName(loan.status) !== "open") throw new Error("loan not active after borrow");
  const wsolBal = (await getAccount(conn, wsolAta)).amount;
  ok("L6", `borrowed: principal ${Number(loan.loan_amount) / 1e9} SOL, repay ${Number(loan.repay_amount) / 1e9} SOL, due ${new Date(Number(loan.due_timestamp) * 1000).toISOString()}, wSOL received ${Number(wsolBal) / 1e9}; cosign admitted ${JSON.stringify(csJson.admitted ?? {}).slice(0, 160)}`);

  // ---- 7. reconciler mirrors the loan ----
  await until("loans row", async () => (await query(`SELECT 1 FROM loans WHERE loan_pda = $1`, [loanPda.toBase58()])).rows[0], { timeoutMs: 120_000 });
  ok("L7", "reconciler indexed the loan from chain");

  // ---- 8. arm a stop-loss 20% below spot; reconciler mirrors it into limit_close_orders ----
  const trigger = (BigInt(feed.latest.price) * 80n) / 100n;
  await sendAndConfirmTransaction(conn, new Transaction().add(ix("arm_conversion", { trigger_price: trigger, direction: 1, max_slice_bps: 2500, total_bps: 10000 }, { loan: loanPda, borrower: borrower.publicKey })), [borrower], { commitment: "confirmed" });
  const order = await until("armed order", async () => (await query(`SELECT id, status, trigger_price::text AS trigger_price, direction FROM limit_close_orders WHERE loan_pda = $1 AND status = 'armed'`, [loanPda.toBase58()])).rows[0], { timeoutMs: 120_000 });
  if (order.trigger_price !== trigger.toString() || order.direction !== "stop_loss") throw new Error(`mirrored order mismatch ${JSON.stringify(order)}`);
  ok("L8", `armed stop-loss at ${trigger} mirrored as order #${order.id}`);

  // ---- 9. price drops 30%; the watcher must attempt and fail cleanly (no router on this cluster) ----
  await query(`UPDATE synthetic_markets SET price_lamports_per_whole = $2, drift_bps_per_tick = 0, updated_at = now() WHERE mint = $1`, [MINT, ((BigInt(feed.latest.price) * 70n) / 100n).toString()]);
  const attempt = await until("watcher attempt", async () => {
    const { rows } = await query(`SELECT status, attempts, last_error, fired_at FROM limit_close_orders WHERE id = $1`, [order.id]);
    const r = rows[0];
    console.log(`   order #${order.id}: ${r.status} attempts=${r.attempts} err=${(r.last_error || "").slice(0, 90)}`);
    return r.attempts > 0 || r.last_error || r.status !== "armed" ? r : null;
  }, { timeoutMs: 240_000, everyMs: 10_000 });
  if (attempt.status === "firing") bad("L9", "order stuck in firing"); else ok("L9", `watcher attempted the fire: status=${attempt.status} attempts=${attempt.attempts} last_error=${(attempt.last_error || "").slice(0, 120)}`);

  // ---- 10. disarm, restore price, repay ----
  await sendAndConfirmTransaction(conn, new Transaction().add(ix("disarm_conversion", {}, { loan: loanPda, borrower: borrower.publicKey })), [borrower], { commitment: "confirmed" });
  await query(`UPDATE synthetic_markets SET price_lamports_per_whole = $2, updated_at = now() WHERE mint = $1`, [MINT, PRICE.toString()]);
  const loanNow = await fetchLoan(conn, loanPda);
  const owed = BigInt(loanNow.repay_amount.toString()) - BigInt(loanNow.sol_proceeds_amount.toString());
  const have = (await getAccount(conn, wsolAta)).amount;
  const topUp = owed > have ? owed - have + 1_000_000n : 0n;
  const repayTx = new Transaction();
  if (topUp > 0n) repayTx.add(SystemProgram.transfer({ fromPubkey: borrower.publicKey, toPubkey: wsolAta, lamports: Number(topUp) }), createSyncNativeInstruction(wsolAta));
  repayTx.add(ix("repay_loan", {}, {
    pool: POOL, loan_token_vault: loanTokenVaultPda(), loan: loanPda, collateral_mint: mint.publicKey, collateral_vault: collateralVaultPda(loanPda),
    borrower_collateral_account: ataCol, borrower_loan_token_account: wsolAta, borrower: borrower.publicKey, sol_proceeds_vault: solProceedsVaultPda(loanPda),
    wsol_mint: NATIVE_MINT, token_program: TOKEN_2022_PROGRAM_ID, loan_token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
  }));
  const repaySig = await sendAndConfirmTransaction(conn, repayTx, [borrower], { commitment: "confirmed" });
  const after = await fetchLoan(conn, loanPda);
  const colBack = (await getAccount(conn, ataCol, "confirmed", TOKEN_2022_PROGRAM_ID)).amount;
  if (after && loanStatusName(after.status) === "repaid" && colBack === SUPPLY) ok("L10", `repaid (${repaySig.slice(0, 12)}); all ${Number(SUPPLY) / 1e6} LCL back in the borrower's wallet`);
  else bad("L10", `after repay: status=${after ? loanStatusName(after.status) : "missing"} collateral=${colBack}`);

  // ---- 11. DB catches up ----
  const row = await until("loan repaid in DB", async () => { const { rows } = await query(`SELECT status FROM loans WHERE loan_pda = $1`, [loanPda.toBase58()]); return rows[0]?.status === "repaid" ? rows[0] : null; }, { timeoutMs: 120_000 });
  const ord = (await query(`SELECT status, last_error FROM limit_close_orders WHERE id = $1`, [order.id])).rows[0];
  ok("L11", `DB: loan ${row.status}, order #${order.id} ${ord.status} (${ord.last_error ?? "-"})`);
} catch (e) {
  bad("ABORT", e.message);
} finally {
  const p = results.filter((r) => r[0]).length, f = results.length - p;
  console.log(`\nlifecycle: ${p} passed, ${f} failed`);
  fs.writeFileSync(path.join(SCRATCH, "results.txt"), results.map((r) => `${r[0] ? "PASS" : "FAIL"} ${r[1]} ${r[2]}`).join("\n"));
  await closeDb().catch(() => {});
  process.exit(f ? 1 : 0);
}
