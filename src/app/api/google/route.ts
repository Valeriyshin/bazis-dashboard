import { NextResponse } from "next/server";
import { getDb, rowsToObjects } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const snapRs = await db.execute("SELECT * FROM google_snapshots ORDER BY id DESC LIMIT 1");
    const snapshot = rowsToObjects(snapRs)[0];
    if (!snapshot) {
      return NextResponse.json({ error: "Нет данных Google Ads. Запустите npm run sync:google." }, { status: 404 });
    }
    const snapId = snapshot.id as number;
    const [daily, campaigns] = await Promise.all([
      db.execute({ sql: "SELECT * FROM google_daily WHERE snapshot_id=? ORDER BY date ASC", args: [snapId] }),
      db.execute({ sql: "SELECT * FROM google_campaigns WHERE snapshot_id=? ORDER BY spend DESC", args: [snapId] }),
    ]);
    return NextResponse.json({ snapshot, daily: rowsToObjects(daily), campaigns: rowsToObjects(campaigns) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
