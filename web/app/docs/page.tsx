import Link from "next/link";
import { DocShell, DOCS, H2 } from "@/components/DocShell";

export const metadata = { title: "Docs" };

export default function DocsPage() {
  return (
    <DocShell title="Docs" kicker="What the program enforces, not what we promise" current="/docs">
      <p>HOCK is a Solana launchpad with built-in lending. A coin launched here is graded continuously by a gate; once it passes, holders can lock it in a program-owned vault and borrow SOL from a pool of lender deposits at a fixed term. Every action is signed in the user's own wallet. No server holds keys or funds.</p>
      <H2>Read in this order</H2>
      <ol style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
        {DOCS.slice(1).map((d) => <li key={d.href}><Link href={d.href} style={{ fontWeight: 700 }}>{d.label}</Link></li>)}
      </ol>
      <H2>Three parts</H2>
      <ul style={{ margin: 0, paddingLeft: 22, display: "grid", gap: 8 }}>
        <li><strong>Program.</strong> The Anchor program hock_lending: pool, depositor positions, per-mint price history with a 30-minute TWAP, loans with in-vault collateral and borrower-armed limit-close triggers.</li>
        <li><strong>Engine.</strong> An off-chain service that attests prices, grades the gate, watches armed orders and overdue loans, and runs canaries. It can only call the three instructions the pool configures it for.</li>
        <li><strong>Site.</strong> This app. Launch, board, borrow, lend and these docs. It reads chain state through an RPC proxy and gate rows from a database; it never holds a key.</li>
      </ul>
      <p style={{ fontSize: 15, color: "var(--muted)" }}>Status: pre-devnet build. No mainnet program, pool or token exists. Anything claiming otherwise is an impostor; the security page publishes the real identifiers when they exist.</p>
    </DocShell>
  );
}
