import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { getDb, rowsToObjects } from "@/lib/db";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SCHEMA = `CREATE TABLE IF NOT EXISTS sales_recon_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  dedup_key TEXT NOT NULL,
  phone TEXT,
  date_iso TEXT,
  data TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(kind, dedup_key)
)`;

type Kind = "lead" | "contract" | "adlead";

// "05.06.2026" / "05.06.2026 17:58" → "2026-06-05". "08/12/2026 5:15am" (выгрузка
// кабинета, американский формат) → тоже "2026-08-12". Нераспознанное — null.
function toIso(raw: string): string | null {
  const dm = String(raw).match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (dm) return `${dm[3]}-${dm[2].padStart(2, "0")}-${dm[1].padStart(2, "0")}`;
  const am = String(raw).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (am) return `${am[3]}-${am[1].padStart(2, "0")}-${am[2].padStart(2, "0")}`;
  return null;
}
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 24);

// Ключ дедупликации: для договора — номер договора (устойчивый естественный ключ
// CRM), если есть; иначе — хэш содержимого строки. Повторная загрузка того же
// файла (или файла с пересекающимся периодом) не создаёт дублей.
function dedupKey(kind: Kind, row: Record<string, unknown>): string {
  if (kind === "contract") {
    const num = String(row.number ?? "").trim();
    if (num) return "num:" + num;
    return hash(["c", (row.phones as string[] | undefined)?.join(",") ?? "", row.date, row.sum, row.zhk, row.client].join("|"));
  }
  if (kind === "lead") {
    return hash(["l", row.phone, row.date, row.channel, row.source, row.descr].join("|"));
  }
  return hash(["a", row.phone, row.date, row.campaign].join("|"));
}
function phoneOf(kind: Kind, row: Record<string, unknown>): string {
  if (kind === "contract") return ((row.phones as string[] | undefined)?.[0]) ?? "";
  return String(row.phone ?? "");
}

export async function POST(req: NextRequest) {
  try {
    const db = getDb();
    await db.execute(SCHEMA);
    const body = await req.json();
    const kind = body.kind as Kind;
    const rows = body.rows as Record<string, unknown>[];
    if (!["lead", "contract", "adlead"].includes(kind)) return NextResponse.json({ error: "kind must be lead/contract/adlead" }, { status: 400 });
    if (!Array.isArray(rows) || !rows.length) return NextResponse.json({ error: "rows required" }, { status: 400 });

    const now = new Date().toISOString();
    const stmts = rows.map((row) => ({
      sql: "INSERT OR IGNORE INTO sales_recon_rows (kind, dedup_key, phone, date_iso, data, created_at) VALUES (?,?,?,?,?,?)",
      args: [kind, dedupKey(kind, row), phoneOf(kind, row), toIso(String(row.date ?? "")) ?? "", JSON.stringify(row), now],
    }));
    // Батчами по 500 — libSQL плохо переваривает батчи в десятки тысяч операций разом.
    let inserted = 0;
    for (let i = 0; i < stmts.length; i += 500) {
      const chunk = stmts.slice(i, i + 500);
      const results = await db.batch(chunk, "write");
      for (const r of results) inserted += Number(r.rowsAffected ?? 0);
    }
    return NextResponse.json({ ok: true, received: rows.length, inserted, skippedDuplicates: rows.length - inserted });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  try {
    const db = getDb();
    await db.execute(SCHEMA);
    const kinds = (req.nextUrl.searchParams.get("kind") || "lead,contract,adlead").split(",");
    const since = req.nextUrl.searchParams.get("since") || "";
    const until = req.nextUrl.searchParams.get("until") || "";
    const out: Record<string, Record<string, unknown>[]> = {};
    const LIMIT_ROWS = 80000; // ~15-20 МБ JSON на "лиды" — за этим порогом браузер уже падал на файлах того же размера
    for (const kind of kinds) {
      const baseWhere = ["kind=?"];
      const baseArgs: (string | number)[] = [kind];
      if (since) { baseWhere.push("date_iso >= ?"); baseArgs.push(since); }
      if (until) { baseWhere.push("date_iso <= ?"); baseArgs.push(until); }
      const cnt = await db.execute({ sql: `SELECT COUNT(*) AS n FROM sales_recon_rows WHERE ${baseWhere.join(" AND ")}`, args: baseArgs });
      const total = Number(rowsToObjects(cnt)[0]?.n ?? 0);
      if (total > LIMIT_ROWS) {
        return NextResponse.json({
          error: `За выбранный период в базе ${total.toLocaleString("ru-RU")} строк «${kind === "lead" ? "лиды" : kind === "contract" ? "договоры" : "рекламные лиды"}» — это больше, чем браузер может принять и разобрать за один раз (лимит ~${LIMIT_ROWS.toLocaleString("ru-RU")}). Сузьте период (например, до квартала) и сверяйте частями.`,
        }, { status: 413 });
      }
      let sql = `SELECT id, data FROM sales_recon_rows WHERE ${baseWhere.join(" AND ")}`;
      const args = baseArgs;
      // Даже в пределах лимита читаем постранично по id, а не одним SELECT: сама Turso
      // (Hrana-протокол) роняет большой единый ответ с SQLITE_UNKNOWN: Resource exhausted.
      sql += " AND id > ? ORDER BY id LIMIT 20000";
      const rows: Record<string, unknown>[] = [];
      let lastId = 0;
      for (;;) {
        const rs = await db.execute({ sql, args: [...args, lastId] });
        const page = rowsToObjects(rs);
        if (!page.length) break;
        for (const r of page) rows.push(JSON.parse(String(r.data)));
        lastId = Number(page[page.length - 1].id);
        if (page.length < 20000) break;
      }
      out[kind] = rows;
    }
    // Диапазон дат, реально накопленных в базе — чтобы показать пользователю на UI.
    const rangeRs = await db.execute("SELECT kind, MIN(date_iso) AS minD, MAX(date_iso) AS maxD, COUNT(*) AS n FROM sales_recon_rows WHERE date_iso != '' GROUP BY kind");
    const ranges = rowsToObjects(rangeRs);
    return NextResponse.json({ ...out, ranges });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
