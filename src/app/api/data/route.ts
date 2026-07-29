import { NextRequest, NextResponse } from "next/server";
import { getDb, rowsToObjects } from "@/lib/db";

export const dynamic = "force-dynamic";

// daily_insights теперь хранит всю доступную историю (до ~37 месяцев), а не только
// период снапшота — график по умолчанию показывает последние N дней, чтобы не пытаться
// отрисовать сотни точек разом. Полная история доступна через ?days=all.
const DEFAULT_CHART_DAYS = 90;

export async function GET(req: NextRequest) {
  try {
    const daysParam = req.nextUrl.searchParams.get("days");
    const db = getDb();
    const snapRs = await db.execute("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1");
    const snapshot = rowsToObjects(snapRs)[0];
    if (!snapshot) {
      return NextResponse.json({ error: "Нет снапшотов. Нажмите «Обновить» или запустите npm run sync." }, { status: 404 });
    }
    const snapId = snapshot.id as number;

    const dailySql = daysParam === "all"
      ? "SELECT * FROM daily_insights WHERE snapshot_id=? ORDER BY date ASC"
      : `SELECT * FROM daily_insights WHERE snapshot_id=? ORDER BY date DESC LIMIT ${Math.max(1, Number(daysParam) || DEFAULT_CHART_DAYS)}`;

    const [dailyRs, campaigns, adsets, ads, summaryRs] = await Promise.all([
      db.execute({ sql: dailySql, args: [snapId] }),
      db.execute({ sql: "SELECT * FROM campaign_insights WHERE snapshot_id=? ORDER BY spend DESC", args: [snapId] }),
      db.execute({ sql: "SELECT * FROM adset_insights WHERE snapshot_id=? ORDER BY spend DESC", args: [snapId] }),
      db.execute({ sql: "SELECT * FROM ad_insights WHERE snapshot_id=? ORDER BY spend DESC", args: [snapId] }),
      db.execute({ sql: "SELECT body, author, created_at FROM summaries WHERE snapshot_id=?", args: [snapId] }),
    ]);

    let summary = null;
    const sRow = rowsToObjects(summaryRs)[0];
    if (sRow) {
      let data: unknown = null;
      try { data = JSON.parse(sRow.body as string); } catch { data = null; }
      summary = { ...sRow, data };
    }

    // При выборке "последние N" строки идут по убыванию даты — разворачиваем в хронологический порядок.
    const daily = rowsToObjects(dailyRs);
    if (daysParam !== "all") daily.reverse();

    return NextResponse.json({
      snapshot,
      daily,
      campaigns: rowsToObjects(campaigns),
      adsets: rowsToObjects(adsets),
      ads: rowsToObjects(ads),
      summary,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
