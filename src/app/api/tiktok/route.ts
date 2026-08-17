import { NextRequest, NextResponse } from "next/server";
import { getDb, rowsToObjects } from "@/lib/db";

export const dynamic = "force-dynamic";

// tiktok_daily хранит всю доступную историю — по умолчанию отдаём последние N дней,
// чтобы график не пытался отрисовать сотни точек разом (?days=all — вся история).
const DEFAULT_CHART_DAYS = 90;

export async function GET(req: NextRequest) {
  try {
    const daysParam = req.nextUrl.searchParams.get("days");
    // since/until — точный период (например, тот же, что выбран для Meta): каждый
    // синк перезаписывает всю накопленную историю в tiktok_daily под своим snapshot_id
    // (не только своё короткое окно), так что дневные суммы за произвольный период
    // доступны даже если сама выгрузка кампаний давно не обновлялась (например,
    // пока TikTok API недоступен) — используем то, что реально есть в базе.
    const since = req.nextUrl.searchParams.get("since");
    const until = req.nextUrl.searchParams.get("until");
    const db = getDb();
    const snapRs = await db.execute("SELECT * FROM tiktok_snapshots ORDER BY id DESC LIMIT 1");
    const snapshot = rowsToObjects(snapRs)[0];
    if (!snapshot) {
      return NextResponse.json({ error: "Нет данных TikTok. Запустите npm run sync:tiktok." }, { status: 404 });
    }
    const snapId = snapshot.id as number;
    let dailySql: string, dailyArgs: (string | number)[];
    if (since && until) {
      dailySql = "SELECT * FROM tiktok_daily WHERE snapshot_id=? AND date>=? AND date<=? ORDER BY date ASC";
      dailyArgs = [snapId, since, until];
    } else if (daysParam === "all") {
      dailySql = "SELECT * FROM tiktok_daily WHERE snapshot_id=? ORDER BY date ASC";
      dailyArgs = [snapId];
    } else {
      dailySql = `SELECT * FROM tiktok_daily WHERE snapshot_id=? ORDER BY date DESC LIMIT ${Math.max(1, Number(daysParam) || DEFAULT_CHART_DAYS)}`;
      dailyArgs = [snapId];
    }
    const [dailyRs, campaigns] = await Promise.all([
      db.execute({ sql: dailySql, args: dailyArgs }),
      db.execute({ sql: "SELECT * FROM tiktok_campaigns WHERE snapshot_id=? ORDER BY spend DESC", args: [snapId] }),
    ]);
    // tiktok_adgroups — новая таблица (может отсутствовать на старых базах до первого нового синка).
    let adgroups: Record<string, unknown>[] = [];
    try {
      const rs = await db.execute({ sql: "SELECT * FROM tiktok_adgroups WHERE snapshot_id=? ORDER BY spend DESC", args: [snapId] });
      adgroups = rowsToObjects(rs);
    } catch { /* таблицы ещё нет — просто без разбивки по группам объявлений */ }
    const daily = rowsToObjects(dailyRs);
    if (!(since && until) && daysParam !== "all") daily.reverse(); // ASC уже при since/until и days=all
    return NextResponse.json({ snapshot, daily, campaigns: rowsToObjects(campaigns), adgroups });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
