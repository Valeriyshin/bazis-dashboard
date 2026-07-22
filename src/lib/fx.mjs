// Курсы USD/KZT от Нацбанка РК. Считаем СРЕДНЕМЕСЯЧНЫЙ курс и кэшируем в БД,
// чтобы не дёргать API на каждый запрос.
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
  loadEnv();
  const url = process.env.TURSO_DATABASE_URL || "file:./data/app.db";
  return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
}

const FALLBACK = Number(process.env.KZT_USD_RATE) || 500;

// Курс USD на конкретную дату (НБ РК). Возвращает null, если не отдал.
async function rateOnDate(d) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const url = `https://nationalbank.kz/rss/get_rates.cfm?fdate=${dd}.${mm}.${d.getFullYear()}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const xml = await res.text();
    for (const chunk of xml.split("<item>")) {
      if (!/<title>\s*USD\s*<\/title>/i.test(chunk)) continue;
      const m = chunk.match(/<description>\s*([\d.,]+)\s*<\/description>/i);
      if (m) {
        const v = Number(m[1].replace(",", "."));
        if (Number.isFinite(v) && v > 0) return v;
      }
    }
  } catch { /* сеть/таймаут — вернём null */ }
  return null;
}

// Среднемесячный курс: выборка по дням (1,5,10,15,20,25,28) — этого достаточно
// для средней и не создаёт 30 запросов на месяц.
async function fetchMonthlyAverage(year, month) {
  const days = [1, 5, 10, 15, 20, 25, 28];
  const vals = [];
  for (const day of days) {
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d > new Date()) break; // будущее не запрашиваем
    const r = await rateOnDate(d);
    if (r) vals.push(r);
  }
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

async function ensureTable(conn) {
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS fx_monthly (month TEXT PRIMARY KEY, rate REAL, updated_at TEXT)`
  );
}

// Курс месяца с кэшем. month = "YYYY-MM".
async function monthlyRate(conn, month) {
  const rs = await conn.execute({ sql: "SELECT rate FROM fx_monthly WHERE month=?", args: [month] });
  if (rs.rows.length) return Number(rs.rows[0][0]);
  const [y, m] = month.split("-").map(Number);
  const avg = await fetchMonthlyAverage(y, m);
  if (!avg) return null;
  await conn.execute({
    sql: "INSERT OR REPLACE INTO fx_monthly (month, rate, updated_at) VALUES (?,?,?)",
    args: [month, avg, new Date().toISOString()],
  });
  return avg;
}

// Эффективный курс за период: среднее месячных курсов, взвешенное по числу дней
// периода, попавших в каждый месяц.
export async function getPeriodRate(since, until) {
  const conn = db();
  await ensureTable(conn);

  const start = new Date(since + "T00:00:00Z");
  const end = new Date(until + "T00:00:00Z");
  if (isNaN(start) || isNaN(end) || end < start) return { rate: FALLBACK, months: [], fallback: true };

  // Сколько дней периода приходится на каждый месяц.
  const weight = {};
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    weight[key] = (weight[key] || 0) + 1;
  }

  const months = [];
  let sum = 0, total = 0;
  for (const [month, days] of Object.entries(weight)) {
    const r = await monthlyRate(conn, month);
    if (!r) continue;
    months.push({ month, rate: Math.round(r * 100) / 100, days });
    sum += r * days;
    total += days;
  }
  if (!total) return { rate: FALLBACK, months: [], fallback: true };
  return { rate: Math.round((sum / total) * 100) / 100, months, fallback: false };
}
