import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const API = "https://graph.facebook.com/v21.0";
const num = (v: unknown) => (v == null || v === "" ? 0 : Number(v));

interface MRow {
  campaign_id?: string; campaign_name?: string;
  adset_id?: string; adset_name?: string;
  ad_id?: string; ad_name?: string;
  spend?: string; impressions?: string; reach?: string; frequency?: string;
  clicks?: string; ctr?: string;
  actions?: { action_type: string; value: string }[];
}

function leadsFrom(actions: MRow["actions"]): number {
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions)
    if (["lead", "onsite_conversion.lead_grouped", "leadgen_grouped"].includes(a.action_type)) n = Math.max(n, Number(a.value || 0));
  return n;
}

async function fetchAll(url: string): Promise<MRow[]> {
  const out: MRow[] = [];
  let next: string | null = url;
  while (next) {
    const res: Response = await fetch(next);
    const json: { data?: MRow[]; paging?: { next?: string }; error?: { message?: string } } = await res.json();
    if (json.error) throw new Error(json.error.message || "Graph API error");
    out.push(...(json.data ?? []));
    next = json.paging?.next ?? null;
  }
  return out;
}

function accountIds(): string[] {
  const list = process.env.FB_AD_ACCOUNT_IDS || process.env.FB_AD_ACCOUNT_ID || "1201997914797230";
  return list.split(",").map((s) => s.trim()).filter(Boolean);
}

// level: campaign — верхний уровень (без родителя); adset — parentId = campaign_id;
// ad — parentId = adset_id. Каждый период = отдельный вызов insights c своим time_range,
// Graph API сам агрегирует метрики за диапазон в одну строку на сущность.
export async function POST(req: NextRequest) {
  const TOKEN = process.env.FB_ACCESS_TOKEN;
  if (!TOKEN) return NextResponse.json({ error: "Нет FB_ACCESS_TOKEN" }, { status: 400 });

  const body = await req.json().catch(() => ({}));
  const level: "campaign" | "adset" | "ad" = body.level || "campaign";
  const parentId: string | undefined = body.parentId;
  const periods: { since: string; until: string }[] = body.periods || [];
  if (!periods.length) return NextResponse.json({ error: "Нужен хотя бы один период" }, { status: 400 });
  if (level !== "campaign" && !parentId) return NextResponse.json({ error: "Нужен parentId для adset/ad" }, { status: 400 });

  const idField = level === "campaign" ? "campaign_id" : level === "adset" ? "adset_id" : "ad_id";
  const nameField = level === "campaign" ? "campaign_name" : level === "adset" ? "adset_name" : "ad_name";
  const filterField = level === "adset" ? "campaign.id" : "adset.id";
  const fields = "campaign_id,campaign_name,adset_id,adset_name,ad_id,ad_name,spend,impressions,reach,frequency,clicks,ctr,actions";

  try {
    const rowsByEntity = new Map<string, { id: string; name: string; periods: (Record<string, number> | null)[] }>();

    for (let pi = 0; pi < periods.length; pi++) {
      const { since, until } = periods[pi];
      const tr = encodeURIComponent(JSON.stringify({ since, until }));
      const filtering = level !== "campaign" ? `&filtering=${encodeURIComponent(JSON.stringify([{ field: filterField, operator: "IN", value: [parentId] }]))}` : "";
      for (const acc of accountIds()) {
        const url = `${API}/act_${acc}/insights?level=${level}&time_range=${tr}&limit=500&fields=${fields}${filtering}&access_token=${TOKEN}`;
        const rows = await fetchAll(url);
        for (const r of rows) {
          const id = String(r[idField as keyof MRow] ?? "");
          if (!id) continue;
          const name = String(r[nameField as keyof MRow] ?? id);
          const e = rowsByEntity.get(id) ?? { id, name, periods: periods.map(() => null) };
          const spend = num(r.spend), leads = leadsFrom(r.actions);
          e.periods[pi] = {
            spend, impressions: num(r.impressions), reach: num(r.reach), frequency: num(r.frequency),
            clicks: num(r.clicks), ctr: num(r.ctr), leads, cpl: leads ? spend / leads : 0,
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
