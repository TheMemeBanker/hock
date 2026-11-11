/**
 * In-process liveness signal for the engine.
 *
 * The watcher calls markProgress() once per poll tick — specifically at the
 * per-tick heartbeat write, a point a tick only reaches after its shared
 * dependencies (DB, RPC, Jupiter probe) have responded. The health server
 * reports the age of the last mark, and an in-process stall watchdog
 * (health-server.js) self-restarts the process if that age crosses the
 * threshold.
 *
 * Why in-process and not just the DB heartbeat: the engine_heartbeats row
 * tells the BOT the engine is dead, but it cannot make the engine restart
 * ITSELF. This module + the watchdog close that gap so a wedged loop heals
 * without waiting for a human. Marking at the heartbeat point (not at tick
 * START) matters because the watcher schedules ticks with an overlapping
 * setInterval — a new tick begins every POLL_MS regardless of whether the
 * prior one finished, so "a tick started" would stay fresh even while every
 * tick hangs. "A tick reached the heartbeat" only stays fresh when the loop
 * is genuinely making progress.
 */
let lastProgressAt = Date.now();
let lastStatus = "boot";
const bootAt = Date.now();

/** Called once per healthy tick. `status` mirrors the DB heartbeat status. */
export function markProgress(status) {
  lastProgressAt = Date.now();
  if (status) lastStatus = status;
}

/** Snapshot of liveness for the health endpoint + stall watchdog. */
export function getLiveness() {
  const now = Date.now();
  return {
    bootAt,
    uptimeMs: now - bootAt,
    lastProgressAt,
    lastProgressAgeMs: now - lastProgressAt,
    lastStatus,
  };
}
