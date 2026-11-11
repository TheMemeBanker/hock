/** Display helpers. Every function renders a dash for missing input rather than a guess. */
export const DASH = "—";

export function fmtLamports(v: bigint | string | number | null | undefined, dp = 4): string {
  if (v === null || v === undefined || v === "") return DASH;
  const n = Number(typeof v === "bigint" ? v : BigInt(String(v))) / 1e9;
  if (!Number.isFinite(n)) return DASH;
  return `${n.toLocaleString("en-US", { maximumFractionDigits: dp, minimumFractionDigits: Math.min(2, dp) })} SOL`;
}

/** Price in lamports per whole token, shown in SOL with magnitude-aware precision. */
export function fmtPriceLamports(v: bigint | null | undefined): string {
  if (v === null || v === undefined) return DASH;
  const n = Number(v) / 1e9;
  if (!Number.isFinite(n)) return DASH;
  if (n === 0) return "0 SOL";
  const dp = n >= 1 ? 4 : n >= 0.001 ? 6 : n >= 1e-6 ? 9 : 12;
  return `${n.toFixed(dp)} SOL`;
}

export function fmtTokenAmount(raw: bigint | string | null | undefined, decimals: number, symbol?: string): string {
  if (raw === null || raw === undefined) return DASH;
  const b = typeof raw === "bigint" ? raw : BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = b / base;
  const frac = b % base;
  const fracStr = decimals > 0 ? (frac.toString().padStart(decimals, "0").slice(0, Math.min(decimals, 4)).replace(/0+$/, "")) : "";
  const s = `${whole.toLocaleString("en-US")}${fracStr ? "." + fracStr : ""}`;
  return symbol ? `${s} ${symbol}` : s;
}

export function fmtPct(bps: number | null | undefined): string {
  if (bps === null || bps === undefined) return DASH;
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, "")}%`;
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return DASH;
  return new Date(ts * 1000).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function fmtAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return DASH;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d`;
}

/** Parse a decimal string into raw units; null on anything unusable. */
export function parseUnits(s: string, decimals: number): bigint | null {
  const t = s.trim();
  if (!/^\d*(\.\d*)?$/.test(t) || t === "" || t === ".") return null;
  const [w, f = ""] = t.split(".");
  if (f.length > decimals) return null;
  return BigInt(w || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}
