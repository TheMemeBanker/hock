/**
 * RPC proxy. The browser talks to /api/rpc; this route forwards to the
 * configured upstream so provider keys never reach the client. The logic
 * (method allowlist, origin check, backup failover, body limits) lives in
 * lib/api/rpc-proxy.ts.
 */
export { POST, GET, OPTIONS } from "@/lib/api/rpc-proxy";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
