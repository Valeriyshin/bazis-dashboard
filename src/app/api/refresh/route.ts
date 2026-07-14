import { NextRequest, NextResponse } from "next/server";
import { runSync } from "@/lib/sync.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let since: string | undefined, until: string | undefined, days: number | undefined;
  try {
    const body = await req.json();
    since = body.since; until = body.until; days = body.days ? Number(body.days) : undefined;
  } catch { /* тело необязательно */ }

  try {
    const r = await runSync({ since, until, days });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
