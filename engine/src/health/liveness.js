/**
 * Liveness bookkeeping shared by every loop and the health server.
 *
 * heartbeat(loop, status, extra)  -- a loop finished a tick
 * setGauge(name, value)           -- stuck counts, feed staleness per mint, etc.
 * getLiveness()                   -- snapshot for /health
 */
const bootAt = Date.now();
let lastProgressAt = Date.now();
let lastStatus = "boot";
const loops = new Map();
const gauges = new Map();

export function markProgress(status) {
  lastProgressAt = Date.now();
  if (status) lastStatus = status;
}

export function registerLoop(name, { intervalMs }) {
  loops.set(name, { intervalMs, lastTickAt: null, lastOkAt: null, lastStatus: "registered", ticks: 0, errors: 0, lastError: null, extra: {} });
}

export function heartbeat(name, status = "ok", extra = {}) {
  const l = loops.get(name) || { intervalMs: null, ticks: 0, errors: 0, extra: {} };
  l.lastTickAt = Date.now();
  l.ticks += 1;
  l.lastStatus = status;
  if (status === "ok") l.lastOkAt = l.lastTickAt;
  if (status === "error") { l.errors += 1; l.lastError = extra.error || null; }
  l.extra = { ...l.extra, ...extra };
  loops.set(name, l);
  markProgress(`${name}:${status}`);
}

export function setGauge(name, value) {
  gauges.set(name, value);
}

export function getLiveness() {
  const now = Date.now();
  const loopView = {};
  for (const [name, l] of loops) {
    const ageMs = l.lastTickAt ? now - l.lastTickAt : null;
    const stalled = l.intervalMs && l.lastTickAt ? ageMs > Math.max(l.intervalMs * 4, 60_000) : l.lastTickAt == null && now - bootAt > 120_000;
    loopView[name] = { ...l, lastTickAgeMs: ageMs, stalled };
  }
  return {
    bootAt,
    uptimeMs: now - bootAt,
    lastProgressAt,
    lastProgressAgeMs: now - lastProgressAt,
    lastStatus,
    loops: loopView,
    gauges: Object.fromEntries(gauges),
  };
}
