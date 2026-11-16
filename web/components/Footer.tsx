import Link from "next/link";
import { Mark } from "./Mark";
import { XLogo } from "./XLogo";

const X_URL = "https://x.com/HockFinance";

export function Footer() {
  const link = { color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 13 } as const;
  return (
    <footer style={{ padding: "36px 0 56px", borderTop: "1px solid var(--line)", display: "flex", flexWrap: "wrap", gap: "16px 26px", alignItems: "center" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 10, color: "var(--ink)" }}>
        <Mark size={22} />
        <span className="wm" style={{ fontSize: 17 }}>HOCK</span>
      </span>
      <Link href="/docs" style={link}>Docs</Link>
      <Link href="/docs/whitepaper" style={link}>Whitepaper</Link>
      <Link href="/docs/fees" style={link}>Fees</Link>
      <Link href="/docs/security" style={link}>Security</Link>
      <Link href="/docs/risk" style={link}>Risk</Link>
      <Link href="/docs/terms" style={link}>Terms</Link>
      <Link href="/docs/privacy" style={link}>Privacy</Link>
      <a href="https://github.com/TheMemeBanker/hock" target="_blank" rel="noopener noreferrer" style={link}>Source</a>
      <a href={X_URL} target="_blank" rel="noopener noreferrer" style={{ ...link, display: "inline-flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
        <XLogo size={14} /> @HockFinance
      </a>
      <span style={{ flexBasis: "100%", fontSize: 13, color: "var(--muted)", lineHeight: 1.6, maxWidth: "92ch" }}>
        HOCK never holds your keys or funds. Memecoins are volatile; read the risk disclosure before you launch, borrow or lend. Nothing here is financial advice. Every figure on this site is read from chain state when the page loads.
      </span>
    </footer>
  );
}
