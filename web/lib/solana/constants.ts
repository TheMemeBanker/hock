/**
 * HOCK chain constants. Program id and pool come from env (no fallback: a
 * missing value is a configuration error, not a reason to invent one).
 * Everything else mirrors the constants in program/programs/hock-lending/src/lib.rs.
 */
import { PublicKey } from "@solana/web3.js";

export type Cluster = "localnet" | "devnet" | "mainnet-beta";

function envKey(name: string): PublicKey | null {
  const v = process.env[name];
  if (!v) return null;
  try {
    return new PublicKey(v);
  } catch {
    return null;
  }
}

/** hock_lending program id for this cluster (NEXT_PUBLIC_PROGRAM_ID). */
export const PROGRAM_ID: PublicKey | null = envKey("NEXT_PUBLIC_PROGRAM_ID");
/** The single live LendingPool PDA for v1 (NEXT_PUBLIC_POOL_PDA). */
export const POOL_PDA: PublicKey | null = envKey("NEXT_PUBLIC_POOL_PDA");
export const CLUSTER: Cluster = ((process.env.NEXT_PUBLIC_HOCK_CLUSTER as Cluster) || "devnet");

export function requireProgramId(): PublicKey {
  if (!PROGRAM_ID) throw new Error("NEXT_PUBLIC_PROGRAM_ID is not set");
  return PROGRAM_ID;
}
export function requirePoolPda(): PublicKey {
  if (!POOL_PDA) throw new Error("NEXT_PUBLIC_POOL_PDA is not set");
  return POOL_PDA;
}

/** Explorer link for a signature or address on the configured cluster. */
export function explorerUrl(kind: "tx" | "address", value: string): string {
  const c = CLUSTER === "mainnet-beta" ? "" : `?cluster=${CLUSTER === "localnet" ? "custom" : CLUSTER}`;
  return `https://explorer.solana.com/${kind}/${value}${c}`;
}

// --- lib.rs constants (one source of truth is the program; these mirror it) ---
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
export const BPS_DENOM = 10_000;
export const CATEGORY_MEMECOIN = 0;
export const CATEGORY_RWA = 1;
/** MAX_PRICE_STALENESS / MAX_ORACLE_AGE_SECONDS: latest sample must be at most this old. */
export const MAX_PRICE_STALENESS_SECONDS = 120;
export const TWAP_WINDOW_SECONDS = 30 * 60;
export const MIN_SAMPLES_FOR_TWAP = 8;
export const MIN_HISTORY_SECONDS = 300;
export const PRICE_HISTORY_CAPACITY = 32;
/** Spot may exceed TWAP by at most this many bps at borrow time. */
export const MAX_SPOT_VS_TWAP_PUMP_BPS = 1_500;
/** Submitted collateral_value may exceed the oracle value by at most this. */
export const MAX_VALUE_TOLERANCE_BPS = 300;
/** Floor on min_sol_out for conversions: TWAP value minus this slippage. */
export const MAX_PROTOCOL_SLIPPAGE_BPS = 1_500;
export const PROTOCOL_FEE_BPS_AUTOSELL = 100;
export const SLICE_BPS_MAX = 10_000;
export const MAX_PRICE_UPDATE_FACTOR = 100;
export const SECONDS_PER_DAY = 86_400;
