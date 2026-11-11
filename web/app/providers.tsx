"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter, SolflareWalletAdapter } from "@solana/wallet-adapter-wallets";
import "@solana/wallet-adapter-react-ui/styles.css";
import { CLUSTER } from "@/lib/solana/constants";
import { DemoKeypairWalletAdapter } from "@/lib/solana/demo-wallet";

// Test clusters only: an in-page keypair wallet for the lifecycle driver and demo recordings. Never on mainnet.
const DEMO_WALLET = process.env.NEXT_PUBLIC_DEMO_WALLET === "true" && CLUSTER !== "mainnet-beta";

/**
 * Wallet and connection context. The browser never sees a provider key: all
 * RPC traffic goes through /api/rpc, which forwards to the configured upstream.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const endpoint = useMemo(() => {
    if (typeof window === "undefined") return "http://127.0.0.1:8899";
    return `${window.location.origin}/api/rpc`;
  }, []);
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter(), ...(DEMO_WALLET ? [new DemoKeypairWalletAdapter()] : [])], []);
  return (
    <ConnectionProvider endpoint={endpoint} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
