/**
 * PDA derivations. Seeds are copied from the #[account(seeds = ...)]
 * constraints in program/programs/hock-lending/src/lib.rs:
 *   pool              = ["pool", authority]
 *   loan-token-vault  = ["loan-token-vault", pool]
 *   position          = ["position", pool, depositor]
 *   loan              = ["loan", borrower, loan_id.to_le_bytes()]
 *   collateral-vault  = ["collateral-vault", loan]
 *   sol-proceeds      = ["sol-proceeds", loan]
 *   price feed        = ["price_v3", mint, pool]   (PriceHistory account)
 */
import { PublicKey } from "@solana/web3.js";
import { requireProgramId } from "./constants";

const pid = (p?: PublicKey) => p ?? requireProgramId();

export function poolPda(authority: PublicKey, programId?: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), authority.toBuffer()], pid(programId));
}

export function loanTokenVaultPda(pool: PublicKey, programId?: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("loan-token-vault"), pool.toBuffer()], pid(programId));
}

export function depositorPositionPda(pool: PublicKey, depositor: PublicKey, programId?: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), pool.toBuffer(), depositor.toBuffer()], pid(programId));
}

export function loanPda(borrower: PublicKey, loanId: bigint, programId?: PublicKey) {
  const id = Buffer.alloc(8);
  // Manual little-endian encode: the browser Buffer shim does not implement writeBigUInt64LE.
  let v = BigInt.asUintN(64, loanId);
  for (let i = 0; i < 8; i++) { id[i] = Number(v & 0xffn); v >>= 8n; }
  return PublicKey.findProgramAddressSync([Buffer.from("loan"), borrower.toBuffer(), id], pid(programId));
}

export function collateralVaultPda(loan: PublicKey, programId?: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("collateral-vault"), loan.toBuffer()], pid(programId));
}

export function solProceedsVaultPda(loan: PublicKey, programId?: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("sol-proceeds"), loan.toBuffer()], pid(programId));
}

/** PriceHistory PDA (the IDL calls it price_feed in some instructions and price_history in others; same account). */
export function priceFeedPda(mint: PublicKey, pool: PublicKey, programId?: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("price_v3"), mint.toBuffer(), pool.toBuffer()], pid(programId));
}
