/**
 * Devnet / localnet launch path.
 *
 * PumpPortal and the pump.fun bonding curve exist on mainnet only, so on a test
 * cluster "launch" creates a Token-2022 test mint with on-chain metadata
 * (MetadataPointer + TokenMetadata extensions), mints the full supply to the
 * launcher and revokes the mint authority, so supply is fixed like a pump coin.
 * The transaction is simulated before the wallet is asked to sign; the mint
 * keypair is generated in the browser and never leaves it. Same step hooks as
 * the mainnet path so the form renders identically.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  AuthorityType,
  ExtensionType,
  LENGTH_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TYPE_SIZE,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMetadataPointerInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createSetAuthorityInstruction,
  getAssociatedTokenAddressSync,
  getMintLen,
} from "@solana/spl-token";
import { createInitializeInstruction, pack, type TokenMetadata } from "@solana/spl-token-metadata";
import { pinViaIrys, pinViaPinata, pinViaProxy } from "./metadata.js";

export const DEVNET_DECIMALS = 6;
export const DEVNET_SUPPLY_WHOLE = 1_000_000_000n;

type WalletLike = {
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
  signMessage?: (m: Uint8Array) => Promise<Uint8Array>;
};

export type DevnetLaunchArgs = {
  wallet: WalletLike;
  pubkey: PublicKey;
  meta: { name: string; symbol: string; description: string; twitter?: string; telegram?: string; website?: string };
  imageFile: File;
  rpcUrl: string;
  uploadProxy?: string;
  pinataJwt?: string;
  dry?: boolean;
  onStatus?: (s: string, cls?: string) => void;
  onStep?: (n: number, state?: string) => void;
};

export type LaunchResult = { mint: string; sig: string | null; uri?: string; dry: boolean; simulatedUnits?: number };

/** Build the unsigned-by-wallet create transaction (mint keypair already signed). */
export async function buildDevnetCreate(conn: Connection, payer: PublicKey, mint: Keypair, meta: { name: string; symbol: string }, uri: string) {
  const metadata: TokenMetadata = {
    mint: mint.publicKey,
    name: meta.name.slice(0, 32),
    symbol: meta.symbol.slice(0, 10),
    uri,
    additionalMetadata: [["launchpad", "hock"]],
  };
  const mintLen = getMintLen([ExtensionType.MetadataPointer]);
  const metaLen = TYPE_SIZE + LENGTH_SIZE + pack(metadata).length;
  const lamports = await conn.getMinimumBalanceForRentExemption(mintLen + metaLen);
  const ata = getAssociatedTokenAddressSync(mint.publicKey, payer, false, TOKEN_2022_PROGRAM_ID);
  const ixs = [
    SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint.publicKey, space: mintLen, lamports, programId: TOKEN_2022_PROGRAM_ID }),
    createInitializeMetadataPointerInstruction(mint.publicKey, payer, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createInitializeMintInstruction(mint.publicKey, DEVNET_DECIMALS, payer, null, TOKEN_2022_PROGRAM_ID),
    createInitializeInstruction({ programId: TOKEN_2022_PROGRAM_ID, mint: mint.publicKey, metadata: mint.publicKey, name: metadata.name, symbol: metadata.symbol, uri: metadata.uri, mintAuthority: payer, updateAuthority: payer }),
    createAssociatedTokenAccountIdempotentInstruction(payer, ata, payer, mint.publicKey, TOKEN_2022_PROGRAM_ID),
    createMintToInstruction(mint.publicKey, ata, payer, DEVNET_SUPPLY_WHOLE * 10n ** BigInt(DEVNET_DECIMALS), [], TOKEN_2022_PROGRAM_ID),
    createSetAuthorityInstruction(mint.publicKey, payer, AuthorityType.MintTokens, null, [], TOKEN_2022_PROGRAM_ID),
  ];
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([mint]);
  return { tx, blockhash, lastValidBlockHeight, ata };
}

export async function launchDevnet({ wallet, pubkey, meta, imageFile, rpcUrl, uploadProxy = "", pinataJwt = "", dry = false, onStatus = () => {}, onStep = () => {} }: DevnetLaunchArgs): Promise<LaunchResult> {
  // rpcs is only consulted by the storage client when an upload exceeds the free tier (art is shrunk under it); it still has to exist.
  const config = { uploadProxy, rpcs: [rpcUrl], irysGateway: "https://gateway.irys.xyz/", irysBundle: "/vendor/irys.bundle.js", gateway: "https://ipfs.io/ipfs/", fetchGateway: "https://gateway.pinata.cloud/ipfs/" };
  onStep(1); onStatus("Storing art and metadata…");
  let uri: string;
  if (uploadProxy) uri = await pinViaProxy(meta, imageFile, config);
  else if (pinataJwt) uri = await pinViaPinata(meta, imageFile, pinataJwt, config);
  else if (wallet.signMessage) uri = (await pinViaIrys(meta, imageFile, onStatus, { wallet, pubkey, config })).uri;
  else if (dry) uri = "https://example.invalid/dry-run.json";
  else throw new Error("This wallet cannot sign messages. Paste a free Pinata key instead.");

  onStep(2); onStatus("Building the test-mint transaction (Token-2022, on-chain metadata)…");
  const conn = new Connection(rpcUrl, "confirmed");
  const mint = Keypair.generate();
  const { tx, blockhash, lastValidBlockHeight } = await buildDevnetCreate(conn, pubkey, mint, meta, uri);

  onStatus("Simulating…");
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    const logs = (sim.value.logs || []).slice(-4).join(" | ");
    throw new Error(`Simulation failed: ${JSON.stringify(sim.value.err)}${logs ? ` — ${logs}` : ""}`);
  }
  const units = sim.value.unitsConsumed ?? undefined;
  onStatus(`Simulated OK${units ? ` (${units.toLocaleString("en-US")} compute units)` : ""}. Approve in your wallet…`);

  onStep(3);
  const signed = await wallet.signTransaction(tx);
  if (dry) { onStep(4, "done"); onStatus("Dry run complete: stored, built, simulated and signed, not broadcast.", "ok"); return { mint: mint.publicKey.toBase58(), sig: null, uri, dry: true, simulatedUnits: units }; }

  onStep(4); onStatus("Sending…");
  const sig = await conn.sendRawTransaction(signed.serialize(), { skipPreflight: false, maxRetries: 3 });
  onStatus(`Confirming ${sig.slice(0, 8)}…`);
  // Poll signature status gently (one call every 1.5 s) instead of confirmTransaction's subscription + tight loop,
  // which does not work through the HTTP-only proxy and trips its rate limit.
  const deadline = Date.now() + 90_000;
  for (;;) {
    const st = (await conn.getSignatureStatuses([sig])).value[0];
    if (st?.err) throw new Error("Transaction failed on-chain: " + JSON.stringify(st.err));
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) break;
    if (Date.now() > deadline) throw new Error("Not confirmed within 90 s; check the explorer before retrying.");
    if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) throw new Error("Transaction expired before confirmation; try again.");
    await new Promise((r) => setTimeout(r, 1500));
  }
  onStep(4, "done"); onStatus("Launched on the test cluster. Your coin is on the board.", "ok");
  return { mint: mint.publicKey.toBase58(), sig, uri, dry: false, simulatedUnits: units };
}
