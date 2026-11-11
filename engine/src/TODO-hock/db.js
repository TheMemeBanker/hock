// TODO-hock: Postgres pool. The source repos had their own pool modules which
// were deliberately not lifted. This is the minimal pg-backed shape every
// lifted module expects: query(text, params), getClient(), pool.
import pg from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set (TODO-hock/db.js)");
}
export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const query = (text, params) => pool.query(text, params);
export const getClient = () => pool.connect();
