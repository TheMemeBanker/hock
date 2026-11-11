/* Broadcast loop: try each RPC in order until one accepts the raw transaction. */
import { Connection } from "@solana/web3.js";

export async function rpcSend(raw, rpcs) {
  let last;
  for (const url of rpcs) {
    try { const c = new Connection(url, "confirmed"); const sig = await c.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 }); return { c, sig }; } catch (e) { last = e; }
  }
  throw last || new Error("No RPC accepted the transaction");
}
