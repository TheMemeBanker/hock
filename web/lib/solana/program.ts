/**
 * Anchor Program factory and typed reads for hock_lending.
 * Works with a wallet-adapter AnchorWallet (signing) or no wallet (read-only).
 * Account layouts come from the IDL; PDAs from ./pdas; TWAP arithmetic below
 * replicates PriceHistory::twap in lib.rs so the site shows what the program
 * would compute, not an approximation.
 */
import { AnchorProvider, BN, Program, type Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import idlJson from "@/lib/idl/hock_lending.json";
import type { HockLending } from "@/lib/idl/hock_lending";
import {
  MAX_PRICE_STALENESS_SECONDS,
  MAX_SPOT_VS_TWAP_PUMP_BPS,
  MIN_HISTORY_SECONDS,
  MIN_SAMPLES_FOR_TWAP,
  PRICE_HISTORY_CAPACITY,
  TWAP_WINDOW_SECONDS,
  BPS_DENOM,
  requirePoolPda,
  requireProgramId,
} from "./constants";
import { depositorPositionPda, priceFeedPda } from "./pdas";

export type AnchorWalletLike = {
  publicKey: PublicKey;
  signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T>;
  signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]>;
};

export type HockProgram = Program<HockLending>;

const readOnlyWallet: AnchorWalletLike = {
  publicKey: PublicKey.default,
  signTransaction: async () => {
    throw new Error("read-only provider cannot sign");
  },
  signAllTransactions: async () => {
    throw new Error("read-only provider cannot sign");
  },
};

/** Build a Program bound to the env program id (the IDL's address is replaced, never trusted blindly). */
export function getProgram(connection: Connection, wallet?: AnchorWalletLike | null): HockProgram {
  const programId = requireProgramId();
  const provider = new AnchorProvider(connection, wallet ?? readOnlyWallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
  const idl = { ...(idlJson as Idl), address: programId.toBase58() } as HockLending;
  return new Program<HockLending>(idl, provider);
}

/** Server-side connection from SOLANA_RPC_URL (provider key stays on the server). Null when unset. */
export function serverConnection(): Connection | null {
  const url = process.env.SOLANA_RPC_URL || process.env.RPC_PROXY_UPSTREAM || process.env.SOLANA_RPC_URL_FALLBACK;
  if (!url) return null;
  return new Connection(url, "confirmed");
}

// ---------- decoded shapes (bigint-safe, serialisable with toJSON helpers) ----------

export type PoolState = {
  address: PublicKey;
  authority: PublicKey;
  loanTokenVault: PublicKey;
  loanTokenMint: PublicKey;
  protocolFeeBps: number;
  keeperRewardBps: number;
  totalDeposits: bigint;
  totalShares: bigint;
  totalBorrowed: bigint;
  totalFeesEarned: bigint;
  pendingFees: bigint;
  totalLoansIssued: bigint;
  totalLiquidations: bigint;
  paused: boolean;
  engineAuthority: PublicKey;
  feeWallet: PublicKey;
};

export type LoanStatus = "active" | "repaid" | "liquidated";

export type LoanState = {
  address: PublicKey;
  loanId: bigint;
  borrower: PublicKey;
  pool: PublicKey;
  collateralMint: PublicKey;
  collateralVault: PublicKey;
  collateralAmount: bigint;
  currentCollateralAmount: bigint;
  loanAmount: bigint;
  repayAmount: bigint;
  transactionFee: bigint;
  ltvBps: number;
  durationDays: number;
  startTimestamp: number;
  dueTimestamp: number;
  status: LoanStatus;
  collateralValueAtStart: bigint;
  category: number;
  solProceedsAmount: bigint;
  autoSellsFired: number;
  accruedPoolFees: bigint;
  armedTriggerPrice: bigint;
  armedTriggerDirection: number;
  armedMaxSliceBps: number;
  armedTotalBps: number;
  armedConvertedBps: number;
};

export type PriceSample = { priceLamports: bigint; timestamp: number };

export type PriceFeedState = {
  address: PublicKey;
  mint: PublicKey;
  pool: PublicKey;
  authority: PublicKey;
  count: number;
  latest: PriceSample | null;
  /** Age of the latest sample in seconds (null when empty). */
  ageSeconds: number | null;
  fresh: boolean;
  twap: { price: bigint; samples: number; oldestAgeSeconds: number } | null;
  /** Whether request_and_fund_loan would accept this feed right now, and why not. */
  borrowable: boolean;
  reason: string;
  /** min(spot, twap): the price the program values collateral at. */
  valuationPrice: bigint | null;
};

export type DepositorPositionState = {
  address: PublicKey;
  owner: PublicKey;
  pool: PublicKey;
  shares: bigint;
  depositedAmount: bigint;
  lastDepositTs: number;
};

const big = (v: BN | number | bigint) => BigInt(v.toString());

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

function decodeLoan(address: PublicKey, a: Raw): LoanState {
  const statusKey = (Object.keys(a.status ?? {})[0] ?? "active").toLowerCase();
  return {
    address,
    loanId: big(a.loanId),
    borrower: a.borrower,
    pool: a.pool,
    collateralMint: a.collateralMint,
    collateralVault: a.collateralVault,
    collateralAmount: big(a.collateralAmount),
    currentCollateralAmount: big(a.currentCollateralAmount),
    loanAmount: big(a.loanAmount),
    repayAmount: big(a.repayAmount),
    transactionFee: big(a.transactionFee),
    ltvBps: Number(a.ltvBps),
    durationDays: Number(a.durationDays),
    startTimestamp: Number(a.startTimestamp),
    dueTimestamp: Number(a.dueTimestamp),
    status: statusKey as LoanStatus,
    collateralValueAtStart: big(a.collateralValueAtStart),
    category: Number(a.category),
    solProceedsAmount: big(a.solProceedsAmount),
    autoSellsFired: Number(a.autoSellsFired),
    accruedPoolFees: big(a.accruedPoolFees),
    armedTriggerPrice: big(a.armedTriggerPrice),
    armedTriggerDirection: Number(a.armedTriggerDirection),
    armedMaxSliceBps: Number(a.armedMaxSliceBps),
    armedTotalBps: Number(a.armedTotalBps),
    armedConvertedBps: Number(a.armedConvertedBps),
  };
}

export async function getPool(program: HockProgram, pool?: PublicKey): Promise<PoolState | null> {
  const address = pool ?? requirePoolPda();
  const a = await program.account.lendingPool.fetchNullable(address);
  if (!a) return null;
  return {
    address,
    authority: a.authority,
    loanTokenVault: a.loanTokenVault,
    loanTokenMint: a.loanTokenMint,
    protocolFeeBps: a.protocolFeeBps,
    keeperRewardBps: a.keeperRewardBps,
    totalDeposits: big(a.totalDeposits),
    totalShares: big(a.totalShares),
    totalBorrowed: big(a.totalBorrowed),
    totalFeesEarned: big(a.totalFeesEarned),
    pendingFees: big(a.pendingFees),
    totalLoansIssued: big(a.totalLoansIssued),
    totalLiquidations: big(a.totalLiquidations),
    paused: a.paused,
    engineAuthority: a.engineAuthority,
    feeWallet: a.feeWallet,
  };
}

export async function getLoan(program: HockProgram, loan: PublicKey): Promise<LoanState | null> {
  const a = await program.account.loan.fetchNullable(loan);
  return a ? decodeLoan(loan, a) : null;
}

/** All loans for a borrower (memcmp on Loan.borrower at offset 8 + 8). Needs getProgramAccounts: server-side only through the proxy. */
export async function getLoansForWallet(program: HockProgram, borrower: PublicKey): Promise<LoanState[]> {
  const rows = await program.account.loan.all([{ memcmp: { offset: 16, bytes: borrower.toBase58() } }]);
  return rows.map((r) => decodeLoan(r.publicKey, r.account)).sort((x, y) => y.startTimestamp - x.startTimestamp);
}

export async function getDepositorPosition(program: HockProgram, depositor: PublicKey, pool?: PublicKey): Promise<DepositorPositionState | null> {
  const poolKey = pool ?? requirePoolPda();
  const [address] = depositorPositionPda(poolKey, depositor, program.programId);
  const a = await program.account.depositorPosition.fetchNullable(address);
  if (!a) return null;
  return { address, owner: a.owner, pool: a.pool, shares: big(a.shares), depositedAmount: big(a.depositedAmount), lastDepositTs: Number(a.lastDepositTs) };
}

/**
 * Replica of PriceHistory::twap(now) from lib.rs, including the pre-window
 * carry-forward and the distinct-timestamp sample count.
 */
export function computeTwap(samples: PriceSample[], headIndex: number, count: number, now: number) {
  if (count === 0) return null;
  const cap = PRICE_HISTORY_CAPACITY;
  const start = count >= cap ? headIndex : 0;
  const ordered: PriceSample[] = [];
  for (let i = 0; i < Math.min(count, cap); i++) ordered.push(samples[(start + i) % cap]);
  const cutoff = now - TWAP_WINDOW_SECONDS;
  let carry: PriceSample | null = null;
  const inWindow: PriceSample[] = [];
  for (const s of ordered) {
    if (s.timestamp >= cutoff) inWindow.push(s);
    else carry = s;
  }
  let distinct = 0;
  for (let i = 0; i < inWindow.length; i++) if (i === 0 || inWindow[i].timestamp !== inWindow[i - 1].timestamp) distinct++;
  if (distinct < MIN_SAMPLES_FOR_TWAP) return null;
  let weighted = 0n;
  let totalWeight = 0n;
  const coverageStart = carry ? cutoff : inWindow[0].timestamp;
  if (carry) {
    const w = Math.max(0, inWindow[0].timestamp - cutoff);
    if (w > 0) {
      weighted += carry.priceLamports * BigInt(w);
      totalWeight += BigInt(w);
    }
  }
  for (let i = 0; i < inWindow.length; i++) {
    const end = i + 1 < inWindow.length ? inWindow[i + 1].timestamp : now;
    const w = Math.max(0, end - inWindow[i].timestamp);
    if (w === 0) continue;
    weighted += inWindow[i].priceLamports * BigInt(w);
    totalWeight += BigInt(w);
  }
  if (totalWeight <= 0n) return null;
  return { price: weighted / totalWeight, samples: distinct, oldestAgeSeconds: now - coverageStart };
}

const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
/** Cluster clock (Clock sysvar unix_timestamp): the program judges feed age against this, not the viewer's wall clock. Falls back to wall time minus 5 s. */
export async function chainNow(connection: Connection): Promise<number> {
  try {
    const info = await connection.getAccountInfo(SYSVAR_CLOCK, "processed");
    if (info) return Number(info.data.readBigInt64LE(32));
  } catch {
    /* fall through */
  }
  return Math.floor(Date.now() / 1000) - 5;
}

export async function getPriceFeed(program: HockProgram, mint: PublicKey, pool?: PublicKey, now?: number): Promise<PriceFeedState | null> {
  if (now === undefined) now = await chainNow(program.provider.connection);
  const poolKey = pool ?? requirePoolPda();
  const [address] = priceFeedPda(mint, poolKey, program.programId);
  const a = await program.account.priceHistory.fetchNullable(address);
  if (!a) return null;
  const samples: PriceSample[] = (a.samples as Raw[]).map((s) => ({ priceLamports: big(s.priceLamports), timestamp: Number(s.timestamp) }));
  const count = Number(a.count);
  const headIndex = Number(a.headIndex);
  const latest = count === 0 ? null : samples[(headIndex + PRICE_HISTORY_CAPACITY - 1) % PRICE_HISTORY_CAPACITY];
  const ageSeconds = latest ? now - latest.timestamp : null;
  const fresh = ageSeconds !== null && ageSeconds >= 0 && ageSeconds <= MAX_PRICE_STALENESS_SECONDS;
  const twap = computeTwap(samples, headIndex, count, now);
  let borrowable = false;
  let reason = "";
  if (!latest) reason = "No price samples yet.";
  else if (!fresh) reason = `Latest attestation is ${ageSeconds}s old; the program accepts at most ${MAX_PRICE_STALENESS_SECONDS}s.`;
  else if (!twap) reason = `TWAP needs at least ${MIN_SAMPLES_FOR_TWAP} distinct samples in the last ${TWAP_WINDOW_SECONDS / 60} minutes.`;
  else if (twap.oldestAgeSeconds < MIN_HISTORY_SECONDS) reason = `Price history covers ${twap.oldestAgeSeconds}s; the program requires ${MIN_HISTORY_SECONDS}s.`;
  else if (latest.priceLamports * BigInt(BPS_DENOM) > twap.price * BigInt(BPS_DENOM + MAX_SPOT_VS_TWAP_PUMP_BPS)) reason = `Spot is more than ${MAX_SPOT_VS_TWAP_PUMP_BPS / 100}% above TWAP; the program refuses to lend into a pump.`;
  else {
    borrowable = true;
    reason = "Feed fresh, TWAP valid, spot within the pump guard.";
  }
  const valuationPrice = latest && twap ? (latest.priceLamports < twap.price ? latest.priceLamports : twap.price) : null;
  return { address, mint: a.mint, pool: a.pool, authority: a.authority, count, latest, ageSeconds, fresh, twap, borrowable, reason, valuationPrice };
}

/** Collateral value in lamports exactly as the program computes it: amount * price / 10^decimals (floor). */
export function collateralValueLamports(amountRaw: bigint, priceLamports: bigint, decimals: number): bigint {
  return (amountRaw * priceLamports) / 10n ** BigInt(decimals);
}

/** Health as extend_loan_is_healthy evaluates it: (collateral value + proceeds) * ltv / 10000 >= repay. */
export function loanHealth(loan: LoanState, feed: PriceFeedState | null, decimals: number) {
  if (!feed?.valuationPrice || !feed.fresh) return null;
  const value = collateralValueLamports(loan.currentCollateralAmount, feed.valuationPrice, decimals) + loan.solProceedsAmount;
  const supported = (value * BigInt(loan.ltvBps)) / BigInt(BPS_DENOM);
  // Price at which supported debt equals repay: liquidation-style threshold for display.
  const denom = loan.currentCollateralAmount * BigInt(loan.ltvBps);
  const thresholdPrice = denom > 0n ? ((loan.repayAmount * BigInt(BPS_DENOM) - loan.solProceedsAmount * BigInt(loan.ltvBps)) * 10n ** BigInt(decimals)) / denom : null;
  return { collateralValue: value, supportedDebt: supported, healthy: supported >= loan.repayAmount, thresholdPrice: thresholdPrice && thresholdPrice > 0n ? thresholdPrice : null };
}

export { BN };
