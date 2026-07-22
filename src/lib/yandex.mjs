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

const REPORTS_URL = "https://api.direct.yandex.com/json/v5/reports";
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

// Reports API отдаёт TSV. Возвращает массив объектов по заголовку.
async function report(body) {
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await fetch(REPORTS_URL, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    // 201/202 — отчёт ставится в очередь, надо подождать и повторить тот же запрос.
    if (res.status === 201 || res.status === 202) {
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Yandex Direct API ${res.status}: ${text.slice(0, 400)}`);
    const lines = text.trim().split("\n").filter(Boolean);
    if (lines.length < 2) return [];
    const cols = lines[0].split("\t");
    return lines.slice(1).map((l) => {
      const parts = l.split("\t");
      return Object.fromEntries(cols.map((c, i) => [c, parts[i]]));
    });
  }
  throw new Error("Yandex Direct: отчёт не готов после ожидания");
}

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

export async function runYandexSync(opts = {}) {
  loadEnv();
  if (!process.env.YANDEX_OAUTH_TOKEN) throw new Error("Нет YANDEX_OAUTH_TOKEN в .env.local");

  const days = Number(opts.days) || Number(process.env.YA_DAYS) || 60;
  const since = opts.since || dateRange(days).since;
  const until = opts.until || dateRange(days).until;
  const range = { DateFrom: since, DateTo: until };

  const base = (name, fields) => ({
    params: {
      SelectionCriteria: range,
      FieldNames: fields,
      ReportName: `${name}_${Date.now()}`,
      ReportType: name === "daily" ? "ACCOUNT_PERFORMANCE_REPORT" : "CAMPAIGN_PERFORMANCE_REPORT",
      DateRangeType: "CUSTOM_DATE",
      Format: "TSV",
      IncludeVAT: "NO",
      IncludeDiscount: "NO",
    },
  });

  const dailyRaw = await report(base("daily", ["Date", "Impressions", "Clicks", "Cost", "Conversions"]));
  const campRaw = await report(base("campaigns", ["CampaignId", "CampaignName", "Impressions", "Clicks", "Cost", "Ctr", "AvgCpc", "Conversions"]));

  const daily = dailyRaw.map((r) => ({
    date: r.Date,
    spend: money(r.Cost),
    impressions: num(r.Impressions),
    clicks: num(r.Clicks),
    conversions: num(r.Conversions),
  }));
  const camps = campRaw.map((r) => {
    const spend = money(r.Cost), conv = num(r.Conversions);
    return {
      id: String(r.CampaignId),
      name: r.CampaignName,
      status: "ACTIVE", // статус в отчёте не приходит
      spend, impressions: num(r.Impressions), clicks: num(r.Clicks),
      ctr: num(r.Ctr), cpc: money(r.AvgCpc),
      conversions: conv, cost_per_conversion: conv ? spend / conv : 0,
    };
  });

  const conn = db();
  await conn.batch(SCHEMA, "write");
  const now = new Date().toISOString();
  const snap = await conn.execute({
    sql: "INSERT INTO yandex_snapshots (client_login, created_at, period_start, period_end, currency) VALUES (?,?,?,?,?)",
    args: [process.env.YANDEX_CLIENT_LOGIN || "", now, since, until, process.env.YANDEX_CURRENCY || "KZT"],
  });
  const snapId = Number(snap.lastInsertRowid);

  const stmts = [];
  for (const r of daily) stmts.push({ sql: "INSERT INTO yandex_daily (snapshot_id,date,spend,impressions,clicks,conversions) VALUES (?,?,?,?,?,?)", args: [snapId, r.date, r.spend, r.impressions, r.clicks, r.conversions] });
  for (const r of camps) stmts.push({ sql: "INSERT INTO yandex_campaigns (snapshot_id,campaign_id,name,status,spend,impressions,clicks,ctr,cpc,conversions,cost_per_conversion) VALUES (?,?,?,?,?,?,?,?,?,?,?)", args: [snapId, r.id, r.name, r.status, r.spend, r.impressions, r.clicks, r.ctr, r.cpc, r.conversions, r.cost_per_conversion] });
  if (stmts.length) await conn.batch(stmts, "write");

  return { snapshotId: snapId, since, until, days: daily.length, campaigns: camps.length };
}
