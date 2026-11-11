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
  icon = "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="8" width="80" height="12" rx="6" fill="#141414"/><rect x="27" y="18" width="6" height="14" fill="#141414"/><rect x="67" y="18" width="6" height="14" fill="#141414"/><rect x="47" y="18" width="6" height="48" fill="#141414"/><circle cx="30" cy="46" r="16" fill="#FFB800"/><circle cx="70" cy="46" r="16" fill="#FFB800"/><circle cx="50" cy="80" r="16" fill="#FFB800"/></svg>');
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
