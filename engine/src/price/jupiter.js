/**
 * Jupiter v6 swap integration — builds a signed swap transaction for
 * the engine's execution flow.
 *
 * Two-step: quote → swap. Both use Jupiter v6 endpoints. The swap
 * endpoint returns a base64 versioned transaction we sign and submit.
 *
 * Wrapped-SOL handling is automatic via Jupiter's wrapAndUnwrapSol=true
 * — when destination is SOL, Jupiter inserts the close-account instruction
 * for the wSOL ATA so the user gets native SOL, not wSOL.
 */
import { VersionedTransaction, ComputeBudgetProgram, PublicKey, TransactionInstruction } from "@solana/web3.js";

const JUPITER_API = process.env.JUPITER_API || "https://lite-api.jup.ag/swap/v1";

/**
 * Fetch the swap transaction.
 *   route       — the full quote object returned from jupiterQuote()
 *   userPubkey  — base58 of the signer
 *   destination — "sol" or "usdc"
 */
export async function buildSwapTx({ route, userPubkey, destination }) {
  const body = {
    quoteResponse: route,
    userPublicKey: userPubkey,
    wrapAndUnwrapSol: destination === "sol", // close wSOL ATA → native SOL on output
    // Skip slippage protection on the wrapper — we already passed
    // slippageBps when fetching the quote.
    dynamicSlippage: false,
    // Give the swap room to land — Jupiter recommends 75k extra CUs
    // beyond the route's own estimate.
    computeUnitPriceMicroLamports: 100_000,
  };
  const res = await fetch(`${JUPITER_API}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`jupiter_swap_http_${res.status}: ${errText.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json?.swapTransaction) {
    throw new Error("jupiter_swap_no_tx");
  }
  const buf = Buffer.from(json.swapTransaction, "base64");
  return VersionedTransaction.deserialize(buf);
}
