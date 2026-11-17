import { DocShell, H2 } from "@/components/DocShell";
import { MILESTONE_TIERS, MILESTONE_RULES, BOOSTS, MAX_BOOST } from "@/lib/rewards";

export const metadata = { title: "Milestone rewards" };

const usd = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `$${(n / 1e3).toFixed(0)}k`;

export default function Rewards() {
  const total = MILESTONE_TIERS.reduce((a, t) => a + t.rewardSol, 0);
  return (
    <DocShell title="Milestone rewards" kicker="HOCK pays launchers whose coins prove themselves" current="/docs/rewards">
      <p>
        Every coin launched on HOCK is on a ladder. When its market cap holds a milestone, HOCK pays the launcher in SOL. The ladder rewards coins that get there and stay there, not coins that print one candle: a milestone counts only on the same 30-minute TWAP the vault uses, held for a full day, with the gate passing and the launcher still holding.
      </p>

      <H2>The ladder</H2>
      <div style={{ overflowX: "auto" }}><table>
        <thead><tr><th>Tier</th><th>Market cap held</th><th>Reward</th><th>With max boost</th></tr></thead>
        <tbody>
          {MILESTONE_TIERS.map((t) => (
            <tr key={t.rank}>
              <td><strong>{t.rank}. {t.name}</strong></td>
              <td className="mono">{usd(t.capUsd)}</td>
              <td className="mono">{t.rewardSol} SOL</td>
              <td className="mono">{(t.rewardSol * MAX_BOOST).toFixed(2)} SOL</td>
            </tr>
          ))}
          <tr><td><strong>Whole ladder</strong></td><td /><td className="mono">{total} SOL</td><td className="mono">{(total * MAX_BOOST).toFixed(0)} SOL</td></tr>
        </tbody>
      </table></div>
      <p style={{ color: "var(--muted)", fontSize: 14 }}>Tiers pay once each, in order. A coin that opens at $300k still collects Ignition, Orbit and Escape, one hold window each. The per-coin lifetime cap is {MILESTONE_RULES.perCoinCapSol} SOL.</p>

      <H2>What counts as holding a milestone</H2>
      <ul>
        <li><strong>The feed, not the candle.</strong> Market cap is the 30-minute TWAP price times circulating supply, read from the same attested feed that sizes loans. A spike that the pump guard would ignore for a loan is ignored here too.</li>
        <li><strong>{MILESTONE_RULES.holdHours} hours without a break.</strong> The TWAP market cap must stay at or above the line for {MILESTONE_RULES.holdHours} consecutive hours. One cycle below the line restarts the clock.</li>
        <li><strong>The gate must be open.</strong> All gate checks pass at claim: pooled liquidity, trading velocity, routability at loan size, holder concentration, clean token extensions.</li>
        <li><strong>Real distribution.</strong> At least {MILESTONE_RULES.minHolders} holders excluding the launcher, pools and burn; top ten hold at most {MILESTONE_RULES.maxTop10Pct}%; the launcher wallet holds at most {MILESTONE_RULES.maxLauncherPct}% of supply.</li>
        <li><strong>Real trading.</strong> During the hold window, 24-hour volume is at least {MILESTONE_RULES.minVolumeToCapPct}% of market cap with at least {MILESTONE_RULES.minTraders24h} unique traders. Wash patterns (the same wallets round-tripping) are excluded from both counts.</li>
      </ul>

      <H2>Launcher conduct</H2>
      <ul>
        <li><strong>Still holding.</strong> At claim, the launcher wallet holds at least {MILESTONE_RULES.launcherMinRetainedPct}% of its day-0 allocation.</li>
        <li><strong>No sells in the window.</strong> Zero launcher sells during the {MILESTONE_RULES.noSellWindowHours}-hour hold. Sells reset the clock for that tier.</li>
        <li><strong>Dumping forfeits the ladder.</strong> Selling more than {MILESTONE_RULES.dumpForfeitPct}% of the allocation, ever, forfeits every tier not yet paid. Paid tiers are never clawed back.</li>
        <li><strong>One launcher wallet.</strong> The creator wallet from the launch transaction. Allocations moved to other wallets count as sold.</li>
      </ul>

      <H2>Boosts</H2>
      <div style={{ overflowX: "auto" }}><table>
        <thead><tr><th>Boost</th><th>Adds</th><th>Earned when</th></tr></thead>
        <tbody>
          {BOOSTS.map((b) => <tr key={b.id}><td><strong>{b.name}</strong></td><td className="mono">+{Math.round(b.mult * 100)}%</td><td>{b.why}</td></tr>)}
        </tbody>
      </table></div>
      <p style={{ color: "var(--muted)", fontSize: 14 }}>Boosts stack to a maximum of {MAX_BOOST}x and apply to every tier paid while they hold. The second boost is the point of the product: a launcher who needs SOL and hocks the coin instead of selling it earns more from the ladder, not less.</p>

      <H2>How payouts work</H2>
      <ul>
        <li>When a hold window completes, the tier becomes <strong>claimable</strong> on the launcher's dashboard for {MILESTONE_RULES.claimWindowDays} days. The launcher claims with one signature; SOL is paid from the Rewards Pool to the launcher wallet.</li>
        <li>The Rewards Pool is funded by {Math.round(MILESTONE_RULES.rewardsPoolShareOfProtocolFees * 100)}% of HOCK's share of borrow fees plus launch-partner contributions. Its balance and every payout are public.</li>
        <li>If the pool cannot cover a claim, claims queue in the order the hold windows completed and pay as the pool refills. Nothing is paid out of lender capital, ever.</li>
        <li>Every evaluation the engine makes (feed samples, holder counts, volume, launcher balance) is stored with the claim, so a payout can be audited after the fact.</li>
      </ul>

      <H2>Why these rules</H2>
      <p>
        Paying for market cap with no conditions pays for pumps. Each rule closes one door: the TWAP closes the candle, the hold window closes the flash, the distribution floor closes the one-wallet coin, the trading floor closes the dead coin, the conduct rules close the dump, and the forfeit makes the dump expensive for anyone already on the ladder. What is left to reward is the thing HOCK wants more of: coins that climb and launchers who stay.
      </p>
      <p style={{ color: "var(--muted)", fontSize: 14 }}>Status: program design, surfaced here and on the demo dashboard before the payout path ships. Amounts and thresholds are parameters and may change before launch; changes are announced and never applied to a hold window already in progress.</p>
    </DocShell>
  );
}
