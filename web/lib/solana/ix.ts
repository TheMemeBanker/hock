/**
 * Transaction builders for every user-signed hock_lending instruction.
 * Account lists mirror the #[derive(Accounts)] structs in lib.rs one to one
 * (accountsStrict: nothing is auto-resolved, so a missing account is a type
 * error here rather than a runtime surprise). Each builder prepends a
 * compute-budget priority fee and the loan-token (wSOL) wrap/unwrap steps the
 * program expects around it.
 */
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import idlJson from "@/lib/idl/hock_lending.json";
import { priorityFeeInstructions } from "./priority-fee";
import { sendAndConfirmWithRebroadcast, type ConfirmResult } from "./send-confirm";
import { translateTxError } from "./tx-error";
import { BN, type HockProgram, type LoanState, type PoolState } from "./program";
import { collateralVaultPda, depositorPositionPda, loanPda, loanTokenVaultPda, priceFeedPda, solProceedsVaultPda } from "./pdas";
import { WSOL_MINT } from "./constants";

export type BuiltTx = {
  tx: Transaction;
  label: string;
  /** Writable keys, used for the priority-fee estimate. */
  accountKeys: string[];
  /** Whether a co-signature from the pool authority is required before broadcast. */
  needsAuthorityCosign?: boolean;
};

export type ProgramError = { title: string; body: string; code?: number; name?: string };

export type SimResult =
  | { ok: true; unitsConsumed: number | null; logs: string[] }
  | { ok: false; error: ProgramError; logs: string[] };

type Ctx = { program: HockProgram; connection: Connection; wallet: PublicKey; pool: PoolState };

const CU = { small: 60_000, token: 120_000, borrow: 400_000, repay: 260_000, extend: 200_000 } as const;

// ---------- token helpers ----------

/** Owner program of a mint: Tokenkeg or Token-2022. */
export async function mintTokenProgram(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error("Collateral mint account not found.");
  if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  if (info.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
  throw new Error("Mint is not owned by a token program.");
}

export function ata(mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey = TOKEN_PROGRAM_ID): PublicKey {
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
}

export function wsolAta(owner: PublicKey): PublicKey {
  return ata(WSOL_MINT, owner, TOKEN_PROGRAM_ID);
}

/** Create (idempotent) the owner's wSOL ATA and, when lamports > 0, wrap that much SOL into it. */
export function wrapSolIxs(owner: PublicKey, lamports: bigint): TransactionInstruction[] {
  const acct = wsolAta(owner);
  const ixs: TransactionInstruction[] = [createAssociatedTokenAccountIdempotentInstruction(owner, acct, owner, WSOL_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)];
  if (lamports > 0n) {
    ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: acct, lamports }));
    ixs.push(createSyncNativeInstruction(acct, TOKEN_PROGRAM_ID));
  }
  return ixs;
}

/** Close the wSOL ATA, returning every lamport in it (wrapped SOL and rent) to the owner. */
export function unwrapSolIx(owner: PublicKey): TransactionInstruction {
  return createCloseAccountInstruction(wsolAta(owner), owner, owner, [], TOKEN_PROGRAM_ID);
}

async function assemble(connection: Connection, payer: PublicKey, ixs: TransactionInstruction[], cu: number, label: string, needsAuthorityCosign = false): Promise<BuiltTx> {
  const writable = new Set<string>();
  for (const ix of ixs) for (const k of ix.keys) if (k.isWritable) writable.add(k.pubkey.toBase58());
  const accountKeys = [...writable];
  const prio = await priorityFeeInstructions(connection, cu, { accountKeys, label });
  const tx = new Transaction();
  tx.add(...prio, ...ixs);
  tx.feePayer = payer;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  return { tx, label, accountKeys, needsAuthorityCosign };
}

const bn = (v: bigint) => new BN(v.toString());

// ---------- lender ----------

/** deposit(amount): Deposit { pool, loan_token_vault, position, depositor_token_account, depositor, token_program, system_program } */
export async function deposit(c: Ctx, lamports: bigint): Promise<BuiltTx> {
  const [loanTokenVault] = loanTokenVaultPda(c.pool.address, c.program.programId);
  const [position] = depositorPositionPda(c.pool.address, c.wallet, c.program.programId);
  const ix = await c.program.methods
    .deposit(bn(lamports))
    .accountsStrict({
      pool: c.pool.address,
      loanTokenVault,
      position,
      depositorTokenAccount: wsolAta(c.wallet),
      depositor: c.wallet,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  return assemble(c.connection, c.wallet, [...wrapSolIxs(c.wallet, lamports), ix, unwrapSolIx(c.wallet)], CU.token, "deposit");
}

/** withdraw(shares): Withdraw { pool, loan_token_vault, position, depositor_token_account, depositor, token_program } */
export async function withdraw(c: Ctx, shares: bigint): Promise<BuiltTx> {
  const [loanTokenVault] = loanTokenVaultPda(c.pool.address, c.program.programId);
  const [position] = depositorPositionPda(c.pool.address, c.wallet, c.program.programId);
  const ix = await c.program.methods
    .withdraw(bn(shares))
    .accountsStrict({
      pool: c.pool.address,
      loanTokenVault,
      position,
      depositorTokenAccount: wsolAta(c.wallet),
      depositor: c.wallet,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return assemble(c.connection, c.wallet, [...wrapSolIxs(c.wallet, 0n), ix, unwrapSolIx(c.wallet)], CU.token, "withdraw");
}

// ---------- borrower ----------

export type BorrowParams = {
  mint: PublicKey;
  collateralAmountRaw: bigint;
  /** Collateral value in lamports at the program's valuation price (min(spot, TWAP)). */
  collateralValueLamports: bigint;
  tier: 0 | 1 | 2;
  category?: number;
  loanId?: bigint;
};

/**
 * request_and_fund_loan(collateral_amount, loan_option, collateral_value, loan_id, category):
 * RequestLoan { pool, loan_token_vault, loan, collateral_vault, collateral_mint, borrower_collateral_account,
 *   borrower_loan_token_account, fee_wallet_token_account, borrower, authority (signer: pool.authority),
 *   price_feed, system_program, token_program (collateral), loan_token_program (Tokenkeg), rent }
 * The pool authority must co-sign (lib.rs: "Pool authority must co-sign every borrow"), so the returned
 * transaction is partially signable by the wallet and must be completed by the authority before broadcast.
 */
export async function requestAndFundLoan(c: Ctx, p: BorrowParams): Promise<BuiltTx & { loanId: bigint; loan: PublicKey }> {
  const loanId = p.loanId ?? BigInt(Date.now());
  const tokenProgram = await mintTokenProgram(c.connection, p.mint);
  const [loanTokenVault] = loanTokenVaultPda(c.pool.address, c.program.programId);
  const [loan] = loanPda(c.wallet, loanId, c.program.programId);
  const [collateralVault] = collateralVaultPda(loan, c.program.programId);
  const [priceFeed] = priceFeedPda(p.mint, c.pool.address, c.program.programId);
  const ix = await c.program.methods
    .requestAndFundLoan(bn(p.collateralAmountRaw), p.tier, bn(p.collateralValueLamports), bn(loanId), p.category ?? 0)
    .accountsStrict({
      pool: c.pool.address,
      loanTokenVault,
      loan,
      collateralVault,
      collateralMint: p.mint,
      borrowerCollateralAccount: ata(p.mint, c.wallet, tokenProgram),
      borrowerLoanTokenAccount: wsolAta(c.wallet),
      feeWalletTokenAccount: c.pool.feeWallet,
      borrower: c.wallet,
      authority: c.pool.authority,
      priceFeed,
      systemProgram: SystemProgram.programId,
      tokenProgram,
      loanTokenProgram: TOKEN_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  const built = await assemble(c.connection, c.wallet, [...wrapSolIxs(c.wallet, 0n), ix, unwrapSolIx(c.wallet)], CU.borrow, "borrow", true);
  return { ...built, loanId, loan };
}

/**
 * repay_loan(): RepayLoan { pool, loan_token_vault, loan, collateral_mint, collateral_vault, borrower_collateral_account,
 *   borrower_loan_token_account, borrower, sol_proceeds_vault, wsol_mint, token_program, loan_token_program, system_program, rent }
 * Wraps repay_amount SOL first (minus any wSOL already held), unwraps everything after.
 */
export async function repayLoan(c: Ctx, loan: LoanState): Promise<BuiltTx> {
  const tokenProgram = await mintTokenProgram(c.connection, loan.collateralMint);
  const [loanTokenVault] = loanTokenVaultPda(c.pool.address, c.program.programId);
  const [collateralVault] = collateralVaultPda(loan.address, c.program.programId);
  const [solProceedsVault] = solProceedsVaultPda(loan.address, c.program.programId);
  const toWrap = await shortfall(c.connection, c.wallet, loan.repayAmount);
  const collAta = ata(loan.collateralMint, c.wallet, tokenProgram);
  const ix = await c.program.methods
    .repayLoan()
    .accountsStrict({
      pool: c.pool.address,
      loanTokenVault,
      loan: loan.address,
      collateralMint: loan.collateralMint,
      collateralVault,
      borrowerCollateralAccount: collAta,
      borrowerLoanTokenAccount: wsolAta(c.wallet),
      borrower: c.wallet,
      solProceedsVault,
      wsolMint: WSOL_MINT,
      tokenProgram,
      loanTokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  const ensureColl = createAssociatedTokenAccountIdempotentInstruction(c.wallet, collAta, c.wallet, loan.collateralMint, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);
  return assemble(c.connection, c.wallet, [ensureColl, ...wrapSolIxs(c.wallet, toWrap), ix, unwrapSolIx(c.wallet)], CU.repay, "repay");
}

/** partial_repay(amount): PartialRepay { pool, loan_token_vault, loan, borrower_loan_token_account, borrower, loan_token_program } */
export async function partialRepay(c: Ctx, loan: LoanState, lamports: bigint): Promise<BuiltTx> {
  const [loanTokenVault] = loanTokenVaultPda(c.pool.address, c.program.programId);
  const toWrap = await shortfall(c.connection, c.wallet, lamports);
  const ix = await c.program.methods
    .partialRepay(bn(lamports))
    .accountsStrict({
      pool: c.pool.address,
      loanTokenVault,
      loan: loan.address,
      borrowerLoanTokenAccount: wsolAta(c.wallet),
      borrower: c.wallet,
      loanTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return assemble(c.connection, c.wallet, [...wrapSolIxs(c.wallet, toWrap), ix, unwrapSolIx(c.wallet)], CU.token, "partial repay");
}

/** add_collateral(amount): AddCollateral { loan, collateral_mint, collateral_vault, borrower_collateral_account, borrower, token_program } */
export async function addCollateral(c: Ctx, loan: LoanState, amountRaw: bigint): Promise<BuiltTx> {
  const tokenProgram = await mintTokenProgram(c.connection, loan.collateralMint);
  const [collateralVault] = collateralVaultPda(loan.address, c.program.programId);
  const ix = await c.program.methods
    .addCollateral(bn(amountRaw))
    .accountsStrict({
      loan: loan.address,
      collateralMint: loan.collateralMint,
      collateralVault,
      borrowerCollateralAccount: ata(loan.collateralMint, c.wallet, tokenProgram),
      borrower: c.wallet,
      tokenProgram,
    })
    .instruction();
  return assemble(c.connection, c.wallet, [ix], CU.token, "add collateral");
}

/**
 * extend_loan(): ExtendLoan { pool, loan_token_vault, loan, collateral_mint, price_history, borrower_loan_token_account,
 *   fee_wallet_token_account, borrower, authority (optional; only when the loan is not provably healthy), loan_token_program }
 * Wraps the extension fee (ceil(repay * fee_bps / 10000)) first.
 */
export async function extendLoan(c: Ctx, loan: LoanState, feeLamports: bigint): Promise<BuiltTx> {
  const [loanTokenVault] = loanTokenVaultPda(c.pool.address, c.program.programId);
  const [priceHistory] = priceFeedPda(loan.collateralMint, c.pool.address, c.program.programId);
  const toWrap = await shortfall(c.connection, c.wallet, feeLamports);
  const ix = await c.program.methods
    .extendLoan()
    .accountsStrict({
      pool: c.pool.address,
      loanTokenVault,
      loan: loan.address,
      collateralMint: loan.collateralMint,
      priceHistory,
      borrowerLoanTokenAccount: wsolAta(c.wallet),
      feeWalletTokenAccount: c.pool.feeWallet,
      borrower: c.wallet,
      authority: null,
      loanTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return assemble(c.connection, c.wallet, [...wrapSolIxs(c.wallet, toWrap), ix, unwrapSolIx(c.wallet)], CU.extend, "extend");
}

export type ArmParams = {
  /** Trigger price in lamports per whole token, same unit as the attested feed. */
  triggerPriceLamports: bigint;
  /** 0 = take-profit (fires at or above), 1 = stop-loss (fires at or below). */
  direction: 0 | 1;
  /** Largest slice per fire, bps of original collateral (0, 10000]. */
  maxSliceBps: number;
  /** Total the engine may convert across fires, bps, >= maxSliceBps. */
  totalBps: number;
};

/**
 * arm_conversion(trigger_price, direction, max_slice_bps, total_bps): ArmConversion { loan, borrower }
 * Note: the program takes no min_sol_out from the borrower; the oracle floor (TWAP value minus
 * MAX_PROTOCOL_SLIPPAGE_BPS) is enforced on chain against whatever the engine submits.
 */
export async function armConversion(c: Ctx, loan: LoanState, p: ArmParams): Promise<BuiltTx> {
  const ix = await c.program.methods
    .armConversion(bn(p.triggerPriceLamports), p.direction, p.maxSliceBps, p.totalBps)
    .accountsStrict({ loan: loan.address, borrower: c.wallet })
    .instruction();
  return assemble(c.connection, c.wallet, [ix], CU.small, "arm limit-close");
}

/** disarm_conversion(): DisarmConversion { loan, borrower } */
export async function disarmConversion(c: Ctx, loan: LoanState): Promise<BuiltTx> {
  const ix = await c.program.methods.disarmConversion().accountsStrict({ loan: loan.address, borrower: c.wallet }).instruction();
  return assemble(c.connection, c.wallet, [ix], CU.small, "disarm limit-close");
}

/**
 * recover_liquidated_collateral(amount): RecoverLiquidatedCollateral { pool, loan, loan_token_vault, authority, authority_loan_token_account, loan_token_program }
 * Pool-authority only (authority == pool.authority is required on chain). Exposed for the operator console; a
 * borrower wallet cannot sign this.
 */
export async function recoverLiquidatedCollateral(c: Ctx, loan: LoanState, lamports: bigint): Promise<BuiltTx> {
  const [loanTokenVault] = loanTokenVaultPda(c.pool.address, c.program.programId);
  const toWrap = await shortfall(c.connection, c.wallet, lamports);
  const ix = await c.program.methods
    .recoverLiquidatedCollateral(bn(lamports))
    .accountsStrict({
      pool: c.pool.address,
      loan: loan.address,
      loanTokenVault,
      authority: c.wallet,
      authorityLoanTokenAccount: wsolAta(c.wallet),
      loanTokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();
  return assemble(c.connection, c.wallet, [...wrapSolIxs(c.wallet, toWrap), ix, unwrapSolIx(c.wallet)], CU.token, "recover");
}

/** Lamports to wrap so the wSOL ATA holds at least `need`. */
async function shortfall(connection: Connection, owner: PublicKey, need: bigint): Promise<bigint> {
  try {
    const bal = await connection.getTokenAccountBalance(wsolAta(owner), "confirmed");
    const have = BigInt(bal.value.amount);
    return need > have ? need - have : 0n;
  } catch {
    return need;
  }
}

// ---------- simulate / errors / send ----------

const IDL_ERRORS: { code: number; name: string; msg?: string }[] = (idlJson as { errors?: { code: number; name: string; msg?: string }[] }).errors ?? [];

/** Map a program error code (from logs or an InstructionError) to the IDL's message. */
export function programErrorFromCode(code: number): ProgramError | null {
  const e = IDL_ERRORS.find((x) => x.code === code);
  if (!e) return null;
  return { title: e.name.replace(/([a-z])([A-Z])/g, "$1 $2"), body: e.msg ?? e.name, code: e.code, name: e.name };
}

export function parseProgramError(raw: unknown, logs: string[] = [], flow: "deposit" | "withdraw" | "repay" = "repay"): ProgramError {
  const blob = `${raw instanceof Error ? raw.message : typeof raw === "string" ? raw : JSON.stringify(raw ?? "")}\n${logs.join("\n")}`;
  const num = blob.match(/Error Number:\s*(\d+)/);
  const hex = blob.match(/custom program error:\s*0x([0-9a-f]+)/i);
  const json = blob.match(/"Custom"\s*:\s*(\d+)/);
  const code = num ? Number(num[1]) : hex ? parseInt(hex[1], 16) : json ? Number(json[1]) : null;
  if (code !== null && code >= 6000) {
    const e = programErrorFromCode(code);
    if (e) return e;
  }
  const f = translateTxError(raw, { flow });
  return { title: f.title, body: f.body, code: code ?? undefined };
}

/** Preflight: simulate without signatures and return the parsed program error if any. */
export async function simulate(connection: Connection, built: BuiltTx, flow: "deposit" | "withdraw" | "repay" = "repay"): Promise<SimResult> {
  try {
    const res = await connection.simulateTransaction(built.tx);
    const logs = res.value.logs ?? [];
    if (res.value.err) return { ok: false, error: parseProgramError(res.value.err, logs, flow), logs };
    return { ok: true, unitsConsumed: res.value.unitsConsumed ?? null, logs };
  } catch (e) {
    return { ok: false, error: parseProgramError(e, [], flow), logs: [] };
  }
}

export type SignerLike = {
  sendTransaction: (tx: Transaction, connection: Connection) => Promise<string>;
  signTransaction?: <T extends Transaction | import("@solana/web3.js").VersionedTransaction>(tx: T) => Promise<T>;
};

/** Sign in the wallet and broadcast with rebroadcast-until-confirmed. */
export async function signAndSend(connection: Connection, built: BuiltTx, wallet: SignerLike): Promise<ConfirmResult> {
  return sendAndConfirmWithRebroadcast(connection, built.tx, {
    sendTransaction: (tx, conn) => wallet.sendTransaction(tx as Transaction, conn),
    signTransaction: wallet.signTransaction,
    commitment: "confirmed",
  });
}

/**
 * Borrow path: the wallet signs first, then the pool authority co-signs through the relay at
 * NEXT_PUBLIC_COSIGN_URL (POST { tx: base64 } -> { tx: base64 }). Without a relay the borrow
 * cannot be completed; the caller shows that plainly instead of pretending.
 */
export async function signCosignAndSend(connection: Connection, built: BuiltTx, wallet: SignerLike): Promise<ConfirmResult> {
  const relay = process.env.NEXT_PUBLIC_COSIGN_URL;
  if (!relay) throw new Error("Borrow co-sign relay is not configured (NEXT_PUBLIC_COSIGN_URL). The pool authority must co-sign every borrow.");
  if (!wallet.signTransaction) throw new Error("This wallet cannot partially sign; use a wallet that supports signTransaction.");
  const userSigned = await wallet.signTransaction(built.tx);
  const body = { tx: Buffer.from(userSigned.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64") };
  const r = await fetch(relay, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`Co-sign relay refused (${r.status}): ${(await r.text()).slice(0, 200)}`);
  const j = (await r.json()) as { tx?: string; error?: string };
  if (!j.tx) throw new Error(j.error || "Co-sign relay returned no transaction.");
  const full = Transaction.from(Buffer.from(j.tx, "base64"));
  return sendAndConfirmWithRebroadcast(connection, full, {
    sendTransaction: async (tx, conn) => conn.sendRawTransaction((tx as Transaction).serialize(), { skipPreflight: false, maxRetries: 0 }),
    signTransaction: (async (tx: Transaction) => tx) as SignerLike["signTransaction"],
    commitment: "confirmed",
  });
}
