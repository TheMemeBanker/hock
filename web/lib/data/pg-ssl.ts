/** SSL setting for a Postgres URL: off for loopback hosts or sslmode=disable, otherwise TLS to the provider (Neon/Supabase). */
export function pgSsl(url: string): false | { rejectUnauthorized: boolean } {
  try {
    const u = new URL(url);
    if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(u.hostname) || u.searchParams.get("sslmode") === "disable") return false;
  } catch {
    /* fall through to TLS */
  }
  return { rejectUnauthorized: false };
}
