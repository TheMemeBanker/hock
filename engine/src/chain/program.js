/**
 * Shared chain plumbing for every loop: program id, IDL, keypairs, PDAs,
 * account decoding (LendingPool / Loan / PriceHistory) and the two reads the
 * safety gates depend on (feed freshness, slot advance).
 *
 * PROGRAM_ID is required from env. There is deliberately no fallback: the
 * bundled IDL address is overwritten with the env value so a stale IDL can
 * never point the engine at a program the operator did not choose.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import anchorPkg from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeConnection } from "../rpc/rpc.js";

const { AnchorProvider, BorshCoder, Program, Wallet } = anchorPkg;
const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL_PATH = join(__dirname, "..", "tx", "idl", "hock_lending.json");

export const PRICE_HISTORY_CAPACITY = 32;
export const MAX_PRICE_STALENESS_SECONDS = 120;
export const MAX_PRICE_UPDATE_FACTOR = 100n;
export const MAX_PROTOCOL_SLIPPAGE_BPS = 1_500n;
export const MAX_SPOT_VS_TWAP_PUMP_BPS = 1_500n;
export const MIN_SAMPLES_FOR_TWAP = 8;
export const MIN_HISTORY_SECONDS = 300;
export const TWAP_WINDOW_SECONDS = 30 * 60;
export const PROTOCOL_FEE_BPS_AUTOSELL = 100n;
export const BPS_DENOM = 10_000n;

export function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required and not set`);
  return v;
}

export function programId() {
  return new PublicKey(requireEnv("PROGRAM_ID"));
}

export function poolPda() {
  return new PublicKey(requireEnv("POOL_PDA"));
}

let _idl = null;
export function getIdl() {
  if (_idl) return _idl;
  const idl = JSON.parse(readFileSync(IDL_PATH, "utf8"));
  const pid = requireEnv("PROGRAM_ID");
  if (idl.address !== pid) {
    console.log(`[program] IDL address ${String(idl.address).slice(0, 8)} overridden by PROGRAM_ID ${pid.slice(0, 8)}`);
    idl.address = pid;
  }
  _idl = idl;
  return _idl;
}

let _coder = null;
export function getCoder() {
  if (!_coder) _coder = new BorshCoder(getIdl());
  return _coder;
}

export function discriminator(accountName) {
  const acc = getIdl().accounts.find((a) => a.name === accountName);
  if (!acc) throw new Error(`IDL has no account ${accountName}`);
  return Buffer.from(acc.discriminator);
}

function expandHome(p) {
  return p.startsWith("~/") ? p.replace(/^~/, process.env.HOME ?? "") : p;
}

export function loadKeypair(envName, { optional = false } = {}) {
  const path = process.env[envName];
  if (!path) {
    if (optional) return null;
    throw new Error(`${envName} is not set`);
  }
  const raw = JSON.parse(readFileSync(expandHome(path), "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

let _engineKp = null;
export function engineKeypair() {
  if (!_engineKp) _engineKp = loadKeypair("ENGINE_AUTHORITY_KEYPAIR_PATH");
  return _engineKp;
}

let _gasKp = null;
export function gasKeypair() {
  if (!_gasKp) _gasKp = loadKeypair("ENGINE_GAS_KEYPAIR_PATH", { optional: true }) || engineKeypair();
  return _gasKp;
}

let _conn = null;
export function connection() {
  if (!_conn) _conn = makeConnection(requireEnv("SOLANA_RPC_URL"));
  return _conn;
}

export function programFor(signer, conn = connection()) {
  const provider = new AnchorProvider(conn, new Wallet(signer), { commitment: "confirmed", skipPreflight: false });
  return new Program(getIdl(), provider);
}

// ---- PDAs -----------------------------------------------------------------
export function priceFeedPda(mint, pool = poolPda(), pid = programId()) {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("price_v3"), new PublicKey(mint).toBuffer(), pool.toBuffer()],
    pid,
  )[0];
}
export function collateralVaultPda(loanPk, pid = programId()) {
  return PublicKey.findProgramAddressSync([Buffer.from("collateral-vault"), new PublicKey(loanPk).toBuffer()], pid)[0];
}
export function solProceedsVaultPda(loanPk, pid = programId()) {
  return PublicKey.findProgramAddressSync([Buffer.from("sol-proceeds"), new PublicKey(loanPk).toBuffer()], pid)[0];
}
export function loanTokenVaultPda(pool = poolPda(), pid = programId()) {
  return PublicKey.findProgramAddressSync([Buffer.from("loan-token-vault"), pool.toBuffer()], pid)[0];
}

// ---- decoders ---------------------------------------------------------------
/**
 * Decode a program account. The Anchor coder returns the IDL's snake_case field
 * names (engine_authority, due_timestamp, ...). Lifted modules read camelCase
 * (engineAuthority, dueTimestamp, ...), so every decoded object carries both
 * spellings; the camelCase ones are non-enumerable aliases of the same values.
 */
export function decodeAccount(name, data) {
  return addCamelAliases(getCoder().accounts.decode(name, data));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
}

/** Recursively add camelCase aliases to plain objects (nested structs, arrays of structs); PublicKey/BN/enums are left alone. */
export function addCamelAliases(v) {
  if (Array.isArray(v)) { for (const el of v) addCamelAliases(el); return v; }
  if (!isPlainObject(v)) return v;
  for (const key of Object.keys(v)) {
    addCamelAliases(v[key]);
    if (!key.includes("_")) continue;
    const camel = key.replace(/^_+/, "").replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
    if (camel && !(camel in v)) Object.defineProperty(v, camel, { value: v[key], enumerable: false, writable: true, configurable: true });
  }
  return v;
}

let _poolCache = { at: 0, value: null };
export async function fetchPool(conn = connection(), { maxAgeMs = 30_000 } = {}) {
  if (_poolCache.value && Date.now() - _poolCache.at < maxAgeMs) return _poolCache.value;
  const info = await conn.getAccountInfo(poolPda(), "confirmed");
  if (!info) throw new Error(`pool ${poolPda().toBase58()} not found on chain`);
  const pool = decodeAccount("LendingPool", info.data);
  _poolCache = { at: Date.now(), value: pool };
  return pool;
}

export async function fetchLoan(conn, loanPk) {
  const info = await conn.getAccountInfo(new PublicKey(loanPk), "confirmed");
  if (!info) return null;
  return decodeAccount("Loan", info.data);
}

/** Anchor decodes enum variants under their IDL spelling ("Active"); normalise to lower case before comparing. */
export function statusKey(status) {
  if (!status || typeof status !== "object") return "unknown";
  const k = Object.keys(status)[0];
  return k ? k.toLowerCase() : "unknown";
}

export function loanStatusName(status) {
  const k = statusKey(status);
  return { active: "open", repaid: "repaid", liquidated: "liquidated" }[k] || k;
}

export async function mintTokenProgram(conn, mint) {
  const info = await conn.getAccountInfo(new PublicKey(mint));
  if (!info) throw new Error(`mint ${String(mint).slice(0, 8)} not found`);
  return info.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

/**
 * Read a PriceHistory ring buffer and compute the same numbers the program
 * does: latest sample, TWAP over TWAP_WINDOW_SECONDS, oldest-sample age.
 * Returns null when the feed account does not exist.
 */
const SYSVAR_CLOCK = new PublicKey("SysvarC1ock11111111111111111111111111111111");
let _clockCache = { at: 0, chainTs: 0, wallMs: 0 };
/**
 * The cluster's clock (Clock sysvar unix_timestamp), which is what the program
 * compares feed timestamps against. It lags wall time by seconds on mainnet and
 * more on a slow local validator (16 s observed 2026-11-11), so every freshness
 * or TWAP-history decision made here uses it, never Date.now(). Cached 2 s and
 * extrapolated with the wall clock between refreshes; falls back to wall time
 * minus a 5 s margin if the sysvar cannot be read.
 */
export async function chainNow(conn = connection()) {
  const wallMs = Date.now();
  if (_clockCache.at && wallMs - _clockCache.at < 2_000) return _clockCache.chainTs + Math.floor((wallMs - _clockCache.wallMs) / 1000);
  try {
    const info = await conn.getAccountInfo(SYSVAR_CLOCK, "processed");
    const ts = Number(info.data.readBigInt64LE(32));
    _clockCache = { at: wallMs, chainTs: ts, wallMs };
    return ts;
  } catch {
    return Math.floor(wallMs / 1000) - 5;
  }
}

export async function readPriceFeed(conn, mint, nowTs = null) {
  const pda = priceFeedPda(mint);
  const [info, now] = await Promise.all([conn.getAccountInfo(pda, "confirmed"), nowTs == null ? chainNow(conn) : Promise.resolve(nowTs)]);
  if (!info) return null;
  const feed = decodeAccount("PriceHistory", info.data);
  return summarisePriceFeed(feed, now, pda);
}

export function summarisePriceFeed(feed, nowTs, pda = null) {
  const count = Number(feed.count);
  const head = Number(feed.headIndex);
  const cap = PRICE_HISTORY_CAPACITY;
  const ordered = [];
  if (count > 0) {
    const start = count < cap ? 0 : head;
    for (let i = 0; i < count; i++) {
      const s = feed.samples[(start + i) % cap];
      ordered.push({ price: BigInt(s.priceLamports.toString()), ts: Number(s.timestamp) });
    }
  }
  const latest = ordered.length ? ordered[ordered.length - 1] : null;
  const windowStart = nowTs - TWAP_WINDOW_SECONDS;
  const inWindow = ordered.filter((s) => s.ts >= windowStart);
  let twap = null;
  let oldestAge = 0;
  if (inWindow.length >= 2) {
    let weighted = 0n;
    let span = 0n;
    for (let i = 0; i < inWindow.length - 1; i++) {
      const dt = BigInt(Math.max(0, inWindow[i + 1].ts - inWindow[i].ts));
      weighted += inWindow[i].price * dt;
      span += dt;
    }
    twap = span > 0n ? weighted / span : inWindow[inWindow.length - 1].price;
    oldestAge = nowTs - inWindow[0].ts;
  } else if (inWindow.length === 1) {
    twap = inWindow[0].price;
    oldestAge = nowTs - inWindow[0].ts;
  }
  return {
    pda: pda ? pda.toBase58() : null,
    mint: feed.mint.toBase58(),
    authority: feed.authority.toBase58(),
    count,
    latest,
    ageSeconds: latest ? nowTs - latest.ts : null,
    twap,
    samplesInWindow: inWindow.length,
    oldestAgeSeconds: oldestAge,
    twapReady: inWindow.length >= MIN_SAMPLES_FOR_TWAP && oldestAge >= MIN_HISTORY_SECONDS,
    fresh: latest ? nowTs - latest.ts <= MAX_PRICE_STALENESS_SECONDS : false,
  };
}

/** Two slot reads a short interval apart; the chain must be moving. */
export async function assertSlotAdvancing(conn = connection(), { gapMs = 1_200 } = {}) {
  const a = await conn.getSlot("confirmed");
  await new Promise((r) => setTimeout(r, gapMs));
  const b = await conn.getSlot("confirmed");
  if (!(b > a)) throw new Error(`slot_not_advancing (${a} -> ${b})`);
  return { from: a, to: b };
}

/** Oracle floor exactly as convert_collateral_slice computes it. */
export function oracleFloorLamports({ sliceAmount, spot, twap, decimals }) {
  const price = twap != null && twap < spot ? twap : spot;
  return (BigInt(sliceAmount) * price * (BPS_DENOM - MAX_PROTOCOL_SLIPPAGE_BPS)) / BPS_DENOM / 10n ** BigInt(decimals);
}

export function withinUpdateFactor(prev, next) {
  if (prev === 0n) return true;
  return next <= prev * MAX_PRICE_UPDATE_FACTOR && next * MAX_PRICE_UPDATE_FACTOR >= prev;
}

export { Connection, PublicKey, Keypair };
