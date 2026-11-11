/**
 * Postgres pool for the HOCK engine.
 *
 * - `query(text, params)`      writes and reads against DATABASE_URL.
 * - `queryRead(text, params)`  reads; falls over to DATABASE_URL_READONLY when
 *                              the primary is unreachable (never for writes).
 * - `getClient()`              a dedicated client (advisory locks, transactions).
 * - `dbPing()`                 health check used by preflight and /health.
 *
 * Pools are created lazily so `node --check` and the boot-check script can
 * import modules without a database configured; the first real query throws
 * a clear error when DATABASE_URL is missing.
 */
import pg from "pg";

let _primary = null;
let _readonly = null;
let _lastPrimaryError = null;

function makePool(url, label) {
  const p = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX) || 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: `hock-engine:${process.env.ENGINE_INSTANCE_ID || "engine"}:${label}`,
  });
  p.on("error", (err) => {
    console.error(`[db:${label}] idle client error: ${err.message}`);
  });
  return p;
}

function primary() {
  if (_primary) return _primary;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set (engine/src/db/pool.js)");
  }
  _primary = makePool(process.env.DATABASE_URL, "rw");
  return _primary;
}

function readonly() {
  if (_readonly) return _readonly;
  if (!process.env.DATABASE_URL_READONLY) return null;
  _readonly = makePool(process.env.DATABASE_URL_READONLY, "ro");
  return _readonly;
}

function isConnectivityError(err) {
  const code = err?.code || "";
  return (
    ["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET", "57P01", "57P02", "57P03", "08006", "08001", "08004"].includes(code) ||
    /terminat|timeout|ECONNREFUSED|connection/i.test(err?.message || "")
  );
}

export const query = (text, params) => primary().query(text, params);

export async function queryRead(text, params) {
  try {
    return await primary().query(text, params);
  } catch (err) {
    const ro = readonly();
    if (!ro || !isConnectivityError(err)) throw err;
    _lastPrimaryError = { at: Date.now(), message: err.message };
    console.warn(`[db] primary read failed (${err.message.slice(0, 80)}); serving from DATABASE_URL_READONLY`);
    return ro.query(text, params);
  }
}

export const getClient = () => primary().connect();

/** Proxy that behaves like a pg.Pool for lifted modules that import `pool`. */
export const pool = {
  query: (text, params) => primary().query(text, params),
  connect: () => primary().connect(),
  end: () => closeDb(),
};

export async function dbPing() {
  const t0 = Date.now();
  try {
    const { rows } = await primary().query("SELECT 1 AS one");
    return { ok: rows[0]?.one === 1, latencyMs: Date.now() - t0, lastPrimaryError: _lastPrimaryError };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - t0, error: err.message, lastPrimaryError: _lastPrimaryError };
  }
}

export async function closeDb() {
  const tasks = [];
  if (_primary) tasks.push(_primary.end().catch(() => {}));
  if (_readonly) tasks.push(_readonly.end().catch(() => {}));
  _primary = null;
  _readonly = null;
  await Promise.all(tasks);
}
