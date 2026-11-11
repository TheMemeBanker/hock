import { DocShell, H2 } from "@/components/DocShell";

export const metadata = { title: "How it works" };

export default function HowItWorks() {
  return (
    <DocShell title="How it works" kicker="Three steps, one wallet" current="/docs/how-it-works">
      <H2>1. Launch</H2>
      <p>Name the coin, add the art, sign once. Metadata is pinned to Arweave (you sign one message) or IPFS through a relay; the mint keypair is generated in your browser; the create transaction is built, simulated so you see the exact fee, signed by you and rebroadcast with a dynamic priority fee until it confirms. The new mint is registered with the gate immediately. Creating is free; an optional initial buy pays only the router's own fee.</p>
      <H2>2. Clear the gate</H2>
      <p>The engine grades every HOCK-launched mint continuously on five checks: pooled liquidity, trading velocity, routability on Jupiter at the loan size, top-holder concentration and a token-program extension audit. A coin is promoted to collateral only when all five pass twice in a row, and demoted the moment one fails. Demotion stops new borrows; existing loans continue to their term. Progress and the reason for any failure are shown on the coin's page.</p>
      <H2>3. Hock it</H2>
      <p>On a collateral-ready coin's page, pick a tier and an amount. The site reads the on-chain price feed, computes the collateral value at the lower of spot and TWAP, shows principal, fee, repay amount, due date, the health threshold and the conversion floor, then simulates the exact transaction. Only after a passing simulation does your wallet ask for a signature. The program also requires the pool authority to co-sign each borrow as its attestation of the collateral value; your signature is collected first and the transaction is broadcast once both are present.</p>
      <H2>While the loan runs</H2>
      <ul style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
        <li><strong>Repay</strong> the full amount any time before the due date; collateral and any proceeds in the vault return to you in the same transaction.</li>
        <li><strong>Partial repay</strong> reduces the outstanding amount; the final payment goes through repay so the vault is closed properly.</li>
        <li><strong>Add collateral</strong> at no fee to move the health threshold down.</li>
        <li><strong>Extend</strong> for another term at the tier fee on the outstanding amount. A loan the program can prove healthy from a fresh feed extends on your signature alone; otherwise the pool authority must co-sign.</li>
        <li><strong>Arm a limit-close</strong>: on-chain consent for the engine to convert collateral inside the vault once the attested price crosses your trigger, in slices you cap. The program enforces a floor on every slice: at least its TWAP value minus 15 percent. Disarm any time before the due date.</li>
      </ul>
      <H2>If the trigger is reached, or the term passes</H2>
      <p>The engine converts slices inside the vault until principal plus fee is covered and returns the rest to you. Past the due date, an unpaid loan is liquidated: the lender is made whole first, a keeper reward is paid from proceeds, and the remainder is recoverable. You are warned at 10 percent and 5 percent above the trigger price.</p>
      <H2>Lend</H2>
      <p>Deposit SOL into the pool and receive shares. Origination fees flow into the pool and raise the value of every share; a configurable protocol share goes to the fee destination. Withdraw any time, limited by what is not currently lent out.</p>
    </DocShell>
  );
}
