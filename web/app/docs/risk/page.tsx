import { DocShell, H2 } from "@/components/DocShell";

export const metadata = { title: "Risk" };

export default function Risk() {
  return (
    <DocShell title="Risk" kicker="Read before you launch, borrow or lend" current="/docs/risk">
      <H2>For borrowers</H2>
      <ul style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
        <li>Memecoins are volatile. If the attested price falls far enough that your tier's LTV no longer covers the repay amount, the loan is not provably healthy: it cannot self-extend, and if you armed a limit-close the engine may convert collateral at your trigger.</li>
        <li>A loan unpaid at the due date is liquidatable. The lender is made whole first; a keeper reward is paid; the remainder is recoverable, but collateral sold under liquidation realises whatever the market gives at the time.</li>
        <li>Conversions execute through an allowlist of routers with a program-enforced floor. In a fast collapse the floor may be unreachable, in which case nothing fires and the loan runs to term.</li>
        <li>If a coin is delisted by the gate, your existing loan continues to its term, but no new loan can be written against it and liquidity to repay by selling elsewhere may be thin.</li>
        <li>The pool authority co-signs each borrow; if that service is unavailable, new borrows pause. Repay, add collateral, arm and disarm never depend on it.</li>
      </ul>
      <H2>For lenders</H2>
      <ul style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
        <li>Deposits can lose value if a collateral coin becomes unsellable faster than the vault can exit. Low LTV, short terms and sliced conversions reduce this; they do not eliminate it.</li>
        <li>Withdrawals are limited to deposits not currently lent out. At high utilisation you may wait for repayments.</li>
        <li>Realised yield shown on the lend page is historical and computed from pool state. It is not a forecast.</li>
        <li>Smart-contract risk exists. The program is ported from a prior audited lending program; this build has not yet completed its own audit and nothing is deployed to mainnet.</li>
      </ul>
      <H2>For launchers</H2>
      <ul style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
        <li>Launching is free and permissionless; nothing about a launch guarantees the coin will clear the gate or hold value.</li>
        <li>The gate opens borrowing at $50,000 of market cap and, beneath that line, measures real liquidity, volume, routability and holder concentration. Concentrated supply or thin pools keep a coin out of collateral.</li>
      </ul>
      <H2>Platform</H2>
      <p>RPC providers can serve stale state; the site and engine fail over and check slot advance, but a sufficiently broad outage can delay actions. Nothing here is financial advice.</p>
    </DocShell>
  );
}
