/**
 * Loan tiers. Mirrors TIER_MEMECOIN_* and TIER_RWA_* in
 * program/programs/hock-lending/src/lib.rs. The program is the source of
 * truth; this table exists so the site can show the ladder before a loan
 * exists and compute previews with the same arithmetic the program uses.
 */
export type Tier = {
  option: 0 | 1 | 2;
  name: string;
  ltvBps: number;
  feeBps: number;
  durationDays: number;
};

export const MEMECOIN_TIERS: readonly Tier[] = [
  { option: 0, name: "Express", ltvBps: 3_000, feeBps: 300, durationDays: 2 },
  { option: 1, name: "Quick", ltvBps: 2_500, feeBps: 200, durationDays: 3 },
  { option: 2, name: "Standard", ltvBps: 2_000, feeBps: 150, durationDays: 7 },
];

/** Present in the program for a later version; not offered on the site in v1. */
export const RWA_TIERS: readonly Tier[] = [
  { option: 0, name: "RWA Express", ltvBps: 5_000, feeBps: 250, durationDays: 7 },
  { option: 1, name: "RWA Quick", ltvBps: 6_000, feeBps: 350, durationDays: 15 },
  { option: 2, name: "RWA Standard", ltvBps: 7_000, feeBps: 500, durationDays: 30 },
];

export function tiersFor(category: number): readonly Tier[] {
  return category === 1 ? RWA_TIERS : MEMECOIN_TIERS;
}

/** Resolve the tier a stored loan was written under (category + ltv_bps), as resolve_tier_for_loan does. */
export function tierForLoan(category: number, ltvBps: number): Tier | null {
  return tiersFor(category).find((t) => t.ltvBps === ltvBps) ?? null;
}

export const pct = (bps: number) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : bps % 50 === 0 ? 1 : 2)}%`;

const BPS = 10_000n;

/**
 * Loan arithmetic exactly as request_and_fund_loan computes it:
 * gross = value * ltv / 10000 (floor); fee = ceil(gross * fee_bps / 10000);
 * net = gross - fee; repay_amount = gross.
 */
export function previewLoan(valueLamports: bigint, tier: Tier) {
  const gross = (valueLamports * BigInt(tier.ltvBps)) / BPS;
  const fee = (gross * BigInt(tier.feeBps) + (BPS - 1n)) / BPS;
  const net = gross - fee;
  return { gross, fee, net, repay: gross };
}

/** Extension fee as extend_loan computes it: ceil(repay_amount * fee_bps / 10000). */
export function extensionFee(repayLamports: bigint, tier: Tier): bigint {
  return (repayLamports * BigInt(tier.feeBps) + (BPS - 1n)) / BPS;
}
