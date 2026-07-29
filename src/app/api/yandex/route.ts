import { NextRequest, NextResponse } from "next/server";
import { getDb, rowsToObjects } from "@/lib/db";
import { getPeriodRate } from "@/lib/fx.mjs";

export const dynamic = "force-dynamic";

// yandex_daily теперь хранит всю доступную историю — по умолчанию отдаём последние
// N дней, чтобы график не пытался отрисовать сотни точек разом (?days=all — вся история).
const DEFAULT_CHART_DAYS = 90;

export async function GET(req: NextRequest) {
  try {
    const daysParam = req.nextUrl.searchParams.get("days");
    const db = getDb();
    const snapRs = await db.execute("SELECT * FROM yandex_snapshots ORDER BY id DESC LIMIT 1");
    const snapshot = rowsToObjects(snapRs)[0];
    if (!snapshot) {
      return NextResponse.json({ error: "Нет данных Яндекс.Директа. Запустите npm run sync:yandex." }, { status: 404 });
    }
    const snapId = snapshot.id as number;
    const dailySql = daysParam === "all"
      ? "SELECT * FROM yandex_daily WHERE snapshot_id=? ORDER BY date ASC"
      : `SELECT * FROM yandex_daily WHERE snapshot_id=? ORDER BY date DESC LIMIT ${Math.max(1, Number(daysParam) || DEFAULT_CHART_DAYS)}`;
    const [dailyRs, campaigns] = await Promise.all([
      db.execute({ sql: dailySql, args: [snapId] }),
      db.execute({ sql: "SELECT * FROM yandex_campaigns WHERE snapshot_id=? ORDER BY spend DESC", args: [snapId] }),
    ]);
    const daily = rowsToObjects(dailyRs);
    if (daysParam !== "all") daily.reverse();
    // Курс ₸ → $ : среднемесячные курсы НБ РК, взвешенные по дням периода.
    const fx = await getPeriodRate(String(snapshot.period_start), String(snapshot.period_end));
    return NextResponse.json({
      snapshot, rate: fx.rate, fxMonths: fx.months, fxFallback: fx.fallback,
      daily, campaigns: rowsToObjects(campaigns),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
