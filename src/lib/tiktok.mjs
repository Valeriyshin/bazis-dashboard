// Выгрузка TikTok Ads → БД (libSQL/Turso). По образцу google-ads.mjs.
// CLI: npm run sync:tiktok. Требует TIKTOK_APP_ID/SECRET/ACCESS_TOKEN/ADVERTISER_IDS в .env.local.
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

const TT_API = "https://business-api.tiktok.com/open_api/v1.3";
const num = (v) => (v == null || v === "" ? 0 : Number(v));

// GET /report/integrated/get/ с пагинацией (page_size до 1000, но подстраховываемся циклом).
async function report(advertiserId, dataLevel, dimensions, metrics, startDate, endDate) {
  const rows = [];
  let page = 1;
  for (;;) {
    const params = new URLSearchParams({
      advertiser_id: advertiserId,
      report_type: "BASIC",
      data_level: dataLevel,
      dimensions: JSON.stringify(dimensions),
      metrics: JSON.stringify(metrics),
      start_date: startDate,
      end_date: endDate,
      page_size: "1000",
      page: String(page),
    });
    const res = await fetch(`${TT_API}/report/integrated/get/?${params}`, {
      headers: { "Access-Token": process.env.TIKTOK_ACCESS_TOKEN },
    });
    const j = await res.json();
    if (j.code !== 0) throw new Error(`TikTok API: ${j.message || JSON.stringify(j).slice(0, 300)}`);
    rows.push(...(j.data?.list ?? []));
    const info = j.data?.page_info;
    if (!info || page >= info.total_page) break;
    page += 1;
  }
  return rows;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tiktok_snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, advertiser_id TEXT, created_at TEXT, period_start TEXT, period_end TEXT, currency TEXT DEFAULT 'USD')`,
  `CREATE TABLE IF NOT EXISTS tiktok_daily (snapshot_id INTEGER, date TEXT, spend REAL, impressions INTEGER, clicks INTEGER, conversions REAL, PRIMARY KEY (snapshot_id, date))`,
  `CREATE TABLE IF NOT EXISTS tiktok_campaigns (snapshot_id INTEGER, campaign_id TEXT, name TEXT, status TEXT, spend REAL, impressions INTEGER, clicks INTEGER, ctr REAL, conversions REAL, cost_per_conversion REAL, PRIMARY KEY (snapshot_id, campaign_id))`,
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

// Официального жёсткого лимита не встретили, но держим ту же глубину, что у остальных
// площадок (37 месяцев), для консистентности между кабинетами.
function historyFloor() {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() - 37);
  d.setUTCDate(d.getUTCDate() + 2);
  return d.toISOString().slice(0, 10);
}
const RECON_DAYS = Number(process.env.TT_RECON_DAYS) || 14;

// Reporting API с измерением stat_time_day ограничивает диапазон 30 днями за один
// запрос — режем произвольный диапазон на куски по 30 дней.
function chunk30(since, until) {
  const chunks = [];
  let s = since;
  while (s <= until) {
    const e = addDays(s, 29) > until ? until : addDays(s, 29);
    chunks.push([s, e]);
    s = addDays(e, 1);
  }
  return chunks;
}

async function knownDaily(conn) {
  const rs = await conn.execute(`
    SELECT td.* FROM tiktok_daily td
    JOIN (SELECT date, MAX(snapshot_id) AS sid FROM tiktok_daily GROUP BY date) latest
      ON td.date = latest.date AND td.snapshot_id = latest.sid
  `);
  const map = new Map();
  for (const r of rs.rows) map.set(String(r.date), r);
  return map;
}

// Несколько рекламных кабинетов объединяются в одну сводку (как у Meta/Google).
// TIKTOK_ADVERTISER_IDS — список через запятую; TIKTOK_ADVERTISER_ID — одиночный формат.
function advertiserIds() {
  const list = process.env.TIKTOK_ADVERTISER_IDS || process.env.TIKTOK_ADVERTISER_ID || "";
  return list.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function runTiktokSync(opts = {}) {
  loadEnv();
  const token = process.env.TIKTOK_ACCESS_TOKEN;
  const ADVS = advertiserIds();
  if (!token || !ADVS.length)
    throw new Error("Не хватает TikTok кредов в .env.local (TIKTOK_ACCESS_TOKEN, TIKTOK_ADVERTISER_ID(S)).");

  const until = opts.until || todayIso();
  const explicitDays = Number(opts.days) || Number(process.env.TT_DAYS) || 0;
  const requestedSince = opts.since || (explicitDays ? dateRange(explicitDays).since : historyFloor());
  const floor = historyFloor();
  const since = requestedSince < floor ? floor : requestedSince;

  // Разбивка по кампаниям — короткое окно, как у остальных площадок.
  const entityDays = explicitDays || Number(process.env.TT_ENTITY_DAYS) || 60;
  const sinceEntity = opts.since || dateRange(entityDays).since;

  const conn = db();
  await conn.batch(SCHEMA, "write");

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
  for (const adv of ADVS) {
    for (const [rs, ru] of fetchRanges) {
      for (const [cs, ce] of chunk30(rs, ru)) {
        const rows = await report(adv, "AUCTION_ADVERTISER", ["stat_time_day"],
          ["spend", "impressions", "clicks", "conversion"], cs, ce);
        for (const r of rows) {
          const d = String(r.dimensions.stat_time_day).slice(0, 10);
          const acc = freshByDate.get(d) || { date: d, spend: 0, impressions: 0, clicks: 0, conversions: 0 };
          acc.spend += num(r.metrics.spend); acc.impressions += num(r.metrics.impressions);
          acc.clicks += num(r.metrics.clicks); acc.conversions += num(r.metrics.conversion);
          freshByDate.set(d, acc);
        }
      }
    }
  }

  const daily = [];
  for (let d = since; d <= until; d = addDays(d, 1)) {
    if (freshByDate.has(d)) { daily.push(freshByDate.get(d)); continue; }
    const k = known.get(d);
    if (k) daily.push({ date: d, spend: num(k.spend), impressions: num(k.impressions), clicks: num(k.clicks), conversions: num(k.conversions) });
  }

  // Кампании — без stat_time_day лимит в 30 дней не действует, можно одним запросом
  // на весь sinceEntity..until. campaign_id уникален только внутри кабинета — префиксуем
  // advertiser_id, чтобы не столкнуть id кампаний разных кабинетов.
  const camps = [];
  for (const adv of ADVS) {
    const rows = await report(adv, "AUCTION_CAMPAIGN", ["campaign_id"],
      ["campaign_name", "spend", "impressions", "clicks", "conversion"], sinceEntity, until);
    for (const r of rows) {
      const spend = num(r.metrics.spend);
      const conversions = num(r.metrics.conversion);
      camps.push({
        id: `${adv}:${r.dimensions.campaign_id}`,
        name: r.metrics.campaign_name,
        status: "ACTIVE", // /campaign/get/ (статус) требует отдельный OAuth scope, которого нет — считаем активной, если был расход
        spend, impressions: num(r.metrics.impressions), clicks: num(r.metrics.clicks),
        ctr: num(r.metrics.impressions) ? (num(r.metrics.clicks) / num(r.metrics.impressions)) * 100 : 0,
        conversions,
        cost_per_conversion: conversions ? spend / conversions : 0,
      });
    }
  }

  const now = new Date().toISOString();
  const snap = await conn.execute({
    sql: "INSERT INTO tiktok_snapshots (advertiser_id, created_at, period_start, period_end, currency) VALUES (?,?,?,?,?)",
    args: [ADVS.join(","), now, sinceEntity, until, "USD"],
  });
  const snapId = Number(snap.lastInsertRowid);

  const stmts = [];
  for (const r of daily) stmts.push({ sql: "INSERT INTO tiktok_daily (snapshot_id,date,spend,impressions,clicks,conversions) VALUES (?,?,?,?,?,?)", args: [snapId, r.date, r.spend, r.impressions, r.clicks, r.conversions] });
  for (const r of camps) stmts.push({ sql: "INSERT INTO tiktok_campaigns (snapshot_id,campaign_id,name,status,spend,impressions,clicks,ctr,conversions,cost_per_conversion) VALUES (?,?,?,?,?,?,?,?,?,?)", args: [snapId, r.id, r.name, r.status, r.spend, r.impressions, r.clicks, r.ctr, r.conversions, r.cost_per_conversion] });
  if (stmts.length) await conn.batch(stmts, "write");

  return {
    snapshotId: snapId, since: sinceEntity, until,
    days: daily.filter((r) => r.date >= sinceEntity).length, campaigns: camps.length,
    dailyHistorySince: since, dailyHistoryDays: daily.length,
  };
}
