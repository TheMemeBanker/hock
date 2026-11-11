/* HOCK launch. Builds one pump.fun create transaction via PumpPortal's local API, signed in the user's own wallet.
   Art + metadata pinned to IPFS (relay if configured, else the user's Pinata key) or stored permanently on Irys/Arweave. */
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { pinViaProxy, pinViaPinata, pinViaIrys } from "./metadata.js";
import { grindVanity } from "./vanity.js";
import { rpcSend } from "./send.js";

export const LAUNCH_CONFIG = {
  uploadProxy: "",                                   // optional: your own relay (see worker/) e.g. "https://pin.yourdomain.xyz"
  rpcs: ["https://solana-rpc.publicnode.com", "https://solana.drpc.org", "https://api.mainnet-beta.solana.com"],
  tradeLocal: "https://pumpportal.fun/api/trade-local",
  feedWs: "wss://pumpportal.fun/api/data",
  irysGateway: "https://gateway.irys.xyz/",                 // permanent storage (Arweave via Irys); uploads under 100 KiB are free, signed by the launcher's wallet
  irysBundle: "./vendor/irys.bundle.js",
  gateway: "https://ipfs.io/ipfs/",
  fetchGateway: "https://gateway.pinata.cloud/ipfs/",     // gateway that sends CORS headers, used for reading metadata JSON in the browser
  pool: "pump",
};

/* dry run: stop before broadcasting (?dry=1) */
export const DRY = typeof location !== "undefined" && new URLSearchParams(location.search).get("dry") === "1";

/* Build the PumpPortal create transaction and sign it with the mint keypair. */
export async function buildCreateTransaction({ pubkey, meta, uri, mint, buy, slip, prio, config = LAUNCH_CONFIG }) {
  const body = { publicKey: pubkey.toBase58(), action: "create", tokenMetadata: { name: meta.name, symbol: meta.symbol, uri }, mint: mint.publicKey.toBase58(), denominatedInSol: "true", amount: buy, slippage: slip, priorityFee: prio, pool: config.pool };
  const r = await fetch(config.tradeLocal, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error("Transaction builder refused: " + (await r.text()).slice(0, 140));
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
  tx.sign([mint]);
  return tx;
}

/* Full launch flow: store -> (vanity) -> build -> sign -> send -> confirm. UI hooks: onStatus(text, cls), onStep(n, state). */
export async function launch({ wallet, pubkey, meta, imageFile, buy, slip = 10, prio = 0.0005, pinataJwt = "", vanity = false, dry = DRY, config = LAUNCH_CONFIG, onStatus = () => {}, onStep = () => {} }) {
  onStep(1); onStatus("Storing art and metadata…");
  let uri;
  if (config.uploadProxy) uri = await pinViaProxy(meta, imageFile, config);
  else if (pinataJwt) uri = await pinViaPinata(meta, imageFile, pinataJwt, config);
  else if (wallet.signMessage) uri = (await pinViaIrys(meta, imageFile, onStatus, { wallet, pubkey, config })).uri;
  else if (dry) uri = "https://example.invalid/dry-run.json";
  else throw new Error("This wallet cannot sign messages. Paste a free Pinata key instead.");
  onStep(2);
  let mint = null;
  if (vanity && !dry) {
    const t0 = Date.now();
    mint = await grindVanity("pump", (tot, n) => onStatus("Grinding a pump address… " + tot.toLocaleString("en-US") + " keys tried on " + n + " threads, " + Math.round((Date.now() - t0) / 1000) + "s"));
    if (!mint) onStatus("Skipped grinding, using a random mint address.");
  }
  if (!mint) mint = Keypair.generate();
  onStatus("Building the create transaction…");
  const tx = await buildCreateTransaction({ pubkey, meta, uri, mint, buy, slip, prio, config });
  onStep(3); onStatus("Approve the transaction in your wallet…");
  const signed = await wallet.signTransaction(tx);
  if (dry) { onStep(4, "done"); onStatus("Dry run complete: stored, built and signed, not broadcast.", "ok"); return { mint: mint.publicKey.toBase58(), sig: null, uri, dry: true }; }
  onStep(4); onStatus("Sending…");
  const { c, sig } = await rpcSend(signed.serialize(), config.rpcs);
  onStatus("Confirming " + sig.slice(0, 8) + "…");
  const bh = await c.getLatestBlockhash("confirmed");
  const conf = await c.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  if (conf.value.err) throw new Error("Transaction failed on-chain: " + JSON.stringify(conf.value.err));
  onStep(4, "done"); onStatus("Launched. Your coin is live.", "ok");
  return { mint: mint.publicKey.toBase58(), sig, uri, dry: false };
}
