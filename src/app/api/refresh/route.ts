import { NextRequest, NextResponse } from "next/server";
import { runSync } from "@/lib/sync.mjs";
import { runGoogleAdsSync } from "@/lib/google-ads.mjs";
import { runYandexSync } from "@/lib/yandex.mjs";
import { runTiktokSync } from "@/lib/tiktok.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  let since: string | undefined, until: string | undefined, days: number | undefined;
  try {
    const body = await req.json();
    since = body.since; until = body.until; days = body.days ? Number(body.days) : undefined;
  } catch { /* тело необязательно */ }

  // Площадки синкаются параллельно: они независимы (разные API, разные таблицы),
  // а последовательно это занимало сумму времени всех четырёх — на замере
  // Meta 38.7с + Google 6.0с + Яндекс 110.9с + TikTok 8.9с = 164.6с, хотя реально
  // нужно столько, сколько работает самая долгая из них.
  const opts = { since, until, days };
  const [meta, google, yandex, tiktok] = await Promise.allSettled([
    runSync(opts), runGoogleAdsSync(opts), runYandexSync(opts), runTiktokSync(opts),
  ]);

  const err = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" ? String((r.reason as Error)?.message ?? r.reason) : null;
  const val = (r: PromiseSettledResult<unknown>) => (r.status === "fulfilled" ? r.value : null);

  // Meta — основная площадка: если упала она, это ошибка всего обновления (как и раньше).
  // Остальные best-effort: их падение не мешает обновить то, что доступно.
  if (meta.status === "rejected") {
    return NextResponse.json({ error: err(meta) }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    meta: val(meta),
    google: val(google), googleError: err(google),
    yandex: val(yandex), yandexError: err(yandex),
    tiktok: val(tiktok), tiktokError: err(tiktok),
  });
}
