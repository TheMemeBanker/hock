/**
 * HOCK engine entrypoint.
 *
 * Boot order
 *   1. migrations (db/migrations-runner.js, advisory-locked, checksum-verified)
 *   2. preflight (PROGRAM_ID + POOL_PDA, keys readable, RPC slot advancing,
 *      DB reachable + tables, program executable, pool.engine_authority ==
 *      engine key, gas balance)
 *   3. health server, then the loops with jittered first ticks:
 *      attestor, gate, watcher (+ stuck-firing recovery), reconciler, canary,
 *      armed-order health probe
 *   4. SIGTERM/SIGINT -> stop timers, close DB, exit 0
 *
 * `node src/index.js --boot-check` runs steps 1-2 (skipping the DB when
 * DATABASE_URL is unset) and exits with the preflight result.
 */
import "dotenv/config";
import { applyPendingMigrations } from "../db/migrations-runner.js";
import { runPreflight } from "./safety/preflight.js";
import { startHealthServer, stopHealthServer } from "./health/health-server.js";
import { startAttestor, stopAttestor } from "./attestor/attestor.js";
import { startGate, stopGate } from "./gate/gate.js";
import { startWatcher, stopWatcher } from "./watcher/watcher.js";
import { startReconciler, stopReconciler } from "./reconciler/reconciler.js";
import { startCanary, stopCanary } from "./canary/canary.js";
import { startArmedOrderHealthProbe, stopArmedOrderHealthProbe } from "./orders/armed-order-health-probe.js";
import { closeDb } from "./db/pool.js";

const BOOT_CHECK = process.argv.includes("--boot-check");
const REQUIRED = ["PROGRAM_ID", "POOL_PDA", "SOLANA_RPC_URL", "ENGINE_AUTHORITY_KEYPAIR_PATH"];

function requireEnv() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (!BOOT_CHECK) missing.push(...["DATABASE_URL"].filter((k) => !process.env[k]));
  if (missing.length) {
    console.error(`[boot] missing required env: ${missing.join(", ")}`);
    process.exit(2);
  }
}

async function shutdown(signal) {
  console.log(`[boot] ${signal}: shutting down`);
  for (const stop of [stopAttestor, stopGate, stopWatcher, stopReconciler, stopCanary, stopArmedOrderHealthProbe, stopHealthServer]) {
    try { stop(); } catch {}
  }
  await closeDb().catch(() => {});
  process.exit(0);
}

async function main() {
  requireEnv();
  console.log(`[boot] hock-engine ${process.env.ENGINE_INSTANCE_ID || "engine"} cluster=${process.env.HOCK_CLUSTER || "?"} program=${process.env.PROGRAM_ID.slice(0, 8)} pool=${process.env.POOL_PDA.slice(0, 8)}`);

  const hasDb = !!process.env.DATABASE_URL;
  if (hasDb) {
    const m = await applyPendingMigrations();
    console.log(`[boot] migrations applied=${m.applied.length} skipped=${m.skipped.length}`);
  } else {
    console.warn("[boot] DATABASE_URL unset; boot-check without DB");
  }

  const pf = await runPreflight({ skipDb: !hasDb });
  if (BOOT_CHECK) {
    console.log(`[boot-check] ${pf.ok ? "PASS" : "FAIL"} (${pf.failures.length} failure(s))`);
    await closeDb().catch(() => {});
    process.exit(pf.ok ? 0 : 1);
  }
  if (!pf.ok) {
    console.error(`[boot] preflight failed: ${pf.failures.map((f) => f.name).join(", ")}; refusing to start loops`);
    await closeDb().catch(() => {});
    process.exit(1);
  }

  startHealthServer();
  startAttestor();
  startGate();
  startWatcher();
  startReconciler();
  startCanary();
  startArmedOrderHealthProbe();

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (err) => console.error(`[boot] unhandledRejection: ${err?.message || err}`));
  console.log("[boot] all loops started");
}

main().catch(async (err) => {
  console.error(`[boot] fatal: ${err.stack || err.message}`);
  await closeDb().catch(() => {});
  process.exit(1);
});
