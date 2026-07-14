// Единый источник правды по метрикам рекламного кабинета.
// kind: "sum" — аддитивные (суммируются по дням); "ratio" — производные (пересчитываются из сумм).
// goodDirection: "up" — рост это хорошо; "down" — снижение это хорошо (стоимостные метрики).

export type MetricKind = "sum" | "ratio";
export type GoodDirection = "up" | "down" | "neutral";

export interface MetricDef {
  key: string;
  label: string;
  unit: "currency" | "number" | "percent" | "ratio";
  kind: MetricKind;
  goodDirection: GoodDirection;
  // Для производных метрик — как пересчитать из агрегатов.
  derive?: (a: Totals) => number;
}

export interface Totals {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  page_engagement: number;
  link_click: number;
  days: number;
}

export const METRICS: MetricDef[] = [
  { key: "spend", label: "Расход", unit: "currency", kind: "sum", goodDirection: "neutral" },
  { key: "impressions", label: "Показы", unit: "number", kind: "sum", goodDirection: "up" },
  { key: "reach", label: "Охват", unit: "number", kind: "sum", goodDirection: "up" },
  { key: "clicks", label: "Клики", unit: "number", kind: "sum", goodDirection: "up" },
  { key: "link_click", label: "Клики по ссылке", unit: "number", kind: "sum", goodDirection: "up" },
  { key: "page_engagement", label: "Вовлечённость", unit: "number", kind: "sum", goodDirection: "up" },
  {
    key: "ctr",
    label: "CTR",
    unit: "percent",
    kind: "ratio",
    goodDirection: "up",
    derive: (a) => (a.impressions ? (a.clicks / a.impressions) * 100 : 0),
  },
  {
    key: "cpc",
    label: "CPC",
    unit: "currency",
    kind: "ratio",
    goodDirection: "down",
    derive: (a) => (a.clicks ? a.spend / a.clicks : 0),
  },
  {
    key: "cpm",
    label: "CPM",
    unit: "currency",
    kind: "ratio",
    goodDirection: "down",
    derive: (a) => (a.impressions ? (a.spend / a.impressions) * 1000 : 0),
  },
  {
    key: "frequency",
    label: "Частота",
    unit: "ratio",
    kind: "ratio",
    goodDirection: "neutral",
    derive: (a) => (a.reach ? a.impressions / a.reach : 0),
  },
  {
    key: "cpp",
    label: "CPP (цена за 1000 охвата)",
    unit: "currency",
    kind: "ratio",
    goodDirection: "down",
    derive: (a) => (a.reach ? (a.spend / a.reach) * 1000 : 0),
  },
];

export const METRIC_BY_KEY: Record<string, MetricDef> = Object.fromEntries(
  METRICS.map((m) => [m.key, m])
);

export const DEFAULT_KPI_KEYS = ["spend", "impressions", "reach", "clicks", "ctr", "cpc", "cpm", "frequency"];

export interface DailyRow {
  date: string;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  cpc: number;
  cpm: number;
  cpp: number;
  ctr: number;
  page_engagement: number;
  link_click: number;
}

export function emptyTotals(): Totals {
  return { spend: 0, impressions: 0, reach: 0, clicks: 0, page_engagement: 0, link_click: 0, days: 0 };
}

export function sumRows(rows: DailyRow[]): Totals {
  const t = emptyTotals();
  for (const r of rows) {
    t.spend += r.spend;
    t.impressions += r.impressions;
    t.reach += r.reach;
    t.clicks += r.clicks;
    t.page_engagement += r.page_engagement;
    t.link_click += r.link_click;
    t.days += 1;
  }
  return t;
}

// Значение любой метрики (в т.ч. производной) по агрегату.
export function metricValue(key: string, totals: Totals): number {
  const def = METRIC_BY_KEY[key];
  if (!def) return 0;
  if (def.kind === "sum") return (totals as unknown as Record<string, number>)[key] ?? 0;
  return def.derive ? def.derive(totals) : 0;
}

export function formatMetric(key: string, value: number): string {
  const def = METRIC_BY_KEY[key];
  const unit = def?.unit ?? "number";
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (unit === "currency") {
    return "$" + value.toLocaleString("ru-RU", { minimumFractionDigits: value < 100 ? 2 : 0, maximumFractionDigits: 2 });
  }
  if (unit === "percent") return value.toLocaleString("ru-RU", { maximumFractionDigits: 2 }) + "%";
  if (unit === "ratio") return value.toLocaleString("ru-RU", { maximumFractionDigits: 2 });
  return Math.round(value).toLocaleString("ru-RU");
}

// Дельта период-к-периоду с учётом «хорошего направления».
export function delta(key: string, current: number, previous: number) {
  const def = METRIC_BY_KEY[key];
  const abs = current - previous;
  const pct = previous ? (abs / previous) * 100 : null;
  let sentiment: "good" | "bad" | "neutral" = "neutral";
  if (pct !== null && def && def.goodDirection !== "neutral" && Math.abs(pct) >= 0.5) {
    const rising = abs > 0;
    sentiment = (def.goodDirection === "up") === rising ? "good" : "bad";
  }
  return { abs, pct, sentiment };
}
