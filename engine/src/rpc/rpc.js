/**
 * RPC failover — primary → backup, for the fire path.
 *
 * Why: when the primary RPC degrades (429 / 5xx / timeout / network), a
 * perfectly healthy fire stalls — the engine can't fetch a blockhash to build
 * the tx, can't confirm a broadcast, can't verify a signature. Today's SPCX
 * fire dropped its first tx and the confirm read timed out; a degraded primary
 * is a real way for an order to sit unfilled. This wraps the primary Connection
 * so idempotent READS transparently retry on a backup RPC, keeping the fire/
 * recovery loop alive even when the primary is down.
 *
 * ── SAFETY: SENDS ARE NEVER FAILED OVER ──────────────────────────────────────
 * sendRawTransaction / sendTransaction run on the PRIMARY ONLY. Blindly
 * re-broadcasting a tx on the backup after the primary "failed" could double-
 * broadcast and — if the primary actually landed it — risk a double-fire /
 * double-sell, the one invariant this engine guards hardest. Send reliability
 * is the engine's job instead: the breadcrumb double-sell guard + stuck-firing
 * recovery + next-tick re-arm re-send with a fresh blockhash. Crucially, the
 * confirm / signature-status / blockhash READS that recovery depends on DO fail
 * over, so the retry loop keeps functioning on a degraded primary — which is
 * exactly what makes the re-send eventually land.
 *
 * Only TRANSPORT-level errors trigger failover (429/5xx/timeout/network). A
 * deterministic RPC-application error (e.g. blockhash expired, a real sim
 * revert) is NOT transient — it would fail identically on the backup, and for
 * confirmTransaction "blockheight exceeded" specifically it correctly means the
 * tx didn't land, so we surface it to the engine's recovery rather than mask it.
 *
 * If SOLANA_RPC_URL_BACKUP is unset, this returns the plain primary Connection
 * with zero overhead — failover is a no-op until a backup is configured.
 */
import { Connection } from "@solana/web3.js";

const PRIMARY_URL = process.env.SOLANA_RPC_URL;
const BACKUP_URL =
  process.env.SOLANA_RPC_URL_BACKUP ||
  process.env.SOLANA_RPC_URL_FALLBACK ||
  "";

// Idempotent READ methods that are SAFE to retry on the backup. Sends and any
// state-affecting call are intentionally absent — they run on primary only.
const FAILOVER_READ_METHODS = new Set([
  "getLatestBlockhash",
  "getBlockHeight",
  "getSlot",
  "getSignatureStatus",
  "getSignatureStatuses",
  "confirmTransaction",
  "simulateTransaction",
  "getBalance",
  "getAccountInfo",
  "getParsedAccountInfo",
  "getMultipleAccountsInfo",
  "getTransaction",
  "getParsedTransaction",
  "getAddressLookupTable",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
]);

/** True only for transport-level errors that a different RPC could recover. */
function isTransientRpcError(err) {
  const msg = (err && (err.message || String(err))) || "";
  // Definitive non-transient outcomes — must NOT mask these by retrying.
  // "blockheight exceeded" from confirmTransaction means the tx didn't land;
  // a sim "custom program error"/"InstructionError" is deterministic.
  if (/blockheight exceeded|block height exceeded|TransactionExpired/i.test(msg)) return false;
  if (/InstructionError|custom program error|0x[0-9a-f]+/i.test(msg)) return false;
  return /\b(429|408|5\d\d)\b|rate.?limit|too many requests|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|network|fetch failed|failed to fetch|service unavailable|bad gateway|gateway timeout/i.test(
    msg,
  );
}

// P1-2 — bound EVERY RPC request with a deadline. web3.js Connection reads have
// no fetch timeout of their own, so a black-holed RPC (TCP accepted but never
// answered) hangs getAccountInfo / confirmTransaction / sendRawTransaction /
// Anchor .rpc() forever, and the failover proxy below — which only engages on a
// THROWN error — never fires. Injecting an AbortSignal turns that hang into a
// "timed out" throw that isTransientRpcError matches → the read fails over to
// backup. (A send's rare timed-out-but-landed case is covered by the
// fail-closed breadcrumb + stuck-firing recovery, NOT a blind re-broadcast.)
// No behavior change on a healthy RPC.
const RPC_FETCH_TIMEOUT_MS = Number(process.env.RPC_FETCH_TIMEOUT_MS) || 20_000;
const RPC_CONFIRM_INITIAL_TIMEOUT_MS =
  Number(process.env.RPC_CONFIRM_INITIAL_TIMEOUT_MS) || 60_000;

function fetchWithTimeout(input, init = {}) {
  // Respect a caller-supplied signal; otherwise inject our per-request deadline.
  if (init && init.signal) return fetch(input, init);
  return fetch(input, { ...init, signal: AbortSignal.timeout(RPC_FETCH_TIMEOUT_MS) });
}

/**
 * Build a Connection whose every HTTP request is deadline-bounded (P1-2).
 * Use this everywhere instead of `new Connection(url, "confirmed")`.
 */
export function makeConnection(url, commitment = "confirmed") {
  return new Connection(url, {
    commitment,
    fetch: fetchWithTimeout,
    confirmTransactionInitialTimeout: RPC_CONFIRM_INITIAL_TIMEOUT_MS,
  });
}

let _primary = null;
let _backup = null;
let _failover = null;

function primaryConn() {
  if (!_primary) _primary = makeConnection(PRIMARY_URL);
  return _primary;
}

/** The backup Connection, or null if none configured. */
export function getBackupConnection() {
  if (!BACKUP_URL) return null;
  if (!_backup) _backup = makeConnection(BACKUP_URL);
  return _backup;
}

export function hasBackupRpc() {
  return !!BACKUP_URL;
}

/**
 * A Connection that transparently fails idempotent READS over to the backup on
 * a transient primary error. Sends + everything else go straight to primary.
 * Cached singleton. With no backup configured, returns the plain primary.
 */
export function getFailoverConnection() {
  if (_failover) return _failover;
  const primary = primaryConn();
  const backup = getBackupConnection();
  if (!backup) {
    _failover = primary; // no backup → no wrapping, no overhead
    return _failover;
  }
  _failover = new Proxy(primary, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof orig !== "function") return orig;
      if (!FAILOVER_READ_METHODS.has(prop)) {
        // Sends + non-read methods: bind to primary, no failover.
        return orig.bind(target);
      }
      return async (...args) => {
        try {
          return await orig.apply(target, args);
        } catch (err) {
          if (!isTransientRpcError(err)) throw err;
          const backupFn = backup[prop];
          if (typeof backupFn !== "function") throw err;
          try {
            const out = await backupFn.apply(backup, args);
            console.warn(
              `[rpc] primary ${String(prop)} transient-failed (${(err.message || "").slice(0, 60)}) — served from BACKUP`,
            );
            return out;
          } catch (backupErr) {
            // Both RPCs failed — surface the ORIGINAL primary error so the
            // engine's existing recovery sees the real (transient) cause.
            console.warn(
              `[rpc] ${String(prop)} failed on BOTH primary + backup (${(backupErr.message || "").slice(0, 50)})`,
            );
            throw err;
          }
        }
      };
    },
  });
  console.log(
    `[rpc] failover armed — reads retry on backup (${BACKUP_URL.replace(/\?.*$/, "").slice(0, 40)}…); sends stay on primary`,
  );
  return _failover;
}
