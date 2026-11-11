import { DocShell, H2 } from "@/components/DocShell";

export const metadata = { title: "Terms" };

export default function Terms() {
  return (
    <DocShell title="Terms" kicker="Plain terms for a non-custodial protocol" current="/docs/terms">
      <H2>What HOCK is</H2>
      <p>HOCK is a website that lets you construct and sign Solana transactions against an open-source on-chain program and third-party services (a bonding-curve launch router, storage networks, aggregators). The site does not take custody of your assets, does not hold keys and cannot reverse a transaction you sign.</p>
      <H2>Eligibility</H2>
      <p>You must be legally permitted to use digital-asset services where you live. Do not use HOCK if you are a resident of, or acting on behalf of a person in, a jurisdiction where this activity is prohibited or where you are subject to sanctions.</p>
      <H2>Your responsibilities</H2>
      <ul style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
        <li>Verify the program id, pool and token addresses on the security page before interacting. Addresses are always shown in full.</li>
        <li>Read every simulated outcome before signing. A signed transaction is final.</li>
        <li>Monitor your loans. Due dates, triggers and health are shown on the borrow page and in notifications where enabled, but the obligation to act is yours.</li>
      </ul>
      <H2>No advice, no guarantee</H2>
      <p>Nothing on this site is financial, legal or tax advice. Figures are computed from chain state and third-party data at render time and may be delayed or wrong if those sources are. The program's behaviour, not this site's description of it, governs.</p>
      <H2>Fees</H2>
      <p>Fees are set by the program and the pool configuration and are described on the fees page. Network fees and priority fees are paid to the Solana network.</p>
      <H2>Changes and availability</H2>
      <p>The site may change or go offline. Your positions live on chain and remain actionable through any client that speaks to the program. The program may be upgraded by its authority; upgrades are published with their build hash on the security page.</p>
      <H2>Liability</H2>
      <p>To the fullest extent permitted by law, HOCK and its contributors are not liable for losses arising from use of the site or program, including losses from market movements, liquidations, conversions, third-party service failures or software defects.</p>
    </DocShell>
  );
}
