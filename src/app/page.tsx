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

const TABS = ["Обзор", "Meta", "Google Ads", "Яндекс", "TikTok", "Сводка", "Выгорание", "Сверка продаж"] as const;
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
      {tab === "Сверка продаж" && <SalesReconcile />}
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
  // Разные написания одного и того же ЖК в разных кабинетах/адсетах — сводим в одно.
  "admplus": "Adamant Plus",
  "adamantplus": "Adamant Plus",
  "admlife": "Adamant Life",
  "adamantlife": "Adamant Life",
  "eliosпост": "Elios", // "Elios — пост" (адсет с постовым форматом) — тот же ЖК, что и "Elios"
  "parkvile": "Parkville", // опечатка в названии адсета ("Parkvile" вместо "Parkville")
};

// Ручная привязка конкретных Google ad group → ЖК, когда в названии группы объявлений
// нет ни одного узнаваемого сегмента (только техническое "МЖ18-54 | Широкая" и т.п.),
// но по факту известно, что это конкретный проект/ЖК.
const ADGROUP_ZHK_OVERRIDE: Record<string, string> = {
  "197448007198": "Роща Баума", // 2002HUBATY | YT InStream | HUB ALMATY — видео про благоустройство рощи Баума
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
  "IG", "IG+FB", "FB", "AstAud", "База Аст", "База", "Бренд",
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

// Служебные сегменты, которые встречаются ТОЛЬКО в названиях групп объявлений
// Google Ads (не кампаний) — общий охват без привязки к конкретному ЖК.
const ADGROUP_NON_ZHK = new Set(["General", "Широкая", "Комплект 1", "Комплект 2", "Комплект 3", "Комплект"].map(normz));
// Гендерно-возрастные коды вида "МЖ18-54", "МЖ25+", "М18+" — буквы, сразу за ними цифры.
const AUDIENCE_CODE_RE = /^[a-zа-я]{1,3}\d/i;

// Разбор ЖК для Google ad group: в отличие от кампаний, у групп объявлений НЕТ единой
// конвенции "код | цель | ... " — ЖК может быть и первым сегментом ("Cascade | General"),
// и вторым ("Бренд | PARKVILLE"), поэтому не режем позиционно, а фильтруем весь набор.
function resolveZhkFromAdgroup(name: string, canon: Map<string, string>): string {
  const cands = segs(name).filter((s) => {
    const n = normz(s);
    if (!n || NON_ZHK.has(n) || ADGROUP_NON_ZHK.has(n)) return false;
    if (/^#?\d+$/.test(s.trim())) return false;
    if (/^(cpa|cpl|cpm|cpv|cpc|cpe)\d*$/.test(n)) return false;
    if (AUDIENCE_CODE_RE.test(s.trim())) return false;
    return true;
  });
  if (cands.length === 0) return "Бренд / Общие";
  const pick = (s: string) => ZHK_CANON[normz(s)] ?? s;
  for (const c of cands) { const k = normz(c); if (canon.has(k)) return pick(canon.get(k)!); }
  for (const c of cands) {
    for (const disp of canon.values()) {
      if (disp.length < 3) continue;
      const re = new RegExp(`(^|[^\\p{L}\\p{N}])${reEsc(disp)}([^\\p{L}\\p{N}]|$)`, "iu");
      if (re.test(c)) return pick(disp);
    }
  }
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
interface TAdgroup { adgroup_id: string; campaign_id: string; name: string; spend: number; impressions: number; clicks: number; conversions: number }
interface GAdgroup { ad_group_id: string; campaign_id: string; name: string; spend: number; impressions: number; clicks: number; ctr: number; conversions: number; cost_per_conversion: number }

// Кампании, которые бьём не по ЖК, а по городам (группам объявлений) — это
// сквозные акции на несколько городов сразу, у них нет единого ЖК-названия.
const MULTICITY_RE = /коммерц|летние\s*скидк|summer\s*fest/i;
const CITY_LIST = ["Алматы", "Астана", "Шымкент", "Атырау", "Караганда", "Актобе"];
// HUB-кампании (Meta и Google) — сборные по нескольким ЖК сразу, ЖК виден только на
// уровне группы объявлений (Meta: адсет, Google: ad group), а не в названии кампании.
const HUB_RE = /\bhub\b/i;

function ZhkSummary({ metaCampaigns, metaAdsets, metaPeriod }: { metaCampaigns: Entity[]; metaAdsets: Entity[]; metaPeriod: { start: string; end: string } }) {
  const [google, setGoogle] = useState<GCampaign[] | null>(null);
  const [googleAdgroups, setGoogleAdgroups] = useState<GAdgroup[]>([]);
  const [yandex, setYandex] = useState<YCampaign[] | null>(null);
  const [tiktok, setTiktok] = useState<TCampaign[] | null>(null);
  const [tiktokAdgroups, setTiktokAdgroups] = useState<TAdgroup[]>([]);
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
      setGoogleAdgroups(d.error ? [] : (d.adgroups ?? []));
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
      setTiktokAdgroups(d.error ? [] : (d.adgroups ?? []));
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
  // HUB/Коммерция/Летние скидки — сборные кампании без единого ЖК, их не сеем в canon
  // (иначе "HUB" зарегистрируется как fake-ЖК ещё до того, как мы её разберём по адсетам).
  const canon = new Map<string, string>();
  for (const c of metaCampaigns) {
    if (MULTICITY_RE.test(c.name) || HUB_RE.test(c.name)) continue;
    const cs = zhkCandidates(c.name);
    if (cs.length) { const k = normz(cs[0]); if (!canon.has(k)) canon.set(k, cs[0]); }
  }
  const isZero = (p: { impressions?: number; spend?: number; clicks?: number; leads?: number }) =>
    !(p.impressions || 0) && !(p.spend || 0) && !(p.clicks || 0) && !(p.leads || 0);

  for (const c of metaCampaigns) {
    if (MULTICITY_RE.test(c.name) || HUB_RE.test(c.name)) continue; // эти кампании бьём ниже по адсетам
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
    // Сквозные акции (Коммерция / Летние скидки / Summer Fest) без единого ЖК — бьём по
    // городам из названий групп объявлений (адсетов).
    const multiCampaignIds = new Set(metaCampaigns.filter((c) => MULTICITY_RE.test(c.name)).map((c) => c.campaign_id));
    const campaignById = new Map(metaCampaigns.map((c) => [c.campaign_id, c]));
    for (const a of metaAdsets) {
      if (!a.campaign_id || !multiCampaignIds.has(a.campaign_id)) continue;
      const camp = campaignById.get(a.campaign_id);
      if (!camp) continue;
      const label = /летние\s*скидк/i.test(camp.name) ? "Летние скидки"
        : /summer\s*fest/i.test(camp.name) ? "Summer Fest" : "Коммерция";
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
  {
    // HUB-кампании Meta (сборные по нескольким ЖК) — бьём по адсетам: ЖК определяется
    // по названию адсета (последний сегмент), а не кампании.
    const hubCampaignIds = new Set(metaCampaigns.filter((c) => HUB_RE.test(c.name)).map((c) => c.campaign_id));
    for (const a of metaAdsets) {
      if (!a.campaign_id || !hubCampaignIds.has(a.campaign_id)) continue;
      const ac = a as unknown as Record<string, number | string>;
      const spend = +ac.spend;
      const patch = {
        impressions: +ac.impressions, reach: +ac.reach, clicks: +ac.clicks,
        leads: ac.result_type === "Лиды" ? +ac.results : 0,
        spend, spendKzt: spend * rate, spendKztTax: spend * taxRate * (1 + ak) * (1 + nds),
        type: (ac.result_type as string) || "—",
      };
      if (isZero(patch)) continue;
      add(resolveZhk(a.name, canon), "Meta", patch);
    }
  }
  {
    // Google: кампании, где сам названием кампании ЖК не выдаёт (HUB-кампании или
    // "Бренд/Общий поиск" без содержательного сегмента) — бьём по группам объявлений
    // ("Бренд | PARKVILLE"), там ЖК виден напрямую.
    const googleSplitIds = new Set(
      (google ?? []).filter((c) => HUB_RE.test(c.name) || zhkCandidates(c.name).length === 0).map((c) => c.campaign_id)
    );
    const googleChannelById = new Map((google ?? []).map((c) => [c.campaign_id, (c as unknown as Record<string, unknown>).channel as string]));
    for (const c of google ?? []) {
      if (googleSplitIds.has(c.campaign_id)) continue;
      const gc = c as unknown as Record<string, unknown>;
      const patch = {
        impressions: c.impressions, reach: 0, clicks: c.clicks, leads: c.conversions,
        spend: c.spend, spendKzt: c.spend * rate, spendKztTax: c.spend * taxRate * (1 + ak) * (1 + nds),
        type: (gc.channel as string) || "—",
      };
      if (isZero(patch)) continue;
      add(resolveZhk(c.name, canon), "Google Ads", patch);
    }
    for (const ag of googleAdgroups) {
      if (!googleSplitIds.has(ag.campaign_id)) continue;
      const spend = ag.spend;
      const patch = {
        impressions: ag.impressions, reach: 0, clicks: ag.clicks, leads: ag.conversions,
        spend, spendKzt: spend * rate, spendKztTax: spend * taxRate * (1 + ak) * (1 + nds),
        type: googleChannelById.get(ag.campaign_id) || "—",
      };
      if (isZero(patch)) continue;
      add(ADGROUP_ZHK_OVERRIDE[ag.ad_group_id] ?? resolveZhkFromAdgroup(ag.name, canon), "Google Ads", patch);
    }
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
    if (MULTICITY_RE.test(c.name)) continue; // эти кампании бьём ниже по городам (ad group)
    const spend = c.spend; // кабинет в USD
    const type = /лиды/i.test(c.name) ? "Лидген формы" : /охват/i.test(c.name) ? "Охват" : "—";
    const patch = {
      impressions: c.impressions, reach: 0, clicks: c.clicks, leads: c.conversions,
      spend, spendKzt: spend * rate, spendKztTax: spend * taxRate * (1 + ak) * (1 + nds), type,
    };
    if (isZero(patch)) continue;
    add(resolveZhk(c.name, canon), "TikTok", patch);
  }
  {
    // TikTok: сквозные акции (Коммерция / Летние скидки / Summer Fest) — бьём по городам
    // из названий групп объявлений, как и у Meta.
    const multiIds = new Set((tiktok ?? []).filter((c) => MULTICITY_RE.test(c.name)).map((c) => c.campaign_id));
    const campById = new Map((tiktok ?? []).map((c) => [c.campaign_id, c]));
    for (const ag of tiktokAdgroups) {
      if (!multiIds.has(ag.campaign_id)) continue;
      const camp = campById.get(ag.campaign_id);
      if (!camp) continue;
      const label = /летние\s*скидк/i.test(camp.name) ? "Летние скидки"
        : /summer\s*fest/i.test(camp.name) ? "Summer Fest" : "Коммерция";
      const city = CITY_LIST.find((ct) => ag.name.includes(ct)) || "Прочее";
      const type = /лиды/i.test(camp.name) ? "Лидген формы" : /охват/i.test(camp.name) ? "Охват" : "—";
      const spend = ag.spend;
      const patch = {
        impressions: ag.impressions, reach: 0, clicks: ag.clicks, leads: ag.conversions,
        spend, spendKzt: spend * rate, spendKztTax: spend * taxRate * (1 + ak) * (1 + nds), type,
      };
      if (isZero(patch)) continue;
      add(`${label} · ${city}`, "TikTok", patch);
    }
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

/* ============ Сверка продаж: лиды (канал) × договоры (телефон) ============ */
type SheetRow = (string | number | null)[];

// Телефон → последние 10 цифр (без кода страны/форматирования) — общий ключ сопоставления.
// Ячейка может содержать несколько телефонов через запятую/точку с запятой/слэш.
function normPhones(raw: string | number | null): string[] {
  if (raw == null || raw === "") return [];
  return String(raw)
    .split(/[,;/]/)
    .map((s) => s.replace(/\D/g, ""))
    .filter((d) => d.length >= 9)
    .map((d) => d.slice(-10));
}

// ФИО → устойчивый ключ: нижний регистр, ё→е, только буквы, слова по алфавиту
// (порядок "Фамилия Имя Отчество" в двух системах может отличаться).
// Требуем минимум 2 слова: одиночное имя ("Айгерим") слишком часто повторяется,
// по нему матчить нельзя — получим ложные совпадения между разными людьми.
function nameKey(raw: string): string {
  const words = String(raw).toLowerCase().replace(/ё/g, "е")
    .replace(/[^a-zа-я\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  return words.length >= 2 ? words.sort().join(" ") : "";
}

// "05.06.2026" → "20260605" для корректного сравнения дат (лексикографически dd.mm.yyyy
// сортируется по дню, а не по году). Нераспознанное — в конец.
function sortableDate(s: string): string {
  const m = String(s).match(/(\d{2})[.\-/](\d{2})[.\-/](\d{4})/);
  return m ? m[3] + m[2] + m[1] : "99999999";
}
// Выгрузка Центра лидов датируется в американском формате "08/12/2026 5:15am" (ММ/ДД/ГГГГ).
function sortableAdDate(s: string): string {
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? m[3] + m[1].padStart(2, "0") + m[2].padStart(2, "0") : "99999999";
}

// Строка (0-индексная), в которой хотя бы одна ячейка содержит keyword — ищем заголовок.
function findHeaderRow(rows: SheetRow[], keyword: string): number {
  const k = keyword.toLowerCase();
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    if ((rows[i] ?? []).some((c) => String(c ?? "").toLowerCase().includes(k))) return i;
  }
  return -1;
}
// Собираем подписи колонок из строки заголовка, докладывая объединённые ячейки строкой выше
// (в "Реестр договоров" заголовок двухуровневый: "Оплата" сверху, "Условие оплаты" под ним).
function buildHeaders(rows: SheetRow[], headerRow: number): string[] {
  const cur = rows[headerRow] ?? [];
  const above = rows[headerRow - 1] ?? [];
  const n = Math.max(cur.length, above.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = String(cur[i] ?? "").trim();
    const a = String(above[i] ?? "").trim();
    out.push(c || a);
  }
  return out;
}
// Точное совпадение имеет приоритет над подстрокой: иначе ключ "номер телефона"
// цепляется за "Дополнительный номер телефона" вместо колонки "Телефон".
function findCol(headers: string[], ...keywords: string[]): number {
  const norm = headers.map((h) => h.toLowerCase().trim());
  for (const kw of keywords) {
    const i = norm.indexOf(kw.toLowerCase());
    if (i >= 0) return i;
  }
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    const i = norm.findIndex((h) => h.includes(k));
    if (i >= 0) return i;
  }
  return -1;
}
async function readSheet(file: File): Promise<SheetRow[]> {
  // ExcelJS падает на этих выгрузках (нет части docProps/core.xml) — читаем через xlsx (SheetJS).
  const XLSX = await import("xlsx");
  const wb = file.name.toLowerCase().endsWith(".csv")
    ? XLSX.read(await file.text(), { type: "string" })
    : XLSX.read(await file.arrayBuffer(), { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  // Выгрузки этой CRM пишут в <dimension> заведомо неверный диапазон (например
  // "A1:AB15" при 4624 фактических строках), а SheetJS обрезает лист по нему —
  // из 4614 договоров читалось 5. Пересчитываем ref по реальным адресам ячеек.
  let maxR = 0, maxC = 0;
  for (const addr of Object.keys(ws)) {
    if (addr.startsWith("!")) continue;
    const { r, c } = XLSX.utils.decode_cell(addr);
    if (r > maxR) maxR = r;
    if (c > maxC) maxC = c;
  }
  if (maxR > 0) ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });
  return XLSX.utils.sheet_to_json<SheetRow>(ws, { header: 1, defval: "" }) as unknown as SheetRow[];
}

interface LeadRow { phone: string; channel: string; source: string; object: string; date: string; client: string; descr: string; meeting: boolean }
interface ContractRow { phones: string[]; sum: number; zhk: string; status: string; date: string; client: string; city: string }
interface ReconRow { channel: string; leadsTotal: number; deals: number; sum: number }
interface AdLeadRow { phone: string; campaign: string; adset: string; ad: string; date: string; client: string }

const NOT_FOUND = "Лид не найден (сайт/офлайн/вне периода выгрузки)";
const LATE_TOUCH = "Обращение только ПОСЛЕ сделки (реклама не привела)";

// Кириллические двойники латиницы: в выгрузках встречается "CASCADЕ" с русской «Е»,
// из-за чего название не совпадает с "Cascade" из рекламных кабинетов.
const HOMOGLYPH: Record<string, string> = {
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X",
  "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
};
// Ключ ЖК, общий для трёх источников: рекламные кабинеты ("Satpaev"), поле «Объект»
// в CRM ("VESPER, 1 очередь") и колонка «ЖК» в реестре ("Landmark Gold, V очередь").
// Берём часть до запятой и отбрасываем номер очереди — это один и тот же проект.
const ZHK_STAGE_CANON: Record<string, string> = {
  landmark: "landmarkgold", monaco: "grandmonaco", riviera: "rivieraplus",
  nurlydala2: "nurlydalaii", admplus: "adamantplus", admlife: "adamantlife",
};
function zhkKey(raw: string): string {
  const s = String(raw ?? "").replace(/[АВЕКМНОРСТУХавекмнорстух]/g, (c) => HOMOGLYPH[c] ?? c)
    .split(",")[0]
    .replace(/\s*\b[IVX0-9]+\s*очеред\w*/gi, "")
    .replace(/\bочеред\w*/gi, "")
    .toLowerCase().replace(/[^a-z0-9а-я]+/g, "");
  return ZHK_STAGE_CANON[s] ?? s;
}
// Строка воронки по ЖК: показы/клики из рекламных кабинетов, лиды и квал-лиды из CRM,
// продажи из реестра договоров.
interface FunnelRow {
  zhk: string; reach: number; clicks: number;
  leads: Set<string>; qual: Set<string>;
  buyers: Set<string>;      // все покупатели этого ЖК
  buyersQual: Set<string>;  // из них те, кто был квал-лидом — только по ним честная конверсия
  deals: number; sum: number;
}
const AD_SOURCE = "Реклама (по выгрузке кабинета)";
const NO_CAMPAIGN = "Кампания не указана в карточке лида";
const GROUP_BY = [
  { key: "campaign", label: "Кампания (из карточки лида)", hint: "реальное название кампании/UTM из поля «Описание» — не зависит от ручного тегирования" },
  { key: "source", label: "Источник информации", hint: "откуда клиент узнал — заполняется вручную оператором" },
  { key: "channel", label: "Канал лида", hint: "как обратился — звонок, личный кабинет и т.д." },
  { key: "form", label: "Форма (Центр лидов)", hint: "название рекламной формы из выгрузки кабинета" },
] as const;
type GroupKey = (typeof GROUP_BY)[number]["key"];

// Поле "Описание" в карточке лида содержит цепочку "кампания; группа объявлений; объявление"
// из рекламного кабинета (или UTM-метки для форм на сайте), иногда с мусором в начале
// ("Не ответил, КЦ нужно позвонить; ; 1-комнатная; 3000ND | Лиды | NURLY DALA 2 | ...").
// Берём первый сегмент, похожий на структурированное название (содержит "|").
function campaignFromDescr(descr: string): string {
  if (!descr) return "";
  for (const seg of String(descr).split(";")) {
    const s = seg.trim();
    if (s.includes("|") && s.length > 8) return s;
  }
  return "";
}
// Для группировки укорачиваем до первых трёх сегментов: "3000SAT | Лиды | Satpaev"
// (дальше идут город/модель оплаты, которые дробят одну кампанию на десятки строк).
function shortCampaign(full: string): string {
  return full.split("|").slice(0, 3).map((s) => s.trim()).filter(Boolean).join(" | ");
}

function SalesReconcile() {
  const [leadsFile, setLeadsFile] = useState<File | null>(null);
  const [contractsFile, setContractsFile] = useState<File | null>(null);
  const [adLeadsFile, setAdLeadsFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [leads, setLeads] = useState<LeadRow[] | null>(null);
  const [contracts, setContracts] = useState<ContractRow[] | null>(null);
  const [adLeads, setAdLeads] = useState<AdLeadRow[] | null>(null);
  const [unmatchedOnly, setUnmatchedOnly] = useState(false);
  const [groupBy, setGroupBy] = useState<GroupKey>("source");
  // Показы/охват/клики для воронки берём из уже синхронизированных рекламных кабинетов.
  const [adsByZhk, setAdsByZhk] = useState<Record<string, { reach: number; clicks: number }> | null>(null);
  const [adsPeriod, setAdsPeriod] = useState<string>("");
  useEffect(() => {
    const acc: Record<string, { reach: number; clicks: number }> = {};
    const canon = new Map<string, string>();
    const add = (name: string, reach: number, clicks: number) => {
      const k = zhkKey(resolveZhk(name, canon));
      if (!k) return;
      const o = (acc[k] ??= { reach: 0, clicks: 0 });
      o.reach += reach; o.clicks += clicks;
    };
    Promise.all([
      fetch("/api/data").then((r) => r.json()).catch(() => null),
      fetch("/api/google").then((r) => r.json()).catch(() => null),
      fetch("/api/tiktok").then((r) => r.json()).catch(() => null),
      fetch("/api/yandex").then((r) => r.json()).catch(() => null),
    ]).then(([meta, google, tiktok, yandex]) => {
      // Сначала Meta — у неё стабильный нейминг, она наполняет canon для остальных.
      for (const c of meta?.campaigns ?? []) add(c.name, +c.reach || 0, +c.clicks || 0);
      for (const c of google?.campaigns ?? []) add(c.name, 0, +c.clicks || 0);
      for (const c of tiktok?.campaigns ?? []) add(c.name, 0, +c.clicks || 0);
      for (const c of yandex?.campaigns ?? []) add(c.name, 0, +c.clicks || 0);
      setAdsByZhk(acc);
      if (meta?.snapshot) setAdsPeriod(`${meta.snapshot.period_start} — ${meta.snapshot.period_end}`);
    });
  }, []);

  const run = async () => {
    if (!leadsFile || !contractsFile) { setErr("Загрузите хотя бы «Отчёт по Лидам» и «Реестр договоров»"); return; }
    setLoading(true); setErr(null);
    try {
      const [leadRows, contractRows, adLeadRows] = await Promise.all([
        readSheet(leadsFile), readSheet(contractsFile), adLeadsFile ? readSheet(adLeadsFile) : Promise.resolve(null),
      ]);

      const lh = findHeaderRow(leadRows, "телефон");
      if (lh < 0) throw new Error("В «Отчёте по Лидам» не найдена колонка «Телефон» — проверьте файл");
      const lHeaders = buildHeaders(leadRows, lh);
      const lCol = {
        phone: findCol(lHeaders, "телефон"),
        channel: findCol(lHeaders, "канал"),
        source: findCol(lHeaders, "источник"),
        object: findCol(lHeaders, "объект"),
        date: findCol(lHeaders, "дата начала", "дата"),
        client: findCol(lHeaders, "клиент"),
        descr: findCol(lHeaders, "описание"),
        meeting: findCol(lHeaders, "встреча"),
      };
      const parsedLeads: LeadRow[] = [];
      for (let i = lh + 1; i < leadRows.length; i++) {
        const r = leadRows[i];
        if (!r || !r.some((c) => c !== "" && c != null)) continue;
        const client = String(r[lCol.client] ?? "").trim();
        const base = {
          channel: String(r[lCol.channel] ?? "").trim() || "—",
          source: String(r[lCol.source] ?? "").trim(),
          object: String(r[lCol.object] ?? "").trim(),
          date: String(r[lCol.date] ?? "").trim(),
          client,
          descr: String(r[lCol.descr] ?? "").trim(),
          // «Встреча назначена» / «Встреча не назначена» — признак квалифицированного лида.
          meeting: /встреча\s+назначена/i.test(String(r[lCol.meeting] ?? "")),
        };
        const phones = normPhones(r[lCol.phone]);
        // Лид без телефона, но с ФИО тоже сохраняем: карточку могли заполнить плохо,
        // а в договоре данные корректные — такие ловим вторым ключом (по ФИО).
        if (!phones.length) {
          if (nameKey(client)) parsedLeads.push({ phone: "", ...base });
          continue;
        }
        for (const phone of phones) parsedLeads.push({ phone, ...base });
      }

      const ch = findHeaderRow(contractRows, "телефон");
      if (ch < 0) throw new Error("В «Реестре договоров» не найдена колонка «Телефоны» — проверьте файл");
      const cHeaders = buildHeaders(contractRows, ch);
      const cCol = {
        phones: findCol(cHeaders, "телефон"),
        sum: findCol(cHeaders, "сумма договора", "сумма"),
        zhk: findCol(cHeaders, "жк"),
        status: findCol(cHeaders, "состояние"),
        date: findCol(cHeaders, "дата"),
        client: findCol(cHeaders, "наименование", "клиент"),
        city: findCol(cHeaders, "город"),
      };
      const parsedContracts: ContractRow[] = [];
      for (let i = ch + 1; i < contractRows.length; i++) {
        const r = contractRows[i];
        if (!r || !r.some((c) => c !== "" && c != null)) continue;
        const sumRaw = r[cCol.sum];
        parsedContracts.push({
          phones: normPhones(r[cCol.phones]),
          sum: Number(sumRaw) || 0,
          zhk: String(r[cCol.zhk] ?? "").trim(),
          status: String(r[cCol.status] ?? "").trim(),
          date: String(r[cCol.date] ?? "").trim(),
          client: String(r[cCol.client] ?? "").trim(),
          city: String(r[cCol.city] ?? "").trim(),
        });
      }

      if (!parsedLeads.length) throw new Error("Не удалось прочитать ни одной строки лидов — проверьте файл");
      if (!parsedContracts.length) throw new Error("Не удалось прочитать ни одной строки договоров — проверьте файл");

      let parsedAdLeads: AdLeadRow[] | null = null;
      if (adLeadRows) {
        const ah = findHeaderRow(adLeadRows, "phone") >= 0 ? findHeaderRow(adLeadRows, "phone") : findHeaderRow(adLeadRows, "телефон");
        if (ah < 0) throw new Error("В выгрузке из Центра лидов не найдена колонка с телефоном (phone_number / Телефон)");
        const aHeaders = buildHeaders(adLeadRows, ah);
        const aCol = {
          // Выгрузка Центра лидов бывает двух видов: "родная" из Ads Manager
          // (phone_number + campaign_name) и из лид-менеджера (Телефон + Форма +
          // Источник + доп. номера) — поддерживаем оба набора колонок.
          phone: findCol(aHeaders, "phone_number", "номер телефона", "телефон", "phone"),
          phone2: findCol(aHeaders, "дополнительный номер"),
          wa: findCol(aHeaders, "whatsapp"),
          campaign: findCol(aHeaders, "campaign_name", "название кампании", "кампания", "форма", "form_name"),
          adset: findCol(aHeaders, "adset_name", "название группы", "группа объявлений"),
          ad: findCol(aHeaders, "ad_name", "название объявления"),
          date: findCol(aHeaders, "created_time", "дата создания", "дата"),
          client: findCol(aHeaders, "имя", "full_name", "name"),
        };
        parsedAdLeads = [];
        for (let i = ah + 1; i < adLeadRows.length; i++) {
          const r = adLeadRows[i];
          if (!r || !r.some((c) => c !== "" && c != null)) continue;
          const phones = new Set([
            ...normPhones(r[aCol.phone]),
            ...(aCol.phone2 >= 0 ? normPhones(r[aCol.phone2]) : []),
            ...(aCol.wa >= 0 ? normPhones(r[aCol.wa]) : []),
          ]);
          const client = aCol.client >= 0 ? String(r[aCol.client] ?? "").trim() : "";
          const rec = {
            campaign: String(r[aCol.campaign] ?? "").trim() || "—",
            adset: String(r[aCol.adset] ?? "").trim(),
            ad: String(r[aCol.ad] ?? "").trim(),
            date: String(r[aCol.date] ?? "").trim(),
            client,
          };
          // Строка без телефона, но с именем тоже нужна: она может стать мостиком по ФИО.
          if (!phones.size && nameKey(client)) parsedAdLeads.push({ phone: "", ...rec });
          for (const phone of phones) parsedAdLeads.push({ phone, ...rec });
        }
        if (!parsedAdLeads.length) throw new Error("Не удалось прочитать ни одной строки из выгрузки Центра лидов — проверьте файл");
      }

      setLeads(parsedLeads);
      setContracts(parsedContracts);
      setAdLeads(parsedAdLeads);
    } catch (e) {
      setErr((e as Error).message);
      setLeads(null); setContracts(null); setAdLeads(null);
    }
    setLoading(false);
  };

  // phone → лид ПЕРВОГО касания: именно первый контакт привёл клиента, а последующие
  // обращения того же телефона — уже работа с существующим лидом.
  // Дату сравниваем как yyyymmdd: "05.06.2026" >= "12.01.2026" строкой даёт неверный порядок.
  // Храним ВСЕ касания клиента, а не только первое: для атрибуции нужно выбрать
  // самое раннее обращение, случившееся ДО договора. Если брать глобально первое,
  // можно приписать источник обращению, которого на момент сделки ещё не было
  // (клиент написал в рекламную форму уже после покупки — таких 27%).
  const touchesByPhone = new Map<string, LeadRow[]>();
  const touchesByName = new Map<string, LeadRow[]>();
  for (const l of leads ?? []) {
    if (l.phone) {
      const arr = touchesByPhone.get(l.phone);
      if (arr) arr.push(l); else touchesByPhone.set(l.phone, [l]);
    }
    const k = nameKey(l.client);
    if (k) {
      const arr = touchesByName.get(k);
      if (arr) arr.push(l); else touchesByName.set(k, [l]);
    }
  }
  // Первое касание из списка, не позже даты договора (пустая дата договора — без ограничения).
  const earliestBefore = (arr: LeadRow[] | undefined, until: string): LeadRow | null => {
    if (!arr?.length) return null;
    const lim = until ? sortableDate(until) : "99999999";
    let best: LeadRow | null = null;
    for (const l of arr) {
      const d = sortableDate(l.date);
      if (d > lim) continue;
      if (!best || d < sortableDate(best.date)) best = l;
    }
    return best;
  };
  // Есть ли у клиента хоть какое-то касание (пусть и после сделки) — чтобы отличать
  // "лида нет вовсе" от "лид есть, но появился уже после покупки".
  const hasAnyTouch = (c: ContractRow) =>
    c.phones.some((p) => touchesByPhone.has(p)) || touchesByName.has(nameKey(c.client));

  // Для разрезок по кампании/лидам нужен ещё общий индекс "первое касание вообще".
  const leadByPhone = new Map<string, LeadRow>();
  for (const [phone, arr] of touchesByPhone) {
    let best = arr[0];
    for (const l of arr) if (sortableDate(l.date) < sortableDate(best.date)) best = l;
    leadByPhone.set(phone, best);
  }

  // Индексы выгрузки Центра лидов — по телефону и по имени. Кабинет используется
  // и как отдельная разрезка ("Форма"), и как третий ключ сопоставления: если лид
  // не завели в CRM (или завели вне периода выгрузки), договор всё равно можно
  // атрибутировать на рекламу напрямую по данным кабинета.
  const adLeadByPhone = new Map<string, AdLeadRow>();
  const adLeadByName = new Map<string, AdLeadRow>();
  for (const l of adLeads ?? []) {
    if (l.phone && !adLeadByPhone.has(l.phone)) adLeadByPhone.set(l.phone, l);
    const nk = nameKey(l.client);
    if (nk && !adLeadByName.has(nk)) adLeadByName.set(nk, l);
  }
  const adTotalMatched = (contracts ?? []).filter((c) => c.phones.some((p) => adLeadByPhone.has(p))).length;

  const matched: { contract: ContractRow; lead: LeadRow | null; by: "phone" | "name" | "ads" | "late" | null }[] = (contracts ?? []).map((c) => {
    // Атрибутируем только по обращениям, случившимся ДО договора: если клиент написал
    // в рекламную форму уже после покупки, реклама его не приводила.
    for (const p of c.phones) {
      const hit = earliestBefore(touchesByPhone.get(p), c.date);
      if (hit) return { contract: c, lead: hit, by: "phone" as const };
    }
    const byName = earliestBefore(touchesByName.get(nameKey(c.client)), c.date);
    if (byName) return { contract: c, lead: byName, by: "name" as const };
    // Третий ключ — сама выгрузка кабинета (тоже только если лид был до сделки).
    const ad = c.phones.map((p) => adLeadByPhone.get(p)).find((l) => l) ?? adLeadByName.get(nameKey(c.client));
    if (ad && (!c.date || !ad.date || sortableAdDate(ad.date) <= sortableDate(c.date))) {
      return {
        contract: c,
        lead: { phone: ad.phone, channel: "Центр лидов", source: AD_SOURCE, object: "", date: ad.date, client: ad.client, descr: "", meeting: false },
        by: "ads" as const,
      };
    }
    // Касания есть, но все — после сделки. Это не "не найден", но и не источник привлечения.
    if (hasAnyTouch(c) || ad) return { contract: c, lead: null, by: "late" as const };
    return { contract: c, lead: null, by: null };
  });
  const matchedByPhone = matched.filter((m) => m.by === "phone").length;
  const matchedByName = matched.filter((m) => m.by === "name").length;
  const matchedByAds = matched.filter((m) => m.by === "ads").length;
  const matchedLate = matched.filter((m) => m.by === "late").length;

  // Кампания ищется по ВСЕМ касаниям клиента, а не только по первому: описание с
  // названием кампании может быть заполнено на любом из обращений. Берём самое раннее
  // из заполненных — это и есть кампания, которая клиента изначально привела.
  const campByPhone = new Map<string, { camp: string; date: string }>();
  const campByName = new Map<string, { camp: string; date: string }>();
  for (const l of leads ?? []) {
    const camp = campaignFromDescr(l.descr);
    if (!camp) continue;
    if (l.phone) {
      const prev = campByPhone.get(l.phone);
      if (!prev || sortableDate(l.date) < sortableDate(prev.date)) campByPhone.set(l.phone, { camp, date: l.date });
    }
    const nk = nameKey(l.client);
    if (nk) {
      const prev = campByName.get(nk);
      if (!prev || sortableDate(l.date) < sortableDate(prev.date)) campByName.set(nk, { camp, date: l.date });
    }
  }
  const campaignOf = (c: ContractRow): string => {
    for (const p of c.phones) { const hit = campByPhone.get(p); if (hit) return shortCampaign(hit.camp); }
    const hit = campByName.get(nameKey(c.client));
    return hit ? shortCampaign(hit.camp) : "";
  };

  // Разрезка задаётся одним ключом: "Кампания" — из поля «Описание» карточки лида
  // (реальное название кампании, не зависит от оператора), "Источник информации" —
  // откуда клиент узнал (ручное поле), "Канал лида" — как обратился, "Форма" —
  // название формы из выгрузки Центра лидов.
  const groupOf = (l: LeadRow, phone: string, c: ContractRow): string => {
    if (groupBy === "campaign") return campaignOf(c) || NO_CAMPAIGN;
    if (groupBy === "source") return l.source || "(не заполнено)";
    if (groupBy === "channel") return l.channel || "(не заполнено)";
    return adLeadByPhone.get(phone)?.campaign ?? "(нет в Центре лидов)";
  };
  // Уникальных лидов на группу считаем по телефонам, а не по строкам: в выгрузке
  // один и тот же клиент встречается многократно (каждое касание — отдельная строка).
  const leadsPerGroup: Record<string, number> = {};
  if (groupBy === "form") {
    for (const l of adLeadByPhone.values()) leadsPerGroup[l.campaign] = (leadsPerGroup[l.campaign] ?? 0) + 1;
  } else if (groupBy === "campaign") {
    for (const phone of leadByPhone.keys()) {
      const hit = campByPhone.get(phone);
      const k = hit ? shortCampaign(hit.camp) : NO_CAMPAIGN;
      leadsPerGroup[k] = (leadsPerGroup[k] ?? 0) + 1;
    }
  } else {
    for (const [phone, l] of leadByPhone) {
      const k = groupBy === "source" ? (l.source || "(не заполнено)") : (l.channel || "(не заполнено)");
      leadsPerGroup[k] = (leadsPerGroup[k] ?? 0) + 1;
    }
  }

  const recon: Record<string, ReconRow & { buyers: Set<string> }> = {};
  for (const { contract, lead, by } of matched) {
    // Договор без телефона И без единого касания атрибутировать нечем — пропускаем,
    // иначе он раздувал бы "не найден" тем, что мы физически не могли сопоставить.
    if (!contract.phones.length && !lead && by !== "late") continue;
    const key = lead
      ? groupOf(lead, contract.phones.find((p) => leadByPhone.has(p)) ?? contract.phones[0] ?? "", contract)
      : by === "late" ? LATE_TOUCH : NOT_FOUND;
    const row = (recon[key] ??= { channel: key, leadsTotal: leadsPerGroup[key] ?? 0, deals: 0, sum: 0, buyers: new Set() });
    row.deals += 1;
    row.buyers.add(contract.phones[0] || nameKey(contract.client));
    if (!/растор/i.test(contract.status)) row.sum += contract.sum;
  }
  // Группы, где были лиды, но ни одной сделки — тоже показываем (конверсия 0%).
  for (const [g, cnt] of Object.entries(leadsPerGroup)) {
    if (!recon[g]) recon[g] = { channel: g, leadsTotal: cnt, deals: 0, sum: 0, buyers: new Set() };
  }
  // Служебные строки ("не найден", "обращение после сделки") — всегда внизу: это не
  // источники привлечения, а остаток, который нельзя атрибутировать.
  const isTail = (k: string) => (k === NOT_FOUND || k === LATE_TOUCH ? 1 : 0);
  const reconRows = Object.values(recon).sort((a, b) =>
    isTail(a.channel) - isTail(b.channel) || b.sum - a.sum);

  // ---- Воронка по ЖК: Охват → Клики → Лиды → Квал-лиды → Продажи ----
  // Три источника с разными написаниями ЖК сводятся общим ключом zhkKey().
  const funnel: Record<string, FunnelRow> = {};
  const fRow = (key: string, label: string) =>
    (funnel[key] ??= { zhk: label, reach: 0, clicks: 0, leads: new Set(), qual: new Set(), buyers: new Set(), buyersQual: new Set(), deals: 0, sum: 0 });
  for (const [k, v] of Object.entries(adsByZhk ?? {})) {
    const r = fRow(k, k);
    r.reach += v.reach; r.clicks += v.clicks;
  }
  // Лиды считаем по уникальным клиентам (телефон, иначе ФИО): одна карточка = много строк.
  const qualIds = new Set<string>();
  for (const l of leads ?? []) {
    const k = zhkKey(l.object);
    if (!k) continue;
    const id = l.phone || nameKey(l.client);
    if (!id) continue;
    const r = fRow(k, l.object.split(",")[0].trim() || k);
    r.leads.add(id);
    if (l.meeting) { r.qual.add(id); qualIds.add(id); }
  }
  for (const { contract } of matched) {
    const k = zhkKey(contract.zhk);
    if (!k) continue;
    const r = fRow(k, contract.zhk.split(",")[0].trim() || k);
    r.deals += 1;
    const id = contract.phones[0] || nameKey(contract.client);
    r.buyers.add(id || String(r.deals));
    // Честная конверсия квал→продажа возможна только по тем покупателям, которых мы
    // реально видели как квал-лид: иначе делим два независимых счётчика и получаем >100%.
    if (id && qualIds.has(id)) r.buyersQual.add(id);
    if (!/растор/i.test(contract.status)) r.sum += contract.sum;
  }
  const funnelRows = Object.values(funnel).sort((a, b) => b.sum - a.sum || b.leads.size - a.leads.size);
  const fTotal = funnelRows.reduce((t, r) => ({
    reach: t.reach + r.reach, clicks: t.clicks + r.clicks, leads: t.leads + r.leads.size,
    qual: t.qual + r.qual.size, buyers: t.buyers + r.buyers.size, buyersQual: t.buyersQual + r.buyersQual.size,
    deals: t.deals + r.deals, sum: t.sum + r.sum,
  }), { reach: 0, clicks: 0, leads: 0, qual: 0, buyers: 0, buyersQual: 0, deals: 0, sum: 0 });

  const money = (n: number) => Math.round(n).toLocaleString("ru-RU") + " ₸";
  const totalDeals = matched.length;
  const totalSum = matched.reduce((s, { contract }) => s + (/растор/i.test(contract.status) ? 0 : contract.sum), 0);
  const totalMatched = matched.filter((m) => m.lead).length;
  // Договоры без телефона ловятся только по ФИО — показываем, сколько их всего.
  const noPhone = matched.filter((m) => !m.contract.phones.length).length;

  const rowsToShow = unmatchedOnly ? matched.filter((m) => !m.lead) : matched;

  return (
    <>
      <div className="panel">
        <div className="panel-title">Сверка: источник лида × реальные продажи</div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
          Загрузите «Отчёт по Лидам» (телефон + канал) и «Реестр договоров» (телефон + сумма) за один и тот же период —
          сопоставление идёт по номеру телефона, без обращения к API рекламных площадок.
          Опционально — выгрузка из <b>Центра лидов</b> рекламного кабинета (.csv/.xlsx) для разрезки «Форма».
          <br /><b>Как считается:</b> по каждому договору ищем лид — сначала по телефону, если не нашли — по ФИО.
          У найденного лида берём кампанию из поля «Описание» (по всем его обращениям, самое раннее заполненное),
          источник и канал. Выгрузка кабинета — отдельная разрезка, она не расширяет охват сопоставления.
        </div>
        <div className="controls">
          <div className="field">
            <label>Отчёт по Лидам (.xlsx)</label>
            <input type="file" accept=".xlsx,.xls" onChange={(e) => setLeadsFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="field">
            <label>Реестр договоров (.xlsx)</label>
            <input type="file" accept=".xlsx,.xls" onChange={(e) => setContractsFile(e.target.files?.[0] ?? null)} />
          </div>
          <div className="field">
            <label>Центр лидов (.csv/.xlsx, опционально)</label>
            <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setAdLeadsFile(e.target.files?.[0] ?? null)} />
          </div>
          <button className="btn" onClick={run} disabled={loading} style={{ alignSelf: "end" }}>
            {loading ? "⏳ Обрабатываю…" : "Сверить"}
          </button>
        </div>
        {err && <div className="err" style={{ marginTop: 10 }}>{err}</div>}
      </div>

      {leads && contracts && (
        <>
          <div className="panel">
            <div className="kpi-grid">
              <div className="kpi"><div className="label">Лидов (уник. телефонов)</div><div className="value">{leadByPhone.size}</div><div className="delta neutral">строк в выгрузке: {leads.length.toLocaleString("ru-RU")}</div></div>
              <div className="kpi"><div className="label">Договоров</div><div className="value">{totalDeals}</div><div className="delta neutral">из них без телефона: {noPhone}</div></div>
              <div className="kpi"><div className="label">Сопоставлено с лидом</div><div className="value">{totalMatched} ({totalDeals ? Math.round((totalMatched / totalDeals) * 100) : 0}%)</div><div className="delta neutral">телефон: {matchedByPhone} · ФИО: {matchedByName} · кабинет: {matchedByAds}</div></div>
              <div className="kpi"><div className="label">Обращение после сделки</div><div className="value">{matchedLate}</div><div className="delta neutral">не считаем источником привлечения</div></div>
              <div className="kpi"><div className="label">Сумма договоров (без расторгнутых)</div><div className="value">{money(totalSum)}</div></div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">Воронка по ЖК</div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
              Охват и клики — из рекламных кабинетов{adsPeriod && <> (период базы: <b>{adsPeriod}</b>)</>}; лиды и квал-лиды — из
              «Отчёта по Лидам» (поле «Объект»); продажи — из реестра договоров (колонка «ЖК»).
              Названия ЖК в трёх системах пишутся по-разному («VESPER, 1 очередь», «Landmark Gold, V очередь», «CASCADЕ»
              с кириллической Е) — сводятся к одному проекту автоматически.
              {!adsByZhk && <> · <span className="err">загружаю данные кабинетов…</span></>}
              <br /><b>Периоды могут не совпадать:</b> охват и клики берутся за период последнего синка базы, а лиды и
              продажи — за период загруженных файлов. Для корректного сравнения обновите базу тем же периодом.
            </div>
            <div className="table-scroll">
              <table>
                <thead><tr>
                  <th>ЖК</th><th>Охват</th><th>Клики</th><th>Лиды</th><th>Квал-лиды<br />(встреча назначена)</th>
                  <th>CR лид→квал</th><th title="Покупатели, которых мы видели в лидах как квал">Купили из квал-лидов</th>
                  <th>CR квал→продажа</th><th>Покупателей<br />всего</th><th>Договоров</th><th>Сумма</th>
                </tr></thead>
                <tbody>
                  {funnelRows.map((r) => (
                    <tr key={r.zhk}>
                      <td>{r.zhk}</td>
                      <td>{r.reach ? int0(r.reach) : "—"}</td>
                      <td>{r.clicks ? int0(r.clicks) : "—"}</td>
                      <td>{r.leads.size || "—"}</td>
                      <td>{r.qual.size || "—"}</td>
                      <td>{r.leads.size ? ((r.qual.size / r.leads.size) * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%" : "—"}</td>
                      <td>{r.buyersQual.size || "—"}</td>
                      <td>{r.qual.size ? ((r.buyersQual.size / r.qual.size) * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%" : "—"}</td>
                      <td>{r.buyers.size || "—"}</td>
                      <td>{r.deals || "—"}</td>
                      <td>{r.sum ? money(r.sum) : "—"}</td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700, background: "var(--panel-2)" }}>
                    <td>Итого</td>
                    <td>{int0(fTotal.reach)}</td><td>{int0(fTotal.clicks)}</td>
                    <td>{fTotal.leads}</td><td>{fTotal.qual}</td>
                    <td>{fTotal.leads ? ((fTotal.qual / fTotal.leads) * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%" : "—"}</td>
                    <td>{fTotal.buyersQual}</td>
                    <td>{fTotal.qual ? ((fTotal.buyersQual / fTotal.qual) * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 }) + "%" : "—"}</td>
                    <td>{fTotal.buyers}</td><td>{fTotal.deals}</td>
                    <td>{money(fTotal.sum)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              Лиды и квал-лиды считаются по уникальным клиентам (телефон, иначе ФИО) — в выгрузке одна карточка занимает
              много строк. Охват отдаёт только Meta, поэтому по остальным площадкам в этой колонке пусто.
              <br />«Купили из квал-лидов» — покупатели, которых мы реально видели в лидах со статусом «встреча назначена»;
              только по ним считается конверсия квал→продажа. «Покупателей всего» больше, потому что часть клиентов
              обратилась до периода выгрузки лидов или пришла мимо CRM — делить продажи на квал-лиды напрямую нельзя,
              это два независимых счётчика (иначе получаются конверсии выше 100%).
            </div>
          </div>

          <div className="panel">
            <div className="panel-title">Продажи по источникам</div>
            <div className="chips" style={{ marginBottom: 4 }}>
              {GROUP_BY.map((g) => (
                <div key={g.key} className={"chip" + (groupBy === g.key ? " on" : "")}
                  onClick={() => setGroupBy(g.key)} title={g.hint}>{g.label}</div>
              ))}
            </div>
            <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
              {GROUP_BY.find((g) => g.key === groupBy)?.hint}
              {groupBy === "form" && adLeads && <> · в выгрузке Центра лидов {adLeadByPhone.size.toLocaleString("ru-RU")} уник. телефонов, совпало с договорами: {adTotalMatched}</>}
              {groupBy === "form" && !adLeads && <> · <b>файл Центра лидов не загружен</b> — загрузите его выше, чтобы увидеть эту разрезку</>}
            </div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>{GROUP_BY.find((g) => g.key === groupBy)?.label}</th><th>Лидов (уник.)</th><th>Покупателей</th><th>Договоров</th><th>Конверсия лид→покупатель</th><th>Сумма договоров</th></tr></thead>
                <tbody>
                  {reconRows.map((r) => (
                    <tr key={r.channel} style={isTail(r.channel) ? { color: "var(--muted)" } : undefined}>
                      <td>{r.channel}</td>
                      <td>{r.leadsTotal || "—"}</td>
                      <td>{r.buyers.size}</td>
                      <td>{r.deals}</td>
                      <td>{r.leadsTotal ? ((r.buyers.size / r.leadsTotal) * 100).toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%" : "—"}</td>
                      <td>{money(r.sum)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              «Покупателей» и «Договоров» отличаются: один клиент может купить несколько квартир (в ваших данных есть
              инвестор с 20 договорами по одному номеру) — поэтому конверсия считается по уникальным покупателям, а не по договорам.
            </div>
          </div>

          <div className="panel">
            <div className="panel-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span>Договоры ({rowsToShow.length})</span>
              <label style={{ fontSize: 12, fontWeight: 400, display: "flex", gap: 6, alignItems: "center", cursor: "pointer" }}>
                <input type="checkbox" checked={unmatchedOnly} onChange={(e) => setUnmatchedOnly(e.target.checked)} />
                только без совпадения
              </label>
            </div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>Клиент</th><th>ЖК</th><th>Дата</th><th>Статус</th><th>Сумма</th><th>Кампания (из карточки)</th><th>Источник</th><th>Дата лида</th><th>Совпало по</th></tr></thead>
                <tbody>
                  {rowsToShow.slice(0, 500).map(({ contract, lead, by }, i) => {
                    const camp = lead ? campaignOf(contract) : "";
                    return (
                      <tr key={i}>
                        <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={contract.client}>{contract.client}</td>
                        <td>{contract.zhk}</td>
                        <td>{contract.date}</td>
                        <td>{contract.status}</td>
                        <td>{money(contract.sum)}</td>
                        <td style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={camp}>
                          {camp || <span className="muted">—</span>}
                        </td>
                        <td>{lead ? (lead.source || <span className="muted">не заполнен</span>) : <span className="muted">—</span>}</td>
                        <td>{lead?.date ?? "—"}</td>
                        <td>{by === "phone" ? "телефону"
                          : by === "name" ? <span style={{ color: "#f59e0b" }}>ФИО</span>
                          : by === "ads" ? <span style={{ color: "var(--good)" }}>кабинету</span>
                          : by === "late" ? <span className="muted" title="Клиент обращался, но уже после подписания договора">лид после сделки</span>
                          : <span className="muted">—</span>}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {rowsToShow.length > 500 && <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>Показаны первые 500 из {rowsToShow.length}.</div>}
            <div className="muted" style={{ marginTop: 10, fontSize: 12 }}>
              Сопоставление идёт тремя ключами по очереди: <b>телефон</b> в отчёте по лидам → <b>ФИО</b> в отчёте по лидам
              (если телефон не заполнен или записан иначе) → <b>выгрузка кабинета</b> (телефон или имя), если лида нет в CRM вовсе.
              Учитываются только обращения <b>до даты договора</b> — если клиент оставил заявку уже после покупки
              (например, задал вопрос через рекламную форму), реклама его не приводила, такие помечены «лид после сделки»
              и не приписываются ни одному источнику. Совпадения по ФИО помечены жёлтым — они менее надёжны (однофамильцы).
              «Не найден» — обращение было раньше периода выгрузки лидов, клиент пришёл напрямую/по рекомендации,
              либо данные в системах расходятся.
            </div>
          </div>
        </>
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
