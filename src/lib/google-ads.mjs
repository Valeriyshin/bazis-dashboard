// Выгрузка Google Ads → БД (libSQL/Turso). По образцу sync.mjs (Meta).
// CLI: npm run sync:google. Требует OAuth-креды в .env.local (см. README).
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

const GA_API = "https://googleads.googleapis.com/v21";
const num = (v) => (v == null || v === "" ? 0 : Number(v));
const micros = (v) => num(v) / 1e6;

// Access token из refresh token.
async function accessToken() {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_ADS_CLIENT_ID,
      client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
      refresh_token: process.env.GOOGLE_ADS_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error("OAuth: " + (j.error_description || j.error || "нет access_token"));
  return j.access_token;
}

// GAQL searchStream → массив результатов (склеиваем батчи).
async function gaql(token, customerId, loginCustomerId, query) {
  const res = await fetch(`${GA_API}/customers/${customerId}/googleAds:searchStream`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "developer-token": process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
      "login-customer-id": loginCustomerId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Google Ads API ${res.status}: ${text.slice(0, 400)}`);
  const batches = JSON.parse(text);
  const rows = [];
  for (const b of batches) rows.push(...(b.results ?? []));
  return rows;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS google_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id TEXT, created_at TEXT, period_start TEXT, period_end TEXT, currency TEXT DEFAULT 'USD')`,
  `CREATE TABLE IF NOT EXISTS google_daily (snapshot_id INTEGER, date TEXT, spend REAL, impressions INTEGER, clicks INTEGER, conversions REAL, PRIMARY KEY (snapshot_id, date))`,
  `CREATE TABLE IF NOT EXISTS google_campaigns (snapshot_id INTEGER, campaign_id TEXT, name TEXT, status TEXT, channel TEXT, spend REAL, impressions INTEGER, clicks INTEGER, ctr REAL, cpc REAL, conversions REAL, cost_per_conversion REAL, PRIMARY KEY (snapshot_id, campaign_id))`,
];

function dateRange(days) {
  const until = new Date();
  const since = new Date(until.getTime() - (days - 1) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { since: iso(since), until: iso(until) };
}

export async function runGoogleAdsSync(opts = {}) {
  loadEnv();
  const dev = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const cid = (process.env.GOOGLE_ADS_CUSTOMER_ID || "").replace(/-/g, "");
  const login = (process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || "").replace(/-/g, "");
  if (!dev || !process.env.GOOGLE_ADS_CLIENT_ID || !process.env.GOOGLE_ADS_REFRESH_TOKEN || !cid)
    throw new Error("Не хватает Google Ads кредов в .env.local (DEVELOPER_TOKEN, CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, CUSTOMER_ID).");

  const days = Number(opts.days) || Number(process.env.GA_DAYS) || 60;
  const since = opts.since || dateRange(days).since;
  const until = opts.until || dateRange(days).until;
  const token = await accessToken();

  // Подневная статистика аккаунта.
  const dailyRows = await gaql(token, cid, login,
    `SELECT segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
     FROM customer WHERE segments.date BETWEEN '${since}' AND '${until}'`);
  const daily = dailyRows.map((r) => ({
    date: r.segments.date,
    spend: micros(r.metrics.costMicros),
    impressions: num(r.metrics.impressions),
    clicks: num(r.metrics.clicks),
    conversions: num(r.metrics.conversions),
  }));

  // Кампании (advertising_channel_type — чтобы отличать Поиск / YouTube / КМС / PMax).
  const campRows = await gaql(token, cid, login,
    `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type,
            metrics.cost_micros, metrics.impressions,
            metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.conversions, metrics.cost_per_conversion
     FROM campaign WHERE segments.date BETWEEN '${since}' AND '${until}'`);
  const CHANNEL = {
    SEARCH: "Поиск", VIDEO: "YouTube", DISPLAY: "КМС", PERFORMANCE_MAX: "PMax",
    SHOPPING: "Торговая", DEMAND_GEN: "Demand Gen", MULTI_CHANNEL: "Multi", DISCOVERY: "Discovery",
  };
  const camps = campRows.map((r) => ({
    id: String(r.campaign.id),
    name: r.campaign.name,
    channel: CHANNEL[r.campaign.advertisingChannelType] || r.campaign.advertisingChannelType || "—",
    status: r.campaign.status === "ENABLED" ? "ACTIVE" : "PAUSED",
    spend: micros(r.metrics.costMicros),
    impressions: num(r.metrics.impressions),
    clicks: num(r.metrics.clicks),
    ctr: num(r.metrics.ctr) * 100,
    cpc: micros(r.metrics.averageCpc),
    conversions: num(r.metrics.conversions),
    cost_per_conversion: micros(r.metrics.costPerConversion),
  }));

  const conn = db();
  await conn.batch(SCHEMA, "write");
  // Миграция для уже созданных БД: колонка channel.
  try { await conn.execute("ALTER TABLE google_campaigns ADD COLUMN channel TEXT"); } catch { /* уже есть */ }
  const now = new Date().toISOString();
  const snap = await conn.execute({
    sql: "INSERT INTO google_snapshots (customer_id, created_at, period_start, period_end, currency) VALUES (?,?,?,?,?)",
    args: [cid, now, since, until, "USD"],
  });
  const snapId = Number(snap.lastInsertRowid);

  const stmts = [];
  for (const r of daily) stmts.push({ sql: "INSERT INTO google_daily (snapshot_id,date,spend,impressions,clicks,conversions) VALUES (?,?,?,?,?,?)", args: [snapId, r.date, r.spend, r.impressions, r.clicks, r.conversions] });
  for (const r of camps) stmts.push({ sql: "INSERT INTO google_campaigns (snapshot_id,campaign_id,name,status,channel,spend,impressions,clicks,ctr,cpc,conversions,cost_per_conversion) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", args: [snapId, r.id, r.name, r.status, r.channel, r.spend, r.impressions, r.clicks, r.ctr, r.cpc, r.conversions, r.cost_per_conversion] });
  if (stmts.length) await conn.batch(stmts, "write");

  return { snapshotId: snapId, since, until, days: daily.length, campaigns: camps.length };
}
