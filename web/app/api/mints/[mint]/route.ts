import { NextResponse } from "next/server";
import { getCoin } from "@/lib/data/reads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/mints/<mint>: name, symbol, decimals and gate verdict for one mint (DB read). */
export async function GET(_req: Request, ctx: { params: Promise<{ mint: string }> }) {
  const { mint } = await ctx.params;
  const c = await getCoin(mint);
  if (!c) return NextResponse.json({ error: "unknown mint" }, { status: 404 });
  return NextResponse.json({ mint: c.mint, name: c.name, symbol: c.symbol, decimals: c.decimals, tokenProgram: c.tokenProgram, verdict: c.verdict }, { headers: { "cache-control": "public, max-age=30" } });
}
