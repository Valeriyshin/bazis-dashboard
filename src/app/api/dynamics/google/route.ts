import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const GA_API = "https://googleads.googleapis.com/v22";
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));
const micros = (v: unknown) => num(v) / 1e6;

async function accessToken(): Promise<string> {
  const res: Response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID || "",
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET || "",
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN || "",
      grant_type: "refresh_token",
    }),
  });
  const j: { access_token?: string; error_description?: string; error?: string } = await res.json();
  if (!j.access_token) throw new Error("OAuth: " + (j.error_description || j.error || "нет access_token"));
  return j.access_token;
}

interface GRow { campaign?: { id?: string; name?: string }; metrics?: Record<string, unknown> }

async function gaql(token: string, cid: string, login: string, query: string): Promise<GRow[]> {
  const res: Response = await fetch(`${GA_API}/customers/${cid}/googleAds:searchStream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
      "login-customer-id": login,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Ads API ${res.status}: ${text.slice(0, 300)}`);
  const batches: { results?: GRow[] }[] = JSON.parse(text);
  const out: GRow[] = [];
  for (const b of batches) out.push(...(b.results ?? []));
  return out;
}

// Только уровень кампаний — у Google в дашборде нет разбивки по группам объявлений.
export async function POST(req: NextRequest) {
  const cid = (process.env.GOOGLE_ADS_CUSTOMER_ID || "").replace(/-/g, "");
  const login = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, "");
  if (!process.env.GOOGLE_ADS_REFRESH_TOKEN || !cid)
    return NextResponse.json({ error: "Нет кредов Google Ads в окружении" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const periods: { since: string; until: string }[] = body.periods || [];
  if (!periods.length) return NextResponse.json({ error: "Нужен хотя бы один период" }, { status: 400 });

  try {
    const token = await accessToken();
    const rowsByEntity = new Map<string, { id: string; name: string; periods: (Record<string, number> | null)[] }>();

    for (let pi = 0; pi < periods.length; pi++) {
      const { since, until } = periods[pi];
      const rows = await gaql(token, cid, login,
        `SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks,
                metrics.ctr, metrics.conversions
         FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`);
      for (const r of rows) {
        const id = String(r.campaign?.id ?? "");
        if (!id) continue;
        const name = r.campaign?.name ?? id;
        const e = rowsByEntity.get(id) ?? { id, name, periods: periods.map(() => null) };
        const m = r.metrics ?? {};
        const spend = micros(m.costMicros), leads = num(m.conversions);
        e.periods[pi] = {
          spend, impressions: num(m.impressions), reach: 0, frequency: 0,
          clicks: num(m.clicks), ctr: num(m.ctr) * 100, leads, cpl: leads ? spend / leads : 0,
        };
        rowsByEntity.set(id, e);
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
