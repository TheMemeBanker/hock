import { NextResponse } from "next/server";
import { Pool } from "pg";
import { pgSsl } from "@/lib/data/pg-ssl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let pool: Pool | null = null;
function db() {
  const url = process.env.DATABASE_URL_READONLY || process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) pool = new Pool({ connectionString: url, max: 2, ssl: pgSsl(url) });
  return pool;
}

/** Serves a stored upload (test clusters). Immutable: ids are content hashes. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f]{32}$/.test(id)) return new NextResponse("not found", { status: 404 });
  const p = db();
  if (!p) return new NextResponse("storage unavailable", { status: 503 });
  const { rows } = await p.query(`SELECT content_type, bytes FROM uploads WHERE id = $1`, [id]);
  if (!rows[0]) return new NextResponse("not found", { status: 404 });
  return new NextResponse(new Uint8Array(rows[0].bytes), { headers: { "content-type": rows[0].content_type, "cache-control": "public, max-age=31536000, immutable" } });
}
