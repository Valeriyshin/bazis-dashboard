import { NextResponse } from "next/server";
import { getDb, rowsToObjects } from "@/lib/db";
import { getPeriodRate } from "@/lib/fx.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const snapRs = await db.execute("SELECT * FROM yandex_snapshots ORDER BY id DESC LIMIT 1");
    const snapshot = rowsToObjects(snapRs)[0];
    if (!snapshot) {
      return NextResponse.json({ error: "Нет данных Яндекс.Директа. Запустите npm run sync:yandex." }, { status: 404 });
    }
    const snapId = snapshot.id as number;
    const [daily, campaigns] = await Promise.all([
      db.execute({ sql: "SELECT * FROM yandex_daily WHERE snapshot_id=? ORDER BY date ASC", args: [snapId] }),
      db.execute({ sql: "SELECT * FROM yandex_campaigns WHERE snapshot_id=? ORDER BY spend DESC", args: [snapId] }),
    ]);
    // Курс ₸ → $ : среднемесячные курсы НБ РК, взвешенные по дням периода.
    const fx = await getPeriodRate(String(snapshot.period_start), String(snapshot.period_end));
    return NextResponse.json({
      snapshot, rate: fx.rate, fxMonths: fx.months, fxFallback: fx.fallback,
      daily: rowsToObjects(daily), campaigns: rowsToObjects(campaigns),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
