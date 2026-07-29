// Выгрузка Яндекс.Директ → БД (libSQL/Turso). По образцу google-ads.mjs.
// CLI: npm run sync:yandex. Нужны YANDEX_OAUTH_TOKEN (+ YANDEX_CLIENT_LOGIN для агентств).
import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

function loadEnv() {
  const p = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
function db() {
  const url = process.env.TURSO_DATABASE_URL || "file:./data/app.db";
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}

// Боевой API требует одобренной заявки на доступ. Песочница работает сразу (тестовые данные):
// YANDEX_SANDBOX=1 в .env.local переключает на неё.
// Вычисляем в момент запроса — .env.local грузится уже внутри runYandexSync.
const reportsUrl = () =>
  process.env.YANDEX_SANDBOX === "1"
    ? "https://api-sandbox.direct.yandex.com/json/v5/reports"
    : "https://api.direct.yandex.com/json/v5/reports";
const num = (v) => (v == null || v === "" || v === "--" ? 0 : Number(v));

// Директ отдаёт деньги в микроединицах валюты.
const money = (v) => num(v) / 1e6;

function headers() {
  const h = {
    Authorization: `Bearer ${process.env.YANDEX_OAUTH_TOKEN}`,
    "Accept-Language": "ru",
    "Content-Type": "application/json; charset=utf-8",
    processingMode: "auto",
    returnMoneyInMicros: "true",
    skipReportHeader: "true",
    skipColumnHeader: "false",
    skipReportSummary: "true",
  };
  if (process.env.YANDEX_CLIENT_LOGIN) h["Client-Login"] = process.env.YANDEX_CLIENT_LOGIN;
  return h;
}

// Reports API отдаёт TSV. Возвращает { cols, rows } — заголовок нужен, чтобы
// разобрать динамические колонки вида Conversions_<goalId>_<attribution>.
async function report(body) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await fetch(reportsUrl(), { method: "POST", headers: headers(), body: JSON.stringify(body) });
    // 201/202 — отчёт ставится в очередь, надо подождать и повторить тот же запрос.
    if (res.status === 201 || res.status === 202) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Yandex Direct API ${res.status}: ${text.slice(0, 400)}`);
    const lines = text.trim().split("\n").filter(Boolean);
    if (lines.length < 2) return { cols: [], rows: [] };
    const cols = lines[0].split("\t");
    const rows = lines.slice(1).map((l) => {
      const parts = l.split("\t");
      return Object.fromEntries(cols.map((c, i) => [c, parts[i]]));
    });
    return { cols, rows };
  }
  throw new Error("Yandex Direct: отчёт не готов после ожидания");
}

// Обычный вызов сервиса API (не Reports).
async function api(service, method, params) {
  const h = { ...headers() };
  // Служебные заголовки Reports API здесь не нужны и мешают.
  delete h.processingMode; delete h.returnMoneyInMicros;
  delete h.skipReportHeader; delete h.skipColumnHeader; delete h.skipReportSummary;
  const base = process.env.YANDEX_SANDBOX === "1"
    ? "https://api-sandbox.direct.yandex.com/json/v5/"
    : "https://api.direct.yandex.com/json/v5/";
  const res = await fetch(base + service, { method: "POST", headers: h, body: JSON.stringify({ method, params }) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Yandex ${service}: не JSON — ${text.slice(0, 200)}`); }
  if (json.error) throw new Error(`Yandex ${service}: ${json.error.error_string} — ${json.error.error_detail}`);
  return json.result;
}

// Поле Conversions без указания Goals суммирует ВСЕ цели Метрики, включая
// автоцели, и завышает результат в разы (в кабинете Bazis-A — в 5,5 раза).
// Поэтому берём приоритетные цели из настроек кампаний и считаем только по ним.
async function fetchCampaignGoals() {
  const result = await api("campaigns", "get", {
    SelectionCriteria: {},
    FieldNames: ["Id"],
    TextCampaignFieldNames: ["PriorityGoals"],
  });
  const byCampaign = {};
  for (const c of result?.Campaigns || []) {
    const items = c.TextCampaign?.PriorityGoals?.Items || [];
    // Цель 12 — служебная автоцель Директа («вовлечённая сессия»), не заявка.
    const ids = items.map((g) => String(g.GoalId)).filter((id) => id !== "12" && id !== "13");
    if (ids.length) byCampaign[String(c.Id)] = [...new Set(ids)];
  }
  return byCampaign;
}

// Reports API принимает не более 10 целей за запрос.
const chunk = (arr, size) => {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS yandex_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, client_login TEXT, created_at TEXT, period_start TEXT, period_end TEXT, currency TEXT)`,
  `CREATE TABLE IF NOT EXISTS yandex_daily (snapshot_id INTEGER, date TEXT, spend REAL, impressions INTEGER, clicks INTEGER, conversions REAL, PRIMARY KEY (snapshot_id, date))`,
  `CREATE TABLE IF NOT EXISTS yandex_campaigns (snapshot_id INTEGER, campaign_id TEXT, name TEXT, status TEXT, spend REAL, impressions INTEGER, clicks INTEGER, ctr REAL, cpc REAL, conversions REAL, cost_per_conversion REAL, PRIMARY KEY (snapshot_id, campaign_id))`,
];

function dateRange(days) {
  const until = new Date();
  const since = new Date(until.getTime() - (days - 1) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { since: iso(since), until: iso(until) };
}
const addDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const todayIso = () => new Date().toISOString().slice(0, 10);

// Яндекс отдаёт статистику максимум за 3 года от текущего МЕСЯЦА (проверено —
// точная граница месяца в ответе API), поэтому округляем с небольшим запасом.
function historyFloor() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 35, 1);
  return d.toISOString().slice(0, 10);
}
const RECON_DAYS = Number(process.env.YA_RECON_DAYS) || 14;

async function knownDaily(conn) {
  const rs = await conn.execute(`
    SELECT yd.* FROM yandex_daily yd
    JOIN (SELECT date, MAX(snapshot_id) AS sid FROM yandex_daily GROUP BY date) latest
      ON yd.date = latest.date AND yd.snapshot_id = latest.sid
  `);
  const map = new Map();
  for (const r of rs.rows) map.set(String(r.date), r);
  return map;
}

// Конверсии по целям за конкретный диапазон, в разрезе по дате (для дневного ряда)
// или по кампании (для разбивки) — то же устройство отчёта, разный groupBy.
async function goalConversions(campaignGoals, sinceR, untilR, groupField) {
  const out = {}; // date или campaignId -> сумма конверсий
  const allGoals = [...new Set(Object.values(campaignGoals).flat())];
  if (!allGoals.length) return out;
  for (const batch of chunk(allGoals, 10)) {
    const { cols, rows } = await report({
      params: {
        SelectionCriteria: { DateFrom: sinceR, DateTo: untilR },
        FieldNames: groupField === "Date" ? ["Date", "CampaignId", "Conversions"] : ["CampaignId", "Conversions"],
        ReportName: `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ReportType: "CAMPAIGN_PERFORMANCE_REPORT",
        DateRangeType: "CUSTOM_DATE",
        Format: "TSV",
        IncludeVAT: "NO",
        IncludeDiscount: "NO",
        Goals: batch,
      },
    });
    const goalCols = cols.filter((c) => /^Conversions_\d+_/.test(c)).map((c) => [c, c.match(/^Conversions_(\d+)_/)[1]]);
    for (const r of rows) {
      const cid = String(r.CampaignId);
      const own = campaignGoals[cid] || [];
      const key = groupField === "Date" ? r.Date : cid;
      for (const [col, goalId] of goalCols) {
        if (!own.includes(goalId)) continue; // цель засчитывается только "своей" кампании
        const v = num(r[col]);
        if (!v) continue;
        out[key] = (out[key] || 0) + v;
      }
    }
  }
  return out;
}

export async function runYandexSync(opts = {}) {
  loadEnv();
  if (!process.env.YANDEX_OAUTH_TOKEN) throw new Error("Нет YANDEX_OAUTH_TOKEN в .env.local");

  const until = opts.until || todayIso();
  const explicitDays = Number(opts.days) || Number(process.env.YA_DAYS) || 0;
  const requestedSince = opts.since || (explicitDays ? dateRange(explicitDays).since : historyFloor());
  const floor = historyFloor();
  const since = requestedSince < floor ? floor : requestedSince;

  const entityDays = explicitDays || Number(process.env.YA_ENTITY_DAYS) || 60;
  const sinceEntity = opts.since || dateRange(entityDays).since;

  const base = (name, sinceR, untilR, fields) => ({
    params: {
      SelectionCriteria: { DateFrom: sinceR, DateTo: untilR },
      FieldNames: fields,
      ReportName: `${name}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      ReportType: name === "daily" ? "ACCOUNT_PERFORMANCE_REPORT" : "CAMPAIGN_PERFORMANCE_REPORT",
      DateRangeType: "CUSTOM_DATE",
      Format: "TSV",
      IncludeVAT: "NO",
      IncludeDiscount: "NO",
    },
  });

  // Цели по кампаниям. Если получить не удалось — работаем без них, но честно
  // помечаем результат, чтобы завышенные конверсии не выдавались за точные.
  let campaignGoals = {}, goalsOk = false;
  try {
    campaignGoals = await fetchCampaignGoals();
    goalsOk = Object.keys(campaignGoals).length > 0;
  } catch (e) {
    console.warn("Yandex: не удалось получить цели кампаний —", e.message);
  }

  const conn = db();
  await conn.batch(SCHEMA, "write");

  // Дневная статистика — только окно сверки + недостающая ранняя история;
  // остальное берём из того, что уже знаем по всем прошлым снапшотам.
  const known = await knownDaily(conn);
  const reconStart = addDays(until, -(RECON_DAYS - 1));
  const fetchRanges = [];
  if (known.size === 0) {
    fetchRanges.push([since, until]);
  } else {
    const earliestKnown = [...known.keys()].sort()[0];
    if (since < earliestKnown) fetchRanges.push([since, addDays(earliestKnown, -1)]);
    const tailStart = reconStart > since ? reconStart : since;
    fetchRanges.push([tailStart, until]);
  }

  const freshByDate = new Map();
  for (const [rs, ru] of fetchRanges) {
    const { rows } = await report(base("daily", rs, ru, ["Date", "Impressions", "Clicks", "Cost"]));
    const convByDate = goalsOk ? await goalConversions(campaignGoals, rs, ru, "Date") : {};
    for (const r of rows) {
      freshByDate.set(r.Date, { date: r.Date, spend: money(r.Cost), impressions: num(r.Impressions), clicks: num(r.Clicks), conversions: convByDate[r.Date] || 0 });
    }
  }
  const daily = [];
  for (let d = since; d <= until; d = addDays(d, 1)) {
    if (freshByDate.has(d)) { daily.push(freshByDate.get(d)); continue; }
    const k = known.get(d);
    if (k) daily.push({ date: d, spend: num(k.spend), impressions: num(k.impressions), clicks: num(k.clicks), conversions: num(k.conversions) });
  }

  // Кампании — короткое окно, как раньше.
  const campBase = await report(base("campaigns", sinceEntity, until, ["CampaignId", "CampaignName", "Impressions", "Clicks", "Cost", "Ctr", "AvgCpc"]));
  const convByCampaign = goalsOk ? await goalConversions(campaignGoals, sinceEntity, until, "CampaignId") : {};

  const camps = campBase.rows.map((r) => {
    const spend = money(r.Cost);
    const conv = convByCampaign[String(r.CampaignId)] || 0;
    return {
      id: String(r.CampaignId),
      name: r.CampaignName,
      status: "ACTIVE", // статус в отчёте не приходит
      spend, impressions: num(r.Impressions), clicks: num(r.Clicks),
      ctr: num(r.Ctr), cpc: money(r.AvgCpc),
      conversions: conv, cost_per_conversion: conv ? spend / conv : 0,
    };
  });

  const now = new Date().toISOString();
  const snap = await conn.execute({
    sql: "INSERT INTO yandex_snapshots (client_login, created_at, period_start, period_end, currency) VALUES (?,?,?,?,?)",
    args: [process.env.YANDEX_CLIENT_LOGIN || "", now, sinceEntity, until, process.env.YANDEX_CURRENCY || "KZT"],
  });
  const snapId = Number(snap.lastInsertRowid);

  const stmts = [];
  for (const r of daily) stmts.push({ sql: "INSERT INTO yandex_daily (snapshot_id,date,spend,impressions,clicks,conversions) VALUES (?,?,?,?,?,?)", args: [snapId, r.date, r.spend, r.impressions, r.clicks, r.conversions] });
  for (const r of camps) stmts.push({ sql: "INSERT INTO yandex_campaigns (snapshot_id,campaign_id,name,status,spend,impressions,clicks,ctr,cpc,conversions,cost_per_conversion) VALUES (?,?,?,?,?,?,?,?,?,?,?)", args: [snapId, r.id, r.name, r.status, r.spend, r.impressions, r.clicks, r.ctr, r.cpc, r.conversions, r.cost_per_conversion] });
  if (stmts.length) await conn.batch(stmts, "write");

  const conversions = camps.reduce((s, c) => s + c.conversions, 0);
  return {
    snapshotId: snapId, since: sinceEntity, until,
    days: daily.filter((r) => r.date >= sinceEntity).length, campaigns: camps.length,
    dailyHistorySince: since, dailyHistoryDays: daily.length,
    conversions, goalsApplied: goalsOk,
  };
}
