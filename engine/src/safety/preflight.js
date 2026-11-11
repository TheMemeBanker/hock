/**
 * Boot-time preflight. Every check returns { ok, name, detail }. The engine
 * refuses to start loops when a required check fails; warnings do not block.
 *
 * Checks: PROGRAM_ID + POOL_PDA parse, engine/gas keypairs readable, RPC slot
 * advancing across two reads, DB reachable + baseline tables present, pool
 * account decodes and its engine_authority matches the engine key, program
 * account is executable, Jupiter reachable (warn only).
 */
import { PublicKey } from "@solana/web3.js";
import { dbPing, query } from "../db/pool.js";
import { notifyAdmin } from "../notify/admin.js";
import {
  assertSlotAdvancing,
  connection,
  engineKeypair,
  gasKeypair,
  fetchPool,
  loadKeypair,
  programId,
  poolPda,
} from "../chain/program.js";
import { JUPITER_API } from "../price/jupiter-config.js";

const REQUIRED_TABLES = ["mints", "gate_state", "gate_passes", "attestations", "loans", "limit_close_orders", "conversion_events", "pool_snapshots", "canary_runs", "notifications_outbox"];
const SOL_MINT = "So11111111111111111111111111111111111111112";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function pubkeyEnv(name, { optional = false } = {}) {
  const v = process.env[name];
  if (!v) return { ok: optional, name, detail: optional ? "not set (optional)" : "env var not set" };
  try { new PublicKey(v); return { ok: true, name, detail: v.slice(0, 8) }; }
  catch (err) { return { ok: false, name, detail: `invalid pubkey: ${err.message}` }; }
}

async function checkProgramId() { return pubkeyEnv("PROGRAM_ID"); }
async function checkPoolPda() { return pubkeyEnv("POOL_PDA"); }
async function checkFeeDestination() { return pubkeyEnv("FEE_DESTINATION", { optional: true }); }

async function checkKeypairs() {
  try {
    const e = engineKeypair();
    const g = gasKeypair();
    const pa = loadKeypair("POOL_AUTHORITY_KEYPAIR_PATH", { optional: true });
    return { ok: true, name: "keypairs", detail: `engine=${e.publicKey.toBase58().slice(0, 8)} gas=${g.publicKey.toBase58().slice(0, 8)} pool_authority=${pa ? pa.publicKey.toBase58().slice(0, 8) : "not configured"}` };
  } catch (err) {
    return { ok: false, name: "keypairs", detail: err.message };
  }
}

async function checkRpcSlotAdvancing() {
  try {
    const r = await assertSlotAdvancing(connection());
    return { ok: true, name: "rpc_slot_advancing", detail: `${r.from} -> ${r.to}` };
  } catch (err) {
    return { ok: false, name: "rpc_slot_advancing", detail: err.message };
  }
}

async function checkProgramDeployed() {
  try {
    const info = await connection().getAccountInfo(programId());
    if (!info) return { ok: false, name: "program_deployed", detail: "program account not found" };
    if (!info.executable) return { ok: false, name: "program_deployed", detail: "account is not executable" };
    return { ok: true, name: "program_deployed", detail: `owner=${info.owner.toBase58().slice(0, 8)}` };
  } catch (err) {
    return { ok: false, name: "program_deployed", detail: err.message };
  }
}

async function checkPoolAccount() {
  try {
    const pool = await fetchPool(connection(), { maxAgeMs: 0 });
    const engine = engineKeypair().publicKey;
    const match = pool.engineAuthority.equals(engine);
    const pa = loadKeypair("POOL_AUTHORITY_KEYPAIR_PATH", { optional: true });
    const paMatch = pa ? pool.authority.equals(pa.publicKey) : null;
    const detail = `authority=${pool.authority.toBase58().slice(0, 8)} engine_authority=${pool.engineAuthority.toBase58().slice(0, 8)} fee_wallet=${pool.feeWallet.toBase58().slice(0, 8)} paused=${pool.paused}` +
      (pa ? ` pool_authority_key_matches=${paMatch}` : "");
    if (!match) return { ok: false, name: "pool_account", detail: `${detail}; engine key ${engine.toBase58().slice(0, 8)} is NOT pool.engine_authority (rotate with set_pool_config)` };
    if (pa && !paMatch) return { ok: false, name: "pool_account", detail: `${detail}; POOL_AUTHORITY_KEYPAIR_PATH does not match pool.authority` };
    return { ok: true, name: "pool_account", detail };
  } catch (err) {
    return { ok: false, name: "pool_account", detail: err.message };
  }
}

async function checkDb() {
  const r = await dbPing();
  return { ok: r.ok, name: "db_connect", detail: r.ok ? `${r.latencyMs}ms` : r.error };
}

async function checkTables() {
  const missing = [];
  for (const t of REQUIRED_TABLES) {
    try {
      const { rows } = await query("SELECT to_regclass($1) AS reg", [t]);
      if (rows[0]?.reg == null) missing.push(t);
    } catch (err) {
      return { ok: false, name: "required_tables", detail: `lookup failed for ${t}: ${err.message}` };
    }
  }
  return missing.length ? { ok: false, name: "required_tables", detail: `missing: ${missing.join(", ")}; run migrations` } : { ok: true, name: "required_tables", detail: `${REQUIRED_TABLES.length} present` };
}

async function checkJupiter() {
  try {
    const res = await fetch(`${JUPITER_API}/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000&slippageBps=50`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return { ok: true, warn: true, name: "jupiter", detail: `HTTP ${res.status} (warn; mainnet routing only)` };
    const data = await res.json();
    return { ok: true, name: "jupiter", detail: data?.outAmount ? `outAmount=${data.outAmount}` : "no outAmount (warn)" , warn: !data?.outAmount };
  } catch (err) {
    return { ok: true, warn: true, name: "jupiter", detail: `${err.message} (warn)` };
  }
}

async function checkEngineBalance() {
  try {
    const lamports = await connection().getBalance(gasKeypair().publicKey);
    const sol = lamports / 1e9;
    const hard = Number(process.env.ENGINE_GAS_HARD_FLOOR_SOL || "0.02");
    const warn = Number(process.env.ENGINE_GAS_WARN_FLOOR_SOL || "0.10");
    if (sol < hard) return { ok: false, name: "gas_balance", detail: `${sol.toFixed(4)} SOL below hard floor ${hard}` };
    return { ok: true, warn: sol < warn, name: "gas_balance", detail: `${sol.toFixed(4)} SOL${sol < warn ? ` (below warn floor ${warn})` : ""}` };
  } catch (err) {
    return { ok: false, name: "gas_balance", detail: err.message };
  }
}

const CHECKS = [checkProgramId, checkPoolPda, checkFeeDestination, checkKeypairs, checkDb, checkTables, checkRpcSlotAdvancing, checkProgramDeployed, checkPoolAccount, checkEngineBalance, checkJupiter];

export async function runPreflight({ skipDb = false } = {}) {
  const results = [];
  for (const check of CHECKS) {
    if (skipDb && (check === checkDb || check === checkTables)) continue;
    let r;
    try { r = await check(); }
    catch (err) { r = { ok: false, name: check.name, detail: `check threw: ${err.message}` }; }
    results.push(r);
    console.log(`[preflight] ${(r.ok ? (r.warn ? "warn" : "ok") : "FAIL").padEnd(4)} ${r.name}${r.detail ? ` -- ${r.detail}` : ""}`);
  }
  const failures = results.filter((r) => !r.ok);
  const ok = failures.length === 0;
  if (!ok && !skipDb) {
    await notifyAdmin({ kind: "engine_preflight_failed", throttleMs: 0, payload: { failures: failures.map((f) => ({ name: f.name, detail: f.detail })) } }).catch(() => {});
  }
  return { ok, results, failures };
}
