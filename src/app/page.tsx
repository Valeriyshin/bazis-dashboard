"use client";

import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from "recharts";
// exceljs — только динамически (по клику на "Скачать Excel"), иначе ~250 КБ
// уходят в общий бандл главной страницы, хотя нужны редко.
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

const TABS = ["Обзор", "Meta", "Google Ads", "Яндекс", "TikTok", "Сводка", "Выгорание"] as const;
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
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-end" }}>
          <UserBar />
          <RefreshBar snapshot={data.snapshot} />
        </div>
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <div key={t} className={"tab" + (tab === t ? " active" : "")} onClick={() => setTab(t)}>{t}</div>
        ))}
      </div>

      {tab === "Обзор" && <><OverviewCompare daily={data.daily} /><ZhkSummary metaCampaigns={data.campaigns} metaAdsets={data.adsets} metaPeriod={{ start: data.snapshot.period_start, end: data.snapshot.period_end }} /></>}
      {tab === "Meta" && <><Dynamics daily={data.daily} /><Breakdown campaigns={data.campaigns} adsets={data.adsets} ads={data.ads} snapshot={data.snapshot} /></>}
      {tab === "Сводка" && <Summary summary={data.summary} />}
      {tab === "Google Ads" && <GoogleAds metaPeriod={{ start: data.snapshot.period_start, end: data.snapshot.period_end }} />}
      {tab === "Яндекс" && <YandexAds />}
      {tab === "TikTok" && <TiktokAds />}
      {tab === "Выгорание" && <FatigueTracker />}
    </div>
  );
}

/* ============ Сводка по ЖК (все системы) ============ */
// spend — всегда в USD (канон), spendKzt — та же сумма в тенге.
interface ZhkAgg { impressions: number; reach: number; clicks: number; leads: number; spend: number; spendKzt: number; spendKztTax: number; typeSpend: Record<string, number> }
function newAgg(): ZhkAgg { return { impressions: 0, reach: 0, clicks: 0, leads: 0, spend: 0, spendKzt: 0, spendKztTax: 0, typeSpend: {} }; }
const segs = (name: string) => String(name).split("|").map((s) => s.trim()).filter(Boolean);
// Нормализация написания: без регистра, пробелов и пунктуации ("Nurly Dala 2" == "NURLY DALA 2").
const normz = (s: string) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Ручные каноничные написания ЖК (нормализованный ключ → как показывать).
// Перекрывает автоопределение, если в кабинетах пишут по-разному.
const ZHK_CANON: Record<string, string> = {
  "jandostar": "Jan Dostar",
  "nurlydala2": "Nurly Dala II",
};

// Класс жилья — ручные данные, в рекламных кабинетах их нет. Затравка составлена
// по прошлым отчётам (там, где класс был реально заполнен); для новых ЖК будет
// пусто — колонка помечается жёлтым в выгрузке для заполнения руками.
const ZHK_CLASS_SEED: Record<string, string> = {
  [normz("Cascade")]: "Комфорт",
  [normz("Duman")]: "Комфорт",
  [normz("Jan Dostar")]: "Комфорт",
  [normz("Nurly Dala II")]: "Комфорт",
  [normz("Satpaev")]: "Комфорт",
  [normz("Shahristan")]: "Комфорт",
  [normz("Auezov City Pro")]: "Комфорт",
  [normz("Benelux")]: "Премиум",
  [normz("Parkville")]: "Премиум",
  [normz("Grand Monaco")]: "Бизнес",
  [normz("Landmark Gold")]: "Бизнес",
  [normz("Vesper")]: "Бизнес",
};

// Сегменты, которые НЕ являются ЖК: города, бренд, цели, форматы, языки.
const NON_ZHK = new Set([
  "Алматы", "Астана", "Шымкент", "Караганда", "Актобе", "Атырау", "Almaty", "Astana", "Shymkent",
  "Bazis-A", "Bazis", "BAZIS", "Premium", "PREMIUM",
  "Search", "Общий Поиск", "Поиск", "Dgen", "DGen", "DGEN", "РСЯ", "Сети", "Мастер кампаний",
  "РУС", "КАЗ", "CPA", "CPL", "CPM", "CPV", "CPC", "CPE",
  "Лиды", "Охват", "Вовлеченность", "Вовлечённость", "Лидген формы",
  "ThruPlay", "Thruplay", "Просмотры Thruplay", "Просмотры", "Охват SMM", "SMM",
  "Трафик", "Конверсии", "Продажи", "Сообщения", "Установки",
  "YT Shorts", "YT InStream", "YouTube Multiple Formats", "Adv", "Adv+", "Wide", "LAL",
  "Летние Скидки", "Коммерция", "Smart+", "TT", "4 города", "3 города", "2 города",
].map(normz));

// Содержательные сегменты названия (кандидаты на ЖК): без кода кампании, города, бренда, цели.
function zhkCandidates(name: string): string[] {
  return segs(name).slice(1).filter((s) => {
    const n = normz(s);
    if (!n || NON_ZHK.has(n)) return false;
    if (/^#?\d+$/.test(s.trim())) return false; // "#2", "1"
    if (/^\d{1,2}\.\d{1,2}$/.test(s.trim())) return false; // "05.08" (дата в названии)
    if (/^(cpa|cpl|cpm|cpv|cpc|cpe)\d*$/.test(n)) return false; // "CPA", "CPA #2" → cpa2
    return true;
  });
}

// Разбор ЖК с учётом разнобоя. canon: нормализованный ключ → каноничное отображаемое имя.
// Заполняется из Meta (стабильный нейминг), дополняется по мере встречи новых ЖК.
function resolveZhk(name: string, canon: Map<string, string>): string {
  // Ручная карта имеет приоритет над автоопределением.
  const pick = (s: string) => ZHK_CANON[normz(s)] ?? s;
  const cands = zhkCandidates(name);
  if (cands.length === 0) return "Бренд / Общие";
  // 1) точное совпадение по нормализованному ключу («Nurly Dala 2» == «NURLY DALA 2»)
  for (const c of cands) { const k = normz(c); if (canon.has(k)) return pick(canon.get(k)!); }
  // 2) известный ЖК как отдельное слово внутри сегмента («HUB ALMATY» → «HUB», «Benelux, A club» → «Benelux»)
  for (const c of cands) {
    for (const disp of canon.values()) {
      if (disp.length < 3) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${reEsc(disp)}([^\\p{L}\\p{N}]|$)`, "iu");
      if (re.test(c)) return pick(disp);
    }
  }
  // 3) новый ЖК — регистрируем по первому кандидату
  const first = cands[0], key = normz(first);
  if (!canon.has(key)) canon.set(key, first);
  return pick(canon.get(key)!);
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
  { key: "spend", label: "Расход $", get: (a: ZhkAgg) => a.spend, fmt: (n: number) => "$" + money0(n) },
  { key: "spendKzt", label: "Расход ₸", get: (a: ZhkAgg) => a.spendKzt, fmt: (n: number) => money0(n) + " ₸" },
  { key: "spendKztTax", label: "Расход ₸ (с АК и НДС)", get: (a: ZhkAgg) => a.spendKztTax, fmt: (n: number) => money0(n) + " ₸" },
  { key: "cplKztTax", label: "Цена лида ₸ (с АК и НДС)", get: (a: ZhkAgg) => (a.leads ? a.spendKztTax / a.leads : 0), fmt: (n: number) => (n ? money0(n) + " ₸" : "—") },
] as const;
const ZHK_DEFAULT = ["type", "impressions", "reach", "clicks", "ctr", "leads", "cpl", "spend", "spendKzt", "spendKztTax", "cplKztTax"];

interface YCampaign { campaign_id: string; name: string; spend: number; impressions: number; clicks: number; conversions: number }
interface TCampaign { campaign_id: string; name: string; spend: number; impressions: number; clicks: number; conversions: number }

// Кампании, которые бьём не по ЖК, а по городам (группам объявлений) — это
// сквозные акции на несколько городов сразу, у них нет единого ЖК-названия.
const MULTICITY_RE = /коммерц|летние\s*скидк/i;
const CITY_LIST = ["Алматы", "Астана", "Шымкент", "Атырау", "Караганда", "Актобе"];

function ZhkSummary({ metaCampaigns, metaAdsets, metaPeriod }: { metaCampaigns: Entity[]; metaAdsets: Entity[]; metaPeriod: { start: string; end: string } }) {
  const [google, setGoogle] = useState<GCampaign[] | null>(null);
  const [yandex, setYandex] = useState<YCampaign[] | null>(null);
  const [tiktok, setTiktok] = useState<TCampaign[] | null>(null);
  const [rate, setRate] = useState(500); // ₸ за $1 (эффективный за период, авто по НБ РК)
  // Выгрузка в Excel — свои ручные параметры, независимые от авто-курса выше.
  const [exportRate, setExportRate] = useState("");
  const [akPct, setAkPct] = useState(10);
  const [ndsPct, setNdsPct] = useState(16);
  const [exporting, setExporting] = useState(false);
  const [fxMonths, setFxMonths] = useState<{ month: string; rate: number; days: number }[]>([]);
  const [cols, setCols] = useState<string[]>(ZHK_DEFAULT);
  // Период снапшота каждой площадки — чтобы предупредить, если какая-то из них
  // отстала (например, TikTok не попал в ручной ↻ Обновить за произвольный период
  // и остался на своём обычном скользящем окне — иначе её цифры молча подмешаются
  // в отчёт за совсем другой диапазон дат).
  const [periods, setPeriods] = useState<Record<string, { start: string; end: string } | null>>({});
  useEffect(() => {
    fetch("/api/google").then((r) => r.json()).then((d) => {
      setGoogle(d.error ? [] : d.campaigns);
      setPeriods((p) => ({ ...p, "Google Ads": d.snapshot ? { start: d.snapshot.period_start, end: d.snapshot.period_end } : null }));
    }).catch(() => setGoogle([]));
    fetch("/api/yandex").then((r) => r.json()).then((d) => {
      if (d.error) { setYandex([]); setPeriods((p) => ({ ...p, "Yandex Direct": null })); return; }
      setYandex(d.campaigns);
      if (d.rate) setRate(d.rate);
      if (d.fxMonths) setFxMonths(d.fxMonths);
      setPeriods((p) => ({ ...p, "Yandex Direct": { start: d.snapshot.period_start, end: d.snapshot.period_end } }));
    }).catch(() => setYandex([]));
    fetch("/api/tiktok").then((r) => r.json()).then((d) => {
      setTiktok(d.error ? [] : d.campaigns);
      setPeriods((p) => ({ ...p, TikTok: d.snapshot ? { start: d.snapshot.period_start, end: d.snapshot.period_end } : null }));
    }).catch(() => setTiktok([]));
  }, []);
  const periodMismatches = Object.entries(periods).filter(([, p]) => p && (p.start !== metaPeriod.start || p.end !== metaPeriod.end));
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

  // Курс/АК/НДС для столбцов "с АК и НДС" — те же поля, что и у выгрузки в Excel
  // (ручной курс приоритетнее авто-курса НБ РК, если заполнен).
  const taxRate = Number(exportRate) || rate;
  const ak = akPct / 100, nds = ndsPct / 100;
  const YA_TAX_COEF = 0.95; // у Яндекса не (1+АК), а фиксированный коэффициент — см. выгрузку в Excel

  // group[ЖК][система] = ZhkAgg
  const group: Record<string, Record<string, ZhkAgg>> = {};
  // Ключ строки — система + тип кампании (Поиск / YouTube / КМС / Лиды / Охват),
  // чтобы каждый тип был отдельной строкой и ничего не терялось.
  const add = (zhk: string, sys: string, patch: Partial<ZhkAgg> & { type?: string }) => {
    (group[zhk] ??= {});
    const key = `${sys} ${patch.type || "—"}`;
    const a = (group[zhk][key] ??= newAgg());
    a.impressions += patch.impressions ?? 0; a.reach += patch.reach ?? 0; a.clicks += patch.clicks ?? 0;
    a.leads += patch.leads ?? 0; a.spend += patch.spend ?? 0; a.spendKzt += patch.spendKzt ?? 0;
    a.spendKztTax += patch.spendKztTax ?? 0;
    if (patch.type) a.typeSpend[patch.type] = (a.typeSpend[patch.type] ?? 0) + (patch.spend ?? 0);
  };
  // Каноничные ЖК: сначала из Meta (стабильный нейминг), затем дополняются из Google.
  const canon = new Map<string, string>();
  for (const c of metaCampaigns) {
    const cs = zhkCandidates(c.name);
    if (cs.length) { const k = normz(cs[0]); if (!canon.has(k)) canon.set(k, cs[0]); }
  }
  const isZero = (p: { impressions?: number; spend?: number; clicks?: number; leads?: number }) =>
    !(p.impressions || 0) && !(p.spend || 0) && !(p.clicks || 0) && !(p.leads || 0);

  for (const c of metaCampaigns) {
    if (MULTICITY_RE.test(c.name)) continue; // эти кампании бьём ниже по городам (адсетам)
    const cc = c as unknown as Record<string, number | string>;
    const spend = +cc.spend;
    const patch = {
      impressions: +cc.impressions, reach: +cc.reach, clicks: +cc.clicks,
      leads: cc.result_type === "Лиды" ? +cc.results : 0,
      spend, spendKzt: spend * rate, spendKztTax: spend * taxRate * (1 + ak) * (1 + nds),
      type: (cc.result_type as string) || "—",
    };
    if (isZero(patch)) continue; // скрываем кампании без активности за период
    add(resolveZhk(c.name, canon), "Meta", patch);
  }
  {
    // Сквозные акции (Коммерция / Летние скидки) без единого ЖК — бьём по городам
    // из названий групп объявлений (адсетов).
    const multiCampaignIds = new Set(metaCampaigns.filter((c) => MULTICITY_RE.test(c.name)).map((c) => c.campaign_id));
    const campaignById = new Map(metaCampaigns.map((c) => [c.campaign_id, c]));
    for (const a of metaAdsets) {
      if (!a.campaign_id || !multiCampaignIds.has(a.campaign_id)) continue;
      const camp = campaignById.get(a.campaign_id);
      if (!camp) continue;
      const label = /летние\s*скидк/i.test(camp.name) ? "Летние скидки" : "Коммерция";
      const city = CITY_LIST.find((ct) => a.name.includes(ct)) || "Прочее";
      const ac = a as unknown as Record<string, number | string>;
      const spend = +ac.spend;
      const patch = {
        impressions: +ac.impressions, reach: +ac.reach, clicks: +ac.clicks,
        leads: ac.result_type === "Лиды" ? +ac.results : 0,
        spend, spendKzt: spend * rate, spendKztTax: spend * taxRate * (1 + ak) * (1 + nds),
        type: (ac.result_type as string) || "—",
      };
      if (isZero(patch)) continue;
      add(`${label} · ${city}`, "Meta", patch);
    }
  }
  for (const c of google ?? []) {
    const gc = c as unknown as Record<string, unknown>;
    const patch = {
      impressions: c.impressions, reach: 0, clicks: c.clicks, leads: c.conversions,
      spend: c.spend, spendKzt: c.spend * rate, spendKztTax: c.spend * taxRate * (1 + ak) * (1 + nds),
      type: (gc.channel as string) || "—",
    };
    if (isZero(patch)) continue;
    add(resolveZhk(c.name, canon), "Google Ads", patch);
  }
  for (const c of yandex ?? []) {
    // Яндекс отдаёт расход в тенге — в $ переводим по среднемесячному курсу НБ РК.
    const patch = {
      impressions: c.impressions, reach: 0, clicks: c.clicks, leads: c.conversions,
      spend: c.spend / rate, spendKzt: c.spend, spendKztTax: c.spend * YA_TAX_COEF * (1 + nds), type: "Поиск",
    };
    if (isZero(patch)) continue;
    add(resolveZhk(c.name, canon), "Yandex Direct", patch);
  }
  for (const c of tiktok ?? []) {
    const spend = c.spend; // кабинет в USD
    const type = /лиды/i.test(c.name) ? "Лидген формы" : /охват/i.test(c.name) ? "Охват" : "—";
    const patch = {
      impressions: c.impressions, reach: 0, clicks: c.clicks, leads: c.conversions,
      spend, spendKzt: spend * rate, spendKztTax: spend * taxRate * (1 + ak) * (1 + nds), type,
    };
    if (isZero(patch)) continue;
    add(resolveZhk(c.name, canon), "TikTok", patch);
  }

  const SYS_ICON: Record<string, string> = { "Google Ads": "🔴", Meta: "🔵", "Yandex Direct": "🟡", TikTok: "⚫" };
  const cell = (c: (typeof ZHK_COLS)[number], a: ZhkAgg, isType: boolean) =>
    "type" in c && c.type ? (isType ? domType(a.typeSpend) : "—") : (c as { get: (a: ZhkAgg) => number; fmt: (n: number) => string }).fmt((c as { get: (a: ZhkAgg) => number }).get(a));

  // Итог по каждому ЖК (для сортировки).
  const zhkTotal: Record<string, ZhkAgg> = {};
  for (const zhk of Object.keys(group)) {
    const t = newAgg();
    for (const a of Object.values(group[zhk])) { t.impressions += a.impressions; t.reach += a.reach; t.clicks += a.clicks; t.leads += a.leads; t.spend += a.spend; t.spendKzt += a.spendKzt; t.spendKztTax += a.spendKztTax; }
    zhkTotal[zhk] = t;
  }
  const zhks = Object.keys(group).sort((x, y) => {
    const d = colVal(sortKey, zhkTotal[x]) - colVal(sortKey, zhkTotal[y]);
    return asc ? d : -d;
  });

  // Строка выгрузки: (система, тип) → (Система, Тип кампании, Модель оплаты) под
  // формат "Отчёт [Месяц].xlsx". Google/Яндекс не различают модель оплаты в наших
  // данных — берём разумное соответствие по каналу (документируем допущение внизу файла).
  const exportSysType = (sysKey: string): { system: string; type: string; model: string } => {
    const sys = sysKey.startsWith("Google Ads") ? "Google Ads" : sysKey.startsWith("Meta") ? "Meta"
      : sysKey.startsWith("Yandex Direct") ? "Yandex Direct" : "TikTok";
    const label = sysKey.slice(sys.length + 1) || "—";
    if (sys === "Meta") return { system: "Meta", type: label, model: label === "Охват" ? "CPM" : "CPL" };
    if (sys === "Yandex Direct") return { system: "Yandex Direct", type: "Поиск", model: "CPA" };
    if (sys === "Google Ads") return { system: "Google Ads", type: label, model: label === "YouTube" ? "CPV" : "CPA" };
    const tkLabel = label === "Лиды" ? "Лидген формы" : label;
    return { system: "TikTok", type: tkLabel, model: label === "Охват" ? "CPM" : "CPL" };
  };

  const downloadExcel = async () => {
    const rateNum = Number(exportRate);
    if (!rateNum || rateNum <= 0) { alert("Укажите курс доллара для выгрузки — без него нельзя перевести Meta/Google в тенге."); return; }
    setExporting(true);
    try {
      const { default: ExcelJS } = await import("exceljs");
      const wb = new ExcelJS.Workbook();
      const monthName = new Date().toLocaleDateString("ru-RU", { month: "long" });
      const ws = wb.addWorksheet(`Общий ${monthName}`.slice(0, 31));

      // Строки 1-4 — параметры выгрузки (жёлтые, редактируются прямо в файле, формулы
      // ниже их подхватывают через $B$1:$B$4). Строка 5 — заголовок.
      // Расход с НДС и АК считается по-разному для Яндекса и остальных площадок:
      //   Яндекс: L × 0.95 × (1+НДС)      — фиксированный коэффициент 0.95, не (1+АК)
      //   Остальные (Meta/Google/TikTok): L × (1+АК) × (1+НДС)
      const RATE_ROW = 1, AK_ROW = 2, NDS_ROW = 3, YA_COEF_ROW = 4, HEADER_ROW = 5, FIRST_DATA_ROW = 6;
      ws.getCell(`D${RATE_ROW}`).value = "Курс $ →₸ (ручной, для этой выгрузки):";
      ws.getCell(`B${RATE_ROW}`).value = rateNum; ws.getCell(`B${RATE_ROW}`).numFmt = "0.00";
      ws.getCell(`D${AK_ROW}`).value = "АК, % (Meta/Google/TikTok):";
      ws.getCell(`B${AK_ROW}`).value = akPct / 100; ws.getCell(`B${AK_ROW}`).numFmt = "0%";
      ws.getCell(`D${NDS_ROW}`).value = "НДС, %:";
      ws.getCell(`B${NDS_ROW}`).value = ndsPct / 100; ws.getCell(`B${NDS_ROW}`).numFmt = "0%";
      ws.getCell(`D${YA_COEF_ROW}`).value = "Коэфф. Яндекс (вместо 1+АК):";
      ws.getCell(`B${YA_COEF_ROW}`).value = 0.95; ws.getCell(`B${YA_COEF_ROW}`).numFmt = "0.00";
      for (const row of [RATE_ROW, AK_ROW, NDS_ROW, YA_COEF_ROW]) {
        ws.getCell(`D${row}`).font = { bold: true, name: "Arial" };
        ws.getCell(`B${row}`).font = { name: "Arial" };
        ws.getCell(`B${row}`).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
      }

      const headers = [
        "ЖК", "Класс жилья", "Система", "Тип кампании", "Модель оплаты",
        "Показы", "Охват", "Клики (все)", "CTR (все)", "CR", "Кол-во лидов",
        "Расход без НДС и АК", "Расход с НДС и АК",
        "Стоимость лида без НДС и АК", "Стоимость лида с НДС и АК",
      ];
      ws.getRow(HEADER_ROW).values = headers;
      ws.getRow(HEADER_ROW).font = { bold: true, name: "Arial" };
      ws.getRow(HEADER_ROW).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE8E8E8" } };

      let r = FIRST_DATA_ROW;
      const unclassified = new Set<string>();
      for (const zhk of zhks) {
        const systems = group[zhk];
        for (const key of Object.keys(systems).sort((x, y) => systems[y].spend - systems[x].spend)) {
          const a = systems[key];
          const { system, type, model } = exportSysType(key);
          // Яндекс уже в тенге нативно — курс к нему не применяется, чтобы не искажать конвертацией туда-обратно.
          const isYandex = system === "Yandex Direct";
          const spendRaw = isYandex ? a.spendKzt : a.spend; // тенге либо исходный $ (переведём формулой)
          const klass = ZHK_CLASS_SEED[normz(zhk)] || "";
          if (!klass) unclassified.add(zhk);

          const row = ws.getRow(r);
          row.values = [
            zhk, klass, system, type, model,
            a.impressions, a.reach || null, a.clicks,
          ];
          row.getCell(9).value = { formula: `IF(F${r}=0,0,H${r}/F${r})` };   // CTR = клики/показы
          row.getCell(10).value = { formula: `IF(H${r}=0,0,K${r}/H${r})` };  // CR = лиды/клики
          row.getCell(11).value = a.leads;
          row.getCell(12).value = isYandex ? spendRaw : { formula: `${spendRaw}*$B$${RATE_ROW}` };
          row.getCell(13).value = isYandex
            ? { formula: `L${r}*$B$${YA_COEF_ROW}*(1+$B$${NDS_ROW})` }   // Яндекс: L×0.95×(1+НДС)
            : { formula: `L${r}*(1+$B$${AK_ROW})*(1+$B$${NDS_ROW})` };   // остальные: L×(1+АК)×(1+НДС)
          row.getCell(14).value = { formula: `IF(K${r}=0,0,L${r}/K${r})` };
          row.getCell(15).value = { formula: `IF(K${r}=0,0,M${r}/K${r})` };
          row.getCell(9).numFmt = "0.00%"; row.getCell(10).numFmt = "0.00%";
          row.getCell(12).numFmt = "#,##0"; row.getCell(13).numFmt = "#,##0";
          row.getCell(14).numFmt = "#,##0"; row.getCell(15).numFmt = "#,##0";
          row.font = { name: "Arial" };
          if (!klass) row.getCell(2).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
          r++;
        }
      }

      ws.columns.forEach((col) => { col.width = 16; });
      ws.getColumn(1).width = 20; ws.getColumn(4).width = 14;

      const note = ws.getRow(r + 1);
      note.getCell(1).value =
        "Курс, АК, НДС и коэфф. Яндекс — вводятся вручную (жёлтые ячейки B1:B4), формулы M/N/O/CTR/CR пересчитаются автоматически. " +
        "Расход с НДС и АК (M): Яндекс — L×коэфф.(0.95)×(1+НДС); Meta/Google/TikTok — L×(1+АК)×(1+НДС). " +
        "Google/Яндекс/TikTok: модель оплаты определена по типу кампании (Поиск→CPA, YouTube→CPV, Лидген формы→CPL, Охват→CPM) — в кабинетах эта разбивка отдельно не хранится. " +
        "Охват (G) для Google/Яндекс/TikTok не заполнен — этот показатель сейчас не сохраняется в нашей базе для этих площадок (только Meta). " +
        (unclassified.size ? `Класс жилья не заполнен (жёлтым): ${[...unclassified].join(", ")}.` : "");
      note.getCell(1).font = { italic: true, size: 9, color: { argb: "FF888888" }, name: "Arial" };
      ws.mergeCells(`A${note.number}:O${note.number}`);

      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `Отчёт ${monthName}.xlsx`;
      document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } finally {
      setExporting(false);
    }
  };

  const grand = newAgg();
  const rows: React.ReactNode[] = [];
  for (const zhk of zhks) {
    const systems = group[zhk];
    const sub = newAgg();
    for (const key of Object.keys(systems).sort((x, y) => systems[y].spend - systems[x].spend)) {
      const a = systems[key];
      const sys = key.startsWith("Google Ads") ? "Google Ads" : key.startsWith("Meta") ? "Meta"
        : key.startsWith("Yandex Direct") ? "Yandex Direct" : "TikTok";
      const rawLabel = key.slice(sys.length + 1) || "—";
      const typeLabel = sys === "TikTok" && rawLabel === "Лиды" ? "Лидген формы" : rawLabel;
      sub.impressions += a.impressions; sub.reach += a.reach; sub.clicks += a.clicks; sub.leads += a.leads; sub.spend += a.spend; sub.spendKzt += a.spendKzt; sub.spendKztTax += a.spendKztTax;
      rows.push(
        <tr key={zhk + key}>
          <td>{zhk}</td>
          <td style={{ whiteSpace: "nowrap" }}>{SYS_ICON[sys] ?? ""} {sys}</td>
          {active.map((c) => <td key={c.key}>{"type" in c && c.type ? typeLabel : cell(c, a, true)}</td>)}
        </tr>
      );
    }
    grand.impressions += sub.impressions; grand.reach += sub.reach; grand.clicks += sub.clicks; grand.leads += sub.leads; grand.spend += sub.spend; grand.spendKzt += sub.spendKzt; grand.spendKztTax += sub.spendKztTax;
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
      {periodMismatches.length > 0 && (
        <div className="err" style={{ marginBottom: 14, padding: 10, border: "1px solid var(--bad)", borderRadius: 8 }}>
          ⚠ Период Meta: {metaPeriod.start} — {metaPeriod.end}. У этих площадок другой период в базе — их цифры относятся к другому диапазону дат, суммы ниже будут некорректны:
          <ul style={{ margin: "6px 0 0", paddingLeft: 20 }}>
            {periodMismatches.map(([sys, p]) => <li key={sys}>{sys}: {p!.start} — {p!.end}</li>)}
          </ul>
          Нажмите <b>↻ Обновить</b> с нужным периодом наверху страницы, чтобы пересинхронизировать все площадки разом.
        </div>
      )}
      <div style={{ marginBottom: 14 }}>
        <div className="panel-title" style={{ fontSize: 13 }}>Столбцы</div>
        <div className="chips">
          {ZHK_COLS.map((c) => (
            <div key={c.key} className={"chip" + (cols.includes(c.key) ? " on" : "")} onClick={() => toggle(c.key)}>{c.label}</div>
          ))}
        </div>
      </div>
      <div style={{ marginBottom: 14, padding: 12, border: "1px solid var(--border)", borderRadius: 8 }}>
        <div className="panel-title" style={{ fontSize: 13 }}>Выгрузка в Excel</div>
        <div className="controls">
          <div className="field">
            <label>Курс доллара, ₸</label>
            <input type="number" placeholder="например, 480" value={exportRate} onChange={(e) => setExportRate(e.target.value)} style={{ width: 110 }} />
          </div>
          <div className="field">
            <label>АК, %</label>
            <input type="number" value={akPct} onChange={(e) => setAkPct(Number(e.target.value))} style={{ width: 70 }} />
          </div>
          <div className="field">
            <label>НДС, %</label>
            <input type="number" value={ndsPct} onChange={(e) => setNdsPct(Number(e.target.value))} style={{ width: 70 }} />
          </div>
          <button className="btn" onClick={downloadExcel} disabled={exporting} style={{ alignSelf: "end" }}>
            {exporting ? "⏳ Формирую…" : "⬇ Скачать Excel"}
          </button>
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
          Курс — вручную, конкретно для этой выгрузки (не совпадает с авто-курсом НБ РК выше). Расход с НДС и АК: Яндекс — ×0.95×(1+НДС), остальные площадки — ×(1+АК)×(1+НДС). Всё применяется формулами — можно поменять прямо в файле.
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
        ЖК определяется по названию кампании. «Лиды»: Meta — лид-формы, Google и Яндекс — конверсии, TikTok — лидген формы. Охват отдаёт только Meta (—).
        <br />Курс ₸/$ — среднемесячный по данным Нацбанка РК, за период <b>{rate}</b>
        {fxMonths.length > 0 && <> ({fxMonths.map((m) => `${m.month}: ${m.rate}`).join(", ")})</>}.
        Meta, Google и TikTok приходят в $, Яндекс — в ₸.
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

/* ============ Пользователь: кто вошёл, админка, выход ============ */
function UserBar() {
  const [me, setMe] = useState<{ email: string | null; isOwner: boolean } | null>(null);
  useEffect(() => {
    fetch("/api/me").then((r) => r.json()).then(setMe).catch(() => setMe(null));
  }, []);
  if (!me?.email) return null;
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", fontSize: 12 }} className="muted">
      <span>{me.email}</span>
      {me.isOwner && <a href="/admin" className="pill" style={{ textDecoration: "none" }}>⚙️ Доступы</a>}
      <a href="/api/auth/signout" className="pill" style={{ textDecoration: "none" }}>Выйти</a>
    </div>
  );
}

/* ============ Яндекс.Директ ============ */
interface YData {
  snapshot: { client_login: string; period_start: string; period_end: string; currency: string };
  rate: number;
  daily: { date: string; spend: number; impressions: number; clicks: number; conversions: number }[];
  campaigns: (YCampaign & { ctr: number; cpc: number; cost_per_conversion: number; status: string })[];
}
function YandexAds() {
  const [y, setY] = useState<YData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<"spend" | "clicks" | "conversions" | "impressions">("spend");
  const [sortKey, setSortKey] = useState<string>("spend");
  const [asc, setAsc] = useState(false);

  useEffect(() => {
    fetch("/api/yandex").then((r) => r.json()).then((d) => { d.error ? setErr(d.error) : setY(d); }).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="panel err">Ошибка: {err}<div className="muted" style={{ marginTop: 8 }}>Запустите <code>npm run sync:yandex</code>.</div></div>;
  if (!y) return <div className="center muted">Загрузка Яндекс.Директа…</div>;

  const T = y.daily.reduce((a, r) => ({ spend: a.spend + r.spend, impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks, conversions: a.conversions + r.conversions }), { spend: 0, impressions: 0, clicks: 0, conversions: 0 });
  const tg = (n: number) => Math.round(n).toLocaleString("ru-RU") + " ₸";
  const int = (n: number) => Math.round(n).toLocaleString("ru-RU");
  const cpa = T.conversions ? T.spend / T.conversions : 0;
  const ctr = T.impressions ? (T.clicks / T.impressions) * 100 : 0;
  const cpc = T.clicks ? T.spend / T.clicks : 0;

  const kpis = [
    { l: "Расход", v: tg(T.spend) }, { l: "в долларах", v: "$" + Math.round(T.spend / y.rate).toLocaleString("ru-RU") },
    { l: "Конверсии", v: int(T.conversions) }, { l: "CPA", v: tg(cpa) },
    { l: "Клики", v: int(T.clicks) }, { l: "CTR", v: ctr.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%" },
    { l: "CPC", v: tg(cpc) }, { l: "Показы", v: int(T.impressions) },
  ];
  const METR = [{ k: "spend", l: "Расход" }, { k: "conversions", l: "Конверсии" }, { k: "clicks", l: "Клики" }, { k: "impressions", l: "Показы" }] as const;
  const chart = y.daily.map((r) => ({ date: new Date(r.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" }), value: r[metric] }));

  const COLS = [
    { k: "spend", l: "Расход", f: tg }, { k: "conversions", l: "Конв.", f: int },
    { k: "cost_per_conversion", l: "CPA", f: tg }, { k: "clicks", l: "Клики", f: int },
    { k: "ctr", l: "CTR", f: (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%" },
    { k: "cpc", l: "CPC", f: tg }, { k: "impressions", l: "Показы", f: int },
  ];
  const sorted = [...y.campaigns].sort((a, b) => {
    const av = (a as unknown as Record<string, number>)[sortKey], bv = (b as unknown as Record<string, number>)[sortKey];
    return asc ? av - bv : bv - av;
  });
  const setSort = (k: string) => { if (k === sortKey) setAsc(!asc); else { setSortKey(k); setAsc(false); } };

  return (
    <>
      <div className="panel">
        <div className="panel-title">
          Яндекс.Директ{y.snapshot.client_login ? ` · ${y.snapshot.client_login}` : ""} · {new Date(y.snapshot.period_start).toLocaleDateString("ru-RU")} — {new Date(y.snapshot.period_end).toLocaleDateString("ru-RU")}
        </div>
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
            <YAxis stroke="#8b95a7" fontSize={11} width={70} />
            <Tooltip contentStyle={{ background: "#141925", border: "1px solid #263042", borderRadius: 10, color: "#e6e9ef" }} />
            <Line type="monotone" dataKey="value" stroke="#facc15" strokeWidth={2} dot={false} name={METR.find((m) => m.k === metric)?.l} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="panel">
        <div className="panel-title">Кампании Яндекс.Директа ({y.campaigns.length})</div>
        <div className="table-scroll">
          <table>
            <thead><tr>
              <th>Кампания</th>
              {COLS.map((c) => <th key={c.k} onClick={() => setSort(c.k)} style={{ cursor: "pointer" }}>{c.l}{sortKey === c.k ? (asc ? " ▲" : " ▼") : ""}</th>)}
            </tr></thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.campaign_id}>
                  <td title={c.name} style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</td>
                  {COLS.map((col) => <td key={col.k}>{col.f((c as unknown as Record<string, number>)[col.k])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Суммы в тенге. Курс для сводки по ЖК: {y.rate} ₸ за $1.</div>
      </div>
    </>
  );
}

/* ============ TikTok Ads ============ */
interface TData {
  snapshot: { advertiser_id: string; period_start: string; period_end: string; currency: string };
  daily: { date: string; spend: number; impressions: number; clicks: number; conversions: number }[];
  campaigns: (TCampaign & { ctr: number; cost_per_conversion: number; status: string })[];
}
function TiktokAds() {
  const [t, setT] = useState<TData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [metric, setMetric] = useState<"spend" | "clicks" | "conversions" | "impressions">("spend");
  const [sortKey, setSortKey] = useState<string>("spend");
  const [asc, setAsc] = useState(false);

  useEffect(() => {
    fetch("/api/tiktok").then((r) => r.json()).then((d) => { d.error ? setErr(d.error) : setT(d); }).catch((e) => setErr(String(e)));
  }, []);

  if (err) return <div className="panel err">Ошибка: {err}<div className="muted" style={{ marginTop: 8 }}>Запустите <code>npm run sync:tiktok</code>.</div></div>;
  if (!t) return <div className="center muted">Загрузка TikTok…</div>;

  const T = t.daily.reduce((a, r) => ({ spend: a.spend + r.spend, impressions: a.impressions + r.impressions, clicks: a.clicks + r.clicks, conversions: a.conversions + r.conversions }), { spend: 0, impressions: 0, clicks: 0, conversions: 0 });
  const money = (n: number) => "$" + n.toLocaleString("ru-RU", { maximumFractionDigits: n < 100 ? 2 : 0 });
  const int = (n: number) => Math.round(n).toLocaleString("ru-RU");
  const cpa = T.conversions ? T.spend / T.conversions : 0;
  const ctr = T.impressions ? (T.clicks / T.impressions) * 100 : 0;
  const cpc = T.clicks ? T.spend / T.clicks : 0;

  const kpis = [
    { l: "Расход", v: money(T.spend) }, { l: "Лидген формы", v: int(T.conversions) }, { l: "CPA", v: money(cpa) },
    { l: "Клики", v: int(T.clicks) }, { l: "CTR", v: ctr.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%" },
    { l: "CPC", v: money(cpc) }, { l: "Показы", v: int(T.impressions) },
  ];
  const METR = [{ k: "spend", l: "Расход" }, { k: "conversions", l: "Лидген формы" }, { k: "clicks", l: "Клики" }, { k: "impressions", l: "Показы" }] as const;
  const chart = t.daily.map((r) => ({ date: new Date(r.date).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" }), value: r[metric] }));

  const COLS = [
    { k: "spend", l: "Расход", f: money }, { k: "conversions", l: "Лидген формы", f: int },
    { k: "cost_per_conversion", l: "CPA", f: money }, { k: "clicks", l: "Клики", f: int },
    { k: "ctr", l: "CTR", f: (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%" },
    { k: "impressions", l: "Показы", f: int },
  ];
  const sorted = [...t.campaigns].sort((a, b) => {
    const av = (a as unknown as Record<string, number>)[sortKey], bv = (b as unknown as Record<string, number>)[sortKey];
    return asc ? av - bv : bv - av;
  });
  const setSort = (k: string) => { if (k === sortKey) setAsc(!asc); else { setSortKey(k); setAsc(false); } };

  return (
    <>
      <div className="panel">
        <div className="panel-title">
          TikTok{t.snapshot.advertiser_id ? ` · ${t.snapshot.advertiser_id}` : ""} · {new Date(t.snapshot.period_start).toLocaleDateString("ru-RU")} — {new Date(t.snapshot.period_end).toLocaleDateString("ru-RU")}
        </div>
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
            <YAxis stroke="#8b95a7" fontSize={11} width={70} />
            <Tooltip contentStyle={{ background: "#141925", border: "1px solid #263042", borderRadius: 10, color: "#e6e9ef" }} />
            <Line type="monotone" dataKey="value" stroke="#22d3ee" strokeWidth={2} dot={false} name={METR.find((m) => m.k === metric)?.l} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="panel">
        <div className="panel-title">Кампании TikTok ({t.campaigns.length})</div>
        <div className="table-scroll">
          <table>
            <thead><tr>
              <th>Кампания</th>
              {COLS.map((c) => <th key={c.k} onClick={() => setSort(c.k)} style={{ cursor: "pointer" }}>{c.l}{sortKey === c.k ? (asc ? " ▲" : " ▼") : ""}</th>)}
            </tr></thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.campaign_id}>
                  <td title={c.name} style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.name}</td>
                  {COLS.map((col) => <td key={col.k}>{col.f((c as unknown as Record<string, number>)[col.k])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>Суммы в долларах (кабинет в USD). &quot;Лидген формы&quot; — конверсии по цели кампании в TikTok Ads.</div>
      </div>
    </>
  );
}

/* ============ Выгорание креативов/аудитории (динамика по периодам) ============ */
interface DynPeriod { since: string; until: string }
type DynMetrics = { spend: number; impressions: number; reach: number; frequency: number; clicks: number; ctr: number; leads: number; cpl: number };
interface DynRow { id: string; name: string; periods: (DynMetrics | null)[] }
type DynPlatform = "Meta" | "Google Ads" | "TikTok";
const DYN_ICON: Record<DynPlatform, string> = { Meta: "🔵", "Google Ads": "🔴", TikTok: "⚫" };

const dynMoney = (n: number) => "$" + n.toLocaleString("ru-RU", { maximumFractionDigits: n < 100 ? 2 : 0 });
const dynInt = (n: number) => Math.round(n).toLocaleString("ru-RU");
const dynPct = (n: number) => n.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%";

// Группы колонок: каждая метрика — своим блоком из N колонок (по числу периодов),
// а не наоборот. metaOnly — колонки с "—" для Google Ads/TikTok (нет данных).
const DYN_METRICS = [
  { key: "leads", label: "Лидов", metaOnly: false },
  { key: "cpl", label: "CPL $", metaOnly: false },
  { key: "spend", label: "Spend $", metaOnly: false },
  { key: "reach", label: "Охват", metaOnly: true },
  { key: "frequency", label: "Частота", metaOnly: true },
  { key: "ctr", label: "CTR", metaOnly: false },
] as const;
type DynMetricKey = (typeof DYN_METRICS)[number]["key"];

const dynFmt = (key: DynMetricKey, v: number) => {
  if (key === "leads") return dynInt(v);
  if (key === "cpl" || key === "spend") return dynMoney(v);
  if (key === "reach") return dynInt(v);
  if (key === "frequency") return v.toFixed(2);
  return dynPct(v);
};

// Заливка прямо в ячейке (не отдельной Δ-колонкой): CPL красным/зелёным при
// изменении ≥5% к предыдущему периоду в этой же строке; Частота — оранжевым
// при ≥3 (порог визуальной усталости аудитории), независимо от истории.
function dynCellStyle(key: DynMetricKey, cur: DynMetrics | null, prev: DynMetrics | null): React.CSSProperties {
  if (key === "cpl") {
    if (!cur?.leads || !prev?.leads) return {};
    const pct = ((cur.cpl - prev.cpl) / prev.cpl) * 100;
    if (Math.abs(pct) < 5) return {};
    return pct > 0 ? { color: "var(--bad)", fontWeight: 600 } : { color: "var(--good)", fontWeight: 600 };
  }
  if (key === "frequency") {
    if (!cur || cur.frequency < 3) return {};
    return { background: "rgba(250,204,21,.18)", fontWeight: 600 };
  }
  return {};
}

interface DynFlag { icon: string; label: string; sev: "bad" | "warn" | "good" | "neutral"; cplPct: number | null }

// Статус строки по последним двум периодам: резкий рост CPL / выгорание аудитории
// (частота ≥3 или её резкий скачок) / падение CTR / рост CPL умеренный / стабильно / улучшение.
// Порядок проверок — по убыванию серьёзности, показываем самый важный сигнал.
function dynFlag(row: DynRow, platform: DynPlatform): DynFlag | null {
  const n = row.periods.length;
  const last = row.periods[n - 1], prev = row.periods[n - 2];
  if (!last || !prev) return null;
  const cplPct = prev.leads && last.leads ? ((last.cpl - prev.cpl) / prev.cpl) * 100 : null;
  const ctrPct = prev.ctr ? ((last.ctr - prev.ctr) / prev.ctr) * 100 : null;
  const freqJump = platform === "Meta" && (last.frequency >= 3 || (prev.frequency > 0 && (last.frequency - prev.frequency) / prev.frequency >= 0.3));

  if (cplPct !== null && cplPct >= 30) return { icon: "🔴", label: "CPL резко вырос", sev: "bad", cplPct };
  if (freqJump && cplPct !== null && cplPct > 0) return { icon: "🔴", label: "Выгорание аудитории", sev: "bad", cplPct };
  if (cplPct !== null && cplPct >= 10) return { icon: "🟠", label: "CPL растёт", sev: "warn", cplPct };
  if (freqJump) return { icon: "🟠", label: "Частота высокая", sev: "warn", cplPct };
  if (ctrPct !== null && ctrPct <= -20) return { icon: "🟠", label: "CTR падает", sev: "warn", cplPct };
  if (cplPct !== null && cplPct <= -10) return { icon: "🚀", label: "CPL улучшился", sev: "good", cplPct };
  return { icon: "🟢", label: "Стабильно", sev: "neutral", cplPct };
}

// Одна строка дерева (кампания → адсет → объявление). Раскрытие и дочерние строки —
// только для Meta: у Google/TikTok в дашборде нет уровня групп объявлений.
function FatigueRow({ row, platform, depth, level, periods }: {
  row: DynRow; platform: DynPlatform; depth: number; level: "campaign" | "adset" | "ad"; periods: DynPeriod[];
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DynRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const canExpand = platform === "Meta" && level !== "ad";
  const nextLevel = level === "campaign" ? "adset" : "ad";

  const toggle = async () => {
    if (!canExpand) return;
    if (!expanded && children === null) {
      setLoading(true); setErr(null);
      try {
        const res = await fetch("/api/dynamics/meta", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ level: nextLevel, parentId: row.id, periods }),
        });
        const j = await res.json();
        if (!res.ok) setErr(j.error || "Ошибка"); else setChildren(j.rows);
      } catch (e) { setErr(String(e)); }
      setLoading(false);
    }
    setExpanded(!expanded);
  };

  return (
    <>
      <tr>
        <td style={{ paddingLeft: 12 + depth * 20, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          title={row.name}>
          {canExpand && (
            <span onClick={toggle} style={{ cursor: "pointer", display: "inline-block", width: 16 }}>
              {loading ? "⏳" : expanded ? "▾" : "▸"}
            </span>
          )}
          {depth === 0 && <span style={{ marginRight: 6 }}>{DYN_ICON[platform]}</span>}
          {row.name}
        </td>
        {DYN_METRICS.map((m) => row.periods.map((p, i) => {
          const skip = m.metaOnly && platform !== "Meta";
          const cellVal = p && !skip ? p[m.key as keyof DynMetrics] : null;
          const show = cellVal != null && !(m.key === "cpl" && !p?.leads);
          return (
            <td key={m.key + i} style={p ? dynCellStyle(m.key, p, row.periods[i - 1] ?? null) : {}}>
              {show ? dynFmt(m.key, cellVal as number) : "—"}
            </td>
          );
        }))}
        <td>
          {(() => {
            const f = dynFlag(row, platform);
            return f ? <span title={f.cplPct != null ? `CPL: ${f.cplPct > 0 ? "+" : ""}${f.cplPct.toFixed(0)}%` : ""}>{f.icon} {f.label}</span> : <span className="muted">—</span>;
          })()}
        </td>
      </tr>
      {err && <tr><td colSpan={2 + row.periods.length * DYN_METRICS.length}><span className="err">Ошибка: {err}</span></td></tr>}
      {expanded && children && children.map((c) => (
        <FatigueRow key={c.id} row={c} platform={platform} depth={depth + 1} level={nextLevel} periods={periods} />
      ))}
    </>
  );
}

function FatigueTracker() {
  const today = new Date().toISOString().slice(0, 10);
  const daysAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
  const [periods, setPeriods] = useState<DynPeriod[]>([
    { since: daysAgo(27), until: daysAgo(21) },
    { since: daysAgo(20), until: daysAgo(14) },
    { since: daysAgo(13), until: daysAgo(7) },
    { since: daysAgo(6), until: today },
  ]);
  const [rows, setRows] = useState<{ row: DynRow; platform: DynPlatform }[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [errs, setErrs] = useState<string[]>([]);

  const addPeriod = () => {
    if (periods.length >= 6) return;
    const lastUntil = periods[periods.length - 1]?.until || today;
    setPeriods([...periods, { since: lastUntil, until: today }]);
  };
  const removePeriod = (i: number) => { if (periods.length > 2) setPeriods(periods.filter((_, idx) => idx !== i)); };
  const updatePeriod = (i: number, field: "since" | "until", v: string) =>
    setPeriods(periods.map((p, idx) => (idx === i ? { ...p, [field]: v } : p)));

  const run = async () => {
    setLoading(true); setErrs([]); setRows(null);
    const collected: { row: DynRow; platform: DynPlatform }[] = [];
    const errors: string[] = [];
    const calls: [DynPlatform, string][] = [["Meta", "/api/dynamics/meta"], ["Google Ads", "/api/dynamics/google"], ["TikTok", "/api/dynamics/tiktok"]];
    await Promise.all(calls.map(async ([platform, url]) => {
      try {
        const res = await fetch(url, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(platform === "Meta" ? { level: "campaign", periods } : { periods }),
        });
        const j = await res.json();
        if (!res.ok) { errors.push(`${platform}: ${j.error || res.status}`); return; }
        for (const row of j.rows as DynRow[]) collected.push({ row, platform });
      } catch (e) { errors.push(`${platform}: ${String(e)}`); }
    }));
    collected.sort((a, b) => {
      const sa = a.row.periods.reduce((s, p) => s + (p?.spend ?? 0), 0);
      const sb = b.row.periods.reduce((s, p) => s + (p?.spend ?? 0), 0);
      return sb - sa;
    });
    setRows(collected); setErrs(errors); setLoading(false);
  };

  const fmtShort = (d: string) => new Date(d).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });

  // Автовыводы по верхнеуровневым (кампания) строкам — по тем же сигналам, что и
  // колонка "Статус": резкий рост CPL, выгорание аудитории (частота), падение CTR.
  const insights = useMemo(() => {
    if (!rows) return null;
    const flagged = rows.map((r) => ({ ...r, flag: dynFlag(r.row, r.platform) })).filter((r) => r.flag);
    const bad = flagged.filter((r) => r.flag!.sev === "bad");
    const warn = flagged.filter((r) => r.flag!.sev === "warn");
    const good = flagged.filter((r) => r.flag!.sev === "good");
    const n = periods.length;
    let curLeads = 0, curSpend = 0, prevLeads = 0, prevSpend = 0;
    for (const { row } of rows) {
      const last = row.periods[n - 1], prev = row.periods[n - 2];
      if (last) { curLeads += last.leads; curSpend += last.spend; }
      if (prev) { prevLeads += prev.leads; prevSpend += prev.spend; }
    }
    const curCpl = curLeads ? curSpend / curLeads : 0;
    const prevCpl = prevLeads ? prevSpend / prevLeads : 0;
    const portfolioPct = prevCpl ? ((curCpl - prevCpl) / prevCpl) * 100 : null;
    return { bad, warn, good, curLeads, prevLeads, curCpl, prevCpl, portfolioPct };
  }, [rows, periods.length]);

  const dynRecommend = (label: string) => {
    if (label === "CPL резко вырос") return "рекомендована замена креативов и/или сужение аудитории";
    if (label === "Выгорание аудитории") return "частота высокая при растущем CPL — обновите креативы или расширьте охват";
    if (label === "CPL растёт") return "пока не критично, но стоит проверить в следующем периоде";
    if (label === "CTR падает") return "возможна усталость от креатива — присмотреться к замене";
    return "";
  };

  return (
    <>
      <div className="panel">
        <div className="panel-title">Периоды для сравнения</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {periods.map((p, i) => (
            <div key={i} className="controls" style={{ alignItems: "end" }}>
              <div style={{ alignSelf: "center", minWidth: 46, color: "var(--muted)" }}>P{i + 1}</div>
              <div className="field"><label>с</label><input type="date" value={p.since} onChange={(e) => updatePeriod(i, "since", e.target.value)} /></div>
              <div className="field"><label>по</label><input type="date" value={p.until} onChange={(e) => updatePeriod(i, "until", e.target.value)} /></div>
              {periods.length > 2 && <button className="btn" onClick={() => removePeriod(i)}>✕</button>}
            </div>
          ))}
        </div>
        <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
          {periods.length < 6 && <button className="btn" onClick={addPeriod}>+ Период</button>}
          <button className="btn" onClick={run} disabled={loading} style={{ marginLeft: "auto" }}>
            {loading ? "⏳ Загрузка…" : "Показать динамику"}
          </button>
        </div>
        {errs.length > 0 && <div className="err" style={{ marginTop: 10 }}>{errs.join(" · ")}</div>}
      </div>

      {rows && (
        <div className="panel">
          <div className="panel-title">Динамика по кампаниям ({rows.length})</div>
          <div className="muted" style={{ marginBottom: 10, fontSize: 12 }}>
            ▸ у Meta-кампаний раскрывает группы объявлений, затем — отдельные объявления. У Google Ads и TikTok — только уровень кампаний.
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th rowSpan={2}>Кампания</th>
                  {DYN_METRICS.map((m) => <th key={m.key} colSpan={periods.length} style={{ textAlign: "center", borderBottom: "none" }}>{m.label}</th>)}
                  <th rowSpan={2}>Статус</th>
                </tr>
                <tr>
                  {DYN_METRICS.map((m) => periods.map((p, i) => (
                    <th key={m.key + i} title={`${fmtShort(p.since)}–${fmtShort(p.until)}`}>P{i + 1}</th>
                  )))}
                </tr>
              </thead>
              <tbody>
                {rows.map(({ row, platform }) => (
                  <FatigueRow key={platform + row.id} row={row} platform={platform} depth={0} level="campaign" periods={periods} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
            Данные тянутся из API площадок в реальном времени за выбранные периоды (без записи в базу). Охват/Частота доступны только у Meta.
            <span style={{ color: "var(--bad)", fontWeight: 600 }}> CPL красным</span> — вырос ≥5% к предыдущему периоду в этой строке,
            <span style={{ color: "var(--good)", fontWeight: 600 }}> зелёным</span> — снизился ≥5%.
            <span style={{ background: "rgba(250,204,21,.18)", fontWeight: 600, padding: "0 4px" }}> Частота жёлтым</span> — ≥3 (сигнал усталости аудитории).
            Яндекс.Директ не включён — его API отдаёт отчёты асинхронно (до нескольких минут на запрос), что слишком медленно для интерактивного сравнения нескольких периодов.
          </div>
        </div>
      )}

      {insights && (
        <div className="panel">
          <div className="panel-title">📊 Выводы</div>
          <div style={{ marginBottom: 14 }}>
            Портфель, лидов P{periods.length - 1}→P{periods.length}: <b>{dynInt(insights.prevLeads)}</b> → <b>{dynInt(insights.curLeads)}</b>.
            {" "}CPL: <b>{insights.prevCpl ? dynMoney(insights.prevCpl) : "—"}</b> → <b>{insights.curCpl ? dynMoney(insights.curCpl) : "—"}</b>
            {insights.portfolioPct != null && (
              <span style={{ color: insights.portfolioPct > 0 ? "var(--bad)" : "var(--good)", fontWeight: 600 }}>
                {" "}({insights.portfolioPct > 0 ? "+" : ""}{insights.portfolioPct.toFixed(1)}%)
              </span>
            )}.
          </div>

          {insights.bad.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: "var(--bad)", marginBottom: 6 }}>🔴 Требует внимания</div>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {insights.bad.map(({ row, platform, flag }) => (
                  <li key={platform + row.id} style={{ marginBottom: 4 }}>
                    {DYN_ICON[platform]} <b>{row.name}</b> — {flag!.label}
                    {flag!.cplPct != null && <> (CPL {flag!.cplPct > 0 ? "+" : ""}{flag!.cplPct.toFixed(0)}%)</>}
                    {dynRecommend(flag!.label) && <span className="muted"> — {dynRecommend(flag!.label)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {insights.warn.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: "#f59e0b", marginBottom: 6 }}>🟠 Стоит последить</div>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {insights.warn.map(({ row, platform, flag }) => (
                  <li key={platform + row.id} style={{ marginBottom: 4 }}>
                    {DYN_ICON[platform]} <b>{row.name}</b> — {flag!.label}
                    {flag!.cplPct != null && <> (CPL {flag!.cplPct > 0 ? "+" : ""}{flag!.cplPct.toFixed(0)}%)</>}
                    {dynRecommend(flag!.label) && <span className="muted"> — {dynRecommend(flag!.label)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {insights.good.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontWeight: 700, color: "var(--good)", marginBottom: 6 }}>🚀 Хорошо работает</div>
              <ul style={{ margin: 0, paddingLeft: 20 }}>
                {insights.good.map(({ row, platform, flag }) => (
                  <li key={platform + row.id} style={{ marginBottom: 4 }}>
                    {DYN_ICON[platform]} <b>{row.name}</b> — {flag!.label}
                    {flag!.cplPct != null && <> (CPL {flag!.cplPct.toFixed(0)}%)</>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {insights.bad.length === 0 && insights.warn.length === 0 && (
            <div className="muted">Явных сигналов выгорания (резкий рост CPL, высокая частота, падение CTR) не обнаружено.</div>
          )}
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
      // Остальные площадки синхронизируются best-effort — если какая-то упала, показываем,
      // а не молчим (иначе в сводке останутся данные за старый период с этой площадки).
      const failed: string[] = [];
      if (j.googleError) failed.push("Google Ads: " + String(j.googleError).slice(0, 120));
      if (j.yandexError) failed.push("Яндекс: " + String(j.yandexError).slice(0, 120));
      if (j.tiktokError) failed.push("TikTok: " + String(j.tiktokError).slice(0, 120));
      if (failed.length) {
        setMsg("Meta обновлена, но не удалось: " + failed.join(" · "));
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
