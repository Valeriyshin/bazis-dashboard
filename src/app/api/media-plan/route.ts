import { NextRequest, NextResponse } from "next/server";
import { getDb, rowsToObjects, ensureReconSchema } from "@/lib/db";
import { buildMediaPlan, type LeadRow } from "@/lib/salesRecon";

// Медиаплан: CPL/качество лидов по (ЖК × площадка) за период + рекомендация по бюджету.
// Расход берём из уже синкающихся кабинетов (последний сохранённый снапшот каждой
// площадки — своей истории по месяцам у кампаний пока нет, поэтому бюджет считается
// за ТЕКУЩИЙ синкнутый период площадки, а не жёстко за since/until; используйте
// "↻ Обновить" с периодом = прошлый месяц перед тем, как открывать эту вкладку).
// Лиды — из накопленной в Turso истории (sales_recon_rows), фильтр по since/until точный.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

async function fetchLeads(since: string, until: string): Promise<LeadRow[]> {
  const db = getDb();
  const where = ["kind='lead'"];
  const args: (string | number)[] = [];
  if (since) { where.push("date_iso >= ?"); args.push(since); }
  if (until) { where.push("date_iso <= ?"); args.push(until); }
  const sql = `SELECT id, data FROM sales_recon_rows WHERE ${where.join(" AND ")} AND id > ? ORDER BY id LIMIT 20000`;
  const out: LeadRow[] = [];
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

    await ensureReconSchema();

    const [leads, meta, google, tiktok, yandex] = await Promise.all([
      fetchLeads(since, until),
      fetch(`${req.nextUrl.origin}/api/data`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${req.nextUrl.origin}/api/google`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${req.nextUrl.origin}/api/tiktok`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch(`${req.nextUrl.origin}/api/yandex`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);

    if (!leads.length) {
      return NextResponse.json({ error: "За этот период в базе нет лидов — сначала сохраните выгрузку кнопкой «Сохранить в базу» на вкладке «Сверка продаж», либо расширьте период" }, { status: 404 });
    }

    const campaignsByPlatform: Record<string, { name: string; spend: number }[]> = {
      "Meta": (meta?.campaigns ?? []).map((c: { name: string; spend: number }) => ({ name: c.name, spend: +c.spend || 0 })),
      "Google Ads": (google?.campaigns ?? []).map((c: { name: string; spend: number }) => ({ name: c.name, spend: +c.spend || 0 })),
      "Yandex Direct": (yandex?.campaigns ?? []).map((c: { name: string; spend: number }) => ({ name: c.name, spend: +c.spend || 0 })),
      "TikTok": (tiktok?.campaigns ?? []).map((c: { name: string; spend: number }) => ({ name: c.name, spend: +c.spend || 0 })),
    };

    const rows = buildMediaPlan(leads, campaignsByPlatform);

    const platformPeriods = {
      "Meta": meta?.snapshot ? { start: meta.snapshot.period_start, end: meta.snapshot.period_end } : null,
      "Google Ads": google?.snapshot ? { start: google.snapshot.period_start, end: google.snapshot.period_end } : null,
      "Yandex Direct": yandex?.snapshot ? { start: yandex.snapshot.period_start, end: yandex.snapshot.period_end } : null,
      "TikTok": tiktok?.snapshot ? { start: tiktok.snapshot.period_start, end: tiktok.snapshot.period_end } : null,
    };

    return NextResponse.json({ rows, platformPeriods, leadsPeriod: { since, until }, leadsCount: leads.length });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
