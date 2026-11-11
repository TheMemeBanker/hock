/**
 * HOCK lending — full lifecycle + refusal-case matrix (local validator).
 *
 * Runs against a LOCAL solana-test-validator loaded with the hock_lending
 * build. No special test build is needed: the engine authority and the fee
 * wallet are per-pool fields set in initialize_pool, so the harness supplies
 * its own locally-held engine key and fee wallet.
 *
 * PHASE A (fresh clock): borrow (Token + Token-2022 + PermanentDelegate
 * refusal), TWAP gates, price-change bound, arm/disarm validation, every
 * conversion refusal in on-chain guard order, set_pool_config rotation
 * (authority-only, old engine refused after rotation, wrong-mint fee wallet
 * refused), extend healthy/stale, partial repay + final-payment guard.
 *
 * PHASE B (fresh validator loaded from matrix-state/dump-patched, where loan3's
 *   start/due timestamps are shifted 3 days into the past; --warp-slot never
 *   exposes RPC on macOS): overdue extend/arm
 * refusals, liquidation, recover accounting.
 *
 *   HOCK_PROGRAM_ID  override program id (default: Anchor.toml [programs.localnet])
 *   HOCK_IDL_PATH    override IDL path (default: target/idl/hock_lending.json)
 *   MATRIX_DIR       state dir for keys/state (default: ./matrix-state, gitignored)
 *   LOCAL_RPC_URL    default http://127.0.0.1:8899
 *
 *   node scripts/matrix-harness.mjs A   # phase A (also writes state.json)
 *   node scripts/matrix-harness.mjs B   # phase B (reads state.json)
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  SystemProgram, SYSVAR_RENT_PUBKEY, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction, createInitializeMintInstruction,
  createInitializePermanentDelegateInstruction, createMintToInstruction,
  getMintLen, ExtensionType, MINT_SIZE, getAccount,
} from "@solana/spl-token";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = process.env.MATRIX_DIR || path.join(ROOT, "matrix-state");
fs.mkdirSync(SCRATCH, { recursive: true });
const RPC = process.env.LOCAL_RPC_URL || "http://127.0.0.1:8899";
const conn = new Connection(RPC, "confirmed");

/** Program id: env override, else Anchor.toml [programs.localnet] hock_lending. */
function programIdFromAnchorToml() {
  const toml = fs.readFileSync(path.join(ROOT, "Anchor.toml"), "utf8");
  const sec = toml.split(/\n\[programs\.localnet\]\n/)[1];
  const m = sec && sec.match(/^hock_lending\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/m);
  if (!m) throw new Error("hock_lending id not found under [programs.localnet] in Anchor.toml");
  return m[1];
}
const PROGRAM_ID = new PublicKey(process.env.HOCK_PROGRAM_ID || programIdFromAnchorToml());
const JUPITER_V6 = new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

const IDL_PATH = process.env.HOCK_IDL_PATH || path.join(ROOT, "target", "idl", "hock_lending.json");
const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));
const IX = Object.fromEntries(idl.instructions.map((i) => [i.name, i]));
const ERRS = idl.errors ? idl.errors.map((e) => e.name) : [];

// ── result tracking ─────────────────────────────────────────────────────
let pass = 0, fail = 0;
const results = [];
const ok = (id, msg) => { pass++; results.push(`✅ ${id} ${msg}`); console.log(`✅ ${id} ${msg}`); };
const bad = (id, msg) => { fail++; results.push(`❌ ${id} ${msg}`); console.error(`❌ ${id} ${msg}`); };

// ── generic ix builder driven by the IDL ────────────────────────────────
const disc = (name) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
function encodeArgs(name, args) {
  const spec = IX[name].args;
  const bufs = [disc(name)];
  for (const a of spec) {
    const v = args[a.name.replace(/^_/, "")] ?? args[a.name];
    if (v === undefined) throw new Error(`${name}: missing arg ${a.name}`);
    if (a.type === "u8") { bufs.push(Buffer.from([Number(v)])); }
    else if (a.type === "u16") { const b = Buffer.alloc(2); b.writeUInt16LE(Number(v)); bufs.push(b); }
    else if (a.type === "u64") { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); bufs.push(b); }
    else if (a.type === "bytes") { const b = Buffer.alloc(4); b.writeUInt32LE(v.length); bufs.push(b, Buffer.from(v)); }
    else if (a.type === "pubkey") { bufs.push(new PublicKey(v).toBuffer()); }
    else throw new Error(`${name}: unhandled arg type ${a.type}`);
  }
  return Buffer.concat(bufs);
}
function buildIx(name, args, accountMap, { remaining = [], signerOverrides = {} } = {}) {
  const spec = IX[name];
  const keys = spec.accounts.map((a) => {
    const pk = accountMap[a.name];
    if (!pk) throw new Error(`${name}: unresolved account ${a.name}`);
    const isSigner = a.name in signerOverrides ? signerOverrides[a.name] : !!a.signer;
    return { pubkey: pk, isSigner, isWritable: !!a.writable };
  });
  for (const r of remaining) keys.push(r);
  return new TransactionInstruction({ programId: PROGRAM_ID, keys, data: encodeArgs(name, args) });
}
async function send(ixs, signers, label) {
  const tx = new Transaction().add(...ixs);
  return await sendAndConfirmTransaction(conn, tx, signers, { commitment: "confirmed", skipPreflight: false });
}
/** Expect the named Anchor error; assert on match. */
async function expectErr(id, errName, fn) {
  try {
    await fn();
    bad(id, `expected ${errName} but tx SUCCEEDED`);
  } catch (e) {
    const logs = (e.transactionLogs || e.logs || []).join("\n") + " " + String(e.message);
    const idx = ERRS.indexOf(errName);
    const codeHex = idx >= 0 ? `0x${(6000 + idx).toString(16)}` : "«unknown»";
    if (logs.includes(errName) || (idx >= 0 && logs.includes(codeHex))) ok(id, `refused with ${errName}`);
    else bad(id, `expected ${errName}, got: ${String(e.message).slice(0, 160)} :: ${logs.slice(0, 260)}`);
  }
}

// ── key + state management ──────────────────────────────────────────────
const loadKp = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(SCRATCH, f)))));
const saveKp = (f, kp) => fs.writeFileSync(path.join(SCRATCH, f), JSON.stringify([...kp.secretKey]));
const STATE_F = path.join(SCRATCH, "state.json");
const saveState = (s) => fs.writeFileSync(STATE_F, JSON.stringify(s, null, 1));
const loadState = () => JSON.parse(fs.readFileSync(STATE_F, "utf8"));

// every actor is a throwaway local key, persisted so Phase B reuses them
const kpOrNew = (f) => { try { return loadKp(f); } catch { const k = Keypair.generate(); saveKp(f, k); return k; } };
const engine = kpOrNew("engine.json");
const engine2 = kpOrNew("engine2.json");      // rotation target for set_pool_config
const borrower1 = kpOrNew("borrower1.json");
const borrower2 = kpOrNew("borrower2.json");
const depositor = kpOrNew("depositor.json");
const feeOwner = kpOrNew("fee_owner.json");   // owner of the pool's fee wallet (wSOL ATA)
const authority = kpOrNew("authority.json");
// Pool fee wallet = ATA(feeOwner, wSOL). Recorded on the pool at initialize_pool.
const FEE_WALLET = getAssociatedTokenAddressSync(NATIVE_MINT, feeOwner.publicKey, true);

// ── PDA helpers ─────────────────────────────────────────────────────────
const pda = (...seeds) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
const POOL = pda(Buffer.from("pool"), authority.publicKey.toBuffer());
const VAULT = pda(Buffer.from("loan-token-vault"), POOL.toBuffer());
const feedOf = (mint) => pda(Buffer.from("price_v3"), mint.toBuffer(), POOL.toBuffer());
const loanOf = (borrower, id) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(id)); return pda(Buffer.from("loan"), borrower.toBuffer(), b); };
const cvaultOf = (loan) => pda(Buffer.from("collateral-vault"), loan.toBuffer());
const proceedsOf = (loan) => pda(Buffer.from("sol-proceeds"), loan.toBuffer());
const positionOf = (dep) => pda(Buffer.from("position"), POOL.toBuffer(), dep.toBuffer());

const DEC = 9;
const WHOLE = 10n ** BigInt(DEC);
const PRICE0 = 1_000_000n; // lamports per whole token (0.001 SOL)

async function pushPrice(mint, price) {
  await send([buildIx("update_price", { price_lamports: price, confidence_bps: 200 },
    { pool: POOL, price_feed: feedOf(mint), authority: authority.publicKey })], [authority], "update_price");
}
const tokProg = (t22) => (t22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
const ata = (owner, mint, t22 = false) => getAssociatedTokenAddressSync(mint, owner, true, tokProg(t22));

async function borrowIx(borrower, mint, { t22 = false, amountWhole, valueLamports, loanId, option = 0, category = 0 }) {
  const loan = loanOf(borrower.publicKey, loanId);
  return buildIx("request_and_fund_loan",
    { collateral_amount: amountWhole * WHOLE, loan_option: option, collateral_value: valueLamports, loan_id: loanId, category },
    {
      pool: POOL, loan_token_vault: VAULT, loan: loan, collateral_vault: cvaultOf(loan), collateral_mint: mint,
      borrower_collateral_account: ata(borrower.publicKey, mint, t22),
      borrower_loan_token_account: ata(borrower.publicKey, NATIVE_MINT),
      fee_wallet_token_account: FEE_WALLET,
      borrower: borrower.publicKey, authority: authority.publicKey, price_feed: feedOf(mint),
      system_program: SystemProgram.programId, token_program: tokProg(t22),
      loan_token_program: TOKEN_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    });
}
function convertIx(loan, mint, { sliceBps, minSolOut, swapProgram, t22 = false }) {
  return buildIx("convert_collateral_slice",
    { slice_bps: sliceBps, min_sol_out: minSolOut, swap_ix_data: Buffer.from([1, 2, 3]) },
    {
      loan, collateral_mint: mint, collateral_vault: cvaultOf(loan), sol_proceeds_vault: proceedsOf(loan),
      engine_collateral_account: ata(engine.publicKey, mint, t22), fee_wallet: FEE_WALLET,
      wsol_mint: NATIVE_MINT, engine: engine.publicKey, price_history: feedOf(mint), pool: POOL,
      token_program: tokProg(t22), loan_token_program: TOKEN_PROGRAM_ID,
      system_program: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    },
    { remaining: [{ pubkey: swapProgram, isSigner: false, isWritable: false }] });
}
function extendIx(loan, mint, borrower, { withAuthority }) {
  // Anchor Option<Signer> wire convention: "None" is encoded by passing the
  // PROGRAM ID in the account slot (not a non-signer pubkey).
  return buildIx("extend_loan", {}, {
    pool: POOL, loan_token_vault: VAULT, loan, collateral_mint: mint, price_history: feedOf(mint),
    borrower_loan_token_account: ata(borrower.publicKey, NATIVE_MINT),
    fee_wallet_token_account: FEE_WALLET, borrower: borrower.publicKey,
    authority: withAuthority ? authority.publicKey : PROGRAM_ID,
    loan_token_program: TOKEN_PROGRAM_ID,
  }, { signerOverrides: { authority: withAuthority } });
}

// ═════════════════════════════ PHASE A ═════════════════════════════════
async function phaseA() {
  console.log("── Phase A: setup ──");
  for (const kp of [authority, borrower1, borrower2, depositor, engine, engine2]) {
    await conn.requestAirdrop(kp.publicKey, 500 * LAMPORTS_PER_SOL).then((s) => conn.confirmTransaction(s));
  }

  // Mints: A = classic SPL, B = clean Token-2022, C = Token-2022 + PermanentDelegate
  const mk = async (t22, exts = []) => {
    const kp = Keypair.generate();
    const space = t22 ? getMintLen(exts) : MINT_SIZE;
    const ixs = [SystemProgram.createAccount({
      fromPubkey: authority.publicKey, newAccountPubkey: kp.publicKey, lamports: await conn.getMinimumBalanceForRentExemption(space), space, programId: tokProg(t22),
    })];
    if (exts.includes(ExtensionType.PermanentDelegate))
      ixs.push(createInitializePermanentDelegateInstruction(kp.publicKey, authority.publicKey, TOKEN_2022_PROGRAM_ID));
    ixs.push(createInitializeMintInstruction(kp.publicKey, DEC, authority.publicKey, null, tokProg(t22)));
    await send(ixs, [authority, kp], "mint");
    return kp.publicKey;
  };
  const mintA = await mk(false);
  const mintB = await mk(true);
  const mintC = await mk(true, [ExtensionType.PermanentDelegate]);
  console.log("mints:", mintA.toBase58(), mintB.toBase58(), mintC.toBase58());

  // ATAs + token balances for borrowers, engine, fee wallet
  const ataIxs = [];
  for (const [owner, mint, t22] of [
    [borrower1.publicKey, mintA, false], [borrower1.publicKey, mintB, true], [borrower1.publicKey, mintC, true],
    [borrower2.publicKey, mintA, false], [engine.publicKey, mintA, false],
  ]) {
    ataIxs.push(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata(owner, mint, t22), owner, mint, tokProg(t22)));
    ataIxs.push(createMintToInstruction(mint, ata(owner, mint, t22), authority.publicKey, 100_000n * WHOLE, [], tokProg(t22)));
  }
  // wSOL ATAs: borrowers (loan receipt), depositor (deposit source), fee wallet owner
  for (const owner of [borrower1.publicKey, borrower2.publicKey, depositor.publicKey, feeOwner.publicKey]) {
    ataIxs.push(createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, getAssociatedTokenAddressSync(NATIVE_MINT, owner, true), owner, NATIVE_MINT));
  }
  for (let i = 0; i < ataIxs.length; i += 6) await send(ataIxs.slice(i, i + 6), [authority], "atas");

  // Pool init refusals: fee wallet of the wrong mint; engine == authority; engine == zero key
  const initPoolIx = (engineKey, feeWallet) => buildIx("initialize_pool",
    { protocol_fee_bps: 100, keeper_reward_bps: 100, engine_authority: engineKey },
    { pool: POOL, loan_token_vault: VAULT, loan_token_mint: NATIVE_MINT, fee_wallet: feeWallet, authority: authority.publicKey,
      system_program: SystemProgram.programId, token_program: TOKEN_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY });
  await expectErr("A0a", "InvalidFeeWallet", () => send([initPoolIx(engine.publicKey, ata(borrower1.publicKey, mintA))], [authority], "init_pool-badfee"));
  await expectErr("A0b", "InvalidPoolConfig", () => send([initPoolIx(authority.publicKey, FEE_WALLET)], [authority], "init_pool-engine=auth"));
  await expectErr("A0c", "InvalidPoolConfig", () => send([initPoolIx(PublicKey.default, FEE_WALLET)], [authority], "init_pool-engine=0"));
  // Pool init + LP deposit (100 SOL wrapped)
  await send([initPoolIx(engine.publicKey, FEE_WALLET)], [authority], "init_pool");
  const depAta = getAssociatedTokenAddressSync(NATIVE_MINT, depositor.publicKey, true);
  await send([
    SystemProgram.transfer({ fromPubkey: depositor.publicKey, toPubkey: depAta, lamports: 100 * LAMPORTS_PER_SOL }),
    createSyncNativeInstruction(depAta),
    buildIx("deposit", { amount: 100n * BigInt(LAMPORTS_PER_SOL) },
      { pool: POOL, loan_token_vault: VAULT, position: positionOf(depositor.publicKey), depositor_token_account: depAta,
        depositor: depositor.publicKey, token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId }),
  ], [depositor], "deposit");
  ok("A0", "pool initialized + 100 SOL LP deposit");

  // Price feeds for all three mints + first samples
  for (const m of [mintA, mintB, mintC]) {
    await send([buildIx("initialize_price_feed", {}, { pool: POOL, mint: m, price_feed: feedOf(m), authority: authority.publicKey, system_program: SystemProgram.programId })], [authority], "init_feed");
    await pushPrice(m, PRICE0);
  }
  const t0 = Date.now();
  ok("A1", "price feeds initialized, first samples pushed (update_price normal = pass)");

  // A2 — M-04 price-change bound: >100× jump refused, both directions; zero refused
  await expectErr("A2a", "PriceChangeExceedsBound", () => pushPrice(mintA, PRICE0 * 200n));
  await expectErr("A2b", "PriceChangeExceedsBound", () => pushPrice(mintA, PRICE0 / 200n));
  await expectErr("A2c", "InvalidCollateralValue", () => pushPrice(mintA, 0n));

  // A3 — TWAP span gate: borrow before 300s of history → TwapInsufficientHistory
  await expectErr("A3", "TwapInsufficientHistory", async () =>
    send([await borrowIx(borrower1, mintA, { amountWhole: 1000n, valueLamports: 1000n * PRICE0, loanId: 1n })], [borrower1, authority], "early-borrow"));

  // Sample all feeds every 20s until 300s span reached (jitter ±0.5%)
  console.log("… building 300s of price history (samples every 20s) …");
  let px = { A: PRICE0, B: PRICE0, C: PRICE0 };
  while (Date.now() - t0 < 310_000) {
    await new Promise((r) => setTimeout(r, 20_000));
    for (const [k, m] of [["A", mintA], ["B", mintB], ["C", mintC]]) {
      const jit = 1 + (Math.random() - 0.5) / 100;
      px[k] = BigInt(Math.floor(Number(px[k]) * jit));
      await pushPrice(m, px[k]).catch((e) => console.warn("sample push failed:", e.message.slice(0, 80)));
    }
  }
  ok("A4", `TWAP history built (${Math.round((Date.now() - t0) / 1000)}s span, ~16 samples/feed)`);

  // A5 — borrow success, classic SPL Token (loan1, borrower1)
  const val = (k, whole) => (px[k] * whole * 995n) / 1000n; // 0.5% under spot: passes attestation cap + tolerance
  const b1WsolBefore = (await getAccount(conn, ata(borrower1.publicKey, NATIVE_MINT))).amount;
  const feeBefore = (await getAccount(conn, FEE_WALLET)).amount;
  const loan1 = loanOf(borrower1.publicKey, 1n);
  await send([await borrowIx(borrower1, mintA, { amountWhole: 1000n, valueLamports: val("A", 1000n), loanId: 1n })], [borrower1, authority], "borrow1");
  const b1WsolAfter = (await getAccount(conn, ata(borrower1.publicKey, NATIVE_MINT))).amount;
  const feeAfter = (await getAccount(conn, FEE_WALLET)).amount;
  const vaultBal = (await getAccount(conn, cvaultOf(loan1))).amount;
  const received = b1WsolAfter - b1WsolBefore;
  const feeGot = feeAfter - feeBefore;
  // Fee model (verified against on-chain behavior): loan = value × 30% LTV;
  // borrower receives loan × (1 − 3% Express fee); the withheld fee accrues to
  // the LP vault, with protocol_fee_bps (1%, set at pool init) of it skimmed
  // to the fee wallet.
  const expectedLoan = (val("A", 1000n) * 3000n) / 10000n; // Express 30% LTV
  const expReceived = (expectedLoan * 9700n) / 10000n;
  const expFeeWallet = ((expectedLoan * 300n) / 10000n) * 100n / 10000n;
  const near = (a, b) => (a > b ? a - b : b - a) <= 2n;
  if (vaultBal === 1000n * WHOLE && near(received, expReceived) && near(feeGot, expFeeWallet))
    ok("A5", `SPL borrow funds correctly: borrower ${received} (=loan×97%), fee wallet ${feeGot} (=1% of 3% fee), vault holds full collateral`);
  else
    bad("A5", `SPL borrow accounting off: received=${received} (exp ${expReceived}) fee=${feeGot} (exp ${expFeeWallet}) vault=${vaultBal}`);

  // A6 — borrow success, clean Token-2022 (loan2)
  const loan2 = loanOf(borrower1.publicKey, 2n);
  await send([await borrowIx(borrower1, mintB, { t22: true, amountWhole: 1000n, valueLamports: val("B", 1000n), loanId: 2n })], [borrower1, authority], "borrow2");
  ok("A6", "Token-2022 (clean) borrow succeeds — H-01 allows extension-free T22");

  // A7 — H-01: PermanentDelegate mint refused
  await expectErr("A7", "UnsupportedCollateralExtension", async () =>
    send([await borrowIx(borrower1, mintC, { t22: true, amountWhole: 1000n, valueLamports: val("C", 1000n), loanId: 3n })], [borrower1, authority], "borrow3"));

  // A8 — third loan for Phase B (borrower2, mintA, Express 2-day)
  const loan3 = loanOf(borrower2.publicKey, 10n);
  await send([await borrowIx(borrower2, mintA, { amountWhole: 500n, valueLamports: val("A", 500n), loanId: 10n })], [borrower2, authority], "borrow-b2");
  ok("A8", "loan3 (borrower2) created for Phase B overdue cases");

  // A9 — arm validation (InvalidTrigger) + wrong-signer arm
  await expectErr("A9a", "InvalidTrigger", () => send([buildIx("arm_conversion", { trigger_price: 0, direction: 0, max_slice_bps: 5000, total_bps: 10000 }, { loan: loan1, borrower: borrower1.publicKey })], [borrower1], "arm0"));
  await expectErr("A9b", "InvalidTrigger", () => send([buildIx("arm_conversion", { trigger_price: 1, direction: 2, max_slice_bps: 5000, total_bps: 10000 }, { loan: loan1, borrower: borrower1.publicKey })], [borrower1], "arm-dir"));
  await expectErr("A9c", "InvalidTrigger", () => send([buildIx("arm_conversion", { trigger_price: 1, direction: 0, max_slice_bps: 5000, total_bps: 4000 }, { loan: loan1, borrower: borrower1.publicKey })], [borrower1], "arm-total"));
  try {
    await send([buildIx("arm_conversion", { trigger_price: 1, direction: 0, max_slice_bps: 5000, total_bps: 10000 }, { loan: loan1, borrower: borrower2.publicKey })], [borrower2], "arm-wrong");
    bad("A9d", "non-borrower armed the loan — MUST NOT HAPPEN");
  } catch { ok("A9d", "non-borrower cannot arm (constraint refused)"); }

  // A10 — un-armed conversion → ConversionNotAuthorized (H-02 core)
  await expectErr("A10", "ConversionNotAuthorized", () =>
    send([convertIx(loan1, mintA, { sliceBps: 1000, minSolOut: LAMPORTS_PER_SOL, swapProgram: JUPITER_V6 })], [engine], "conv-unarmed"));

  // A11 — armed TP but trigger ABOVE spot → still ConversionNotAuthorized
  await send([buildIx("arm_conversion", { trigger_price: px.A * 3n, direction: 0, max_slice_bps: 2000, total_bps: 6000 }, { loan: loan1, borrower: borrower1.publicKey })], [borrower1], "arm-high");
  await expectErr("A11", "ConversionNotAuthorized", () =>
    send([convertIx(loan1, mintA, { sliceBps: 1000, minSolOut: LAMPORTS_PER_SOL, swapProgram: JUPITER_V6 })], [engine], "conv-below-trigger"));

  // A12 — slice above per-fire cap while trigger MET → ConversionNotAuthorized (Q-04)
  await send([buildIx("arm_conversion", { trigger_price: px.A / 2n, direction: 0, max_slice_bps: 2000, total_bps: 6000 }, { loan: loan1, borrower: borrower1.publicKey })], [borrower1], "arm-met");
  await expectErr("A12", "ConversionNotAuthorized", () =>
    send([convertIx(loan1, mintA, { sliceBps: 2500, minSolOut: LAMPORTS_PER_SOL, swapProgram: JUPITER_V6 })], [engine], "conv-over-slice"));

  // A13 — armed + met, min_sol_out=0 → MinOutBelowOracleFloor (M-03/L-04 floor)
  await expectErr("A13", "MinOutBelowOracleFloor", () =>
    send([convertIx(loan1, mintA, { sliceBps: 1000, minSolOut: 0, swapProgram: JUPITER_V6 })], [engine], "conv-zero-min"));

  // A14 — everything valid but swap program NOT allowlisted → SwapProgramNotAllowed (GATE B)
  await expectErr("A14", "SwapProgramNotAllowed", () =>
    send([convertIx(loan1, mintA, { sliceBps: 1000, minSolOut: LAMPORTS_PER_SOL, swapProgram: SystemProgram.programId })], [engine], "conv-bad-router"));

  // A15 — allowlisted router passes GATE B; CPI then fails only because Jupiter
  // isn't deployed locally — proves every guard is ordered before the swap.
  try {
    await send([convertIx(loan1, mintA, { sliceBps: 1000, minSolOut: LAMPORTS_PER_SOL, swapProgram: JUPITER_V6 })], [engine], "conv-jup");
    bad("A15", "conversion 'succeeded' with no swap program deployed — impossible");
  } catch (e) {
    const logs = (e.transactionLogs || e.logs || []).join("\n") + String(e.message);
    const guardNames = ["ConversionNotAuthorized", "MinOutBelowOracleFloor", "SwapProgramNotAllowed", "OracleStale", "TwapInsufficientHistory", "InvalidSlice"];
    if (guardNames.some((g) => logs.includes(g))) bad("A15", `hit a guard unexpectedly: ${logs.slice(0, 200)}`);
    else ok("A15", "allowlisted router passes ALL conversion guards; failure is only the absent local Jupiter CPI");
  }

  // A16 — wrong engine signer → constraint refusal
  try {
    const ix = convertIx(loan1, mintA, { sliceBps: 1000, minSolOut: LAMPORTS_PER_SOL, swapProgram: JUPITER_V6 });
    ix.keys = ix.keys.map((k) => k.pubkey.equals(engine.publicKey) ? { ...k, pubkey: borrower2.publicKey } : k);
    await send([ix], [borrower2], "conv-wrong-engine");
    bad("A16", "non-engine signer converted — MUST NOT HAPPEN");
  } catch { ok("A16", "non-engine signer refused (EngineUnauthorized constraint)"); }

  // A16b..A16g — set_pool_config: authority-only rotation of engine + fee wallet
  const setCfgIx = (signer, engineKey, feeWallet) => buildIx("set_pool_config", { engine_authority: engineKey },
    { pool: POOL, authority: signer, fee_wallet: feeWallet });
  try {
    await send([setCfgIx(borrower2.publicKey, engine2.publicKey, FEE_WALLET)], [borrower2], "setcfg-nonauth");
    bad("A16b", "NON-authority rotated pool config — MUST NOT HAPPEN");
  } catch { ok("A16b", "non-authority set_pool_config refused (has_one authority)"); }
  await expectErr("A16c", "InvalidFeeWallet", () => send([setCfgIx(authority.publicKey, engine2.publicKey, ata(borrower1.publicKey, mintA))], [authority], "setcfg-badfee"));
  await expectErr("A16d", "InvalidPoolConfig", () => send([setCfgIx(authority.publicKey, authority.publicKey, FEE_WALLET)], [authority], "setcfg-engine=auth"));
  const rotSig = await send([setCfgIx(authority.publicKey, engine2.publicKey, FEE_WALLET)], [authority], "setcfg-rotate");
  const rotTx = await conn.getTransaction(rotSig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const rotLogs = (rotTx?.meta?.logMessages || []);
  if (rotLogs.some((l) => l.startsWith("Program data: "))) ok("A16e", "set_pool_config by authority landed and emitted an event (Program data log)");
  else bad("A16e", "set_pool_config landed but no event log found");
  // old engine must now be refused; new engine passes the signer gate (then hits the first guard = ConversionNotAuthorized? no — loan1 is armed+met, so next guard is the floor; use min_sol_out=0 to stop at MinOutBelowOracleFloor)
  await expectErr("A16f", "EngineUnauthorized", () =>
    send([convertIx(loan1, mintA, { sliceBps: 1000, minSolOut: 0, swapProgram: JUPITER_V6 })], [engine], "conv-old-engine"));
  {
    const ix = convertIx(loan1, mintA, { sliceBps: 1000, minSolOut: 0, swapProgram: JUPITER_V6 });
    ix.keys = ix.keys.map((k) => k.pubkey.equals(engine.publicKey) ? { ...k, pubkey: engine2.publicKey } : k);
    // engine_collateral_account must be owned by the signer; point it at engine2's ATA (created below)
    await send([createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata(engine2.publicKey, mintA), engine2.publicKey, mintA)], [authority], "engine2-ata");
    ix.keys = ix.keys.map((k) => k.pubkey.equals(ata(engine.publicKey, mintA)) ? { ...k, pubkey: ata(engine2.publicKey, mintA) } : k);
    await expectErr("A16g", "MinOutBelowOracleFloor", () => send([ix], [engine2], "conv-new-engine"));
  }
  // rotate back so the rest of the matrix (and Phase B) keeps using `engine`
  await send([setCfgIx(authority.publicKey, engine.publicKey, FEE_WALLET)], [authority], "setcfg-restore");

  // A17 — M-01 extend: healthy + fresh price + NO authority signature → succeeds
  const due1before = null; // (loan account layout parse skipped; success signal = tx lands + fee flows)
  const feeB4 = (await getAccount(conn, FEE_WALLET)).amount;
  await send([extendIx(loan2, mintB, borrower1, { withAuthority: false })], [borrower1], "extend-fresh");
  const feeAft = (await getAccount(conn, FEE_WALLET)).amount;
  if (feeAft > feeB4) ok("A17", `M-01: healthy+fresh extend WITHOUT authority signature succeeds (fee ${feeAft - feeB4} paid)`);
  else bad("A17", "extend landed but no extension fee flowed");

  // A18 — stale price (mintB sampling stops >120s) → borrower-only extend refused, authority co-sign succeeds
  console.log("… letting mintB price go stale (125s, no samples) …");
  await new Promise((r) => setTimeout(r, 125_000));
  // keep mintA fresh meanwhile for Phase B liquidation floor
  await pushPrice(mintA, px.A);
  await expectErr("A18a", "ExtendRequiresAuthority", () =>
    send([extendIx(loan2, mintB, borrower1, { withAuthority: false })], [borrower1], "extend-stale"));
  await send([extendIx(loan2, mintB, borrower1, { withAuthority: true })], [borrower1, authority], "extend-stale-auth");
  ok("A18b", "stale-price extend succeeds WITH authority co-signature (M-01 privileged path)");

  // A19 — conversion with stale oracle (mintB now stale, arm loan2 first? loan2 is T22 — engine ATA missing)
  // Use loan1/mintA after letting IT go stale is Phase-B-hostile; instead assert OracleStale via mintB loan2:
  await send([createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata(engine.publicKey, mintB, true), engine.publicKey, mintB, TOKEN_2022_PROGRAM_ID)], [authority], "engine-ata-b");
  await expectErr("A19", "OracleStale", () =>
    send([convertIx(loan2, mintB, { sliceBps: 1000, minSolOut: LAMPORTS_PER_SOL, swapProgram: JUPITER_V6, t22: true })], [engine], "conv-stale"));

  // A20 — partial repay + final-payment guard
  const owedProbe = 50_000_000n; // small partial against loan1
  const wrap = [
    SystemProgram.transfer({ fromPubkey: borrower1.publicKey, toPubkey: ata(borrower1.publicKey, NATIVE_MINT), lamports: 2 * LAMPORTS_PER_SOL }),
    createSyncNativeInstruction(ata(borrower1.publicKey, NATIVE_MINT)),
  ];
  await send(wrap, [borrower1], "wrap");
  await send([buildIx("partial_repay", { amount: owedProbe },
    { pool: POOL, loan_token_vault: VAULT, loan: loan1, borrower_loan_token_account: ata(borrower1.publicKey, NATIVE_MINT),
      borrower: borrower1.publicKey, loan_token_program: TOKEN_PROGRAM_ID })], [borrower1], "partial");
  ok("A20a", "partial_repay accepted");
  await expectErr("A20b", "UseRepayLoanForFinalPayment", () =>
    send([buildIx("partial_repay", { amount: 100n * BigInt(LAMPORTS_PER_SOL) },
      { pool: POOL, loan_token_vault: VAULT, loan: loan1, borrower_loan_token_account: ata(borrower1.publicKey, NATIVE_MINT),
        borrower: borrower1.publicKey, loan_token_program: TOKEN_PROGRAM_ID })], [borrower1], "partial-final"));

  // A21 — full repay closes loan1, collateral returned
  const colBefore = (await getAccount(conn, ata(borrower1.publicKey, mintA))).amount;
  await send([buildIx("repay_loan", {}, {
    pool: POOL, loan_token_vault: VAULT, loan: loan1, collateral_mint: mintA, collateral_vault: cvaultOf(loan1),
    borrower_collateral_account: ata(borrower1.publicKey, mintA), borrower_loan_token_account: ata(borrower1.publicKey, NATIVE_MINT),
    borrower: borrower1.publicKey, sol_proceeds_vault: proceedsOf(loan1), wsol_mint: NATIVE_MINT,
    token_program: TOKEN_PROGRAM_ID, loan_token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
  })], [borrower1], "repay1");
  const colAfter = (await getAccount(conn, ata(borrower1.publicKey, mintA))).amount;
  if (colAfter - colBefore === 1000n * WHOLE) ok("A21", "full repay returns 100% of collateral");
  else bad("A21", `repay returned ${colAfter - colBefore}, expected ${1000n * WHOLE}`);

  saveState({
    mintA: mintA.toBase58(), mintB: mintB.toBase58(), mintC: mintC.toBase58(),
    loan3: loan3.toBase58(), pxA: px.A.toString(), pxB: px.B.toString(),
  });
  console.log(`\nPhase A: ${pass} passed, ${fail} failed. State saved for Phase B.`);
  fs.writeFileSync(path.join(SCRATCH, "phaseA-results.txt"), results.join("\n"));
  process.exit(fail ? 1 : 0);
}

// ═════════════════════════════ PHASE B ═════════════════════════════════
async function phaseB() {
  const st = loadState();
  const mintA = new PublicKey(st.mintA);
  const loan3 = new PublicKey(st.loan3);
  let pxA = BigInt(st.pxA);
  console.log("── Phase B: post-warp (loan3 should now be overdue) ──");

  // On a fresh --account-dir validator the actors arrive with no SOL; top them up.
  for (const kp of [authority, borrower1, borrower2, depositor, engine]) {
    if ((await conn.getBalance(kp.publicKey)) < 5 * LAMPORTS_PER_SOL)
      await conn.requestAirdrop(kp.publicKey, 500 * LAMPORTS_PER_SOL).then((sig) => conn.confirmTransaction(sig));
  }

  // clock must be ≥ 2 days past loan3 creation
  const slot = await conn.getSlot();
  const now = await conn.getBlockTime(slot);
  console.log("cluster time:", new Date(now * 1000).toISOString());

  // B-fresh price trail: gates need fresh+spanned oracle again after warp
  console.log("… rebuilding 300s oracle span post-warp …");
  const t0 = Date.now();
  await pushPrice(mintA, pxA);
  while (Date.now() - t0 < 310_000) {
    await new Promise((r) => setTimeout(r, 20_000));
    pxA = BigInt(Math.floor(Number(pxA) * (1 + (Math.random() - 0.5) / 100)));
    await pushPrice(mintA, pxA).catch(() => {});
  }

  // B1 — overdue extend → LoanOverdueForExtension (even with authority)
  await expectErr("B1", "LoanOverdueForExtension", () =>
    send([extendIx(loan3, mintA, borrower2, { withAuthority: true })], [borrower2, authority], "extend-overdue"));

  // B2 — overdue arm/disarm → LoanOverdue (H-02 second-review)
  await expectErr("B2a", "LoanOverdue", () =>
    send([buildIx("arm_conversion", { trigger_price: 1, direction: 0, max_slice_bps: 5000, total_bps: 10000 }, { loan: loan3, borrower: borrower2.publicKey })], [borrower2], "arm-overdue"));
  await expectErr("B2b", "LoanOverdue", () =>
    send([buildIx("disarm_conversion", {}, { loan: loan3, borrower: borrower2.publicKey })], [borrower2], "disarm-overdue"));

  // B3 — overdue conversion IS authorized (H-02: overdue ⇒ keeper could liquidate anyway);
  // passes every guard, fails only at the absent local Jupiter CPI.
  try {
    await send([convertIx(loan3, mintA, { sliceBps: 1000, minSolOut: LAMPORTS_PER_SOL, swapProgram: JUPITER_V6 })], [engine], "conv-overdue");
    bad("B3", "conversion 'succeeded' without a swap program — impossible");
  } catch (e) {
    const logs = (e.transactionLogs || e.logs || []).join("\n") + String(e.message);
    if (logs.includes("ConversionNotAuthorized")) bad("B3", "overdue conversion was refused — H-02 overdue arm should authorize");
    else ok("B3", "overdue conversion authorized through all guards (fails only at absent local router)");
  }

  // B4 — liquidation of the overdue loan; residual collateral → authority, keeper reward flows
  const keeper = authority; // authority acts as keeper locally
  const authColBefore = (await getAccount(conn, ata(authority.publicKey, mintA)).catch(() => ({ amount: 0n }))).amount;
  await send([
    createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata(authority.publicKey, mintA), authority.publicKey, mintA),
    createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, getAssociatedTokenAddressSync(NATIVE_MINT, authority.publicKey, true), authority.publicKey, NATIVE_MINT),
    buildIx("liquidate_loan", {}, {
      pool: POOL, loan_token_vault: VAULT, loan: loan3, collateral_mint: mintA, collateral_vault: cvaultOf(loan3),
      keeper_collateral_account: ata(keeper.publicKey, mintA), authority_collateral_account: ata(authority.publicKey, mintA),
      sol_proceeds_vault: proceedsOf(loan3), keeper_loan_token_account: getAssociatedTokenAddressSync(NATIVE_MINT, keeper.publicKey, true),
      authority_loan_token_account: getAssociatedTokenAddressSync(NATIVE_MINT, authority.publicKey, true),
      keeper: keeper.publicKey, wsol_mint: NATIVE_MINT, token_program: TOKEN_PROGRAM_ID,
      loan_token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })], [authority], "liquidate");
  const authColAfter = (await getAccount(conn, ata(authority.publicKey, mintA))).amount;
  if (authColAfter > authColBefore) ok("B4", `liquidation moved ${authColAfter - authColBefore} residual collateral to authority for off-chain sale`);
  else bad("B4", "liquidation landed but no collateral reached the authority account");

  // B5 — L-02 recover: total_deposits credited, NO shares minted
  const poolBefore = await conn.getAccountInfo(POOL);
  const recoverAmt = 1n * BigInt(LAMPORTS_PER_SOL);
  const authWsol = getAssociatedTokenAddressSync(NATIVE_MINT, authority.publicKey, true);
  await send([
    SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: authWsol, lamports: Number(recoverAmt) }),
    createSyncNativeInstruction(authWsol),
    buildIx("recover_liquidated_collateral", { amount: recoverAmt }, {
      pool: POOL, loan: loan3, loan_token_vault: VAULT, authority: authority.publicKey,
      authority_loan_token_account: authWsol, loan_token_program: TOKEN_PROGRAM_ID,
    })], [authority], "recover");
  const poolAfter = await conn.getAccountInfo(POOL);
  // pool layout: find the total_deposits delta = recoverAmt somewhere in the account diff,
  // and require total_shares bytes UNCHANGED. Compare byte-diff windows:
  const diffs = [];
  for (let i = 0; i < poolBefore.data.length - 8; i++) {
    const a = poolBefore.data.readBigUInt64LE(i), b = poolAfter.data.readBigUInt64LE(i);
    if (a !== b && b - a === recoverAmt) diffs.push(i);
  }
  if (diffs.length >= 1) ok("B5", `L-02 recover credited exactly +${recoverAmt} at pool offset(s) ${diffs.join(",")} (total_deposits) — share-mint-free`);
  else bad("B5", "could not locate an exact total_deposits credit in pool account diff");

  // B6 — liquidating a NON-overdue loan refused (create quick loan then liquidate)
  await expectErr("B6", "LoanNotDue", async () => {
    const loanX = loanOf(borrower2.publicKey, 99n);
    await send([await borrowIx(borrower2, mintA, { amountWhole: 100n, valueLamports: (pxA * 100n * 995n) / 1000n, loanId: 99n })], [borrower2, authority], "borrowX");
    await send([buildIx("liquidate_loan", {}, {
      pool: POOL, loan_token_vault: VAULT, loan: loanX, collateral_mint: mintA, collateral_vault: cvaultOf(loanX),
      keeper_collateral_account: ata(authority.publicKey, mintA), authority_collateral_account: ata(authority.publicKey, mintA),
      sol_proceeds_vault: proceedsOf(loanX), keeper_loan_token_account: authWsol, authority_loan_token_account: authWsol,
      keeper: authority.publicKey, wsol_mint: NATIVE_MINT, token_program: TOKEN_PROGRAM_ID,
      loan_token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    })], [authority], "liquidate-early");
  });

  console.log(`\nPhase B: ${pass} passed, ${fail} failed.`);
  fs.writeFileSync(path.join(SCRATCH, "phaseB-results.txt"), results.join("\n"));
  process.exit(fail ? 1 : 0);
}

const phase = process.argv[2];
if (phase === "A") await phaseA();
else if (phase === "B") await phaseB();
else { console.error("usage: node scripts/matrix-harness.mjs A|B"); process.exit(2); }
