// Dump all Phase-A state as --account files for a warped fresh-genesis restart.
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT } from "@solana/spl-token";
import fs from "node:fs"; import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRATCH = process.env.MATRIX_DIR || path.join(ROOT, "matrix-state");
const conn = new Connection(process.env.LOCAL_RPC_URL || "http://127.0.0.1:8899", "confirmed");
const PROGRAM_ID = new PublicKey(process.env.HOCK_PROGRAM_ID ||
  fs.readFileSync(path.join(ROOT, "Anchor.toml"), "utf8").split(/\n\[programs\.localnet\]\n/)[1].match(/^hock_lending\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/m)[1]);
const st = JSON.parse(fs.readFileSync(path.join(SCRATCH, "state.json")));
const kp = (f) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(SCRATCH, f)))));
const authority = kp("authority.json"), borrower2 = kp("borrower2.json"), engine = kp("engine.json"), depositor = kp("depositor.json"), borrower1 = kp("borrower1.json"), feeOwner = kp("fee_owner.json");
const pda = (...s) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const POOL = pda(Buffer.from("pool"), authority.publicKey.toBuffer());
const VAULT = pda(Buffer.from("loan-token-vault"), POOL.toBuffer());
const mintA = new PublicKey(st.mintA), loan3 = new PublicKey(st.loan3);
const targets = new Map();
const add = (label, pk) => targets.set(pk.toBase58(), label);
// program-owned accounts (pool, loans, feeds, positions)
const prog = await conn.getProgramAccounts(PROGRAM_ID);
for (const a of prog) add("prog", a.pubkey);
// token accounts + mints
add("mintA", mintA); add("mintB", new PublicKey(st.mintB)); add("mintC", new PublicKey(st.mintC));
add("vault", VAULT);
add("cvault3", pda(Buffer.from("collateral-vault"), loan3.toBuffer()));
add("proceeds3", pda(Buffer.from("sol-proceeds"), loan3.toBuffer()));
for (const [o, m, t22] of [
  [borrower2.publicKey, mintA, false], [borrower1.publicKey, mintA, false],
  [engine.publicKey, mintA, false], [authority.publicKey, mintA, false],
]) add("ata", getAssociatedTokenAddressSync(m, o, true, t22 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID));
for (const o of [borrower1.publicKey, borrower2.publicKey, depositor.publicKey, authority.publicKey, feeOwner.publicKey])
  add("wsol", getAssociatedTokenAddressSync(NATIVE_MINT, o, true));
const outDir = path.join(SCRATCH, "dump"); fs.mkdirSync(outDir, { recursive: true });
let n = 0;
for (const [pk, label] of targets) {
  const info = await conn.getAccountInfo(new PublicKey(pk), "confirmed");
  if (!info) { console.log("skip (absent):", label, pk.slice(0, 8)); continue; }
  fs.writeFileSync(path.join(outDir, pk + ".json"), JSON.stringify({
    pubkey: pk,
    account: { lamports: info.lamports, data: [info.data.toString("base64"), "base64"],
      owner: info.owner.toBase58(), executable: info.executable, rentEpoch: 18446744073709551615 },
  }));
  n++;
}
console.log(`dumped ${n} accounts to ${outDir}`);
