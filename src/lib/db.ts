import { createClient, type Client, type ResultSet } from "@libsql/client";

let _c: Client | null = null;

// Локально — file:./data/app.db, в облаке — Turso (env TURSO_DATABASE_URL + TURSO_AUTH_TOKEN).
export function getDb(): Client {
  if (_c) return _c;
  const url = process.env.TURSO_DATABASE_URL || "file:./data/app.db";
  _c = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  return _c;
}

// Схема накопленных выгрузок CRM (лиды/договоры/рекламные лиды) + индексы под неё.
// Раньше DDL дублировался в трёх роутах, а индексов не было вообще: запросы вида
// "kind=? AND date_iso BETWEEN ? AND ?" могли использовать только автоиндекс
// UNIQUE(kind, dedup_key), то есть отбирали нужный kind и дальше сканировали все
// его строки (на 565 тыс. лидов — COUNT за квартал занимал ~8.7 с).
// Два индекса, потому что у запросов разные потребности, и SQLite выбирает сам:
//   (kind, date_iso) — COUNT/диапазоны по периоду (8.7 с → 0.11 с);
//   (kind, id)       — постраничная выборка по курсору id, без сортировки
//                      во временном B-дереве (её как раз добавлял индекс с date_iso).
const RECON_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sales_recon_rows (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    dedup_key TEXT NOT NULL,
    phone TEXT,
    date_iso TEXT,
    data TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(kind, dedup_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_recon_kind_date_id ON sales_recon_rows(kind, date_iso, id)`,
  `CREATE INDEX IF NOT EXISTS idx_recon_kind_id ON sales_recon_rows(kind, id)`,
];

// Создаётся один раз на процесс: DDL идемпотентный, но гонять его на каждый запрос
// — лишние round-trip'ы к Turso (а это сеть, не локальный файл).
let reconReady: Promise<void> | null = null;
export function ensureReconSchema(): Promise<void> {
  return (reconReady ??= (async () => {
    const db = getDb();
    for (const sql of RECON_SCHEMA) await db.execute(sql);
  })().catch((e) => { reconReady = null; throw e; }));
}

// libSQL Row → обычный объект (для JSON-ответов).
export function rowsToObjects(rs: ResultSet): Record<string, unknown>[] {
  return rs.rows.map((row) => {
    const o: Record<string, unknown> = {};
    rs.columns.forEach((c, i) => (o[c] = row[i]));
    return o;
  });
}
