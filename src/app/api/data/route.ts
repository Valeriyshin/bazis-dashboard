import { NextResponse } from "next/server";
import { getDb, rowsToObjects } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const snapRs = await db.execute("SELECT * FROM snapshots ORDER BY id DESC LIMIT 1");
    const snapshot = rowsToObjects(snapRs)[0];
    if (!snapshot) {
      return NextResponse.json({ error: "Нет снапшотов. Нажмите «Обновить» или запустите npm run sync." }, { status: 404 });
    }
    const snapId = snapshot.id as number;

    const [daily, campaigns, adsets, ads, summaryRs] = await Promise.all([
      db.execute({ sql: "SELECT * FROM daily_insights WHERE snapshot_id=? ORDER BY date ASC", args: [snapId] }),
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

    return NextResponse.json({
      snapshot,
      daily: rowsToObjects(daily),
      campaigns: rowsToObjects(campaigns),
      adsets: rowsToObjects(adsets),
      ads: rowsToObjects(ads),
      summary,
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
