/**
 * Borrow co-sign endpoint.
 *
 * The program requires the pool authority to co-sign every
 * request_and_fund_loan. That signature is the lender's admission control, not
 * custody: the borrower has already signed their own transaction; we only add
 * the pool authority's signature after re-checking, with our own evidence,
 * that the loan is one the pool is willing to write.
 *
 * Admission checks (all must pass, fails closed):
 *   1. the request is a single Solana transaction that parses;
 *   2. every instruction is either a ComputeBudget instruction, an Associated
 *      Token / Token / System instruction that only touches the borrower's own
 *      accounts (wSOL wrap, ATA create, syncNative), or exactly ONE
 *      request_and_fund_loan on our program against our pool;
 *   3. the borrower account of that instruction is a required signer and has
 *      already signed (signature present and verifies);
 *   4. the collateral mint is collateral_ready in gate_state;
 *   5. the on-chain price feed for the mint is fresh and has a TWAP;
 *   6. the requested collateral_value does not exceed what the feed supports
 *      at the tier LTV (the program re-checks this; we refuse early);
 *   7. per-loan and per-pool caps from env are respected;
 *   8. the pool is not paused and has liquidity for the principal.
 * Then we sign with the pool authority and return the fully signed bytes.
 */
import http from "node:http";
import { Transaction, VersionedTransaction, PublicKey, SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import nacl from "tweetnacl";
import { query } from "../db/pool.js";
import { programId as getProgramId, poolPda as getPoolPda, loadKeypair, connection, fetchPool, readPriceFeed } from "../chain/program.js";
import { notifyAdmin } from "../notify/admin.js";

const DISC_REQUEST_AND_FUND_LOAN = Buffer.from([21, 217, 199, 183, 6, 96, 200, 52]);
const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const ALLOWED_SIDE_PROGRAMS = new Set([ComputeBudgetProgram.programId.toBase58(), SystemProgram.programId.toBase58(), TOKEN.toBase58(), TOKEN_2022.toBase58(), ATA.toBase58()]);

// Tier table mirrors the program (loan_option -> LTV bps, days). Memecoin category only in v1.
const TIERS = [{ ltvBps: 3000, days: 2 }, { ltvBps: 2500, days: 3 }, { ltvBps: 2000, days: 7 }];

const env = (k, d) => (process.env[k] ?? d);
const MAX_LOAN_SOL = Number(env("COSIGN_MAX_LOAN_SOL", "25"));
const MAX_POOL_UTILISATION_BPS = Number(env("COSIGN_MAX_UTILISATION_BPS", "8000"));
const FEED_MAX_AGE_S = Number(env("COSIGN_FEED_MAX_AGE_SECONDS", "90"));
const PORT = Number(env("COSIGN_PORT", "3002"));
const ALLOWED_ORIGINS = env("HOCK_ALLOWED_ORIGINS", "").split(",").map((s) => s.trim()).filter(Boolean);

function json(res, code, body, origin) {
  const h = { "content-type": "application/json", "cache-control": "no-store" };
  if (origin) { h["access-control-allow-origin"] = origin; h["vary"] = "origin"; h["access-control-allow-headers"] = "content-type"; h["access-control-allow-methods"] = "POST, OPTIONS"; }
  res.writeHead(code, h);
  res.end(JSON.stringify(body));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Parse either a legacy or a v0 transaction from base64. */
function parseTx(b64) {
  const bytes = Buffer.from(b64, "base64");
  try {
    const v = VersionedTransaction.deserialize(bytes);
    if (v.message.addressTableLookups?.length) throw new Error("address lookup tables are not accepted on borrow");
    return { kind: "v0", tx: v };
  } catch (e) {
    if (String(e.message).includes("lookup tables")) throw e;
  }
  return { kind: "legacy", tx: Transaction.from(bytes) };
}

function legacyInstructions(tx) {
  return tx.instructions.map((ix) => ({ programId: ix.programId, keys: ix.keys.map((k) => ({ pubkey: k.pubkey, isSigner: k.isSigner })), data: Buffer.from(ix.data) }));
}

function v0Instructions(tx) {
  const msg = tx.message;
  const keys = msg.staticAccountKeys;
  return msg.compiledInstructions.map((ci) => ({
    programId: keys[ci.programIdIndex],
    keys: ci.accountKeyIndexes.map((i) => ({ pubkey: keys[i], isSigner: msg.isAccountSigner(i) })),
    data: Buffer.from(ci.data),
  }));
}

function decodeBorrowArgs(data) {
  // disc(8) | collateral_amount u64 | loan_option u8 | collateral_value u64 | loan_id u64 | category u8
  if (data.length < 8 + 8 + 1 + 8 + 8 + 1) throw new Error("short borrow data");
  let o = 8;
  const collateralAmount = data.readBigUInt64LE(o); o += 8;
  const loanOption = data.readUInt8(o); o += 1;
  const collateralValue = data.readBigUInt64LE(o); o += 8;
  const loanId = data.readBigUInt64LE(o); o += 8;
  const category = data.readUInt8(o);
  return { collateralAmount, loanOption, collateralValue, loanId, category };
}

/** Verify a signer's existing signature over the message bytes. */
function hasValidSignature(kind, tx, pubkey) {
  if (kind === "legacy") {
    const msgBytes = tx.serializeMessage();
    const s = tx.signatures.find((x) => x.publicKey.equals(pubkey));
    return !!(s && s.signature && nacl.sign.detached.verify(msgBytes, s.signature, pubkey.toBytes()));
  }
  const msgBytes = tx.message.serialize();
  const idx = tx.message.staticAccountKeys.findIndex((k) => k.equals(pubkey));
  if (idx < 0 || idx >= tx.signatures.length) return false;
  const sig = tx.signatures[idx];
  return !!sig && sig.some((b) => b !== 0) && nacl.sign.detached.verify(msgBytes, sig, pubkey.toBytes());
}

export async function admit({ kind, tx }, { programId, poolPda, authorityPk }) {
  const ixs = kind === "legacy" ? legacyInstructions(tx) : v0Instructions(tx);
  const borrowIxs = ixs.filter((ix) => ix.programId.equals(programId));
  if (borrowIxs.length !== 1) throw new Error("exactly one program instruction is required");
  for (const ix of ixs) {
    if (ix.programId.equals(programId)) continue;
    if (!ALLOWED_SIDE_PROGRAMS.has(ix.programId.toBase58())) throw new Error(`instruction to ${ix.programId.toBase58()} is not allowed on a borrow`);
  }
  const ix = borrowIxs[0];
  if (!ix.data.subarray(0, 8).equals(DISC_REQUEST_AND_FUND_LOAN)) throw new Error("only request_and_fund_loan can be co-signed");
  if (ix.keys.length < 15) throw new Error("malformed borrow accounts");
  const pool = ix.keys[0].pubkey, mint = ix.keys[4].pubkey, borrower = ix.keys[8].pubkey, authority = ix.keys[9].pubkey, priceFeed = ix.keys[10].pubkey;
  if (!pool.equals(poolPda)) throw new Error("wrong pool");
  if (!authority.equals(authorityPk)) throw new Error("authority account is not this pool's authority");
  if (!ix.keys[8].isSigner || !ix.keys[9].isSigner) throw new Error("borrower and authority must be signers");
  if (!hasValidSignature(kind, tx, borrower)) throw new Error("borrower has not signed");
  // Side instructions may only move the borrower's own funds.
  for (const side of ixs) {
    if (side.programId.equals(SystemProgram.programId)) {
      const from = side.keys[0]?.pubkey;
      if (from && !from.equals(borrower)) throw new Error("system transfer from an account other than the borrower");
    }
  }
  const args = decodeBorrowArgs(ix.data);
  if (args.category !== 0) throw new Error("only the memecoin category is open");
  const tier = TIERS[args.loanOption];
  if (!tier) throw new Error("unknown tier");

  // Gate verdict from our own evidence.
  const { rows } = await query(`SELECT verdict, graded_at FROM gate_state WHERE mint = $1`, [mint.toBase58()]);
  if (!rows[0] || rows[0].verdict !== "collateral_ready") throw new Error("mint is not collateral ready");
  if (rows[0].graded_at && Date.now() - new Date(rows[0].graded_at).getTime() > 10 * 60 * 1000) throw new Error("gate verdict is stale");

  // Feed freshness and value sanity.
  const conn = connection();
  const feed = await readPriceFeed(conn, mint).catch(() => null);
  if (!feed || !feed.latest) throw new Error("no price feed for mint");
  if (feed.ageSeconds == null || feed.ageSeconds > FEED_MAX_AGE_S) throw new Error(`price feed is ${feed.ageSeconds}s old`);
  if (!feed.twapReady) throw new Error("TWAP not ready");
  const mintInfo = await conn.getParsedAccountInfo(mint, "confirmed");
  const decimals = mintInfo?.value?.data?.parsed?.info?.decimals;
  if (typeof decimals !== "number") throw new Error("mint decimals unreadable");
  const spot = BigInt(feed.latest.price);
  const valuation = feed.twap != null && BigInt(feed.twap) < spot ? BigInt(feed.twap) : spot; // min(spot, TWAP), as the program values collateral
  const impliedValue = (args.collateralAmount * valuation) / 10n ** BigInt(decimals);
  if (args.collateralValue > impliedValue) throw new Error("collateral_value exceeds what the feed supports");
  const principal = (impliedValue * BigInt(tier.ltvBps)) / 10000n;
  if (principal > BigInt(Math.round(MAX_LOAN_SOL * 1e9))) throw new Error(`loan above the per-loan cap of ${MAX_LOAN_SOL} SOL`);

  // Pool state.
  const p = await fetchPool(conn, { maxAgeMs: 5_000 });
  if (p.paused) throw new Error("pool is paused");
  const deposits = BigInt(p.total_deposits.toString()), borrowed = BigInt(p.total_borrowed.toString());
  const available = deposits - borrowed;
  if (available < principal) throw new Error("pool lacks liquidity for this loan");
  const utilAfter = ((borrowed + principal) * 10000n) / (deposits || 1n);
  if (utilAfter > BigInt(MAX_POOL_UTILISATION_BPS)) throw new Error("pool utilisation cap reached");

  return { borrower: borrower.toBase58(), mint: mint.toBase58(), tier: args.loanOption, principalLamports: principal.toString(), priceFeed: priceFeed.toBase58() };
}

export function startCosignServer({ log = console } = {}) {
  const authority = loadKeypair("POOL_AUTHORITY_KEYPAIR_PATH", { optional: true });
  if (!authority) { log.warn("[cosign] POOL_AUTHORITY_KEYPAIR_PATH not set; borrow co-sign disabled"); return null; }
  const programId = getProgramId();
  const poolPda = getPoolPda();
  const server = http.createServer(async (req, res) => {
    const origin = req.headers.origin && ALLOWED_ORIGINS.includes(req.headers.origin) ? req.headers.origin : (ALLOWED_ORIGINS[0] || undefined);
    if (req.method === "OPTIONS") return json(res, 204, {}, origin);
    if (req.method !== "POST" || req.url !== "/cosign/borrow") return json(res, 404, { ok: false, error: "not found" }, origin);
    try {
      const body = JSON.parse(await readBody(req));
      if (typeof body?.tx !== "string") throw new Error("tx (base64) required");
      const parsed = parseTx(body.tx);
      const admitted = await admit(parsed, { programId, poolPda, authorityPk: authority.publicKey });
      if (parsed.kind === "legacy") parsed.tx.partialSign(authority); else parsed.tx.sign([authority]);
      const out = Buffer.from(parsed.tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
      log.info(`[cosign] admitted borrow ${admitted.borrower} ${admitted.mint} tier ${admitted.tier} principal ${admitted.principalLamports}`);
      return json(res, 200, { ok: true, tx: out, admitted }, origin);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn(`[cosign] refused: ${msg}`);
      if (/not allowed|wrong pool|authority account|has not signed|other than the borrower/.test(msg)) notifyAdmin("cosign_refused_suspicious", { msg }).catch(() => {});
      return json(res, 400, { ok: false, error: msg }, origin);
    }
  });
  server.listen(PORT, () => log.info(`[cosign] listening on :${PORT}`));
  return server;
}
