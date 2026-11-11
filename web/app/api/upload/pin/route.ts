import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { pgSsl } from "@/lib/data/pg-ssl";
import { CLUSTER } from "@/lib/solana/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let pool: Pool | null = null;
function db() {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) pool = new Pool({ connectionString: url, max: 2, ssl: pgSsl(url) });
  return pool;
}
const MAX_IMAGE = 4 * 1024 * 1024;
const TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/**
 * Test-cluster storage relay. Same contract as the Cloudflare pin worker the
 * mainnet flow can use (multipart: file + metadata fields -> { metadataUri }),
 * but the bytes live in Postgres and are served by /api/upload/<id>. Refused on
 * mainnet-beta: there, art and metadata go to Arweave, never to our server.
 */
export async function POST(req: Request) {
  if (CLUSTER === "mainnet-beta") return NextResponse.json({ ok: false, error: "server storage is for test clusters only" }, { status: 403 });
  const p = db();
  if (!p) return NextResponse.json({ ok: false, error: "storage unavailable" }, { status: 503 });
  let fd: FormData;
  try { fd = await req.formData(); } catch { return NextResponse.json({ ok: false, error: "multipart body expected" }, { status: 400 }); }
  const file = fd.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "file missing" }, { status: 400 });
  if (!TYPES.has(file.type) || file.size > MAX_IMAGE) return NextResponse.json({ ok: false, error: "png, jpg, gif or webp up to 4 MB" }, { status: 400 });
  const str = (k: string) => String(fd.get(k) ?? "").slice(0, 500);
  const name = str("name"), symbol = str("symbol");
  if (!name || !symbol) return NextResponse.json({ ok: false, error: "name and symbol required" }, { status: 400 });

  // Build URLs from the host the browser actually used (behind a proxy, the forwarded headers), so the same-origin policy and CSP see our own origin.
  const h = req.headers;
  const host = h.get("x-forwarded-host") || h.get("host") || new URL(req.url).host;
  const proto = h.get("x-forwarded-proto") || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  const origin = `${proto}://${host}`;
  const img = Buffer.from(await file.arrayBuffer());
  const imgId = createHash("sha256").update(img).digest("hex").slice(0, 32);
  await p.query(`INSERT INTO uploads (id, content_type, bytes, size, launcher) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`, [imgId, file.type, img, img.length, str("launcher") || null]);
  const imageUri = `${origin}/api/upload/${imgId}`;
  const json: Record<string, unknown> = { name, symbol, description: str("description"), image: imageUri, showName: true, createdOn: `${origin}` };
  for (const k of ["twitter", "telegram", "website"]) if (str(k)) json[k] = str(k);
  const meta = Buffer.from(JSON.stringify(json));
  const metaId = createHash("sha256").update(meta).digest("hex").slice(0, 32);
  await p.query(`INSERT INTO uploads (id, content_type, bytes, size, launcher) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`, [metaId, "application/json", meta, meta.length, str("launcher") || null]);
  return NextResponse.json({ ok: true, metadataUri: `${origin}/api/upload/${metaId}`, imageUri });
}
