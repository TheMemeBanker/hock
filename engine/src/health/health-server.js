/**
 * /health endpoint + stall detector.
 *
 * Body: { ok, service, instance, cluster, programId, loops{name:{lastTickAgeMs,
 * stalled,...}}, gauges{stuck_orders, firing_orders, feed_age_seconds:{mint:age},
 * outbox_backlog, rpc_primary_degraded, db}, stalled }.
 *
 * A loop that misses 4 intervals marks the service degraded (503). If NO loop
 * has made progress for STALL_MS the process exits 1 so the supervisor restarts
 * it; the fail-closed claim pattern means no order double-fires on restart.
 */
import http from "node:http";
import { getLiveness } from "./liveness.js";
import { notifyAdmin } from "../notify/admin.js";
import { getPrimaryHealth } from "../rpc/connection.js";
import { dbPing } from "../db/pool.js";

const STALL_MS = Number(process.env.ENGINE_STALL_MS) || 300_000;
const PORT = Number(process.env.HEALTH_PORT) || 3001;

let server = null;
let watchdog = null;

async function buildStatus() {
  const live = getLiveness();
  const stalled = live.uptimeMs >= STALL_MS && live.lastProgressAgeMs > STALL_MS;
  const anyLoopStalled = Object.values(live.loops).some((l) => l.stalled);
  const db = await dbPing().catch((e) => ({ ok: false, error: e.message }));
  return {
    ok: !stalled && !anyLoopStalled && db.ok,
    service: "hock-engine",
    instance: process.env.ENGINE_INSTANCE_ID || "engine",
    cluster: process.env.HOCK_CLUSTER || "unknown",
    programId: process.env.PROGRAM_ID || null,
    stalled,
    stallThresholdMs: STALL_MS,
    rpc: getPrimaryHealth(),
    db: { ok: db.ok, latencyMs: db.latencyMs, error: db.error || null },
    ...live,
  };
}

export function startHealthServer() {
  server = http.createServer(async (req, res) => {
    const path = (req.url || "").split("?")[0];
    if (path === "/health" || path === "/healthz" || path === "/") {
      const status = await buildStatus();
      res.writeHead(status.ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  server.on("error", (err) => {
    console.error(`[health] server error (continuing without it): ${err.message}`);
  });
  server.listen(PORT, () => {
    console.log(`[health] /health on :${PORT}; stall threshold ${Math.round(STALL_MS / 1000)}s`);
  });

  watchdog = setInterval(async () => {
    const live = getLiveness();
    const stalled = live.uptimeMs >= STALL_MS && live.lastProgressAgeMs > STALL_MS;
    if (!stalled) return;
    console.error(`[health] STALL: no loop progress for ${Math.round(live.lastProgressAgeMs / 1000)}s; exiting 1 for supervisor restart`);
    await notifyAdmin({
      kind: "engine_stall_restart",
      payload: {
        stalled_for_seconds: Math.round(live.lastProgressAgeMs / 1000),
        last_status: live.lastStatus,
        remedy: "Engine stopped making progress and restarted itself. Check RPC and DB health and the last log lines.",
      },
      throttleMs: 0,
    }).catch(() => {});
    setTimeout(() => process.exit(1), 300);
  }, 30_000);
  watchdog.unref?.();
  return server;
}

export function stopHealthServer() {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (server) { try { server.close(); } catch {} server = null; }
}
