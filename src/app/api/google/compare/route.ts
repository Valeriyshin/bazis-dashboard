import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const GA_API = "https://googleads.googleapis.com/v21";
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

function metrics(r: GRow) {
  const m = r.metrics ?? {};
  const spend = micros(m.costMicros);
  const conv = num(m.conversions);
  return {
    spend, impressions: num(m.impressions), clicks: num(m.clicks),
    ctr: num(m.ctr) * 100, cpc: micros(m.averageCpc),
    conversions: conv, cost_per_conversion: conv ? spend / conv : 0,
  };
}

export async function POST(req: NextRequest) {
  const cid = (process.env.GOOGLE_ADS_CUSTOMER_ID || "").replace(/-/g, "");
  const login = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, "");
  if (!process.env.GOOGLE_ADS_REFRESH_TOKEN || !cid)
    return NextResponse.json({ error: "Нет кредов Google Ads в окружении" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const { aSince, aUntil, bSince, bUntil } = body;
  if (!aSince || !aUntil || !bSince || !bUntil)
    return NextResponse.json({ error: "Нужны обе пары дат (период A и B)" }, { status: 400 });

  const q = (since: string, until: string) =>
    `SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks,
            metrics.ctr, metrics.average_cpc, metrics.conversions
     FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`;

  try {
    const token = await accessToken();
    const [aRows, bRows] = await Promise.all([
      gaql(token, cid, login, q(aSince, aUntil)),
      gaql(token, cid, login, q(bSince, bUntil)),
    ]);
    const map = new Map<string, { id: string; name: string; a?: ReturnType<typeof metrics>; b?: ReturnType<typeof metrics> }>();
    for (const r of aRows) {
      const id = String(r.campaign?.id ?? "");
      map.set(id, { id, name: r.campaign?.name ?? id, a: metrics(r) });
    }
    for (const r of bRows) {
      const id = String(r.campaign?.id ?? "");
      const e = map.get(id) ?? { id, name: r.campaign?.name ?? id };
      e.b = metrics(r);
      map.set(id, e);
    }
    const rows = [...map.values()].sort((x, y) => ((y.b?.spend ?? 0) + (y.a?.spend ?? 0)) - ((x.b?.spend ?? 0) + (x.a?.spend ?? 0)));
    return NextResponse.json({ rows });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
