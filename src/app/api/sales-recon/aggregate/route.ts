import { NextRequest, NextResponse } from "next/server";
import { getDb, rowsToObjects } from "@/lib/db";
import {
  buildReconciliation, buildAdsByZhk,
  type LeadRow, type ContractRow, type AdLeadRow, type GroupKey,
} from "@/lib/salesRecon";

// Считает сверку (матчинг + разрезка по каналу + воронка по ЖК + когортный анализ)
// на сервере по ВСЕМ строкам за период — без ограничения в 80 000 строк, которое
// действует на "сырой" GET /api/sales-recon (тот лимит существует специально
// потому что сырые строки едут в браузер; здесь наружу уходит только агрегат —
// несколько десятков/сотен строк, а не сотни тысяч).
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Kind = "lead" | "contract" | "adlead";

async function fetchAllRows(kind: Kind, since: string, until: string): Promise<Record<string, unknown>[]> {
  const db = getDb();
  const where = ["kind=?"];
  const args: (string | number)[] = [kind];
  if (since) { where.push("date_iso >= ?"); args.push(since); }
  if (until) { where.push("date_iso <= ?"); args.push(until); }
  const sql = `SELECT id, data FROM sales_recon_rows WHERE ${where.join(" AND ")} AND id > ? ORDER BY id LIMIT 20000`;
  const out: Record<string, unknown>[] = [];
  let lastId = 0;
  for (;;) {
    const rs = await db.execute({ sql, args: [...args, lastId] });
    const page = rowsToObjects(rs);
    if (!page.length) break;
    for (const r of page) out.push(JSON.parse(String(r.data)));
    lastId = Number(page[page.length - 1].id);
    if (page.length < 20000) break;
  }
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const since = req.nextUrl.searchParams.get("since") || "";
    const until = req.nextUrl.searchParams.get("until") || "";
    const groupBy = (req.nextUrl.searchParams.get("groupBy") || "source") as GroupKey;
    const apartmentsOnly = req.nextUrl.searchParams.get("apartmentsOnly") !== "0";

    const db = getDb();
    await db.execute(`CREATE TABLE IF NOT EXISTS sales_recon_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, dedup_key TEXT NOT NULL,
      phone TEXT, date_iso TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(kind, dedup_key)
    )`);

    const [leadsRaw, contractsRaw, adLeadsRaw] = await Promise.all([
      fetchAllRows("lead", since, until),
      fetchAllRows("contract", since, until),
      fetchAllRows("adlead", since, until),
    ]);
    if (!leadsRaw.length || !contractsRaw.length) {
      return NextResponse.json({ error: "За этот период в базе нет данных — сначала сохраните выгрузки кнопкой «Сохранить в базу», либо расширьте период" }, { status: 404 });
    }
    const leads = leadsRaw as unknown as LeadRow[];
    const allContracts = contractsRaw as unknown as ContractRow[];
    const adLeads = (adLeadsRaw as unknown as AdLeadRow[]).length ? (adLeadsRaw as unknown as AdLeadRow[]) : null;
    const contracts = apartmentsOnly
      ? allContracts.filter((c) => !c.propType || /кварт/i.test(c.propType))
      : allContracts;

    // Охват/клики по ЖК — из уже синхронизированных рекламных кабинетов (тот же
    // источник, что и на клиенте), запрашиваем собственные API того же деплоя.
    const origin = req.nextUrl.origin;
    const [meta, google, tiktok, yandex] = await Promise.all([
      fetch(`${origin}/api/data`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${origin}/api/google`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${origin}/api/tiktok`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${origin}/api/yandex`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    const adsByZhk = buildAdsByZhk(meta, google, tiktok, yandex);

    const result = buildReconciliation(leads, contracts, adLeads, adsByZhk, groupBy);
    return NextResponse.json({
      ...result,
      meta: {
        since, until, groupBy, apartmentsOnly,
        leadsRowsInPeriod: leadsRaw.length, contractsInPeriod: contractsRaw.length, adLeadsInPeriod: adLeadsRaw.length,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
