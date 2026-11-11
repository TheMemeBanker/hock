// TODO-hock: program/lender constants. The source site hard-coded program ids;
// HOCK requires them from env. PROGRAM_ID and LENDER_PUBKEY are mandatory,
// the versioned ids are optional (null = that lane is not deployed).
import { PublicKey } from "@solana/web3.js";

function required(name: string): PublicKey {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return new PublicKey(v);
}
function optional(name: string): PublicKey | null {
  const v = process.env[name];
  return v ? new PublicKey(v) : null;
}

export const PROGRAM_ID: PublicKey = required("NEXT_PUBLIC_PROGRAM_ID");
export const LENDER_PUBKEY: PublicKey = required("NEXT_PUBLIC_LENDER_PUBKEY");
export const PROGRAM_ID_V2: PublicKey | null = optional("NEXT_PUBLIC_PROGRAM_ID_V2");
export const PROGRAM_ID_V3: PublicKey | null = optional("NEXT_PUBLIC_PROGRAM_ID_V3");
export const PROGRAM_ID_V4: PublicKey | null = optional("NEXT_PUBLIC_PROGRAM_ID_V4");
export const PROGRAM_ID_V4_1: PublicKey | null = optional("NEXT_PUBLIC_PROGRAM_ID_V4_1");
