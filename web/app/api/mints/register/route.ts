import { NextResponse } from "next/server";
import { Pool } from "pg";
import { pgSsl } from "@/lib/data/pg-ssl";
import { Connection, PublicKey } from "@solana/web3.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let pool: Pool | null = null;
function db() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) pool = new Pool({ connectionString: url, max: 2, ssl: pgSsl(url) });
  return pool;
}

/**
 * Registers a freshly launched mint with the gate. The client's claim is not
 * trusted: we verify on chain that the signature exists, succeeded, and that
 * the mint account exists before writing. Nothing here grants collateral
 * status; the engine's gate does that on its own evidence.
 */
export async function POST(req: Request) {
  const p = db();
  if (!p) return NextResponse.json({ ok: false, error: "registry unavailable" }, { status: 503 });
  let body: { mint?: string; name?: string; symbol?: string; sig?: string; launcher?: string; metadataUri?: string | null };
  try { body = await req.json(); } catch { return NextResponse.json({ ok: false, error: "bad json" }, { status: 400 }); }
  const { mint, name, symbol, sig, launcher, metadataUri } = body;
  if (!mint || !name || !symbol || !sig || !launcher) return NextResponse.json({ ok: false, error: "missing fields" }, { status: 400 });
  if (!/^[A-Za-z0-9]{1,10}$/.test(symbol) || name.length > 32) return NextResponse.json({ ok: false, error: "bad name or symbol" }, { status: 400 });

  let mintPk: PublicKey;
  try { mintPk = new PublicKey(mint); new PublicKey(launcher); } catch { return NextResponse.json({ ok: false, error: "bad address" }, { status: 400 }); }

  const rpc = process.env.RPC_PROXY_UPSTREAM || process.env.SOLANA_RPC_URL;
  if (!rpc) return NextResponse.json({ ok: false, error: "rpc unavailable" }, { status: 503 });
  const conn = new Connection(rpc, "confirmed");
  const [tx, acct] = await Promise.all([
    conn.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }).catch(() => null),
    conn.getParsedAccountInfo(mintPk, "confirmed").catch(() => null),
  ]);
  if (!tx || tx.meta?.err) return NextResponse.json({ ok: false, error: "transaction not confirmed" }, { status: 409 });
  const info = acct?.value;
  const parsed = info && "parsed" in (info.data as object) ? (info.data as { parsed: { type: string; info: { decimals: number } } }).parsed : null;
  if (!info || !parsed || parsed.type !== "mint") return NextResponse.json({ ok: false, error: "mint not found" }, { status: 409 });
  const keys = tx.transaction.message.getAccountKeys().staticAccountKeys.map((k) => k.toBase58());
  if (!keys.includes(mint) || !keys.includes(launcher)) return NextResponse.json({ ok: false, error: "signature does not involve this mint and launcher" }, { status: 409 });

  // Image URL from the metadata JSON (our test-cluster relay or Arweave), best effort with a short timeout.
  let imageUrl: string | null = null;
  if (metadataUri && /^https?:\/\//.test(metadataUri)) {
    try {
      const r = await fetch(metadataUri, { signal: AbortSignal.timeout(4000), headers: { accept: "application/json" } });
      const j = r.ok ? ((await r.json()) as { image?: unknown }) : null;
      if (j && typeof j.image === "string" && /^https?:\/\//.test(j.image) && j.image.length < 500) {
        imageUrl = j.image;
        // Our own test-cluster relay: store a same-origin path so it renders whichever host name the site is reached by.
        try { const u = new URL(j.image); if (u.pathname.startsWith("/api/upload/")) imageUrl = u.pathname; } catch { /* keep absolute */ }
      }
    } catch { /* leave null */ }
  }
  await p.query(
    `INSERT INTO mints (mint, symbol, name, decimals, token_program, metadata_uri, image_url, launched_here, launch_sig, launcher)
     VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8,$9)
     ON CONFLICT (mint) DO UPDATE SET launched_here = true, launch_sig = EXCLUDED.launch_sig, launcher = EXCLUDED.launcher,
       metadata_uri = COALESCE(EXCLUDED.metadata_uri, mints.metadata_uri), image_url = COALESCE(EXCLUDED.image_url, mints.image_url)`,
    [mint, symbol.toUpperCase(), name, parsed.info.decimals, info.owner.toBase58(), metadataUri ?? null, imageUrl, sig, launcher],
  );
  await p.query(`INSERT INTO gate_state (mint, verdict) VALUES ($1, 'launched') ON CONFLICT (mint) DO NOTHING`, [mint]);
  return NextResponse.json({ ok: true });
}
