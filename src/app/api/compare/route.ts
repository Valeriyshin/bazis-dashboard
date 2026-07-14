import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const API = "https://graph.facebook.com/v21.0";
const CORE = "spend,impressions,reach,frequency,clicks,cpc,cpm,ctr,actions,objective";

type Row = Record<string, unknown>;
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

async function fetchAll(url: string): Promise<Row[]> {
  const out: Row[] = [];
  let next: string | null = url;
  while (next) {
    const res: Response = await fetch(next);
    const json: { data?: Row[]; paging?: { next?: string }; error?: { message?: string } } = await res.json();
    if (json.error) throw new Error(json.error.message || "Graph API error");
    out.push(...(json.data ?? []));
    next = json.paging?.next ?? null;
  }
  return out;
}

function leadsFrom(actions: Row[] | undefined): number {
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions) {
    if (["lead", "onsite_conversion.lead_grouped", "leadgen_grouped"].includes(a.action_type as string)) {
      n = Math.max(n, Number(a.value || 0));
    }
  }
  return n;
}
function metrics(r: Row) {
  const obj = (r.objective as string) || "";
  const spend = num(r.spend);
  let results = 0, cpl = 0;
  if (obj.includes("LEADS")) { results = leadsFrom(r.actions as Row[]); cpl = results ? spend / results : 0; }
  else if (obj.includes("AWARENESS")) { results = num(r.reach); cpl = 0; }
  else { results = num(r.clicks); cpl = 0; }
  return {
    spend, impressions: num(r.impressions), reach: num(r.reach), clicks: num(r.clicks),
    ctr: num(r.ctr), cpc: num(r.cpc), cpm: num(r.cpm), frequency: num(r.frequency),
    results, cost_per_result: cpl, objective: obj,
  };
}

export async function POST(req: NextRequest) {
  const token = process.env.FB_ACCESS_TOKEN;
  const account = process.env.FB_AD_ACCOUNT_ID || "1201997914797230";
  if (!token) return NextResponse.json({ error: "Нет FB_ACCESS_TOKEN в .env.local" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const level = ["campaign", "adset", "ad"].includes(body.level) ? body.level : "campaign";
  const { aSince, aUntil, bSince, bUntil } = body;
  if (!aSince || !aUntil || !bSince || !bUntil)
    return NextResponse.json({ error: "Нужны обе пары дат (период A и B)" }, { status: 400 });

  const idField = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
  const nameField = level === "campaign" ? "campaign_name" : level === "adset" ? "adset_name" : "ad_name";
  const q = (since: string, until: string) => {
    const tr = encodeURIComponent(JSON.stringify({ since, until }));
    return `${API}/act_${account}/insights?level=${level}&time_range=${tr}&limit=500&fields=${idField},${nameField},${CORE}&access_token=${token}`;
  };

  try {
    const [aRows, bRows] = await Promise.all([fetchAll(q(aSince, aUntil)), fetchAll(q(bSince, bUntil))]);
    const map = new Map<string, { id: string; name: string; a?: ReturnType<typeof metrics>; b?: ReturnType<typeof metrics> }>();
    for (const r of aRows) {
      const id = r[idField] as string;
      map.set(id, { id, name: (r[nameField] as string) || id, a: metrics(r) });
    }
    for (const r of bRows) {
      const id = r[idField] as string;
      const e = map.get(id) ?? { id, name: (r[nameField] as string) || id };
      e.b = metrics(r);
      map.set(id, e);
    }
    const rows = [...map.values()].sort((x, y) => (y.b?.spend ?? 0) + (y.a?.spend ?? 0) - ((x.b?.spend ?? 0) + (x.a?.spend ?? 0)));
    return NextResponse.json({ level, rows });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
