import { createClient, type Client, type ResultSet } from "@libsql/client";

let _c: Client | null = null;

// Локально — file:./data/app.db, в облаке — Turso (env TURSO_DATABASE_URL + TURSO_AUTH_TOKEN).
export function getDb(): Client {
  if (_c) return _c;
  const url = process.env.TURSO_DATABASE_URL || "file:./data/app.db";
  _c = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  return _c;
}

// libSQL Row → обычный объект (для JSON-ответов).
export function rowsToObjects(rs: ResultSet): Record<string, unknown>[] {
  return rs.rows.map((row) => {
    const o: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => (o[c] = row[i]));
    return o;
  });
}
