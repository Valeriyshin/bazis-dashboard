// Единая синхронизация: Graph API → БД (libSQL). Используется и кнопкой на сайте
// (/api/refresh), и локальным CLI (npm run sync). Пишет напрямую в Turso/файл, без JSON.
import { createClient } from "@libsql/client";
import fs from "node:fs";
import path from "node:path";

// --- env (.env.local для CLI; в Next уже загружен) ---
function loadEnv() {
  const p = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

function client() {
  const url = process.env.TURSO_DATABASE_URL || "file:./data/app.db";
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}

const API = "https://graph.facebook.com/v21.0";
const CORE = "spend,impressions,reach,frequency,clicks,cpc,cpm,ctr,actions";
const num = (v) => (v == null || v === "" ? 0 : Number(v));

async function fetchAll(url) {
  const out = [];
  let next = url;
  while (next) {
    const res = await fetch(next);
    const json = await res.json();
    if (json.error) throw new Error(json.error.message || "Graph API error");
    out.push(...(json.data ?? []));
    next = json.paging?.next ?? null;
  }
  return out;
}
function actionVal(row, type) {
  return Number((row.actions || []).find((a) => a.action_type === type)?.value ?? 0);
}
// Лиды: max по lead-типам (дедуп, НЕ сумма).
function leadsFrom(actions) {
  if (!Array.isArray(actions)) return 0;
  let n = 0;
  for (const a of actions)
    if (["lead", "onsite_conversion.lead_grouped", "leadgen_grouped"].includes(a.action_type)) n = Math.max(n, Number(a.value || 0));
  return n;
}
function resultInfo(row) {
  const obj = row.objective || "";
  const spend = num(row.spend);
  if (obj.includes("LEADS")) { const l = leadsFrom(row.actions); return { results: l, result_type: "Лиды", cost_per_result: l ? spend / l : 0 }; }
  if (obj.includes("AWARENESS")) { const r = num(row.reach); return { results: r, result_type: "Охват", cost_per_result: r ? (spend / r) * 1000 : 0 }; }
  const c = num(row.clicks); return { results: c, result_type: "Клики", cost_per_result: c ? spend / c : 0 };
}
function base(row) {
  return {
    spend: num(row.spend), impressions: num(row.impressions), reach: num(row.reach),
    frequency: num(row.frequency), clicks: num(row.clicks), cpc: num(row.cpc), cpm: num(row.cpm),
    ctr: num(row.ctr), page_engagement: actionVal(row, "page_engagement"), link_click: actionVal(row, "link_click"),
  };
}
const st = (s) => (s === "ACTIVE" ? "ACTIVE" : "PAUSED");

function buildSummary(daily, campaigns, results, since, until) {
  const money = (n) => "$" + Math.round(n).toLocaleString("ru-RU");
  const money2 = (n) => "$" + Number(n).toFixed(2);
  const totalSpend = daily.reduce((s, r) => s + r.spend, 0);
  const leadCamps = campaigns.filter((c) => results[c.id]?.result_type === "Лиды");
  const totalLeads = leadCamps.reduce((s, c) => s + (results[c.id]?.results || 0), 0);
  const leadSpend = leadCamps.reduce((s, c) => s + c.spend, 0);
  const avgCPL = totalLeads ? leadSpend / totalLeads : 0;
  const half = Math.floor(daily.length / 2);
  const sp1 = daily.slice(0, half).reduce((s, r) => s + r.spend, 0);
  const sp2 = daily.slice(half).reduce((s, r) => s + r.spend, 0);
  const spTrend = sp1 ? ((sp2 - sp1) / sp1) * 100 : 0;
  const byLeads = [...leadCamps].sort((a, b) => (results[b.id].results || 0) - (results[a.id].results || 0));
  const active = leadCamps.filter((c) => (results[c.id].results || 0) >= 20);
  const cheap = [...active].sort((a, b) => (results[a.id].cost_per_result || 1e9) - (results[b.id].cost_per_result || 1e9)).slice(0, 3);
  const pricey = [...active].sort((a, b) => (results[b.id].cost_per_result || 0) - (results[a.id].cost_per_result || 0)).slice(0, 3);
  const short = (n) => n.split("|")[0].trim().slice(0, 34);
  const line = (c) => `${short(c.name)} — ${results[c.id].results} лид., CPL ${money2(results[c.id].cost_per_result)}`;
  return {
    period: `${since} — ${until}`,
    main: [
      `<b>Расход за период:</b> ${money(totalSpend)} за ${daily.length} дн. Динамика открутки: ${spTrend >= 0 ? "рост" : "снижение"} на <b>${Math.abs(spTrend).toFixed(0)}%</b> во второй половине относительно первой.`,
      `<b>Лидов получено:</b> ${totalLeads.toLocaleString("ru-RU")} по ${leadCamps.length} лид-кампаниям. Средний CPL — <b>${money2(avgCPL)}</b>.`,
      `<b>Расход на лидогенерацию:</b> ${money(leadSpend)} (${totalSpend ? Math.round((leadSpend / totalSpend) * 100) : 0}% бюджета).`,
    ],
    money: [
      `<b>Больше всего лидов:</b> ${byLeads.slice(0, 3).map(line).join("; ")}.`,
      cheap.length ? `<b>Самый дешёвый лид</b> (от 20 лид.): ${cheap.map(line).join("; ")}.` : "",
      pricey.length ? `<b>Самый дорогой лид:</b> ${pricey.map(line).join("; ")}.` : "",
    ].filter(Boolean),
    recommendations: [
      "Перераспределить бюджет в пользу кампаний с низким CPL, сократить самые дорогие связки.",
      "Следить за частотой: при значениях выше ~3 обновлять креативы/аудитории.",
      "Проверить кампании с нулевым результатом в периоде — отключить или перезапустить.",
    ],
    note: `Данные за ${since} — ${until}. Все метрики из Graph API. «Результат» = цель кампании (лиды или охват). Conversions/ROAS в кабинете недоступны. Цифры рассчитаны автоматически.`,
  };
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS snapshots (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT, account_name TEXT, created_at TEXT, period_start TEXT, period_end TEXT, currency TEXT DEFAULT 'USD')`,
  `CREATE TABLE IF NOT EXISTS daily_insights (snapshot_id INTEGER, date TEXT, spend REAL, impressions INTEGER, reach INTEGER, frequency REAL, clicks INTEGER, cpc REAL, cpm REAL, cpp REAL, ctr REAL, page_engagement INTEGER, link_click INTEGER, leads INTEGER, PRIMARY KEY (snapshot_id, date))`,
  `CREATE TABLE IF NOT EXISTS campaign_insights (snapshot_id INTEGER, campaign_id TEXT, name TEXT, objective TEXT, status TEXT, spend REAL, impressions INTEGER, reach INTEGER, frequency REAL, clicks INTEGER, cpc REAL, cpm REAL, ctr REAL, page_engagement INTEGER, link_click INTEGER, results REAL, result_type TEXT, cost_per_result REAL, PRIMARY KEY (snapshot_id, campaign_id))`,
  `CREATE TABLE IF NOT EXISTS adset_insights (snapshot_id INTEGER, adset_id TEXT, campaign_id TEXT, name TEXT, status TEXT, spend REAL, impressions INTEGER, reach INTEGER, frequency REAL, clicks INTEGER, cpc REAL, cpm REAL, ctr REAL, page_engagement INTEGER, link_click INTEGER, results REAL, result_type TEXT, cost_per_result REAL, PRIMARY KEY (snapshot_id, adset_id))`,
  `CREATE TABLE IF NOT EXISTS ad_insights (snapshot_id INTEGER, ad_id TEXT, campaign_id TEXT, adset_id TEXT, name TEXT, status TEXT, spend REAL, impressions INTEGER, reach INTEGER, frequency REAL, clicks INTEGER, cpc REAL, cpm REAL, ctr REAL, page_engagement INTEGER, link_click INTEGER, results REAL, result_type TEXT, cost_per_result REAL, PRIMARY KEY (snapshot_id, ad_id))`,
  `CREATE TABLE IF NOT EXISTS summaries (snapshot_id INTEGER PRIMARY KEY, body TEXT, author TEXT DEFAULT 'Claude', created_at TEXT)`,
];

function dateRange(days) {
  const until = new Date();
  const since = new Date(until.getTime() - (days - 1) * 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  return { since: iso(since), until: iso(until) };
}

// Несколько рекламных аккаунтов одного клиента объединяются в одну сводку.
// FB_AD_ACCOUNT_IDS — список через запятую; FB_AD_ACCOUNT_ID — старый одиночный формат,
// поддержан для обратной совместимости.
function accountIds() {
  const list = process.env.FB_AD_ACCOUNT_IDS || process.env.FB_AD_ACCOUNT_ID || "1201997914797230";
  return list.split(",").map((s) => s.trim()).filter(Boolean);
}

// Один аккаунт → { name, daily, camps, adsets, ads, campStatus, adsetStatus, adStatus }.
async function fetchAccount(acc, TOKEN, tr) {
  const q = (extra) => `${API}/act_${acc}/insights?time_range=${tr}&limit=500&${extra}&access_token=${TOKEN}`;
  const statusMap = async (edge) => {
    const rows = await fetchAll(`${API}/act_${acc}/${edge}?fields=id,effective_status&limit=500&access_token=${TOKEN}`);
    return Object.fromEntries(rows.map((r) => [r.id, st(r.effective_status)]));
  };
  const [info, daily, camps, adsets, ads, campStatus, adsetStatus, adStatus] = await Promise.all([
    fetch(`${API}/act_${acc}?fields=name&access_token=${TOKEN}`).then((r) => r.json()),
    fetchAll(q(`time_increment=1&fields=${CORE},cpp`)),
    fetchAll(q(`level=campaign&fields=campaign_id,campaign_name,objective,${CORE}`)),
    fetchAll(q(`level=adset&fields=adset_id,adset_name,campaign_id,objective,${CORE}`)),
    fetchAll(q(`level=ad&fields=ad_id,ad_name,campaign_id,adset_id,objective,${CORE}`)),
    statusMap("campaigns"), statusMap("adsets"), statusMap("ads"),
  ]);
  return { acc, name: info.name || acc, daily, camps, adsets, ads, campStatus, adsetStatus, adStatus };
}

// Суммирует дневные метрики нескольких аккаунтов по одной дате. Frequency/CTR/CPC/CPM
// пересчитываются из просуммированных базовых величин, а не усредняются "в лоб" —
// иначе при разных объёмах аккаунтов среднее было бы смещено в пользу меньшего.
// Reach при этом складывается арифметически: пересечение аудиторий между двумя
// аккаунтами Graph API не отдаёт, так что уникальный охват по факту будет чуть ниже.
function mergeDaily(perAccount) {
  const byDate = new Map();
  for (const { daily } of perAccount) {
    for (const r of daily) {
      const d = r.date_start;
      const acc = byDate.get(d) || { date: d, spend: 0, impressions: 0, reach: 0, clicks: 0, page_engagement: 0, link_click: 0, leads: 0 };
      acc.spend += num(r.spend); acc.impressions += num(r.impressions); acc.reach += num(r.reach);
      acc.clicks += num(r.clicks); acc.page_engagement += actionVal(r, "page_engagement");
      acc.link_click += actionVal(r, "link_click"); acc.leads += leadsFrom(r.actions);
      byDate.set(d, acc);
    }
  }
  return [...byDate.values()].map((r) => ({
    ...r,
    frequency: r.reach ? r.impressions / r.reach : 0,
    cpc: r.clicks ? r.spend / r.clicks : 0,
    cpm: r.impressions ? (r.spend / r.impressions) * 1000 : 0,
    cpp: r.reach ? (r.spend / r.reach) * 1000 : 0,
    ctr: r.impressions ? (r.clicks / r.impressions) * 100 : 0,
  }));
}

// Главная функция. opts: {since, until, days}. Возвращает счётчики.
export async function runSync(opts = {}) {
  loadEnv();
  const TOKEN = process.env.FB_ACCESS_TOKEN;
  const ACCOUNTS = accountIds();
  if (!TOKEN) throw new Error("Нет FB_ACCESS_TOKEN (.env.local или переменные Vercel).");

  const days = Number(opts.days) || Number(process.env.FB_DAYS) || 60;
  const since = opts.since || process.env.FB_SINCE || dateRange(days).since;
  const until = opts.until || process.env.FB_UNTIL || dateRange(days).until;
  const tr = encodeURIComponent(JSON.stringify({ since, until }));

  const perAccount = await Promise.all(ACCOUNTS.map((acc) => fetchAccount(acc, TOKEN, tr)));

  const dailyRows = mergeDaily(perAccount);
  const results = {};
  const campRows = [], adsetRows = [], adRows = [];
  for (const a of perAccount) {
    for (const r of a.camps) { const ri = resultInfo(r); results[r.campaign_id] = ri; campRows.push({ id: r.campaign_id, name: r.campaign_name, objective: r.objective || "", status: a.campStatus[r.campaign_id] ?? "PAUSED", ...base(r), ...ri }); }
    for (const r of a.adsets) adsetRows.push({ id: r.adset_id, campaign_id: r.campaign_id, name: r.adset_name, status: a.adsetStatus[r.adset_id] ?? "PAUSED", ...base(r), ...resultInfo(r) });
    for (const r of a.ads) adRows.push({ id: r.ad_id, campaign_id: r.campaign_id, adset_id: r.adset_id, name: r.ad_name, status: a.adStatus[r.ad_id] ?? "PAUSED", ...base(r), ...resultInfo(r) });
  }
  const summary = buildSummary(dailyRows, campRows, results, since, until);

  const db = client();
  await db.batch(SCHEMA, "write");
  // Миграция для уже созданных БД: добавить колонку leads, если её ещё нет.
  try { await db.execute("ALTER TABLE daily_insights ADD COLUMN leads INTEGER"); } catch { /* уже есть */ }

  const now = new Date().toISOString();
  const snapRes = await db.execute({
    sql: "INSERT INTO snapshots (account_id, account_name, created_at, period_start, period_end, currency) VALUES (?,?,?,?,?,?)",
    args: [ACCOUNTS.join(","), perAccount.map((a) => a.name).join(" + "), now, since, until, "USD"],
  });
  const snapId = Number(snapRes.lastInsertRowid);

  const stmts = [];
  for (const r of dailyRows) stmts.push({ sql: "INSERT INTO daily_insights (snapshot_id,date,spend,impressions,reach,frequency,clicks,cpc,cpm,cpp,ctr,page_engagement,link_click,leads) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [snapId, r.date, r.spend, r.impressions, r.reach, r.frequency, r.clicks, r.cpc, r.cpm, r.cpp, r.ctr, r.page_engagement, r.link_click, r.leads] });
  for (const r of campRows) stmts.push({ sql: "INSERT INTO campaign_insights (snapshot_id,campaign_id,name,objective,status,spend,impressions,reach,frequency,clicks,cpc,cpm,ctr,page_engagement,link_click,results,result_type,cost_per_result) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [snapId, r.id, r.name, r.objective, r.status, r.spend, r.impressions, r.reach, r.frequency, r.clicks, r.cpc, r.cpm, r.ctr, r.page_engagement, r.link_click, r.results, r.result_type, r.cost_per_result] });
  for (const r of adsetRows) stmts.push({ sql: "INSERT INTO adset_insights (snapshot_id,adset_id,campaign_id,name,status,spend,impressions,reach,frequency,clicks,cpc,cpm,ctr,page_engagement,link_click,results,result_type,cost_per_result) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [snapId, r.id, r.campaign_id, r.name, r.status, r.spend, r.impressions, r.reach, r.frequency, r.clicks, r.cpc, r.cpm, r.ctr, r.page_engagement, r.link_click, r.results, r.result_type, r.cost_per_result] });
  for (const r of adRows) stmts.push({ sql: "INSERT INTO ad_insights (snapshot_id,ad_id,campaign_id,adset_id,name,status,spend,impressions,reach,frequency,clicks,cpc,cpm,ctr,page_engagement,link_click,results,result_type,cost_per_result) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", args: [snapId, r.id, r.campaign_id, r.adset_id, r.name, r.status, r.spend, r.impressions, r.reach, r.frequency, r.clicks, r.cpc, r.cpm, r.ctr, r.page_engagement, r.link_click, r.results, r.result_type, r.cost_per_result] });
  stmts.push({ sql: "INSERT INTO summaries (snapshot_id, body, author, created_at) VALUES (?,?,?,?)", args: [snapId, JSON.stringify(summary), "Claude", now] });

  await db.batch(stmts, "write");
  return { snapshotId: snapId, since, until, days: dailyRows.length, campaigns: campRows.length, adsets: adsetRows.length, ads: adRows.length };
}
