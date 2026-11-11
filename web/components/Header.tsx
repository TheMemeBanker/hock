"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { Mark } from "./Mark";

const WalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.WalletMultiButton),
  { ssr: false, loading: () => <button type="button" className="btn line" disabled>Connect wallet</button> },
);

export function Header() {
  return (
    <header style={{ display: "flex", alignItems: "center", gap: 18, flexWrap: "wrap", padding: "22px 0" }}>
      <Link href="/" aria-label="HOCK home" style={{ display: "flex", alignItems: "center", gap: 14, color: "var(--ink)" }}>
        <Mark size={46} />
        <span className="wm" style={{ fontSize: 30 }}>HOCK</span>
      </Link>
      <nav aria-label="Primary" className="nav" style={{ display: "flex", gap: 32, marginLeft: "auto", flexWrap: "wrap", fontSize: 16, fontWeight: 600 }}>
        <Link href="/launch" style={{ color: "var(--body)" }}>Launch</Link>
        <Link href="/board" style={{ color: "var(--body)" }}>Board</Link>
        <Link href="/borrow" style={{ color: "var(--body)" }}>Borrow</Link>
        <Link href="/lend" style={{ color: "var(--body)" }}>Lend</Link>
        <Link href="/docs" style={{ color: "var(--body)" }}>Docs</Link>
      </nav>
      <WalletMultiButton className="btn line" />
      <style jsx>{`
        @media (max-width: 760px) { .nav { display: none !important; } }
      `}</style>
    </header>
  );
}
