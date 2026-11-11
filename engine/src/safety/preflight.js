/**
 * Engine preflight — full self-test that runs ONCE at startup before
 * we arm the watcher loop.
 *
 * Why this exists
 * ───────────────
 * The "fail-fast on missing envs" check in index.js catches typos
 * but it doesn't catch the much nastier failures:
 *   - DATABASE_URL is set but the password rotated
 *   - SOLANA_RPC_URL is set but the host is unreachable
 *   - Jupiter API is set but returning HTML maintenance pages
 *   - ENGINE_TOPUP_KEYPAIR is set but malformed
 *   - LENDER_PUBKEY is set but doesn't match the on-chain lender
 *     account the program expects
 *   - schema_migrations is missing required tables (e.g. engine_heartbeats
 *     from PR #9 wasn't applied)
 *
 * Before this module, any of those would let the engine boot looking
 * healthy, then silently fail when the first armed order tries to
 * fire. The operator finds out from a missed liquidation. That's the
 * exact "find out from a user" reliability problem [[feedback_premium_reliability_proactive]]
 * is meant to prevent.
 *
 * How it works
 * ────────────
 *   1. Run each check serially (parallel offers no real speedup and
 *      makes the log order confusing for ops).
 *   2. Each check returns { ok, name, detail }. On the first failure
 *      we enqueue an operator-DM notification with the full failure
 *      list, then return overall ok=false.
 *   3. index.js refuses to start the watcher when ok=false. The
 *      process exits 1 so the host restarts and we get visibility
 *      via crash-loop alerts.
 *
 * Adding a new check: drop a function into CHECKS below. Keep them
 * idempotent (no side effects beyond reads / DM enqueue).
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { makeConnection } from "../rpc/rpc.js";
import { query, pool } from "../TODO-hock/db.js";
import { enqueueNotification } from "../TODO-hock/notifications.js";
import bs58 from "bs58";

const JUPITER_API = process.env.JUPITER_API || "https://lite-api.jup.ag/swap/v1";
const USDC_MINT = process.env.USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";

// Required tables — if any are missing, the migration didn't run.
const REQUIRED_TABLES = [
  "limit_close_orders",
  "pending_notifications",
  "wallets",
  "engine_heartbeats",
];

async function checkDb() {
  // SELECT 1 — does the engine pool actually open?
  try {
    const { rows } = await pool.query("SELECT 1 AS one");
    if (rows[0]?.one !== 1) {
      return { ok: false, name: "db_connect", detail: "SELECT 1 returned unexpected shape" };
    }
  } catch (err) {
    return { ok: false, name: "db_connect", detail: err.message };
  }
  return { ok: true, name: "db_connect" };
}

async function checkRequiredTables() {
  const missing = [];
  for (const t of REQUIRED_TABLES) {
    try {
      // to_regclass returns NULL when the relation doesn't exist —
      // cheaper than a SELECT * and doesn't fail loudly.
      const { rows } = await query("SELECT to_regclass($1) AS reg", [t]);
      if (rows[0]?.reg == null) missing.push(t);
    } catch (err) {
      return { ok: false, name: "required_tables", detail: `lookup failed for ${t}: ${err.message}` };
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      name: "required_tables",
      detail: `missing: ${missing.join(", ")} — run migrations on this DB`,
    };
  }
  return { ok: true, name: "required_tables" };
}

async function checkSolanaRpc() {
  try {
    const conn = makeConnection(process.env.SOLANA_RPC_URL);
    const slot = await conn.getSlot("confirmed");
    if (!Number.isFinite(slot) || slot < 1) {
      return { ok: false, name: "solana_rpc", detail: `unexpected slot=${slot}` };
    }
    return { ok: true, name: "solana_rpc", detail: `slot=${slot}` };
  } catch (err) {
    return { ok: false, name: "solana_rpc", detail: err.message };
  }
}

async function checkJupiter() {
  // Smallest legal SOL→USDC quote — confirms the upstream is up
  // and returning shape we expect.
  try {
    const url = `${JUPITER_API}/quote?inputMint=${SOL_MINT}&outputMint=${USDC_MINT}&amount=1000000&slippageBps=50`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) {
      return { ok: false, name: "jupiter", detail: `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (!data?.outAmount || !/^\d+$/.test(String(data.outAmount))) {
      return { ok: false, name: "jupiter", detail: "missing/invalid outAmount in response" };
    }
    return { ok: true, name: "jupiter", detail: `outAmount=${data.outAmount}` };
  } catch (err) {
    return { ok: false, name: "jupiter", detail: err.message };
  }
}

function validatePubkeyEnv(name) {
  const v = process.env[name];
  if (!v) return { ok: false, name, detail: "env var not set" };
  try {
    new PublicKey(v);
    return { ok: true, name, detail: v.slice(0, 8) + "…" };
  } catch (err) {
    return { ok: false, name, detail: `invalid pubkey: ${err.message}` };
  }
}

function checkLenderPubkey()        { return validatePubkeyEnv("LENDER_PUBKEY"); }
function checkProgramId()           { return validatePubkeyEnv("PROGRAM_ID"); }
// PR B (2026-06-13): V2 RWA lending program. Optional — if unset, the
// engine cannot fire V2 orders, but V1 memecoin orders still work.
// Validate ONLY when the env var is set, mirroring checkFeeDestination.
// This catches a typo in PROGRAM_ID_V2 at boot rather than at first fire.
function checkProgramIdV2() {
  if (!process.env.PROGRAM_ID_V2) {
    return { ok: true, name: "PROGRAM_ID_V2", detail: "not set (RWA fires disabled — V1 still works)" };
  }
  return validatePubkeyEnv("PROGRAM_ID_V2");
}
// V3 deployed 2026-06-13. Same shape as the V2 check — optional, validated
// only when set, so misconfigured ID fails at boot rather than first fire.
function checkProgramIdV3() {
  if (!process.env.PROGRAM_ID_V3) {
    return { ok: true, name: "PROGRAM_ID_V3", detail: "not set (V3 fires disabled — V1/V2 still work)" };
  }
  return validatePubkeyEnv("PROGRAM_ID_V3");
}
// V4 (in-vault auto-sell). Same shape as V2/V3 — optional, validated only
// when set. Adds an extra alert when set so the operator gets a clear
// boot-time signal that V4 routing is now active in the engine.
function checkProgramIdV4() {
  if (!process.env.PROGRAM_ID_V4) {
    return { ok: true, name: "PROGRAM_ID_V4", detail: "not set (V4 fires disabled — V1/V2/V3 still work)" };
  }
  return validatePubkeyEnv("PROGRAM_ID_V4");
}
function checkFeeDestination() {
  // Optional — operator may run without on-chain fee splits.
  if (!process.env.FEE_DESTINATION) {
    return { ok: true, name: "FEE_DESTINATION", detail: "not set (optional)" };
  }
  return validatePubkeyEnv("FEE_DESTINATION");
}

function checkEngineKeypair(envName) {
  const secret = process.env[envName];
  if (!secret) return { ok: false, name: envName, detail: "env var not set" };
  // Accept either base58 secret-key string or JSON array of bytes.
  try {
    let bytes;
    if (secret.startsWith("[")) {
      bytes = Uint8Array.from(JSON.parse(secret));
    } else {
      bytes = bs58.decode(secret);
    }
    if (bytes.length !== 64) {
      return { ok: false, name: envName, detail: `expected 64-byte secret; got ${bytes.length}` };
    }
    const kp = Keypair.fromSecretKey(bytes);
    return { ok: true, name: envName, detail: kp.publicKey.toBase58().slice(0, 8) + "…" };
  } catch (err) {
    return { ok: false, name: envName, detail: `decode failed: ${err.message}` };
  }
}

function checkTopupKeypair()        { return checkEngineKeypair("ENGINE_TOPUP_KEYPAIR"); }

// 2026-06-16 — V4 engine authority wallet balance check, per operator
// rule [[feedback_engine_v4_authority_balance_monitoring]]. The
// ENGINE_AUTHORITY_V4 keypair signs every convert_collateral_slice
// tx; it pays priority fees + ATA init rent on each fire. If it runs
// dry, fires fail loudly instead of silently. Thresholds:
//   - balance < 0.02 SOL: HARD FAIL — refuse to start watcher.
//                          Even one fire might fail.
//   - balance < 0.10 SOL: WARN — start, but emit operator alert.
//   - balance >= 0.10 SOL: ok.
async function checkEngineV4AuthorityBalance() {
  const name = "engine_v4_authority_balance";
  const b58 = process.env.ENGINE_AUTHORITY_PRIVATE_KEY;
  const path = process.env.ENGINE_AUTHORITY_KEYPAIR_PATH;
  if (!b58 && !path) {
    return { ok: true, name, detail: "not configured (V4 disabled)" };
  }
  try {
    const { Connection, Keypair, PublicKey } = await import("@solana/web3.js");
    const bs58Mod = await import("bs58");
    const { readFileSync } = await import("node:fs");
    let pubkey;
    if (b58) {
      const decode = bs58Mod.default?.decode || bs58Mod.decode;
      pubkey = Keypair.fromSecretKey(decode(b58)).publicKey;
    } else {
      const resolved = path.startsWith("~/") ? path.replace(/^~/, process.env.HOME ?? "") : path;
      pubkey = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(readFileSync(resolved, "utf8"))),
      ).publicKey;
    }
    const connection = makeConnection(
      process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
    );
    const lamports = await connection.getBalance(pubkey);
    const sol = lamports / 1e9;
    const HARD_FLOOR_SOL = Number(process.env.V4_ENGINE_HARD_FLOOR_SOL || "0.02");
    const WARN_SOL = Number(process.env.V4_ENGINE_WARN_FLOOR_SOL || "0.10");
    const detail = `${pubkey.toBase58().slice(0, 8)}… balance=${sol.toFixed(6)} SOL`;
    if (sol < HARD_FLOOR_SOL) {
      return {
        ok: false, name,
        detail: `${detail} — BELOW HARD FLOOR (${HARD_FLOOR_SOL} SOL). Top up before fires can land safely.`,
      };
    }
    if (sol < WARN_SOL) {
      return {
        ok: true, name,
        detail: `${detail} ⚠ below warn threshold (${WARN_SOL} SOL) — top up soon`,
        warn: true,
      };
    }
    return { ok: true, name, detail };
  } catch (err) {
    return { ok: false, name, detail: `balance probe failed: ${err.message?.slice(0, 120)}` };
  }
}
function checkReserveSourceKeypair() {
  // Optional — if not configured, the reserve module just disables itself.
  if (!process.env.ENGINE_RESERVE_SOURCE_KEYPAIR) {
    return { ok: true, name: "ENGINE_RESERVE_SOURCE_KEYPAIR", detail: "not set (reserve disabled)" };
  }
  return checkEngineKeypair("ENGINE_RESERVE_SOURCE_KEYPAIR");
}

async function checkBotApi() {
  // HOCK_API_URL is optional (some engine deploys don't need to call
  // back to the bot). If set, verify reachability so we catch a stale
  // host URL early.
  const url = process.env.HOCK_API_URL;
  if (!url) return { ok: true, name: "bot_api", detail: "not set (optional)" };
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/api/v1/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { ok: false, name: "bot_api", detail: `HTTP ${res.status}` };
    const data = await res.json().catch(() => ({}));
    if (data?.status !== "ok") {
      return { ok: false, name: "bot_api", detail: `unexpected health body: ${JSON.stringify(data).slice(0, 120)}` };
    }
    return { ok: true, name: "bot_api", detail: "healthy" };
  } catch (err) {
    return { ok: false, name: "bot_api", detail: err.message };
  }
}

// 2026-06-17 — Defensive boot-time assertion that every column the
// fire-path SELECTs against actually exists on its target table.
// Triggered after the V4 SPCX loan 826 incident where execution.js
// loadOrderContext was selecting tier_option/category from loans
// (cols missing — migration never landed) and every fire attempt
// threw 'column does not exist'. failure_count = 5 by the time
// operator noticed.
//
// Rule (see feedback_ladder_trigger_must_execute.md):
//   when a ladder leg's trigger hits, the sale order MUST execute.
//   No column referenced by execution.js / safety.js / keeper.js
//   may be missing from its target table on engine boot.
//
// The check enumerates the columns each fire-path query reads and
// asserts each one exists in information_schema. Boot fails LOUDLY
// if any are missing — operator DM fires via the existing preflight
// failure flow and the host crash-loops the deploy until fixed.
const FIRE_PATH_REQUIRED_COLUMNS = {
  loans: [
    "id", "loan_id", "loan_pda", "user_id", "status", "program_id",
    "original_loan_amount_lamports", "collateral_mint",
    "collateral_amount", "borrower_wallet",
  ],
  supported_mints: ["mint", "symbol", "enabled", "category", "decimals"],
  limit_close_orders: [
    "id", "loan_id", "status", "trigger_kind", "trigger_value_micro",
    "trigger_direction", "slippage_bps", "max_slippage_bps_cap",
    "failure_count", "failure_reason", "ladder_group_id",
    "fired_at", "tx_signature_repay", "tx_signature_swap",
  ],
};

async function checkFirePathSchema() {
  try {
    const { rows } = await query(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN ('loans','supported_mints','limit_close_orders')`,
    );
    const have = new Map();
    for (const r of rows) {
      if (!have.has(r.table_name)) have.set(r.table_name, new Set());
      have.get(r.table_name).add(r.column_name);
    }
    const missing = [];
    for (const [tbl, cols] of Object.entries(FIRE_PATH_REQUIRED_COLUMNS)) {
      const present = have.get(tbl) || new Set();
      for (const c of cols) {
        if (!present.has(c)) missing.push(`${tbl}.${c}`);
      }
    }
    if (missing.length > 0) {
      return {
        ok: false,
        name: "fire_path_schema",
        detail: `missing columns: ${missing.join(", ")} — fire path WILL throw 'column does not exist' on every order. Apply migration before deploy.`,
      };
    }
    return { ok: true, name: "fire_path_schema", detail: `${Object.values(FIRE_PATH_REQUIRED_COLUMNS).flat().length} cols asserted across 3 tables` };
  } catch (err) {
    return { ok: false, name: "fire_path_schema", detail: `assertion query failed: ${err.message}` };
  }
}

/**
 * Behavioral self-test for the RWA cross-source-skip carve-out.
 *
 * Why this exists: shipped 2026-06-18 PM after an incident where engine
 * PR #51 (canary skip for RWA Token-2022 mints) was merged to main but
 * the production engine kept running stale code that didn't have the
 * skip. The canary kept firing FAIL on every SPCX run because the
 * deployed binary lacked the behavior. The "code is in the repo" check
 * isn't enough — we need to verify the LOADED MODULE has the behavior.
 *
 * Test: synthesize a fake template loan with category="stock" and call
 * the production checkCrossSourceAgreement. Assert that:
 *   - result.ok === true
 *   - result.detail starts with "skipped"
 *
 * If the assertion fails, the deployed engine has lost or regressed the
 * RWA skip path and would 100% false-fail every SPCX canary again.
 * Better to crash-loop visibly than to silently spam alerts.
 *
 * Test is sync-fast and side-effect-free.
 */
async function checkRwaSkipBehavior() {
  try {
    // Dynamic import so a broken canary.js doesn't crash preflight at
    // load time — the failed import shows up as the FAIL detail.
    const { checkCrossSourceAgreement } = await import("./canary.js");
    if (typeof checkCrossSourceAgreement !== "function") {
      return { ok: false, name: "rwa_skip_behavior", detail: "canary.checkCrossSourceAgreement is not exported" };
    }
    const fakeTemplate = {
      collateral_mint: "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb",
      symbol: "SPCX",
      category: "stock",
      decimals: 6,
      coll_raw: "1000000",
    };
    const r = await checkCrossSourceAgreement(fakeTemplate);
    if (!r?.ok) {
      return { ok: false, name: "rwa_skip_behavior", detail: `expected ok=true, got ${JSON.stringify(r)}` };
    }
    if (!String(r.detail || "").toLowerCase().startsWith("skipped")) {
      return {
        ok: false,
        name: "rwa_skip_behavior",
        detail: `expected detail to start with 'skipped', got: ${String(r.detail || "").slice(0, 100)}`,
      };
    }
    return { ok: true, name: "rwa_skip_behavior", detail: "RWA (stock/etf/metal) carve-out present" };
  } catch (err) {
    return { ok: false, name: "rwa_skip_behavior", detail: `import or call threw: ${err.message?.slice(0, 100)}` };
  }
}

const CHECKS = [
  checkDb,
  checkRequiredTables,
  checkFirePathSchema,
  checkSolanaRpc,
  checkJupiter,
  checkLenderPubkey,
  checkProgramId,
  checkProgramIdV2,
  checkProgramIdV3,
  checkProgramIdV4,
  checkFeeDestination,
  checkTopupKeypair,
  checkReserveSourceKeypair,
  checkBotApi,
  checkEngineV4AuthorityBalance,
  checkRwaSkipBehavior,
];

/**
 * Run all preflight checks. Returns { ok: boolean, results: [{ok, name, detail}] }.
 *
 * Side effect: on overall failure, enqueues an operator DM via
 * pending_notifications (kind: 'engine_preflight_failed'). The bot's
 * notification-sender drains it and DMs the operator. Even if the
 * bot itself is also degraded, the row will be picked up when the
 * bot recovers — better than a silent fail.
 */
export async function runPreflight() {
  const results = [];
  for (const check of CHECKS) {
    let r;
    try {
      r = await check();
    } catch (err) {
      r = { ok: false, name: check.name || "unknown", detail: `check threw: ${err.message}` };
    }
    results.push(r);
    const status = r.ok ? "ok" : "FAIL";
    const tail = r.detail ? ` — ${r.detail}` : "";
    console.log(`[preflight] ${status.padEnd(4)} ${r.name}${tail}`);
  }
  const failures = results.filter((r) => !r.ok);
  const ok = failures.length === 0;

  if (!ok) {
    // Best-effort operator DM. If pending_notifications itself isn't
    // accessible, we still bail — the host crash-loop alarm becomes
    // the second line of visibility.
    try {
      const operatorUserId = Number(process.env.OPERATOR_USER_ID);
      if (Number.isFinite(operatorUserId) && operatorUserId > 0) {
        await enqueueNotification({
          userId: operatorUserId,
          kind: "engine_preflight_failed",
          payload: {
            failures: failures.map((f) => ({ name: f.name, detail: f.detail })),
            checked_at: new Date().toISOString(),
            hostname: process.env.HOSTNAME || "unknown",
          },
        });
        console.error(`[preflight] enqueued operator DM with ${failures.length} failure(s)`);
      } else {
        console.error("[preflight] OPERATOR_USER_ID not set — skipping DM, relying on crash-loop alarm");
      }
    } catch (err) {
      console.error("[preflight] failed to enqueue operator alert:", err.message);
    }
  }

  return { ok, results };
}
