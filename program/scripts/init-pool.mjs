#!/usr/bin/env node
/**
 * Initialise the HOCK lending pool on the configured cluster.
 *
 *   SOLANA_RPC_URL=... POOL_AUTHORITY_KEYPAIR_PATH=... ENGINE_AUTHORITY_KEYPAIR_PATH=... FEE_KEYPAIR_PATH=... \
 *   node scripts/init-pool.mjs [--protocol-fee-bps 100] [--keeper-reward-bps 100] [--seed-sol 0]
 *
 * Signs only with the pool authority (and the fee owner for its wSOL ATA). Idempotent: if the pool PDA
 * already exists it prints it and exits 0. --seed-sol deposits that much SOL from the pool authority as
 * the first lender so loans can fund on a test cluster. Prints POOL_PDA for the engine and web env.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, TransactionInstruction, sendAndConfirmTransaction } from "@solana/web3.js";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) { flags[argv[i].slice(2)] = argv[i + 1]; i++; }
const PROTOCOL_FEE_BPS = Number(flags["protocol-fee-bps"] ?? 100);
const KEEPER_REWARD_BPS = Number(flags["keeper-reward-bps"] ?? 100);
const SEED_SOL = Number(flags["seed-sol"] ?? 0);

const env = (k, opt = false) => { const v = process.env[k]; if (!v && !opt) throw new Error(`missing env ${k}`); return v; };
const kp = (p) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
const conn = new Connection(env("SOLANA_RPC_URL"), "confirmed");
const PROGRAM_ID = new PublicKey(env("PROGRAM_ID", true) || fs.readFileSync(path.join(ROOT, "Anchor.toml"), "utf8").match(/^hock_lending\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/m)[1]);
const authority = kp(env("POOL_AUTHORITY_KEYPAIR_PATH"));
const engine = kp(env("ENGINE_AUTHORITY_KEYPAIR_PATH")).publicKey;
const feeOwner = kp(env("FEE_KEYPAIR_PATH"));
const idl = JSON.parse(fs.readFileSync(process.env.HOCK_IDL_PATH || path.join(ROOT, "target", "idl", "hock_lending.json"), "utf8"));
const IX = Object.fromEntries(idl.instructions.map((i) => [i.name, i]));
const disc = (n) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8);
function enc(name, args) {
  const bufs = [disc(name)];
  for (const a of IX[name].args) {
    const v = args[a.name];
    if (a.type === "u16") { const b = Buffer.alloc(2); b.writeUInt16LE(Number(v)); bufs.push(b); }
    else if (a.type === "u64") { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); bufs.push(b); }
    else if (a.type === "pubkey") bufs.push(new PublicKey(v).toBuffer());
    else throw new Error(`unhandled arg type ${a.type}`);
  }
  return Buffer.concat(bufs);
}
const ix = (name, args, map) => new TransactionInstruction({ programId: PROGRAM_ID, data: enc(name, args), keys: IX[name].accounts.map((a) => ({ pubkey: map[a.name], isSigner: !!a.signer, isWritable: !!a.writable })) });
const pda = (...s) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const POOL = pda(Buffer.from("pool"), authority.publicKey.toBuffer());
const VAULT = pda(Buffer.from("loan-token-vault"), POOL.toBuffer());
const FEE_WALLET = getAssociatedTokenAddressSync(NATIVE_MINT, feeOwner.publicKey, true);

console.log(`cluster ${env("SOLANA_RPC_URL")}\nprogram ${PROGRAM_ID.toBase58()}\nauthority ${authority.publicKey.toBase58()}\nengine ${engine.toBase58()}\nfee wallet ${FEE_WALLET.toBase58()} (owner ${feeOwner.publicKey.toBase58()})\npool ${POOL.toBase58()}\nvault ${VAULT.toBase58()}`);
if (await conn.getAccountInfo(POOL)) { console.log("pool already initialised"); console.log(`POOL_PDA=${POOL.toBase58()}`); process.exit(0); }

const tx = new Transaction().add(
  createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, FEE_WALLET, feeOwner.publicKey, NATIVE_MINT),
  ix("initialize_pool", { protocol_fee_bps: PROTOCOL_FEE_BPS, keeper_reward_bps: KEEPER_REWARD_BPS, engine_authority: engine },
    { pool: POOL, loan_token_vault: VAULT, loan_token_mint: NATIVE_MINT, fee_wallet: FEE_WALLET, authority: authority.publicKey, system_program: SystemProgram.programId, token_program: TOKEN_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY }),
);
const sig = await sendAndConfirmTransaction(conn, tx, [authority], { commitment: "confirmed" });
console.log(`initialize_pool ${sig}`);

if (SEED_SOL > 0) {
  const depAta = getAssociatedTokenAddressSync(NATIVE_MINT, authority.publicKey, true);
  const position = pda(Buffer.from("position"), POOL.toBuffer(), authority.publicKey.toBuffer());
  const lamports = BigInt(Math.round(SEED_SOL * LAMPORTS_PER_SOL));
  const t2 = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, depAta, authority.publicKey, NATIVE_MINT),
    SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: depAta, lamports: Number(lamports) }),
    createSyncNativeInstruction(depAta),
    ix("deposit", { amount: lamports }, { pool: POOL, loan_token_vault: VAULT, position, depositor_token_account: depAta, depositor: authority.publicKey, token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId }),
  );
  console.log(`deposit ${SEED_SOL} SOL ${await sendAndConfirmTransaction(conn, t2, [authority], { commitment: "confirmed" })}`);
}
console.log(`POOL_PDA=${POOL.toBase58()}`);
