"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
import {
  METRICS, METRIC_BY_KEY, DEFAULT_KPI_KEYS, DailyRow,
  sumRows, metricValue, formatMetric, delta,
} from "@/lib/metrics";

interface Entity {
  campaign_id?: string; adset_id?: string; ad_id?: string; name: string; status: string;
  spend: number; impressions: number; reach: number; frequency: number;
  clicks: number; cpc: number; cpm: number; ctr: number; page_engagement: number; link_click: number;
}
interface SummaryData { period: string; main: string[]; money: string[]; recommendations: string[]; note: string }
interface ApiData {
  snapshot: { account_name: string; account_id: string; period_start: string; period_end: string; created_at: string; currency: string };
  daily: DailyRow[];
  campaigns: Entity[];
  adsets: Entity[];
  ads: Entity[];
  summary: { author: string; created_at: string; data: SummaryData | null } | null;
}

const TABS = ["Обзор", "Meta", "Сводка", "Google Ads"] as const;
type Tab = (typeof TABS)[number];
const LINE_COLORS = ["#4f8cff", "#34d399", "#f59e0b", "#f87171", "#a78bfa", "#22d3ee", "#f472b6", "#facc15", "#60a5fa", "#4ade80", "#fb923c"];

function fmtDate(d: string) {
  return new Date(d).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

export default function Page() {
  const [data, setData] = useState<ApiData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("Обзор");

  useEffect(() => {
    fetch("/api/data").then((r) => r.json()).then((d) => {
      if (d.error) setError(d.error); else setData(d);
    }).catch((e) => setError(String(e)));
  }, []);

  if (error) return <div className="wrap"><div className="panel err">Ошибка: {error}<div className="muted" style={{ marginTop: 8 }}>Проверьте <code>npm run seed</code>.</div></div></div>;
  if (!data) return <div className="wrap"><div className="center muted">Загрузка данных…</div></div>;

  return (
    <div className="wrap">
      <div className="topbar">
        <div>
          <div className="title">📊 {data.snapshot.account_name}</div>
          <div className="subtitle">
            Кабинет {data.snapshot.account_id} · {fmtDate(data.snapshot.period_start)} — {fmtDate(data.snapshot.period_end)} · {data.snapshot.currency}
          </div>
        </div>
        <RefreshBar snapshot={data.snapshot} />
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t} className={"tab" + (tab === t ? " active" : "")} onClick={() => setTab(t)}>{t}</div>
        ))}
      </div>

      {tab === "Обзор" && <><OverviewCompare daily={data.daily} /><ZhkSummary metaCampaigns={data.campaigns} /></>}
      {tab === "Meta" && <><Dynamics daily={data.daily} /><Breakdown campaigns={data.campaigns} adsets={data.adsets} ads={data.ads} snapshot={data.snapshot} /></>}
      {tab === "Сводка" && <Summary summary={data.summary} />}
      {tab === "Google Ads" && <GoogleAds metaPeriod={{ start: data.snapshot.period_start, end: data.snapshot.period_end }} />}
    </div>
  );
}

/* ============ Сводка по ЖК (все системы) ============ */
interface ZhkAgg { impressions: number; reach: number; clicks: number; leads: number; spend: number; typeSpend: Record<string, number> }
function newAgg(): ZhkAgg { return { impressions: 0, reach: 0, clicks: 0, leads: 0, spend: 0, typeSpend: {} }; }
// Сегменты названия, которые точно НЕ являются ЖК (города, форматы, цели, бренд).
const ZHK_STOP = new Set([
  "Алматы", "Астана", "Шымкент", "Караганда", "Актобе", "Атырау",
  "Search", "Общий Поиск", "Поиск", "Bazis-A", "Bazis", "BAZIS",
  "РУС", "КАЗ", "CPA", "CPL", "CPM", "CPV", "CPE",
  "Лиды", "Охват", "Вовлеченность", "Вовлечённость", "Лидген формы",
  "YT Shorts", "YT InStream", "YouTube Multiple Formats", "Adv", "Adv+", "Wide", "LAL",
]);
const segs = (name: string) => String(name).split("|").map((s) => s.trim()).filter(Boolean);

// Базовый разбор: первый «содержательный» сегмент начиная с 3-й позиции.
function zhkOf(name: string): string {
  const p = segs(name);
  for (let i = 2; i < p.length; i++) if (!ZHK_STOP.has(p[i])) return p[i];
  return p[2] || p[1] || "Прочее";
}

// Умный разбор: сначала ищем совпадение с уже известными ЖК (нейминг Meta стабильнее),
// иначе — базовый разбор. Нужно из-за разнобоя в названиях Google (ЖК бывает на 3-й и на 4-й позиции).
function resolveZhk(name: string, known: Set<string>): string {
  const p = segs(name);
  // 1) точное совпадение сегмента с известным ЖК
  for (const s of p) if (known.has(s)) return s;
  // 2) известный ЖК как отдельное слово внутри сегмента («HUB ALMATY» → «HUB»,
  //    «Benelux, A club» → «Benelux»). Сегмент 0 пропускаем — там код кампании.
  let best: string | null = null;
  for (const s of p.slice(1)) {
    for (const k of known) {
      if (k.length < 3) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\p{L}\\p{N}]|$)`, "iu");
      if (re.test(s) && (!best || k.length > best.length)) best = k;
    }
    if (best) return best;
  }
  return zhkOf(name);
}
function domType(ts: Record<string, number>): string {
  const e = Object.entries(ts).sort((a, b) => b[1] - a[1])[0];
  return e ? e[0] : "—";
}

const money0 = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 0 });
const int0 = (n: number) => Math.round(n).toLocaleString("ru-RU");
// Столбцы сводки по ЖК. get(agg) → число; fmt форматирует. type — особый (не число).
const ZHK_COLS = [
  { key: "type", label: "Тип кампании", type: true },
  { key: "impressions", label: "Показы", get: (a: ZhkAgg) => a.impressions, fmt: int0 },
  { key: "reach", label: "Охват", get: (a: ZhkAgg) => a.reach, fmt: (n: number) => (n ? int0(n) : "—") },
  { key: "clicks", label: "Клики", get: (a: ZhkAgg) => a.clicks, fmt: int0 },
  { key: "ctr", label: "CTR", get: (a: ZhkAgg) => (a.impressions ? (a.clicks / a.impressions) * 100 : 0), fmt: (n: number) => (n ? n.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%" : "—") },
  { key: "leads", label: "Кол-во лидов", get: (a: ZhkAgg) => a.leads, fmt: int0 },
  { key: "cpl", label: "Цена лида", get: (a: ZhkAgg) => (a.leads ? a.spend / a.leads : 0), fmt: (n: number) => (n ? "$" + n.toFixed(2) : "—") },
  { key: "spend", label: "Расход", get: (a: ZhkAgg) => a.spend, fmt: money0 },
] as const;
const ZHK_DEFAULT = ["type", "impressions", "reach", "clicks", "ctr", "leads", "cpl", "spend"];

function ZhkSummary({ metaCampaigns }: { metaCampaigns: Entity[] }) {
  const [google, setGoogle] = useState<GCampaign[] | null>(null);
  const [cols, setCols] = useState<string[]>(ZHK_DEFAULT);
  useEffect(() => {
    fetch("/api/google").then((r) => r.json()).then((d) => setGoogle(d.error ? [] : d.campaigns)).catch(() => setGoogle([]));
  }, []);
  const [sortKey, setSortKey] = useState<string>("spend");
  const [asc, setAsc] = useState(false);
  const active = ZHK_COLS.filter((c) => cols.includes(c.key));
  const toggle = (k: string) => setCols(cols.includes(k) ? cols.filter((x) => x !== k) : [...cols, k]);
  const setSort = (k: string) => { if (k === sortKey) setAsc(!asc); else { setSortKey(k); setAsc(false); } };
  // Числовое значение столбца по агрегату (для сортировки ЖК).
  const colVal = (key: string, a: ZhkAgg) => {
    const c = ZHK_COLS.find((x) => x.key === key) as { get?: (a: ZhkAgg) => number } | undefined;
    return c?.get ? c.get(a) : a.spend;
  };

  // group[ЖК][система] = ZhkAgg
  const group: Record<string, Record<string, ZhkAgg>> = {};
  // Ключ строки — система + тип кампании (Поиск / YouTube / КМС / Лиды / Охват),
  // чтобы каждый тип был отдельной строкой и ничего не терялось.
  const add = (zhk: string, sys: string, patch: Partial<ZhkAgg> & { type?: string }) => {
    (group[zhk] ??= {});
    const key = `${sys} ${patch.type || "—"}`;
    const a = (group[zhk][key] ??= newAgg());
    a.impressions += patch.impressions ?? 0; a.reach += patch.reach ?? 0; a.clicks += patch.clicks ?? 0;
    a.leads += patch.leads ?? 0; a.spend += patch.spend ?? 0;
    if (patch.type) a.typeSpend[patch.type] = (a.typeSpend[patch.type] ?? 0) + (patch.spend ?? 0);
  };
  // Известные ЖК берём из Meta — там нейминг последовательный.
  const known = new Set(metaCampaigns.map((c) => zhkOf(c.name)).filter((z) => z && z !== "Прочее"));

  for (const c of metaCampaigns) {
    const cc = c as unknown as Record<string, number | string>;
    add(resolveZhk(c.name, known), "Meta", {
      impressions: +cc.impressions, reach: +cc.reach, clicks: +cc.clicks,
      leads: cc.result_type === "Лиды" ? +cc.results : 0, spend: +cc.spend,
      type: (cc.result_type as string) || "—",
    });
  }
  for (const c of google ?? []) {
    const gc = c as unknown as Record<string, unknown>;
    add(resolveZhk(c.name, known), "Google Ads", {
      impressions: c.impressions, reach: 0, clicks: c.clicks, leads: c.conversions, spend: c.spend,
      type: (gc.channel as string) || "—",
    });
  }

  const SYS_ICON: Record<string, string> = { "Google Ads": "🔴", Meta: "🔵", TikTok: "⚫" };
  const cell = (c: (typeof ZHK_COLS)[number], a: ZhkAgg, isType: boolean) =>
    "type" in c && c.type ? (isType ? domType(a.typeSpend) : "—") : (c as { get: (a: ZhkAgg) => number; fmt: (n: number) => string }).fmt((c as { get: (a: ZhkAgg) => number }).get(a));

  // Итог по каждому ЖК (для сортировки).
  const zhkTotal: Record<string, ZhkAgg> = {};
  for (const zhk of Object.keys(group)) {
    const t = newAgg();
    for (const a of Object.values(group[zhk])) { t.impressions += a.impressions; t.reach += a.reach; t.clicks += a.clicks; t.leads += a.leads; t.spend += a.spend; }
    zhkTotal[zhk] = t;
  }
  const zhks = Object.keys(group).sort((x, y) => {
    const d = colVal(sortKey, zhkTotal[x]) - colVal(sortKey, zhkTotal[y]);
    return asc ? d : -d;
  });

  const grand = newAgg();
  const rows: React.ReactNode[] = [];
  for (const zhk of zhks) {
    const systems = group[zhk];
    const sub = newAgg();
    for (const key of Object.keys(systems).sort((x, y) => systems[y].spend - systems[x].spend)) {
      const a = systems[key];
      const sys = key.startsWith("Google Ads") ? "Google Ads" : key.startsWith("Meta") ? "Meta" : "TikTok";
      const typeLabel = key.slice(sys.length + 1) || "—";
      sub.impressions += a.impressions; sub.reach += a.reach; sub.clicks += a.clicks; sub.leads += a.leads; sub.spend += a.spend;
      rows.push(
        <tr key={zhk + key}>
          <td>{zhk}</td>
          <td style={{ whiteSpace: "nowrap" }}>{SYS_ICON[sys] ?? ""} {sys}</td>
          {active.map((c) => <td key={c.key}>{"type" in c && c.type ? typeLabel : cell(c, a, true)}</td>)}
        </tr>
      );
    }
    grand.impressions += sub.impressions; grand.reach += sub.reach; grand.clicks += sub.clicks; grand.leads += sub.leads; grand.spend += sub.spend;
    rows.push(
      <tr key={zhk + "_total"} style={{ fontWeight: 700, background: "var(--panel-2)" }}>
        <td>Итого {zhk}</td><td>—</td>
        {active.map((c) => <td key={c.key}>{cell(c, sub, false)}</td>)}
      </tr>
    );
  }

  return (
    <div className="panel">
      <div className="panel-title">Сводные данные по всем ЖК за период {google === null && <span className="muted">(загрузка Google…)</span>}</div>
      <div style={{ marginBottom: 14 }}>
        <div className="panel-title" style={{ fontSize: 13 }}>Столбцы</div>
        <div className="chips">
          {ZHK_COLS.map((c) => (
            <div key={c.key} className={"chip" + (cols.includes(c.key) ? " on" : "")} onClick={() => toggle(c.key)}>{c.label}</div>
          ))}
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr>
            <th>ЖК</th><th>Система</th>
            {active.map((c) => (
              <th key={c.key} onClick={() => setSort(c.key)} style={{ cursor: "pointer" }}>
                {c.label}{sortKey === c.key ? (asc ? " ▲" : " ▼") : ""}
              </th>
            ))}
          </tr></thead>
          <tbody>
            {rows}
            <tr style={{ fontWeight: 700, borderTop: "2px solid var(--accent)" }}>
              <td>Общий итог</td><td>—</td>
              {active.map((c) => <td key={c.key}>{cell(c, grand, false)}</td>)}
            </tr>
          </tbody>
        </table>
      </div>
      <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
        ЖК определяется как 3-е значение в названии кампании. «Лиды»: Meta — лид-формы, Google — конверсии. Охват Google API не отдаёт (—). TikTok подключим отдельно.
      </div>
    </div>
  );
}

/* ============ Google Ads ============ */
interface GCampaign {
  campaign_id: string; name: string; status: string;
  spend: number; impressions: number; clicks: number; ctr: number; cpc: number;
  conversions: number; cost_per_conversion: number;
}
interface GData {
  snapshot: { customer_id: string; period_start: string; period_end: string; created_at: string; currency: string };
  daily: { date: string; spend: number; impressions: number; clicks: number; conversions: number }[];
  campaigns: GCampaign[];
}
function GoogleAds({ metaPeriod }: { metaPeriod?: { start: string; end: string } }) {
  const [g, setG] = useState<GData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<"spend" | "clicks" | "conversions" | "impressions">("spend");
  const [sortKey, setSortKey] = useState<keyof GCampaign>("spend");
  const [asc, setAsc] = useState(false);
  const [cols, setCols] = useState<string[]>(["spend", "conversions", "cost_per_conversion", "clicks", "ctr", "cpc", "impressions"]);
  const [mode, setMode] = useState<"stats" | "compare">("stats");

  useEffect(() => {
    fetch("/api/google").then((r) => r.json()).then((d) => { d.error ? setErr(d.error) : setG(d); }).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="panel err">Ошибка: {err}<div className="muted" style={{ marginTop: 8 }}>Запустите <code>npm run sync:google</code>.</div></div>;
  if (!g) return <div className="center muted">Загрузка Google Ads…</div>;

  const T = g.daily.reduce((a, r) => ({ spend: a.spend + r.spend, impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks, conversions: a.conversions + r.conversions }), { spend: 0, impressions: 0, clicks: 0, conversions: 0 });
  const money = (n: number) => "$" + n.toLocaleString("ru-RU", { maximumFractionDigits: n < 100 ? 2 : 0 });
  const int = (n: number) => Math.round(n).toLocaleString("ru-RU");
  const cpa = T.conversions ? T.spend / T.conversions : 0;
  const ctr = T.impressions ? (T.clicks / T.impressions) * 100 : 0;
  const cpc = T.clicks ? T.spend / T.clicks : 0;

  const kpis = [
    { l: "Расход", v: money(T.spend) },
    { l: "Конверсии", v: int(T.conversions) },
    { l: "CPA (цена конв.)", v: money(cpa) },
    { l: "Клики", v: int(T.clicks) },
    { l: "CTR", v: ctr.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%" },
    { l: "CPC", v: money(cpc) },
    { l: "Показы", v: int(T.impressions) },
  ];
  const METR = [
    { k: "spend", l: "Расход" }, { k: "conversions", l: "Конверсии" }, { k: "clicks", l: "Клики" }, { k: "impressions", l: "Показы" },
  ] as const;
  const chart = g.daily.map((r) => ({ date: new Date(r.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" }), value: r[metric] }));

  const sorted = [...g.campaigns].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (typeof av === "number" && typeof bv === "number") return asc ? av - bv : bv - av;
    return asc ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
  });
  const setSort = (k: keyof GCampaign) => { if (k === sortKey) setAsc(!asc); else { setSortKey(k); setAsc(false); } };
  const COLS: { k: keyof GCampaign; l: string; f: (n: number) => string }[] = [
    { k: "spend", l: "Расход", f: money }, { k: "conversions", l: "Конв.", f: int },
    { k: "cost_per_conversion", l: "CPA", f: money }, { k: "clicks", l: "Клики", f: int },
    { k: "ctr", l: "CTR", f: (n) => n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%" },
    { k: "cpc", l: "CPC", f: money }, { k: "impressions", l: "Показы", f: int },
  ];
  const activeCols = COLS.filter((c) => cols.includes(c.k));
  const toggleCol = (k: string) => setCols(cols.includes(k) ? cols.filter((x) => x !== k) : [...cols, k]);

  const stale = metaPeriod && (metaPeriod.start !== g.snapshot.period_start || metaPeriod.end !== g.snapshot.period_end);

  return (
    <>
      {stale && (
        <div className="panel" style={{ borderColor: "var(--bad)" }}>
          <b className="err">⚠ Период не совпадает с выбранным</b>
          <div className="muted" style={{ marginTop: 6, fontSize: 12 }}>
            Выбран {new Date(metaPeriod!.start).toLocaleDateString("ru-RU")} — {new Date(metaPeriod!.end).toLocaleDateString("ru-RU")},
            а данные Google Ads за {new Date(g.snapshot.period_start).toLocaleDateString("ru-RU")} — {new Date(g.snapshot.period_end).toLocaleDateString("ru-RU")}.
            Нажмите <b>↻ Обновить</b> в шапке, чтобы перевыгрузить обе системы за один период.
          </div>
        </div>
      )}
      <div className="panel">
        <div className="chips">
          <div className={"chip" + (mode === "stats" ? " on" : "")} onClick={() => setMode("stats")}>Показатели</div>
          <div className={"chip" + (mode === "compare" ? " on" : "")} onClick={() => setMode("compare")}>Сравнение периодов</div>
        </div>
      </div>

      {mode === "compare" && <GoogleCompare metaPeriod={metaPeriod} />}
      {mode === "stats" && (<>
      <div className="panel">
        <div className="panel-title">Google Ads · {g.snapshot.customer_id} · {new Date(g.snapshot.period_start).toLocaleDateString("ru-RU")} — {new Date(g.snapshot.period_end).toLocaleDateString("ru-RU")}</div>
        <div className="kpi-grid">
          {kpis.map((k) => (<div className="kpi" key={k.l}><div className="label">{k.l}</div><div className="value">{k.v}</div></div>))}
        </div>
      </div>

      <div className="panel">
        <div className="controls">
          <div className="field"><label>Метрика графика</label>
            <select value={metric} onChange={(e) => setMetric(e.target.value as typeof metric)}>
              {METR.map((m) => <option key={m.k} value={m.k}>{m.l}</option>)}
            </select>
          </div>
        </div>
        <ResponsiveContainer width="100%" height={340}>
          <LineChart data={chart} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
            <XAxis dataKey="date" stroke="#8b95a7" fontSize={11} interval="preserveStartEnd" minTickGap={24} />
            <YAxis stroke="#8b95a7" fontSize={11} width={64} />
            <Tooltip contentStyle={{ background: "#141925", border: "1px solid #263042", borderRadius: 10, color: "#e6e9ef" }} />
            <Line type="monotone" dataKey="value" stroke="#34d399" strokeWidth={2} dot={false} name={METR.find((m) => m.k === metric)?.l} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="panel">
        <div className="panel-title" style={{ fontSize: 13 }}>Столбцы</div>
        <div className="chips">
          {COLS.map((c) => (
            <div key={c.k} className={"chip" + (cols.includes(c.k) ? " on" : "")} onClick={() => toggleCol(c.k)}>{c.l}</div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Кампании Google Ads ({g.campaigns.length})</div>
        <div className="table-scroll">
          <table>
            <thead><tr>
              <th onClick={() => setSort("name")}>Кампания</th>
              <th onClick={() => setSort("status")}>Статус</th>
              {activeCols.map((c) => <th key={c.k} onClick={() => setSort(c.k)} style={{ cursor: "pointer" }}>{c.l}{sortKey === c.k ? (asc ? " ▲" : " ▼") : ""}</th>)}
            </tr></thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.campaign_id}>
                  <td title={c.name} style={{ maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</td>
                  <td><span className={"badge " + (c.status === "ACTIVE" ? "active" : "paused")}>{c.status === "ACTIVE" ? "Активна" : "Пауза"}</span></td>
                  {activeCols.map((col) => <td key={col.k}>{col.f(c[col.k] as number)}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      </>)}
    </>
  );
}

/* ============ Google Ads: сравнение двух периодов (живая выгрузка) ============ */
const GCMP = [
  { key: "conversions", label: "Конверсии", good: "up", fmt: (n: number) => Math.round(n).toLocaleString("ru-RU") },
  { key: "cost_per_conversion", label: "CPA", good: "down", fmt: (n: number) => (n ? "$" + n.toFixed(2) : "—") },
  { key: "spend", label: "Расход", good: "neutral", fmt: (n: number) => "$" + Math.round(n).toLocaleString("ru-RU") },
  { key: "clicks", label: "Клики", good: "up", fmt: (n: number) => Math.round(n).toLocaleString("ru-RU") },
  { key: "ctr", label: "CTR", good: "up", fmt: (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%" },
  { key: "cpc", label: "CPC", good: "down", fmt: (n: number) => (n ? "$" + n.toFixed(2) : "—") },
  { key: "impressions", label: "Показы", good: "up", fmt: (n: number) => Math.round(n).toLocaleString("ru-RU") },
] as const;

interface GCmpRow { id: string; name: string; a?: Record<string, number>; b?: Record<string, number> }

function GoogleCompare({ metaPeriod }: { metaPeriod?: { start: string; end: string } }) {
  const base = metaPeriod ?? { start: "2026-07-01", end: "2026-07-14" };
  const [aSince, setASince] = useState(base.start);
  const [aUntil, setAUntil] = useState(base.start);
  const [bSince, setBSince] = useState(base.end);
  const [bUntil, setBUntil] = useState(base.end);
  const [rows, setRows] = useState<GCmpRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/google/compare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ aSince, aUntil, bSince, bUntil }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "Ошибка"); setRows(null); } else setRows(j.rows);
    } catch (e) { setErr(String(e)); }
    setLoading(false);
  };

  const delta = (m: (typeof GCMP)[number], r: GCmpRow) => {
    const a = r.a?.[m.key] ?? 0, b = r.b?.[m.key] ?? 0;
    if (!a && !b) return <span className="muted">—</span>;
    const pct = a ? ((b - a) / a) * 100 : null;
    let sent: "good" | "bad" | "neutral" = "neutral";
    if (pct !== null && m.good !== "neutral" && Math.abs(pct) >= 0.5) sent = (m.good === "up") === (b > a) ? "good" : "bad";
    return <span className={"delta " + sent}>{pct === null ? "—" : (pct > 0 ? "+" : "") + pct.toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + "%"}</span>;
  };
  const DateF = ({ l, v, set }: { l: string; v: string; set: (s: string) => void }) => (
    <div className="field"><label>{l}</label><input type="date" value={v} onChange={(e) => set(e.target.value)} /></div>
  );

  return (
    <>
      <div className="panel">
        <div className="controls">
          <DateF l="Период A — с" v={aSince} set={setASince} />
          <DateF l="A — по" v={aUntil} set={setAUntil} />
          <div style={{ alignSelf: "center", color: "var(--muted)", paddingTop: 14 }}>vs</div>
          <DateF l="Период B — с" v={bSince} set={setBSince} />
          <DateF l="B — по" v={bUntil} set={setBUntil} />
          <button className="btn" onClick={run} disabled={loading} style={{ alignSelf: "end" }}>
            {loading ? "⏳ Загрузка…" : "Сравнить"}
          </button>
        </div>
        {err && <div className="err" style={{ marginTop: 10 }}>Ошибка: {err}</div>}
      </div>

      {rows && (
        <div className="panel">
          <div className="panel-title">Google Ads · сравнение A → B ({rows.length} кампаний)</div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th rowSpan={2}>Кампания</th>
                  {GCMP.map((m) => <th key={m.key} colSpan={3} style={{ textAlign: "center", borderBottom: "none" }}>{m.label}</th>)}
                </tr>
                <tr>{GCMP.map((m) => [<th key={m.key + "a"}>A</th>, <th key={m.key + "b"}>B</th>, <th key={m.key + "d"}>Δ</th>])}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td title={r.name} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</td>
                    {GCMP.map((m) => [
                      <td key={m.key + "a"}>{r.a ? m.fmt(r.a[m.key] ?? 0) : "—"}</td>,
                      <td key={m.key + "b"}>{r.b ? m.fmt(r.b[m.key] ?? 0) : "—"}</td>,
                      <td key={m.key + "d"}>{delta(m, r)}</td>,
                    ])}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Данные тянутся из Google Ads API за оба периода в реальном времени.</div>
        </div>
      )}
    </>
  );
}

/* ============ Панель обновления данных (кнопка + период) ============ */
function RefreshBar({ snapshot }: { snapshot: ApiData["snapshot"] }) {
  const [since, setSince] = useState(snapshot.period_start);
  const [until, setUntil] = useState(snapshot.period_end);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true); setMsg(null);
    try {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ since, until }),
      });
      const j = await res.json();
      if (!res.ok) { setMsg("Ошибка: " + (j.error || res.status)); setLoading(false); return; }
      // Google синхронизируется best-effort — если упал, показываем, а не молчим.
      if (j.googleError) {
        setMsg("Meta обновлена, но Google Ads не удалось: " + String(j.googleError).slice(0, 160));
        setLoading(false);
        return;
      }
      setMsg("Готово, обновляю…");
      window.location.reload();
    } catch (e) {
      setMsg("Ошибка сети: " + String(e)); setLoading(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", justifyContent: "flex-end" }}>
        <div className="field"><label>Период с</label><input type="date" value={since} onChange={(e) => setSince(e.target.value)} /></div>
        <div className="field"><label>по</label><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></div>
        <button className="btn" onClick={refresh} disabled={loading}>
          {loading ? "⏳ Выгрузка…" : "↻ Обновить"}
        </button>
      </div>
      <div style={{ fontSize: 12 }} className="muted">
        {msg ?? `Обновлено: ${new Date(snapshot.created_at).toLocaleString("ru-RU")}`}
      </div>
    </div>
  );
}

/* ============ Обзор + Сравнение на одной странице ============ */
function OverviewCompare({ daily }: { daily: DailyRow[] }) {
  const dates = daily.map((r) => r.date);
  const mid = Math.floor(daily.length / 2);
  const [aStart, setAStart] = useState(dates[0]);
  const [aEnd, setAEnd] = useState(dates[mid - 1]);
  const [bStart, setBStart] = useState(dates[mid]);
  const [bEnd, setBEnd] = useState(dates[dates.length - 1]);
  const [kpiKeys, setKpiKeys] = useState<string[]>(DEFAULT_KPI_KEYS);

  const inRange = (s: string, e: string) => daily.filter((r) => r.date >= s && r.date <= e);
  const A = sumRows(inRange(aStart, aEnd));
  const B = sumRows(inRange(bStart, bEnd));

  const toggle = (k: string) => setKpiKeys(kpiKeys.includes(k) ? kpiKeys.filter((x) => x !== k) : [...kpiKeys, k]);
  const DateSel = ({ v, set }: { v: string; set: (s: string) => void }) => (
    <select value={v} onChange={(e) => set(e.target.value)}>
      {dates.map((d) => <option key={d} value={d}>{fmtDate(d)}</option>)}
    </select>
  );

  return (
    <>
      <div className="panel">
        <div className="panel-title">Периоды для сравнения</div>
        <div className="controls">
          <div className="field"><label>Период A — начало</label><DateSel v={aStart} set={setAStart} /></div>
          <div className="field"><label>A — конец</label><DateSel v={aEnd} set={setAEnd} /></div>
          <div style={{ alignSelf: "center", color: "var(--muted)", paddingTop: 14 }}>→</div>
          <div className="field"><label>Период B — начало</label><DateSel v={bStart} set={setBStart} /></div>
          <div className="field"><label>B — конец</label><DateSel v={bEnd} set={setBEnd} /></div>
          <div className="muted" style={{ alignSelf: "end", paddingBottom: 8 }}>A: {A.days} дн. · B: {B.days} дн.</div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Метрики на карточках</div>
        <div className="chips">
          {METRICS.map((m) => (
            <div key={m.key} className={"chip" + (kpiKeys.includes(m.key) ? " on" : "")} onClick={() => toggle(m.key)}>{m.label}</div>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Обзор · Период B vs Период A</div>
        <div className="kpi-grid">
          {kpiKeys.map((k) => {
            const c = metricValue(k, B), p = metricValue(k, A), d = delta(k, c, p);
            return (
              <div className="kpi" key={k}>
                <div className="label">{METRIC_BY_KEY[k]?.label ?? k}</div>
                <div className="value">{formatMetric(k, c)}</div>
                <div className={"delta " + d.sentiment}>
                  {d.pct === null ? "—" : (d.pct > 0 ? "▲ +" : "▼ ") + d.pct.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%"}
                  <span className="muted"> vs {formatMetric(k, p)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Полное сравнение периодов</div>
        <div className="table-scroll">
          <table>
            <thead><tr><th>Метрика</th><th>Период A</th><th>Период B</th><th>Δ абс.</th><th>Δ %</th></tr></thead>
            <tbody>
              {METRICS.map((m) => {
                const a = metricValue(m.key, A), b = metricValue(m.key, B), d = delta(m.key, b, a);
                return (
                  <tr key={m.key}>
                    <td>{m.label}</td>
                    <td>{formatMetric(m.key, a)}</td>
                    <td>{formatMetric(m.key, b)}</td>
                    <td>{formatMetric(m.key, d.abs)}</td>
                    <td className={"delta " + d.sentiment}>{d.pct === null ? "—" : (d.pct > 0 ? "+" : "") + d.pct.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

/* ============ Динамика: мультиметрики с наслаиванием ============ */
function Dynamics({ daily }: { daily: DailyRow[] }) {
  const [selected, setSelected] = useState<string[]>(["spend", "impressions"]);
  const toggle = (k: string) => setSelected(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]);

  const chartData = daily.map((r) => {
    const row: Record<string, number | string> = { date: fmtDate(r.date) };
    for (const k of selected) row[k] = (r as unknown as Record<string, number>)[k];
    return row;
  });

  return (
    <div className="panel">
      <div className="panel-title">Динамика по дням — выберите метрики (наслаиваются)</div>
      <div className="chips" style={{ marginBottom: 16 }}>
        {METRICS.map((m, i) => {
          const on = selected.includes(m.key);
          const color = LINE_COLORS[selected.indexOf(m.key) % LINE_COLORS.length];
          return (
            <div key={m.key} className={"chip" + (on ? " on" : "")} onClick={() => toggle(m.key)}
              style={on ? { borderColor: color, color: "var(--text)", boxShadow: `inset 3px 0 0 ${color}` } : {}}>
              {m.label}
            </div>
          );
        })}
      </div>
      {selected.length === 0 ? (
        <div className="center muted">Выберите хотя бы одну метрику</div>
      ) : (
        <ResponsiveContainer width="100%" height={440}>
          <LineChart data={chartData} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#263042" strokeDasharray="3 3" />
            <XAxis dataKey="date" stroke="#8b95a7" fontSize={11} interval="preserveStartEnd" minTickGap={24} />
            {selected.map((k) => <YAxis key={k} yAxisId={k} hide domain={["auto", "auto"]} />)}
            <Tooltip
              contentStyle={{ background: "#141925", border: "1px solid #263042", borderRadius: 10, color: "#e6e9ef" }}
              formatter={(v: number, name: string) => [formatMetric(name, v), METRIC_BY_KEY[name]?.label ?? name]}
            />
            <Legend formatter={(v) => METRIC_BY_KEY[v]?.label ?? v} />
            {selected.map((k, i) => (
              <Line key={k} yAxisId={k} type="monotone" dataKey={k} name={k}
                stroke={LINE_COLORS[i % LINE_COLORS.length]} strokeWidth={2} dot={false} />
            ))}
          </LineChart>
        </ResponsiveContainer>
      )}
      <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
        У каждой метрики своя шкала (значения разного порядка), поэтому линии сопоставляются по форме тренда. Точные значения — в подсказке при наведении.
      </div>
    </div>
  );
}

/* ============ Дерево: Кампания → Группа → Объявление ============ */
const ALL_COLS = [
  { key: "results", label: "Результаты", special: "results" },
  { key: "cost_per_result", label: "Цена рез-та / CPL", special: "currency" },
  { key: "spend", label: "Расход" },
  { key: "impressions", label: "Показы" },
  { key: "reach", label: "Охват" },
  { key: "frequency", label: "Частота" },
  { key: "clicks", label: "Клики" },
  { key: "link_click", label: "Клики по ссылке" },
  { key: "page_engagement", label: "Вовлечённость" },
  { key: "ctr", label: "CTR" },
  { key: "cpc", label: "CPC" },
  { key: "cpm", label: "CPM" },
] as const;
const DEFAULT_COLS = ["results", "cost_per_result", "spend", "reach", "frequency", "ctr", "cpm"];

function fmtInt(v: number | null | undefined) {
  return v === null || v === undefined ? "—" : Math.round(v).toLocaleString("ru-RU");
}
function cellValue(col: (typeof ALL_COLS)[number], row: Record<string, unknown>) {
  const v = row[col.key] as number | null | undefined;
  const special = (col as { special?: string }).special;
  if (special === "results") return v == null ? "—" : `${fmtInt(v)} ${row.result_type ?? ""}`.trim();
  if (special === "currency") return v == null ? "—" : formatMetric("cpc", v);
  return formatMetric(col.key, v as number);
}

function Breakdown({ campaigns, adsets, ads, snapshot }: { campaigns: Entity[]; adsets: Entity[]; ads: Entity[]; snapshot: ApiData["snapshot"] }) {
  const [mode, setMode] = useState<"tree" | "compare">("tree");
  const [cols, setCols] = useState<string[]>(DEFAULT_COLS);
  const [sortKey, setSortKey] = useState<string>("spend");
  const [asc, setAsc] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const adsetsByCampaign = useMemo(() => {
    const m: Record<string, Entity[]> = {};
    for (const a of adsets) (m[a.campaign_id!] ??= []).push(a);
    return m;
  }, [adsets]);
  const adsByAdset = useMemo(() => {
    const m: Record<string, Entity[]> = {};
    for (const a of ads) (m[a.adset_id!] ??= []).push(a);
    return m;
  }, [ads]);

  const sortFn = (arr: Entity[]) => [...arr].sort((a, b) => {
    const av = (a as unknown as Record<string, number | string>)[sortKey];
    const bv = (b as unknown as Record<string, number | string>)[sortKey];
    if (typeof av === "number" && typeof bv === "number") return asc ? av - bv : bv - av;
    return asc ? String(av ?? "").localeCompare(String(bv ?? "")) : String(bv ?? "").localeCompare(String(av ?? ""));
  });

  const setSort = (k: string) => { if (k === sortKey) setAsc(!asc); else { setSortKey(k); setAsc(false); } };
  const toggleCol = (k: string) => setCols(cols.includes(k) ? cols.filter((x) => x !== k) : [...cols, k]);
  const toggle = (id: string) => setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const activeCols = ALL_COLS.filter((c) => cols.includes(c.key));

  const totalLeads = campaigns.reduce((s, c) => s + ((c as unknown as Record<string, unknown>).result_type === "Лиды" ? ((c as unknown as Record<string, number>).results || 0) : 0), 0);
  const leadSpend = campaigns.reduce((s, c) => s + ((c as unknown as Record<string, unknown>).result_type === "Лиды" ? c.spend : 0), 0);

  const expandAll = () => setExpanded(new Set([...campaigns.map((c) => c.campaign_id!), ...adsets.map((a) => a.adset_id!)]));

  // Собираем плоский список видимых строк с уровнем вложенности.
  type Vis = { row: Entity; depth: 0 | 1 | 2; id: string; hasChildren: boolean; note?: string };
  const visible: Vis[] = [];
  for (const c of sortFn(campaigns)) {
    const cid = c.campaign_id!;
    const kids = adsetsByCampaign[cid] ?? [];
    visible.push({ row: c, depth: 0, id: cid, hasChildren: kids.length > 0 });
    if (expanded.has(cid)) {
      if (kids.length === 0) visible.push({ row: c, depth: 1, id: cid + "-empty", hasChildren: false, note: "нет загруженных групп (подтянуты топ-25 по показам)" });
      for (const g of sortFn(kids)) {
        const gid = g.adset_id!;
        const gkids = adsByAdset[gid] ?? [];
        visible.push({ row: g, depth: 1, id: gid, hasChildren: gkids.length > 0 });
        if (expanded.has(gid)) {
          if (gkids.length === 0) visible.push({ row: g, depth: 2, id: gid + "-empty", hasChildren: false, note: "нет загруженных объявлений" });
          for (const ad of sortFn(gkids)) visible.push({ row: ad, depth: 2, id: ad.ad_id!, hasChildren: false });
        }
      }
    }
  }

  const depthPad = [0, 22, 44];
  const depthDot = ["", "↳ ", "· "];

  return (
    <>
      <div className="panel">
        <div className="chips">
          <div className={"chip" + (mode === "tree" ? " on" : "")} onClick={() => setMode("tree")}>Показатели (дерево)</div>
          <div className={"chip" + (mode === "compare" ? " on" : "")} onClick={() => setMode("compare")}>Сравнение периодов</div>
        </div>
      </div>

      {mode === "compare" && <ComparePeriods snapshot={snapshot} />}
      {mode === "tree" && (<>
      <div className="panel">
        <div className="kpi-grid" style={{ marginBottom: 4 }}>
          <div className="kpi"><div className="label">Лидов за период</div><div className="value">{fmtInt(totalLeads)}</div><div className="delta neutral">по лид-кампаниям</div></div>
          <div className="kpi"><div className="label">Средний CPL</div><div className="value">{totalLeads ? formatMetric("cpc", leadSpend / totalLeads) : "—"}</div><div className="delta neutral">расход лидов / лиды</div></div>
          <div className="kpi"><div className="label">Расход на лиды</div><div className="value">{formatMetric("spend", leadSpend)}</div><div className="delta neutral">из общего бюджета</div></div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Столбцы</div>
        <div className="chips" style={{ marginBottom: 14 }}>
          {ALL_COLS.map((c) => (
            <div key={c.key} className={"chip" + (cols.includes(c.key) ? " on" : "")} onClick={() => toggleCol(c.key)}>{c.label}</div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn ghost" onClick={expandAll}>Развернуть всё</button>
          <button className="btn ghost" onClick={() => setExpanded(new Set())}>Свернуть всё</button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">Иерархия — {campaigns.length} кампаний · клик по строке разворачивает</div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th onClick={() => setSort("name")}>Кампания / Группа / Объявление</th>
                <th onClick={() => setSort("status")}>Статус</th>
                {activeCols.map((c) => <th key={c.key} onClick={() => setSort(c.key)}>{c.label}{sortKey === c.key ? (asc ? " ▲" : " ▼") : ""}</th>)}
              </tr>
            </thead>
            <tbody>
              {visible.map((v) => {
                if (v.note) return (
                  <tr key={v.id}><td colSpan={activeCols.length + 2} className="muted" style={{ paddingLeft: depthPad[v.depth] + 14, fontStyle: "italic" }}>{v.note}</td></tr>
                );
                const r = v.row as unknown as Record<string, unknown>;
                return (
                  <tr key={v.id} style={{ background: v.depth === 1 ? "rgba(79,140,255,0.04)" : v.depth === 2 ? "rgba(79,140,255,0.02)" : undefined }}>
                    <td style={{ maxWidth: 380 }}>
                      <div style={{ paddingLeft: depthPad[v.depth], display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ cursor: v.hasChildren ? "pointer" : "default", width: 14, color: "var(--muted)" }} onClick={() => v.hasChildren && toggle(v.id)}>
                          {v.hasChildren ? (expanded.has(v.id) ? "▼" : "▶") : ""}
                        </span>
                        <span title={v.row.name} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: v.depth === 0 ? 600 : 400 }}>
                          <span className="muted">{depthDot[v.depth]}</span>{v.row.name}
                        </span>
                      </div>
                    </td>
                    <td><span className={"badge " + (v.row.status === "ACTIVE" ? "active" : "paused")}>{v.row.status === "ACTIVE" ? "Активна" : "Пауза"}</span></td>
                    {activeCols.map((c) => <td key={c.key}>{cellValue(c, r)}</td>)}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
          «Результаты» = цель кампании: для лид-кампаний это <b>лиды</b>, для охватных — охват.
        </div>
      </div>
      </>)}
    </>
  );
}

/* ============ Сравнение двух периодов (живая выгрузка из Graph API) ============ */
const CMP_LEVELS = [
  { key: "campaign", label: "Кампании" },
  { key: "adset", label: "Группы" },
  { key: "ad", label: "Объявления" },
] as const;
const CMP_METRICS = [
  { key: "results", label: "Результаты", special: "results", good: "up" },
  { key: "cost_per_result", label: "CPL", special: "currency", good: "down" },
  { key: "spend", label: "Расход", good: "neutral" },
  { key: "reach", label: "Охват", good: "up" },
  { key: "ctr", label: "CTR", good: "up" },
  { key: "cpm", label: "CPM", good: "down" },
  { key: "frequency", label: "Частота", good: "neutral" },
] as const;

interface CmpRow { id: string; name: string; a?: Record<string, number | string>; b?: Record<string, number | string> }

function ComparePeriods({ snapshot }: { snapshot: ApiData["snapshot"] }) {
  const mid = snapshot.period_start;
  const [level, setLevel] = useState<"campaign" | "adset" | "ad">("campaign");
  const [aSince, setASince] = useState(snapshot.period_start);
  const [aUntil, setAUntil] = useState(mid);
  const [bSince, setBSince] = useState(snapshot.period_end);
  const [bUntil, setBUntil] = useState(snapshot.period_end);
  const [rows, setRows] = useState<CmpRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const runCompare = async () => {
    setLoading(true); setErr(null);
    try {
      const res = await fetch("/api/compare", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ level, aSince, aUntil, bSince, bUntil }),
      });
      const j = await res.json();
      if (!res.ok) { setErr(j.error || "Ошибка"); setRows(null); }
      else setRows(j.rows);
    } catch (e) { setErr(String(e)); }
    setLoading(false);
  };

  const cell = (m: (typeof CMP_METRICS)[number], row: Record<string, number | string> | undefined) => {
    if (!row) return "—";
    const v = row[m.key] as number;
    const special = (m as { special?: string }).special;
    if (special === "results") return `${fmtInt(v)} ${row.objective && String(row.objective).includes("LEADS") ? "лид." : ""}`.trim();
    if (special === "currency") return v ? formatMetric("cpc", v) : "—";
    return formatMetric(m.key, v);
  };
  const deltaCell = (m: (typeof CMP_METRICS)[number], r: CmpRow) => {
    const a = (r.a?.[m.key] as number) ?? 0, b = (r.b?.[m.key] as number) ?? 0;
    if (!a && !b) return <span className="muted">—</span>;
    const pct = a ? ((b - a) / a) * 100 : null;
    let sent: "good" | "bad" | "neutral" = "neutral";
    if (pct !== null && m.good !== "neutral" && Math.abs(pct) >= 0.5) sent = (m.good === "up") === (b > a) ? "good" : "bad";
    return <span className={"delta " + sent}>{pct === null ? "—" : (pct > 0 ? "+" : "") + pct.toLocaleString("ru-RU", { maximumFractionDigits: 0 }) + "%"}</span>;
  };

  const DateF = ({ l, v, set }: { l: string; v: string; set: (s: string) => void }) => (
    <div className="field"><label>{l}</label><input type="date" value={v} onChange={(e) => set(e.target.value)} /></div>
  );

  return (
    <>
      <div className="panel">
        <div className="chips" style={{ marginBottom: 14 }}>
          {CMP_LEVELS.map((l) => <div key={l.key} className={"chip" + (level === l.key ? " on" : "")} onClick={() => setLevel(l.key)}>{l.label}</div>)}
        </div>
        <div className="controls">
          <DateF l="Период A — с" v={aSince} set={setASince} />
          <DateF l="A — по" v={aUntil} set={setAUntil} />
          <div style={{ alignSelf: "center", color: "var(--muted)", paddingTop: 14 }}>vs</div>
          <DateF l="Период B — с" v={bSince} set={setBSince} />
          <DateF l="B — по" v={bUntil} set={setBUntil} />
          <button className="btn" onClick={runCompare} disabled={loading} style={{ alignSelf: "end" }}>
            {loading ? "⏳ Загрузка…" : "Сравнить"}
          </button>
        </div>
        {err && <div className="err" style={{ marginTop: 10 }}>Ошибка: {err}</div>}
      </div>

      {rows && (
        <div className="panel">
          <div className="panel-title">Сравнение A → B ({rows.length}) — Δ показывает изменение B к A</div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th rowSpan={2}>Название</th>
                  {CMP_METRICS.map((m) => <th key={m.key} colSpan={3} style={{ textAlign: "center", borderBottom: "none" }}>{m.label}</th>)}
                </tr>
                <tr>
                  {CMP_METRICS.map((m) => [
                    <th key={m.key + "a"}>A</th>, <th key={m.key + "b"}>B</th>, <th key={m.key + "d"}>Δ</th>,
                  ])}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td title={r.name} style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</td>
                    {CMP_METRICS.map((m) => [
                      <td key={m.key + "a"}>{cell(m, r.a)}</td>,
                      <td key={m.key + "b"}>{cell(m, r.b)}</td>,
                      <td key={m.key + "d"}>{deltaCell(m, r)}</td>,
                    ])}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Данные тянутся из Graph API за оба периода в реальном времени. «Результаты» = лиды для лид-кампаний, охват — для охватных.</div>
        </div>
      )}
    </>
  );
}

/* ============ Сводка: 2 колонки ============ */
function Summary({ summary }: { summary: ApiData["summary"] }) {
  if (!summary?.data) return <div className="panel muted">Сводка ещё не сформирована.</div>;
  const d = summary.data;
  const List = ({ items }: { items: string[] }) => (
    <ul className="summary-body">{items.map((h, i) => <li key={i} dangerouslySetInnerHTML={{ __html: h }} />)}</ul>
  );
  return (
    <>
      <div className="topbar" style={{ marginBottom: 14 }}>
        <div className="panel-title" style={{ margin: 0 }}>Письменные выводы <span className="pill">{summary.author}</span> <span className="pill">{d.period}</span></div>
      </div>
      <div className="two-col">
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div className="panel"><div className="panel-title">🎯 Главная</div><List items={d.main} /></div>
          <div className="panel"><div className="panel-title">💰 Деньги</div><List items={d.money} /></div>
        </div>
        <div className="panel" style={{ alignSelf: "start" }}>
          <div className="panel-title">✅ Рекомендации</div>
          <List items={d.recommendations} />
          <div className="muted" style={{ marginTop: 14, fontSize: 12, borderTop: "1px solid var(--border)", paddingTop: 12 }}>{d.note}</div>
        </div>
      </div>
    </>
  );
}
