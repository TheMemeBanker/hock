"use client";

import { useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { Tickets } from "./Tickets";
import { InvestorDemo, INVESTOR_WALLET } from "./InvestorDemo";
import { PageIntro } from "@/components/PageIntro";

type ReadyMint = { mint: string; name: string; symbol: string; decimals: number };

/**
 * The investor demo wallet gets the modelled dashboard; everyone else gets the live one.
 * NEXT_PUBLIC_INVESTOR_PREVIEW=1 (local builds only) also honours ?as=<pubkey> so the demo can be
 * screenshotted without that wallet's key.
 */
export function DashboardGate({ readyMints }: { readyMints: ReadyMint[] }) {
  const wallet = useWallet();
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (process.env.NEXT_PUBLIC_INVESTOR_PREVIEW !== "1") return;
    try { setPreview(new URLSearchParams(window.location.search).get("as")); } catch {}
  }, []);
  const connected = wallet.publicKey?.toBase58() ?? null;
  const who = connected ?? preview;
  if (who && who === INVESTOR_WALLET) {
    return (
      <>
        <PageIntro title="How HOCK works" kicker="Investor demo">One coin, start to finish: launch, the $50,000 line, the ticket, and who gets paid.</PageIntro>
        <InvestorDemo wallet={who} />
      </>
    );
  }
  return (
    <>
      <PageIntro title="Dashboard" kicker="Your coins and tickets, read from chain">
        Every open loan for the connected wallet, with the actions the program allows: repay, partial repay, add collateral, extend, arm or disarm a limit-close. Each action is simulated against the live chain before your wallet is asked to sign.
      </PageIntro>
      <Tickets readyMints={readyMints} />
    </>
  );
}
