import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const TT_API = "https://business-api.tiktok.com/open_api/v1.3";
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

interface TRow { dimensions: { campaign_id: string }; metrics: Record<string, string> }

function advertiserIds(): string[] {
  const list = process.env.TIKTOK_ADVERTISER_IDS || process.env.TIKTOK_ADVERTISER_ID || "";
  return list.split(",").map((s) => s.trim()).filter(Boolean);
}

async function report(advertiserId: string, startDate: string, endDate: string): Promise<TRow[]> {
  const rows: TRow[] = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      advertiser_id: advertiserId, report_type: "BASIC", data_level: "AUCTION_CAMPAIGN",
      dimensions: JSON.stringify(["campaign_id"]),
      metrics: JSON.stringify(["campaign_name", "spend", "impressions", "clicks", "conversion"]),
      start_date: startDate, end_date: endDate, page_size: "1000", page: String(page),
    });
    const res = await fetch(`${TT_API}/report/integrated/get/?${params}`, {
      headers: { "Access-Token": process.env.TIKTOK_ACCESS_TOKEN || "" },
    });
    const j = await res.json();
    if (j.code !== 0) throw new Error(j.message || JSON.stringify(j).slice(0, 300));
    rows.push(...(j.data?.list ?? []));
    const info = j.data?.page_info;
    if (!info || page >= info.total_page) break;
    page += 1;
  }
  return rows;
}

// Только уровень кампаний — как и у Google, без разбивки по группам объявлений.
export async function POST(req: NextRequest) {
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  const advs = advertiserIds();
  if (!token || !advs.length) return NextResponse.json({ error: "Нет кредов TikTok в окружении" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const periods: { since: string; until: string }[] = body.periods || [];
  if (!periods.length) return NextResponse.json({ error: "Нужен хотя бы один период" }, { status: 400 });

  try {
    const rowsByEntity = new Map<string, { id: string; name: string; periods: (Record<string, number> | null)[] }>();

    for (let pi = 0; pi < periods.length; pi++) {
      const { since, until } = periods[pi];
      for (const adv of advs) {
        const rows = await report(adv, since, until);
        for (const r of rows) {
          const id = `${adv}:${r.dimensions.campaign_id}`;
          const e = rowsByEntity.get(id) ?? { id, name: r.metrics.campaign_name || id, periods: periods.map(() => null) };
          const spend = num(r.metrics.spend), leads = num(r.metrics.conversion);
          const impressions = num(r.metrics.impressions);
          e.periods[pi] = {
            spend, impressions, reach: 0, frequency: 0,
            clicks: num(r.metrics.clicks), ctr: impressions ? (num(r.metrics.clicks) / impressions) * 100 : 0,
            leads, cpl: leads ? spend / leads : 0,
          };
          rowsByEntity.set(id, e);
        }
      }
    }

    const out = [...rowsByEntity.values()].sort((a, b) => {
      const sa = a.periods.reduce((s, p) => s + (p?.spend ?? 0), 0);
      const sb = b.periods.reduce((s, p) => s + (p?.spend ?? 0), 0);
      return sb - sa;
    });
    return NextResponse.json({ rows: out });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
