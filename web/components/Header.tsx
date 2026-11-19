"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import { Lockup } from "./Mark";
import { HOCK_CA, HOCK_HREF } from "@/lib/token";

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

const NAV = [
  ["/launch", "Launch"],
  ["/board", "Board"],
  ["/dashboard", "Dashboard"],
  ["/lend", "Lend"],
  ["/docs", "Docs"],
] as const;

export function Header() {
  const path = usePathname() ?? "/";
  return (
    <header className="site-header">
      <Link href="/" aria-label="HOCK home" className="site-logo" style={{ display: "flex", alignItems: "center", gap: 12, color: "var(--ink)" }}>
        <Lockup size={28} />
      </Link>
      <nav aria-label="Primary" className="site-nav">
        {NAV.map(([href, label]) => (
          <Link key={href} href={href} className={path === href || path.startsWith(href + "/") ? "current" : undefined}>
            {label}
          </Link>
        ))}
      </nav>
      <div className="site-wallet">
        <a className="site-token mono" href={HOCK_HREF} {...(HOCK_CA ? { target: "_blank", rel: "noopener noreferrer" } : {})} title={HOCK_CA ? "$HOCK on pump.fun" : "$HOCK contract address: not yet published"}>$HOCK</a>
        <BaseWalletMultiButton className="btn line" labels={WALLET_LABELS} />
      </div>
    </header>
  );
}
