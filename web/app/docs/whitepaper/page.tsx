import { DocShell, H2, Table } from "@/components/DocShell";
import { MEMECOIN_TIERS, pct } from "@/lib/tiers";

export const metadata = { title: "Whitepaper" };

export default function Whitepaper() {
  return (
    <DocShell title="Whitepaper" kicker="Launch it. Hock it." current="/docs/whitepaper">
      <H2>Problem</H2>
      <p>New coins are liquid for a short window and illiquid for most of their life. Holders who want SOL without selling have two options: sell anyway, or hand their tokens to a custodian. Both end the position. HOCK offers a third: borrow against the coin, in a vault the program controls, on terms the program enforces.</p>
      <H2>Principles</H2>
      <ul style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
        <li><strong>Non-custodial.</strong> Users sign every borrow, repay, extend, limit-close arm and launch in their own wallet. The engine signs only the instructions the program authorises for its own key.</li>
        <li><strong>In-vault.</strong> Collateral moves into a program-owned vault at borrow time and leaves only on repay, liquidation or a conversion the program executes through an allowlist of routers.</li>
        <li><strong>Computed, never hard-coded.</strong> Every number the site shows is read from chain state or derived from it at request time.</li>
        <li><strong>Fails closed.</strong> A coin that cannot prove it is sellable is not collateral. A stale price is not a price. An engine that cannot verify a pre-condition does not fire.</li>
        <li><strong>One program version.</strong> One program id, one IDL, no routing table.</li>
      </ul>
      <H2>Lifecycle of a coin</H2>
      <ol style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 6 }}>
        <li>Launched on HOCK, or imported by address later through the same gate.</li>
        <li>On the board as launched; not collateral.</li>
        <li>The gate grades it every cycle: pooled liquidity, 24 h and 1 h volume, routability at loan size, top-holder concentration, Token-2022 extension audit, impersonation check.</li>
        <li>Collateral ready after two consecutive full passes. The price feed is initialised and attested.</li>
        <li>Holders borrow against it. Loans run to term; limit-closes fire if armed and triggered.</li>
        <li>If any check fails: delisted. No new loans; existing loans run out; the reason is shown.</li>
      </ol>
      <H2>Lifecycle of a loan</H2>
      <p>Borrow (user, attested price, in-vault) → optional arm (user consent on chain) → repay, extend, partial repay or add collateral (user) · or trigger reached → the engine converts slices inside the vault until principal plus fee is covered and the remainder returns to the borrower · or term passes unpaid → liquidation: lender made whole first, keeper reward, remainder recoverable.</p>
      <H2>Pricing</H2>
      <p>The engine attests a cross-sourced price per collateral mint into a 32-sample on-chain ring buffer. The program values collateral at the lower of the latest sample and a 30-minute time-weighted average, requires at least 8 distinct samples and 300 seconds of history, refuses a feed older than 120 seconds, refuses to lend when spot sits more than 15 percent above the TWAP, and rejects any single update that moves price by more than 100x.</p>
      <H2>Tiers</H2>
      <Table head={["Tier", "LTV", "Term", "Fee"]} rows={MEMECOIN_TIERS.map((t) => [t.name, pct(t.ltvBps), `${t.durationDays} days`, pct(t.feeBps)])} />
      <H2>What is deliberately not here</H2>
      <p>No custodial wallets. No multi-wallet launch tooling. No auto-sell on behalf of launchers. No referral or points system in version one. No real-world-asset tiers in version one.</p>
    </DocShell>
  );
}
