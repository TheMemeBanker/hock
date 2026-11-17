/**
 * HOCK Milestones: rewards paid to a launcher when their coin holds a market-cap milestone.
 *
 * Designed to pay for coins that PROVE themselves, not coins that print a candle:
 *   - a milestone counts only when the 30-minute TWAP market cap (the same feed the vault uses)
 *     stays at or above the line for HOLD_HOURS without a break;
 *   - the coin must pass every gate check at claim time (liquidity, velocity, routability,
 *     holder spread, clean extensions) and meet the distribution floor below;
 *   - the launcher must still hold most of their day-0 allocation and must not have sold during
 *     the hold window; dumping forfeits every tier above the last one paid;
 *   - tiers pay once, in order, in SOL, from the Rewards Pool; boosts reward holding and hocking.
 *
 * Every constant here is a program/engine parameter, surfaced on the site so it is never a surprise.
 */

export type MilestoneTier = {
  rank: number;
  name: string;
  capUsd: number;
  rewardSol: number;
};

export const MILESTONE_TIERS: readonly MilestoneTier[] = [
  { rank: 1, name: "Ignition", capUsd: 50_000, rewardSol: 0.5 },
  { rank: 2, name: "Orbit", capUsd: 100_000, rewardSol: 1 },
  { rank: 3, name: "Escape", capUsd: 250_000, rewardSol: 2.5 },
  { rank: 4, name: "Deep space", capUsd: 500_000, rewardSol: 5 },
  { rank: 5, name: "Interstellar", capUsd: 1_000_000, rewardSol: 10 },
  { rank: 6, name: "Supernova", capUsd: 5_000_000, rewardSol: 25 },
];

export const MILESTONE_RULES = {
  holdHours: 24, // TWAP market cap must hold the line this long, uninterrupted
  claimWindowDays: 30, // after the hold completes
  minHolders: 100, // unique holders excluding the launcher, pools and burn
  maxTop10Pct: 40, // same as the gate
  maxLauncherPct: 10, // launcher wallet share of supply at claim
  minVolumeToCapPct: 10, // 24h volume must be at least this share of market cap during the hold
  minTraders24h: 50, // unique traders in the hold window
  launcherMinRetainedPct: 50, // launcher must still hold at least half of their day-0 allocation
  noSellWindowHours: 24, // no launcher sells during the hold window
  dumpForfeitPct: 50, // selling more than half of the allocation forfeits all unpaid tiers
  perCoinCapSol: 66, // sum of tiers (44) x max boost (1.5)
  rewardsPoolShareOfProtocolFees: 0.5, // half of HOCK's fee share tops up the Rewards Pool
} as const;

export type Boost = { id: string; name: string; mult: number; why: string };
export const BOOSTS: readonly Boost[] = [
  { id: "diamond", name: "Never sold", mult: 0.25, why: "launcher wallet has sold zero tokens since launch" },
  { id: "hocked", name: "Hocked, not sold", mult: 0.25, why: "launcher wrote a ticket against the coin instead of selling" },
];
export const MAX_BOOST = 1.5;

export type MilestoneStatus = "paid" | "claimable" | "holding" | "locked" | "forfeited";
export type MilestoneRow = MilestoneTier & { status: MilestoneStatus; dayReached: number | null; paidSol: number; holdPct: number };

/**
 * Evaluate the ladder against a day-by-day TWAP market-cap path (one sample per day in the demo;
 * the engine evaluates per gate cycle). `boost` is the multiplier already earned (1.0 to MAX_BOOST).
 */
export function evaluateMilestones(path: number[], opts: { boost: number; gatePasses: boolean; launcherRetainedPct: number; today: number }): MilestoneRow[] {
  const { boost, gatePasses, launcherRetainedPct, today } = opts;
  const holdDays = Math.max(1, Math.round(MILESTONE_RULES.holdHours / 24));
  const dumped = launcherRetainedPct < 100 - MILESTONE_RULES.dumpForfeitPct;
  let previousPaid = true;
  return MILESTONE_TIERS.map((t) => {
    // first day from which the cap stayed >= line for holdDays consecutive samples
    let reached: number | null = null;
    for (let d = 0; d + holdDays - 1 < path.length; d++) {
      if (path.slice(d, d + holdDays).every((v) => v >= t.capUsd)) { reached = d + holdDays - 1; break; }
    }
    // partial hold progress for the row that is currently above the line but not yet held long enough
    let holdPct = 0;
    if (reached === null) {
      let run = 0;
      for (let d = path.length - 1; d >= 0 && path[d] >= t.capUsd; d--) run++;
      holdPct = Math.min(1, run / holdDays);
    }
    let status: MilestoneStatus;
    if (dumped && !(reached !== null && reached <= today && previousPaid && gatePasses)) status = "forfeited";
    else if (reached !== null && reached <= today && previousPaid && gatePasses) status = "paid";
    else if (reached !== null && reached <= today && previousPaid) status = "claimable";
    else if (holdPct > 0) status = "holding";
    else status = "locked";
    const paidSol = status === "paid" ? Math.min(t.rewardSol * Math.min(boost, MAX_BOOST), MILESTONE_RULES.perCoinCapSol) : 0;
    previousPaid = status === "paid";
    return { ...t, status, dayReached: reached, paidSol, holdPct };
  });
}

export function boostFor(flags: { neverSold: boolean; hocked: boolean }): { mult: number; active: Boost[] } {
  const active = BOOSTS.filter((b) => (b.id === "diamond" && flags.neverSold) || (b.id === "hocked" && flags.hocked));
  return { mult: Math.min(MAX_BOOST, 1 + active.reduce((a, b) => a + b.mult, 0)), active };
}
