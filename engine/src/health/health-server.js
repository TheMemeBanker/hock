/**
 * HTTP health endpoint + in-process stall watchdog.
 *
 * GET /health (also / and /healthz) → 200 {ok:true,...} while the watcher is
 * ticking, 503 {ok:false,...} once it has stalled past the threshold. Lets
 * the host (set the service healthcheck path to /health) or any external
 * monitor probe the engine DIRECTLY and restart a wedged loop — independent
 * of the DB heartbeat the bot reads.
 *
 * The same staleness check runs on an internal timer: if the loop has made no
 * progress for STALL_MS, the engine logs, best-effort DMs the operator, and
 * exit(1)s for a clean host restart. Safe because the fire path writes a
 * fail-closed breadcrumb before broadcast, so a restart can never double-fire
 * an order (see project_limitclose_engine_fire_reliability).
 */
import http from "node:http";
import { getLiveness } from "./liveness.js";
import { enqueueNotification } from "../TODO-hock/notifications.js";

const POLL_MS = Number(process.env.LIMIT_CLOSE_POLL_MS) || 30_000;
// Generous: 6× the poll interval, floored at 3 min, so a handful of slow ticks
// (thin Jupiter routes, RPC retries) never trip a needless restart.
const STALL_MS =
  Number(process.env.LIMIT_CLOSE_STALL_MS) || Math.max(POLL_MS * 6, 180_000);
const PORT =
  Number(process.env.PORT) || Number(process.env.HEALTH_PORT) || 8080;

let server = null;
let watchdog = null;

function buildStatus() {
  const live = getLiveness();
  // Boot grace: never report stalled (or restart) until the engine has been
  // up at least one full stall window, so a slow first tick can't trip it.
  const stalled = live.uptimeMs >= STALL_MS && live.lastProgressAgeMs > STALL_MS;
  return {
    ok: !stalled,
    service: "limit-close-engine",
    stalled,
    stallThresholdMs: STALL_MS,
    ...live,
  };
}

export function startHealthServer() {
  server = http.createServer((req, res) => {
    const path = (req.url || "").split("?")[0];
    if (path === "/health" || path === "/healthz" || path === "/") {
      const status = buildStatus();
      res.writeHead(status.ok ? 200 : 503, { "Content-Type": "application/json" });
      res.end(JSON.stringify(status));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  // A bound-port failure must NOT crash the engine — health is auxiliary.
  server.on("error", (err) => {
    console.error(
      `[limit-close-engine] health server error (continuing without it): ${err.message}`,
    );
  });
  server.listen(PORT, () => {
    console.log(
      `[limit-close-engine] health endpoint on :${PORT} (/health); stall threshold ${Math.round(
        STALL_MS / 1000,
      )}s`,
    );
  });

  // In-process stall watchdog — self-heal a wedged loop.
  watchdog = setInterval(() => {
    const status = buildStatus();
    if (!status.stalled) return;
    console.error(
      `[limit-close-engine] STALL: no tick progress for ${Math.round(
        status.lastProgressAgeMs / 1000,
      )}s (threshold ${Math.round(STALL_MS / 1000)}s, last status '${status.lastStatus}') — restarting (exit 1).`,
    );
    const operatorUserId = Number(process.env.OPERATOR_USER_ID);
    if (Number.isFinite(operatorUserId) && operatorUserId > 0) {
      // Fire-and-forget; the timed exit below never waits on the DB write
      // (which may itself be the hung dependency).
      enqueueNotification({
        userId: operatorUserId,
        kind: "engine_stall_restart",
        payload: {
          service: "limit-close-engine",
          stalled_for_seconds: Math.round(status.lastProgressAgeMs / 1000),
          stall_threshold_seconds: Math.round(STALL_MS / 1000),
          last_status: status.lastStatus,
          detected_at: new Date().toISOString(),
          remedy:
            "The fire loop stopped making progress and was auto-restarted. Check RPC/DB health and recent logs; the fail-closed breadcrumb means no order double-fired.",
        },
      }).catch(() => {});
    }
    setTimeout(() => process.exit(1), 300);
  }, Math.max(POLL_MS, 30_000));
  watchdog.unref?.();
}

export function stopHealthServer() {
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = null;
  }
  if (server) {
    try {
      server.close();
    } catch {
      /* already closing */
    }
    server = null;
  }
}
