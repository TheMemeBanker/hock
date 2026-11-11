/**
 * On-chain price-feed freshness, read directly from the PriceHistory account
 * the program consults at execution. This is the authoritative borrow gate:
 * any off-chain status is a convenience, this is what the program will do.
 */
import type { Connection, PublicKey } from "@solana/web3.js";
import { getPriceFeed, getProgram } from "./program";

export interface FeedFreshness {
  borrowable: boolean;
  reason: string;
  ageSeconds: number | null;
}

export async function isOnChainFeedBorrowable(connection: Connection, mint: PublicKey, pool?: PublicKey): Promise<FeedFreshness> {
  try {
    const feed = await getPriceFeed(getProgram(connection), mint, pool);
    if (!feed) return { borrowable: false, reason: "No price feed is initialised for this mint.", ageSeconds: null };
    return { borrowable: feed.borrowable, reason: feed.reason, ageSeconds: feed.ageSeconds };
  } catch (e) {
    return { borrowable: false, reason: e instanceof Error ? e.message : "Feed read failed.", ageSeconds: null };
  }
}
