/**
 * Demo wallet for TEST CLUSTERS ONLY. An in-page keypair that signs like a
 * browser wallet, so the real launch / borrow / lend flows can run headlessly
 * for the lifecycle driver and the demo video. It is registered only when
 * NEXT_PUBLIC_DEMO_WALLET=true and the cluster is not mainnet-beta (see
 * providers.tsx), and it refuses to construct on mainnet regardless of env.
 * The secret lives in localStorage under hock.demo.secret (a JSON byte array);
 * a driver can seed it, otherwise a fresh key is generated on first connect.
 */
import { BaseSignerWalletAdapter, WalletReadyState, type WalletName } from "@solana/wallet-adapter-base";
import { Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { CLUSTER } from "./constants";

export const DemoWalletName = "Demo wallet (test cluster)" as WalletName<"Demo wallet (test cluster)">;
const STORAGE_KEY = "hock.demo.secret";

export class DemoKeypairWalletAdapter extends BaseSignerWalletAdapter {
  name = DemoWalletName;
  url = "/docs/security";
  icon = "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4IiB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcm9sZT0iaW1nIiBhcmlhLWxhYmVsPSJIT0NLIj48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI0IiBmaWxsPSIjMEEwQzEwIi8+PGcgdHJhbnNmb3JtPSJ0cmFuc2xhdGUoOCA4KSBzY2FsZSgwLjg3NTApIj48cGF0aCBkPSJNMTIxLjgyIDY4LjU1IEE1OCA1OCAwIDAgMSA5Ni44NSAxMTEuODAgTDc0Ljc5IDk2LjI0IEEzNCAzNCAwIDAgMCA5NS44NSA3NS45MSBaIiBmaWxsPSIjRTZFRUY3Ii8+PHBhdGggZD0iTTg4Ljk3IDExNi4zNSBBNTggNTggMCAwIDEgMzkuMDMgMTE2LjM1IEw0MS40NyA4OS40NiBBMzQgMzQgMCAwIDAgNjkuNjEgOTcuNTMgWiIgZmlsbD0iI0U2RUVGNyIvPjxwYXRoIGQ9Ik0zMS4xNSAxMTEuODAgQTU4IDU4IDAgMCAxIDYuMTggNjguNTUgTDMwLjY4IDU3LjIyIEEzNCAzNCAwIDAgMCAzNy43NiA4NS42MyBaIiBmaWxsPSIjRTZFRUY3Ii8+PHBhdGggZD0iTTYuMTggNTkuNDUgQTU4IDU4IDAgMCAxIDMxLjE1IDE2LjIwIEw1My4yMSAzMS43NiBBMzQgMzQgMCAwIDAgMzIuMTUgNTIuMDkgWiIgZmlsbD0iI0U2RUVGNyIvPjxwYXRoIGQ9Ik0zOS4wMyAxMS42NSBBNTggNTggMCAwIDEgODguOTcgMTEuNjUgTDg2LjUzIDM4LjU0IEEzNCAzNCAwIDAgMCA1OC4zOSAzMC40NyBaIiBmaWxsPSIjRkY2QTFGIi8+PHBhdGggZD0iTTk2Ljg1IDE2LjIwIEE1OCA1OCAwIDAgMSAxMjEuODIgNTkuNDUgTDk3LjMyIDcwLjc4IEEzNCAzNCAwIDAgMCA5MC4yNCA0Mi4zNyBaIiBmaWxsPSIjRTZFRUY3Ii8+PHBhdGggZD0iTTc5LjU5IDU1LjAwIEw3OS41OSA3My4wMCBMNjQuMDAgODIuMDAgTDQ4LjQxIDczLjAwIEw0OC40MSA1NS4wMCBMNjQuMDAgNDYuMDAgWiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjRTZFRUY3IiBzdHJva2Utd2lkdGg9IjciIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz48Y2lyY2xlIGN4PSI2NCIgY3k9IjY0IiByPSI1IiBmaWxsPSIjRkY2QTFGIi8+PC9nPjwvc3ZnPg==";
  supportedTransactionVersions = new Set(["legacy", 0] as const);
  private _keypair: Keypair | null = null;
  private _connecting = false;

  constructor() {
    super();
    if (CLUSTER === "mainnet-beta") throw new Error("Demo wallet is refused on mainnet-beta");
  }

  get publicKey(): PublicKey | null { return this._keypair?.publicKey ?? null; }
  get connecting(): boolean { return this._connecting; }
  get readyState(): WalletReadyState { return typeof window === "undefined" ? WalletReadyState.Unsupported : WalletReadyState.Loadable; }

  async connect(): Promise<void> {
    if (this.connected || this._connecting) return;
    this._connecting = true;
    try {
      let kp: Keypair | null = null;
      try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
      } catch { kp = null; }
      if (!kp) {
        kp = Keypair.generate();
        try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...kp.secretKey])); } catch { /* ephemeral */ }
      }
      this._keypair = kp;
      this.emit("connect", kp.publicKey);
    } finally {
      this._connecting = false;
    }
  }

  async disconnect(): Promise<void> {
    this._keypair = null;
    this.emit("disconnect");
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
    if (!this._keypair) throw new Error("Demo wallet not connected");
    if (tx instanceof VersionedTransaction) tx.sign([this._keypair]);
    else tx.partialSign(this._keypair);
    return tx;
  }

  async signMessage(message: Uint8Array): Promise<Uint8Array> {
    if (!this._keypair) throw new Error("Demo wallet not connected");
    return nacl.sign.detached(message, this._keypair.secretKey);
  }
}
