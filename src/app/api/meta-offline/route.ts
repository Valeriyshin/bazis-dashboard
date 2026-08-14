import { NextRequest, NextResponse } from "next/server";
import { getDb, rowsToObjects } from "@/lib/db";
import { leadIdOf, type LeadRow } from "@/lib/salesRecon";

// Передача квал-лидов ("встреча назначена") в Meta как офлайн-конверсии, привязанные
// к leadgen_id — чтобы можно было оптимизировать кампании на реальную квалификацию
// лида, а не просто на факт заявки. Два отдельных шага, разнесённых по причине:
// синк (найти новые квал-лиды с lead_id и сложить в очередь) — дешёвая операция по
// уже накопленным в sales_recon_rows данным; отправка в Meta — сетевой вызов,
// который может частично упасть и требует повторных попыток без дублей.
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const SCHEMA = `CREATE TABLE IF NOT EXISTS meta_offline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL UNIQUE,
  phone TEXT,
  event_name TEXT NOT NULL,
  event_time INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  response TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT
)`;

function eventTimeOf(dateStr: string): number | null {
  const m = String(dateStr).match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1], 12); // полдень — без привязки к часовому поясу
  return Math.floor(d.getTime() / 1000);
}

async function fetchAllLeads(): Promise<LeadRow[]> {
  const db = getDb();
  const out: LeadRow[] = [];
  let lastId = 0;
  for (;;) {
    const rs = await db.execute({
      sql: "SELECT id, data FROM sales_recon_rows WHERE kind='lead' AND id > ? ORDER BY id LIMIT 20000",
      args: [lastId],
    });
    const page = rowsToObjects(rs);
    if (!page.length) break;
    for (const r of page) out.push(JSON.parse(String(r.data)));
    lastId = Number(page[page.length - 1].id);
    if (page.length < 20000) break;
  }
  return out;
}

async function doSync() {
  const db = getDb();
  await db.execute(SCHEMA);
  const leads = await fetchAllLeads();
  let found = 0, inserted = 0, skippedNoDate = 0;
  const now = new Date().toISOString();
  const stmts: { sql: string; args: (string | number)[] }[] = [];
  for (const l of leads) {
    if (!l.meeting) continue;
    const leadId = leadIdOf(l.descr);
    if (!leadId) continue;
    found++;
    const eventTime = eventTimeOf(l.date);
    if (!eventTime) { skippedNoDate++; continue; }
    stmts.push({
      sql: "INSERT OR IGNORE INTO meta_offline_events (lead_id, phone, event_name, event_time, status, created_at) VALUES (?,?,?,?,?,?)",
      args: [leadId, l.phone || "", "Schedule", eventTime, "pending", now],
    });
  }
  for (let i = 0; i < stmts.length; i += 500) {
    const chunk = stmts.slice(i, i + 500);
    const results = await db.batch(chunk, "write");
    for (const r of results) inserted += Number(r.rowsAffected ?? 0);
  }
  return { found, inserted, skippedNoDate, alreadyQueued: found - skippedNoDate - inserted };
}

// Тело события Conversions API для CRM-лидов Meta: матчинг по lead_id вместо
// хэшей контактных данных. Точную форму (имя поля user_data.lead_id и т.п.)
// стоит сверить с актуальной документацией Meta CRM-интеграции лид-форм —
// это часть API, которую Meta меняет чаще прочих.
function buildMetaPayload(rows: { lead_id: string; event_name: string; event_time: number }[]) {
  return {
    data: rows.map((r) => ({
      event_name: r.event_name,
      event_time: r.event_time,
      action_source: "system_generated",
      user_data: { lead_id: r.lead_id },
    })),
  };
}

async function doSend(limit: number) {
  const db = getDb();
  await db.execute(SCHEMA);
  const rs = await db.execute({
    sql: "SELECT id, lead_id, event_name, event_time FROM meta_offline_events WHERE status='pending' ORDER BY id LIMIT ?",
    args: [limit],
  });
  const pending = rowsToObjects(rs) as unknown as { id: number; lead_id: string; event_name: string; event_time: number }[];
  if (!pending.length) return { sent: 0, errors: 0, dryRun: false, message: "Нет событий в очереди — сначала запустите синк." };

  const datasetId = process.env.META_OFFLINE_DATASET_ID;
  const token = process.env.META_OFFLINE_TOKEN || process.env.FB_ACCESS_TOKEN;
  const payload = buildMetaPayload(pending);

  if (!datasetId || !token) {
    return {
      sent: 0, errors: 0, dryRun: true, queued: pending.length,
      message: "META_OFFLINE_DATASET_ID и/или токен (META_OFFLINE_TOKEN / FB_ACCESS_TOKEN) не заданы — показываю, что было бы отправлено, без реального вызова Meta.",
      samplePayload: { data: payload.data.slice(0, 3) },
    };
  }

  const url = `https://graph.facebook.com/v21.0/${datasetId}/events?access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  const now = new Date().toISOString();
  const ok = res.ok;
  const stmts = pending.map((p) => ({
    sql: "UPDATE meta_offline_events SET status=?, response=?, sent_at=? WHERE id=?",
    args: [ok ? "sent" : "error", text.slice(0, 2000), now, p.id],
  }));
  await db.batch(stmts, "write");
  return { sent: ok ? pending.length : 0, errors: ok ? 0 : pending.length, dryRun: false, metaStatus: res.status, metaResponse: text.slice(0, 1000) };
}

export async function GET() {
  try {
    const db = getDb();
    await db.execute(SCHEMA);
    const rs = await db.execute("SELECT status, COUNT(*) AS n FROM meta_offline_events GROUP BY status");
    const byStatus = rowsToObjects(rs);
    const configured = Boolean(process.env.META_OFFLINE_DATASET_ID && (process.env.META_OFFLINE_TOKEN || process.env.FB_ACCESS_TOKEN));
    return NextResponse.json({ byStatus, configured });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const action = body.action as string;
    if (action === "sync") return NextResponse.json(await doSync());
    if (action === "send") return NextResponse.json(await doSend(Number(body.limit) || 1000));
    return NextResponse.json({ error: "action must be 'sync' or 'send'" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
