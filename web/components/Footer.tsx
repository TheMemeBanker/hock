import Link from "next/link";

export function Footer() {
  return (
    <footer style={{ padding: "32px 0 56px", borderTop: "1px solid var(--line)", display: "flex", flexWrap: "wrap", gap: "16px 30px", alignItems: "center", fontSize: 15, color: "var(--muted)" }}>
      <span className="wm" style={{ color: "var(--ink)", fontSize: 18 }}>HOCK</span>
      <Link href="/docs" style={{ color: "var(--muted)" }}>Docs</Link>
      <Link href="/docs/whitepaper" style={{ color: "var(--muted)" }}>Whitepaper</Link>
      <Link href="/docs/fees" style={{ color: "var(--muted)" }}>Fees</Link>
      <Link href="/docs/security" style={{ color: "var(--muted)" }}>Security</Link>
      <Link href="/docs/risk" style={{ color: "var(--muted)" }}>Risk</Link>
      <Link href="/docs/terms" style={{ color: "var(--muted)" }}>Terms</Link>
      <Link href="/docs/privacy" style={{ color: "var(--muted)" }}>Privacy</Link>
      <a href="https://github.com/TheMemeBanker/hock" target="_blank" rel="noopener noreferrer" style={{ color: "var(--muted)" }}>Source</a>
      <span style={{ flexBasis: "100%", fontSize: 13, color: "#8A909B", lineHeight: 1.6 }}>
        HOCK never holds your keys or funds. Memecoins are volatile; read the risk disclosure before you launch, borrow or lend. Nothing here is financial advice. Every figure on this site is read from chain state when the page loads.
      </span>
    </footer>
  );
}
