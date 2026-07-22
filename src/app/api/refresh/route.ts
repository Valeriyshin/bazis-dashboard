import { NextRequest, NextResponse } from "next/server";
import { runSync } from "@/lib/sync.mjs";
import { runGoogleAdsSync } from "@/lib/google-ads.mjs";
import { runYandexSync } from "@/lib/yandex.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let since: string | undefined, until: string | undefined, days: number | undefined;
  try {
    const body = await req.json();
    since = body.since; until = body.until; days = body.days ? Number(body.days) : undefined;
  } catch { /* тело необязательно */ }

  try {
    const meta = await runSync({ since, until, days });
    // Google Ads — тем же периодом; best-effort (не валим весь refresh, если нет кредов/доступа).
    let google: unknown = null, googleError: string | null = null;
    try {
      google = await runGoogleAdsSync({ since, until, days });
    } catch (e) {
      googleError = (e as Error).message;
    }
    let yandex: unknown = null, yandexError: string | null = null;
    try {
      yandex = await runYandexSync({ since, until, days });
    } catch (e) {
      yandexError = (e as Error).message;
    }
    return NextResponse.json({ ok: true, meta, google, googleError, yandex, yandexError });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
