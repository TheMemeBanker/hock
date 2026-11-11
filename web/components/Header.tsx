"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { Mark } from "./Mark";

const BaseWalletMultiButton = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then((m) => m.BaseWalletMultiButton),
  { ssr: false, loading: () => <button type="button" className="btn line" disabled>Connect wallet</button> },
);
const WALLET_LABELS = {
  "no-wallet": "Connect wallet",
  "has-wallet": "Connect",
  connecting: "Connecting…",
  "copy-address": "Copy address",
  copied: "Copied",
  "change-wallet": "Change wallet",
  disconnect: "Disconnect",
} as const;

export function Header() {
  return (
    <header className="site-header">
      <Link href="/" aria-label="HOCK home" className="site-logo" style={{ display: "flex", alignItems: "center", gap: 14, color: "var(--ink)" }}>
        <Mark size={46} />
        <span className="wm" style={{ fontSize: 30 }}>HOCK</span>
      </Link>
      <nav aria-label="Primary" className="site-nav">
        <Link href="/launch">Launch</Link>
        <Link href="/board">Board</Link>
        <Link href="/borrow">Dashboard</Link>
        <Link href="/lend">Lend</Link>
        <Link href="/docs">Docs</Link>
      </nav>
      <div className="site-wallet"><BaseWalletMultiButton className="btn line" labels={WALLET_LABELS} /></div>
    </header>
  );
}
