// Общая логика сверки продаж (лиды × договоры × выгрузка кабинета): используется
// и на клиенте (для сверки по загруженным файлам, обычно небольшой объём), и на
// сервере (для сверки по периоду из базы — там объём может быть сотни тысяч строк,
// и гонять их через браузер нельзя, поэтому агрегация считается в API-роуте и
// наружу отдаётся уже готовый результат, а не сырые строки).

export interface LeadRow {
  phone: string; channel: string; source: string; object: string; date: string; client: string; descr: string; meeting: boolean;
  stage: string; callResult: string; // "Стадия" ("В работе"/"Потеряна"/"Закрыта"/"Встреча состоялась") и "Результат звонка" — для медиаплана (% необработанных лидов)
}
export interface ContractRow { phones: string[]; sum: number; zhk: string; status: string; date: string; client: string; city: string; propType: string; number: string }
export interface ReconRow { channel: string; leadsTotal: number; qual: number; deals: number; sum: number; buyers: number }
export interface AdLeadRow { phone: string; campaign: string; adset: string; ad: string; date: string; client: string }

export const NOT_FOUND = "Лид не найден (сайт/офлайн/вне периода выгрузки)";
export const LATE_TOUCH = "Обращение только ПОСЛЕ сделки (реклама не привела)";
export const AD_SOURCE = "Реклама (по выгрузке кабинета)";
export const NO_CAMPAIGN = "Кампания не указана в карточке лида";

export const GROUP_BY = [
  { key: "campaign", label: "Кампания (из карточки лида)", hint: "реальное название кампании/UTM из поля «Описание» — не зависит от ручного тегирования" },
  { key: "source", label: "Источник информации", hint: "откуда клиент узнал — заполняется вручную оператором" },
  { key: "channel", label: "Канал лида", hint: "как обратился — звонок, личный кабинет и т.д." },
  { key: "form", label: "Форма (Центр лидов)", hint: "название рекламной формы из выгрузки кабинета" },
] as const;
export type GroupKey = (typeof GROUP_BY)[number]["key"];

/* ---------- ключи сопоставления ---------- */

export function normPhones(raw: string | number | null | undefined): string[] {
  if (raw == null || raw === "") return [];
  return String(raw)
    .split(/[,;/]/)
    .map((s) => s.replace(/\D/g, ""))
    .filter((d) => d.length >= 9)
    .map((d) => d.slice(-10));
}

export function nameKey(raw: string): string {
  const words = String(raw).toLowerCase().replace(/ё/g, "е")
    .replace(/[^a-zа-я\s]/g, " ").split(/\s+/).filter((w) => w.length > 1);
  return words.length >= 2 ? words.sort().join(" ") : "";
}

export function sortableDate(s: string): string {
  const m = String(s).match(/(\d{2})[.\-/](\d{2})[.\-/](\d{4})/);
  return m ? m[3] + m[2] + m[1] : "99999999";
}
export function sortableAdDate(s: string): string {
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? m[3] + m[1].padStart(2, "0") + m[2].padStart(2, "0") : "99999999";
}

const HOMOGLYPH: Record<string, string> = {
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X",
  "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
};
const ZHK_STAGE_CANON: Record<string, string> = {
  landmark: "landmarkgold", monaco: "grandmonaco", riviera: "rivieraplus",
  nurlydala2: "nurlydalaii", admplus: "adamantplus", admlife: "adamantlife",
};
export function zhkKey(raw: string): string {
  const s = String(raw ?? "").replace(/[АВЕКМНОРСТУХавекмнорстух]/g, (c) => HOMOGLYPH[c] ?? c)
    .split(",")[0]
    .replace(/\s*\b[IVX0-9]+\s*очеред\w*/gi, "")
    .replace(/\bочеред\w*/gi, "")
    .toLowerCase().replace(/[^a-z0-9а-я]+/g, "");
  return ZHK_STAGE_CANON[s] ?? s;
}

export function campaignFromDescr(descr: string): string {
  if (!descr) return "";
  for (const seg of String(descr).split(";")) {
    const s = seg.trim();
    if (s.includes("|") && s.length > 8) return s;
  }
  return "";
}
export function shortCampaign(full: string): string {
  return full.split("|").slice(0, 3).map((s) => s.trim()).filter(Boolean).join(" | ");
}

// «Источник информации» — поле, которое оператор заполняет вручную, и оно часто
// либо пустое, либо содержит расплывчатое "Реклама в интернете". Но в поле
// «Описание» той же карточки нередко есть либо цепочка кампании из Ads Manager
// (Meta) без UTM-меток, либо форма сайта с явной UTM-меткой utm_source — оттуда
// можно восстановить настоящий источник, не полагаясь на ручное заполнение.
const UTM_SOURCE_RE = /utm\s*source\s*:?\s*([a-zа-я0-9_.\-]+)/i;
export function inferSource(descr: string): string | null {
  if (!descr) return null;
  const utm = descr.match(UTM_SOURCE_RE);
  if (utm) {
    const v = utm[1].trim().toLowerCase();
    if (/^(site|сайт|website)/.test(v)) return "Сайт жилого комплекса";
    if (/instagram|^ig$/.test(v)) return "Instagram";
    if (/facebook|^fb$/.test(v)) return "Instagram"; // тот же кабинет Meta, что и Instagram
    if (/google/.test(v)) return "Google Ads";
    if (/yandex|яндекс/.test(v)) return "Yandex Direct";
    if (/tiktok/.test(v)) return "TikTok";
    return v.charAt(0).toUpperCase() + v.slice(1) + " (UTM)";
  }
  // Цепочка вида "3000SAT | Лиды | Satpaev | ..." без UTM-меток — формат
  // Ads Manager для лид-форм, которые публикуются в Instagram/Facebook.
  if (campaignFromDescr(descr)) return "Instagram";
  return null;
}
// Описание карточки — это фактические данные с рекламной платформы (кампания/UTM),
// а ручное поле "Источник информации" заполняется оператором и может быть неверным
// в любой карточке, не только в "Реклама в интернете"/пустых — поэтому сигнал из
// "Описания" проверяем и используем везде, если он там есть, а не только для
// заведомо сомнительных значений.
// leadgen_id из нативной лид-формы Meta прокидывается в конец "Описания" в формате
// "...; l:38037037699213775". По нему офлайн-события матчатся к исходному клику
// почти со 100% точностью — в отличие от хэша телефона (30–60%).
const LEAD_ID_RE = /\bl:(\d{6,})/;
export function leadIdOf(descr: string): string | null {
  const m = String(descr ?? "").match(LEAD_ID_RE);
  return m ? m[1] : null;
}

export function sourceOf(l: LeadRow): string {
  const manual = (l.source || "").trim();
  const inferred = inferSource(l.descr);
  if (inferred) return inferred;
  return manual || "(не заполнено)";
}

// Источник, восстановленный из "Описания" ("Instagram"/"Google Ads"/"Yandex Direct"/
// "TikTok") — это ровно то же, что и площадка, на которую есть рекламный бюджет
// (для медиаплана). Источники без рекламного бюджета (сайт, рекомендации,
// оффлайн-каналы, "не заполнено") в эту карту не попадают — для них нет CPL.
export const CHANNEL_TO_PLATFORM: Record<string, string> = {
  "Instagram": "Meta", "Google Ads": "Google Ads", "Yandex Direct": "Yandex Direct", "TikTok": "TikTok",
};
export function platformOf(l: LeadRow): string | null {
  return CHANNEL_TO_PLATFORM[sourceOf(l)] ?? null;
}

// "Необработан" — лид всё ещё открыт ("Стадия" = "В работе"), а результативного
// дозвона так и не было: либо результат ещё не зафиксирован, либо все попытки —
// недозвон/перезвонить/не смогли дозвониться. Закрытые, потерянные и лиды со
// встречей сюда не попадают — по ним решение уже принято (не важно, какое).
const UNPROCESSED_RESULTS = new Set(["", "Недозвон", "Перезвонить", "Клиент перезвонит сам", "Нет дозвона на межнар. номера"]);
export function isUnprocessed(l: LeadRow): boolean {
  return l.stage === "В работе" && UNPROCESSED_RESULTS.has((l.callResult || "").trim());
}

/* ---------- разбор названий кампаний рекламных кабинетов → ЖК (для воронки) ---------- */

const segs = (name: string) => String(name).split("|").map((s) => s.trim()).filter(Boolean);
const normz = (s: string) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const ZHK_CANON: Record<string, string> = {
  "jandostar": "Jan Dostar",
  "nurlydala2": "Nurly Dala II",
  "admplus": "Adamant Plus",
  "adamantplus": "Adamant Plus",
  "admlife": "Adamant Life",
  "adamantlife": "Adamant Life",
  "eliosпост": "Elios",
  "parkvile": "Parkville",
};

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

function zhkCandidates(name: string): string[] {
  return segs(name).slice(1).filter((s) => {
    const n = normz(s);
    if (!n || NON_ZHK.has(n)) return false;
    if (/^#?\d+$/.test(s.trim())) return false;
    if (/^\d{1,2}\.\d{1,2}$/.test(s.trim())) return false;
    if (/^(cpa|cpl|cpm|cpv|cpc|cpe)\d*$/.test(n)) return false;
    return true;
  });
}

export function resolveZhk(name: string, canon: Map<string, string>): string {
  const pick = (s: string) => ZHK_CANON[normz(s)] ?? s;
  const cands = zhkCandidates(name);
  if (cands.length === 0) return "Бренд / Общие";
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

// Строит карту "ЖК-ключ → охват/клики" из campaign-массивов Meta/Google/TikTok/Яндекс
// (тот же формат, что отдают /api/data, /api/google, /api/tiktok, /api/yandex).
export function buildAdsByZhk(
  meta: { campaigns?: { name: string; reach?: number; clicks?: number }[] } | null,
  google: { campaigns?: { name: string; clicks?: number }[] } | null,
  tiktok: { campaigns?: { name: string; clicks?: number }[] } | null,
  yandex: { campaigns?: { name: string; clicks?: number }[] } | null,
): Record<string, { reach: number; clicks: number }> {
  const acc: Record<string, { reach: number; clicks: number }> = {};
  const canon = new Map<string, string>();
  const add = (name: string, reach: number, clicks: number) => {
    const k = zhkKey(resolveZhk(name, canon));
    if (!k) return;
    const o = (acc[k] ??= { reach: 0, clicks: 0 });
    o.reach += reach; o.clicks += clicks;
  };
  for (const c of meta?.campaigns ?? []) add(c.name, +(c.reach ?? 0) || 0, +(c.clicks ?? 0) || 0);
  for (const c of google?.campaigns ?? []) add(c.name, 0, +(c.clicks ?? 0) || 0);
  for (const c of tiktok?.campaigns ?? []) add(c.name, 0, +(c.clicks ?? 0) || 0);
  for (const c of yandex?.campaigns ?? []) add(c.name, 0, +(c.clicks ?? 0) || 0);
  return acc;
}

/* ---------- воронка по ЖК ---------- */

export interface FunnelRow {
  zhk: string; reach: number; clicks: number;
  leads: number; qual: number; buyers: number; buyersQual: number;
  deals: number; sum: number;
}

/* ---------- когортный анализ цикла сделки ---------- */

export const CYCLE_BUCKETS = [
  { key: "0", label: "В день обращения", test: (d: number) => d === 0 },
  { key: "1-7", label: "1–7 дней", test: (d: number) => d >= 1 && d <= 7 },
  { key: "8-14", label: "8–14 дней", test: (d: number) => d >= 8 && d <= 14 },
  { key: "15-30", label: "15–30 дней", test: (d: number) => d >= 15 && d <= 30 },
  { key: "31-60", label: "31–60 дней", test: (d: number) => d >= 31 && d <= 60 },
  { key: "61-90", label: "61–90 дней", test: (d: number) => d >= 61 && d <= 90 },
  { key: "91-180", label: "91–180 дней", test: (d: number) => d >= 91 && d <= 180 },
  { key: "181+", label: "Более 180 дней", test: (d: number) => d >= 181 },
] as const;
export interface CohortRow { month: string; total: number; buckets: Record<string, number> }

/* ---------- итоговая модель сверки ---------- */

export interface ReconciliationResult {
  kpis: {
    leadsUnique: number; leadsRows: number;
    totalDeals: number; noPhone: number;
    totalMatched: number; matchedPct: number;
    matchedByPhone: number; matchedByName: number; matchedByAds: number; matchedLate: number;
    totalSum: number;
  };
  reconRows: ReconRow[];
  funnelRows: FunnelRow[];
  funnelTotal: { reach: number; clicks: number; leads: number; qual: number; buyers: number; buyersQual: number; deals: number; sum: number };
  cohortRows: CohortRow[];
  overallMedian: number;
  overallAvg: number;
  cycleSamples: number;
}

// Полный проход: по каждому договору ищем лид (сначала по телефону, затем по ФИО,
// затем по выгрузке кабинета), группирует по заданному ключу разрезки, строит
// воронку по ЖК и когортный анализ цикла сделки. Чистая функция без побочных
// эффектов — безопасно гонять и в браузере, и в API-роуте на сервере.
export function buildReconciliation(
  leads: LeadRow[],
  contracts: ContractRow[],
  adLeads: AdLeadRow[] | null,
  adsByZhk: Record<string, { reach: number; clicks: number }>,
  groupBy: GroupKey,
): ReconciliationResult {
  const touchesByPhone = new Map<string, LeadRow[]>();
  const touchesByName = new Map<string, LeadRow[]>();
  for (const l of leads) {
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
  const hasAnyTouch = (c: ContractRow) =>
    c.phones.some((p) => touchesByPhone.has(p)) || touchesByName.has(nameKey(c.client));

  const leadByPhone = new Map<string, LeadRow>();
  for (const [phone, arr] of touchesByPhone) {
    let best = arr[0];
    for (const l of arr) if (sortableDate(l.date) < sortableDate(best.date)) best = l;
    leadByPhone.set(phone, best);
  }

  const adLeadByPhone = new Map<string, AdLeadRow>();
  const adLeadByName = new Map<string, AdLeadRow>();
  for (const l of adLeads ?? []) {
    if (l.phone && !adLeadByPhone.has(l.phone)) adLeadByPhone.set(l.phone, l);
    const nk = nameKey(l.client);
    if (nk && !adLeadByName.has(nk)) adLeadByName.set(nk, l);
  }

  const matched: { contract: ContractRow; lead: LeadRow | null; by: "phone" | "name" | "ads" | "late" | null }[] = contracts.map((c) => {
    for (const p of c.phones) {
      const hit = earliestBefore(touchesByPhone.get(p), c.date);
      if (hit) return { contract: c, lead: hit, by: "phone" as const };
    }
    const byName = earliestBefore(touchesByName.get(nameKey(c.client)), c.date);
    if (byName) return { contract: c, lead: byName, by: "name" as const };
    const ad = c.phones.map((p) => adLeadByPhone.get(p)).find((l) => l) ?? adLeadByName.get(nameKey(c.client));
    if (ad && (!c.date || !ad.date || sortableAdDate(ad.date) <= sortableDate(c.date))) {
      return {
        contract: c,
        lead: { phone: ad.phone, channel: "Центр лидов", source: AD_SOURCE, object: "", date: ad.date, client: ad.client, descr: "", meeting: false, stage: "", callResult: "" },
        by: "ads" as const,
      };
    }
    if (hasAnyTouch(c) || ad) return { contract: c, lead: null, by: "late" as const };
    return { contract: c, lead: null, by: null };
  });
  const matchedByPhone = matched.filter((m) => m.by === "phone").length;
  const matchedByName = matched.filter((m) => m.by === "name").length;
  const matchedByAds = matched.filter((m) => m.by === "ads").length;
  const matchedLate = matched.filter((m) => m.by === "late").length;

  const campByPhone = new Map<string, { camp: string; date: string }>();
  const campByName = new Map<string, { camp: string; date: string }>();
  for (const l of leads) {
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

  const groupOf = (l: LeadRow, phone: string, c: ContractRow): string => {
    if (groupBy === "campaign") return campaignOf(c) || NO_CAMPAIGN;
    if (groupBy === "source") return sourceOf(l);
    if (groupBy === "channel") return l.channel || "(не заполнено)";
    return adLeadByPhone.get(phone)?.campaign ?? "(нет в Центре лидов)";
  };
  // Квал-лид — телефон, у которого хоть на одном обращении стоит "встреча назначена"
  // (не обязательно на первом/учтённом в leadByPhone касании).
  const qualByPhone = new Set<string>();
  for (const l of leads) if (l.meeting && l.phone) qualByPhone.add(l.phone);

  const leadsPerGroup: Record<string, number> = {};
  const qualPerGroup: Record<string, number> = {};
  if (groupBy === "form") {
    for (const l of adLeadByPhone.values()) {
      leadsPerGroup[l.campaign] = (leadsPerGroup[l.campaign] ?? 0) + 1;
      if (qualByPhone.has(l.phone)) qualPerGroup[l.campaign] = (qualPerGroup[l.campaign] ?? 0) + 1;
    }
  } else if (groupBy === "campaign") {
    for (const phone of leadByPhone.keys()) {
      const hit = campByPhone.get(phone);
      const k = hit ? shortCampaign(hit.camp) : NO_CAMPAIGN;
      leadsPerGroup[k] = (leadsPerGroup[k] ?? 0) + 1;
      if (qualByPhone.has(phone)) qualPerGroup[k] = (qualPerGroup[k] ?? 0) + 1;
    }
  } else {
    for (const [phone, l] of leadByPhone) {
      const k = groupBy === "source" ? sourceOf(l) : (l.channel || "(не заполнено)");
      leadsPerGroup[k] = (leadsPerGroup[k] ?? 0) + 1;
      if (qualByPhone.has(phone)) qualPerGroup[k] = (qualPerGroup[k] ?? 0) + 1;
    }
  }

  const recon: Record<string, ReconRow & { _buyers: Set<string> }> = {};
  for (const { contract, lead, by } of matched) {
    if (!contract.phones.length && !lead && by !== "late") continue;
    const key = lead
      ? groupOf(lead, contract.phones.find((p) => leadByPhone.has(p)) ?? contract.phones[0] ?? "", contract)
      : by === "late" ? LATE_TOUCH : NOT_FOUND;
    const row = (recon[key] ??= { channel: key, leadsTotal: leadsPerGroup[key] ?? 0, qual: qualPerGroup[key] ?? 0, deals: 0, sum: 0, buyers: 0, _buyers: new Set() });
    row.deals += 1;
    row._buyers.add(contract.phones[0] || nameKey(contract.client));
    if (!/растор/i.test(contract.status)) row.sum += contract.sum;
  }
  for (const [g, cnt] of Object.entries(leadsPerGroup)) {
    if (!recon[g]) recon[g] = { channel: g, leadsTotal: cnt, qual: qualPerGroup[g] ?? 0, deals: 0, sum: 0, buyers: 0, _buyers: new Set() };
  }
  const isTail = (k: string) => (k === NOT_FOUND || k === LATE_TOUCH ? 1 : 0);
  const reconRows: ReconRow[] = Object.values(recon)
    .map((r) => ({ channel: r.channel, leadsTotal: r.leadsTotal, qual: r.qual, deals: r.deals, sum: r.sum, buyers: r._buyers.size }))
    .sort((a, b) => isTail(a.channel) - isTail(b.channel) || b.sum - a.sum);

  // ---- Воронка по ЖК ----
  const funnel: Record<string, { zhk: string; reach: number; clicks: number; leads: Set<string>; qual: Set<string>; buyers: Set<string>; buyersQual: Set<string>; deals: number; sum: number }> = {};
  const fRow = (key: string, label: string) =>
    (funnel[key] ??= { zhk: label, reach: 0, clicks: 0, leads: new Set(), qual: new Set(), buyers: new Set(), buyersQual: new Set(), deals: 0, sum: 0 });
  for (const [k, v] of Object.entries(adsByZhk)) {
    const r = fRow(k, k);
    r.reach += v.reach; r.clicks += v.clicks;
  }
  const qualIds = new Set<string>();
  for (const l of leads) {
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
    if (id && qualIds.has(id)) r.buyersQual.add(id);
    if (!/растор/i.test(contract.status)) r.sum += contract.sum;
  }
  const funnelRows: FunnelRow[] = Object.values(funnel)
    .map((r) => ({ zhk: r.zhk, reach: r.reach, clicks: r.clicks, leads: r.leads.size, qual: r.qual.size, buyers: r.buyers.size, buyersQual: r.buyersQual.size, deals: r.deals, sum: r.sum }))
    .sort((a, b) => b.sum - a.sum || b.leads - a.leads);
  const funnelTotal = funnelRows.reduce((t, r) => ({
    reach: t.reach + r.reach, clicks: t.clicks + r.clicks, leads: t.leads + r.leads,
    qual: t.qual + r.qual, buyers: t.buyers + r.buyers, buyersQual: t.buyersQual + r.buyersQual,
    deals: t.deals + r.deals, sum: t.sum + r.sum,
  }), { reach: 0, clicks: 0, leads: 0, qual: 0, buyers: 0, buyersQual: 0, deals: 0, sum: 0 });

  // ---- Когортный анализ ----
  const toDate = (yyyymmdd: string) => new Date(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8));
  const cohorts: Record<string, CohortRow> = {};
  const allCycleDays: number[] = [];
  for (const { contract, lead } of matched) {
    if (!lead || !lead.date || !contract.date) continue;
    const leadSD = sortableDate(lead.date), conSD = sortableDate(contract.date);
    if (leadSD === "99999999" || conSD === "99999999") continue;
    const days = Math.round((+toDate(conSD) - +toDate(leadSD)) / 86400000);
    if (days < 0) continue;
    allCycleDays.push(days);
    const month = leadSD.slice(0, 4) + "-" + leadSD.slice(4, 6);
    const row = (cohorts[month] ??= { month, total: 0, buckets: Object.fromEntries(CYCLE_BUCKETS.map((b) => [b.key, 0])) });
    row.total += 1;
    const bucket = CYCLE_BUCKETS.find((b) => b.test(days));
    if (bucket) row.buckets[bucket.key] += 1;
  }
  const cohortRows = Object.values(cohorts).sort((a, b) => a.month.localeCompare(b.month));
  const median = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  const overallMedian = median(allCycleDays);
  const overallAvg = allCycleDays.length ? allCycleDays.reduce((a, b) => a + b, 0) / allCycleDays.length : 0;

  const totalDeals = matched.length;
  const totalSum = matched.reduce((s, { contract }) => s + (/растор/i.test(contract.status) ? 0 : contract.sum), 0);
  const totalMatched = matched.filter((m) => m.lead).length;
  const noPhone = matched.filter((m) => !m.contract.phones.length).length;

  return {
    kpis: {
      leadsUnique: leadByPhone.size, leadsRows: leads.length,
      totalDeals, noPhone,
      totalMatched, matchedPct: totalDeals ? Math.round((totalMatched / totalDeals) * 100) : 0,
      matchedByPhone, matchedByName, matchedByAds, matchedLate,
      totalSum,
    },
    reconRows, funnelRows, funnelTotal, cohortRows,
    overallMedian, overallAvg, cycleSamples: allCycleDays.length,
  };
}

/* ---------- медиаплан: CPL/качество по ЖК × площадка, рекомендация по бюджету ---------- */

export interface MediaPlanRow {
  zhk: string; platform: string;
  spend: number; leads: number; cpl: number;
  qual: number; crQual: number;
  unprocessed: number; unprocessedPct: number;
  benchmarkCpl: number; benchmarkCrQual: number;
  recommendation: string; explanation: string; suggestedBudget: number;
}

const PLATFORM_ORDER = ["Meta", "Google Ads", "Yandex Direct", "TikTok"];

// Сводит расход рекламных кабинетов и лиды CRM в одну таблицу по (ЖК × площадка) за
// период, сравнивает CPL/конверсию в квал каждого ЖК со средним по ТОЙ ЖЕ площадке
// (в рамках периода — без сравнения месяц-к-месяцу, для этого нужен архив снапшотов
// кампаний по месяцам, которого пока нет) и даёт рекомендацию по бюджету.
export function buildMediaPlan(
  leads: LeadRow[],
  campaignsByPlatform: Record<string, { name: string; spend: number }[]>,
): MediaPlanRow[] {
  const canon = new Map<string, string>();
  const spend: Record<string, Record<string, number>> = {};
  const displayName: Record<string, string> = {};
  for (const platform of PLATFORM_ORDER) {
    for (const c of campaignsByPlatform[platform] ?? []) {
      const label = resolveZhk(c.name, canon);
      const k = zhkKey(label);
      if (!k) continue;
      displayName[k] ??= label;
      (spend[k] ??= {})[platform] = (spend[k]?.[platform] ?? 0) + (c.spend || 0);
    }
  }

  // "\u0000" — служебный разделитель ключа (ЖК/площадка/id не могут его содержать).
  const leadIds: Record<string, Set<string>> = {};
  const qualIds: Record<string, Set<string>> = {};
  const latestByKey = new Map<string, LeadRow>();
  for (const l of leads) {
    const platform = platformOf(l);
    if (!platform) continue; // источники без рекламного бюджета в медиаплан не входят
    const zk = zhkKey(l.object);
    if (!zk) continue;
    const id = l.phone || nameKey(l.client);
    if (!id) continue;
    const bucketKey = `${zk}\u0000${platform}`;
    (leadIds[bucketKey] ??= new Set()).add(id);
    if (l.meeting) (qualIds[bucketKey] ??= new Set()).add(id);
    const idKey = `${bucketKey}\u0000${id}`;
    const prev = latestByKey.get(idKey);
    if (!prev || sortableDate(l.date) > sortableDate(prev.date)) latestByKey.set(idKey, l);
  }
  const unprocessedIds: Record<string, Set<string>> = {};
  for (const [idKey, l] of latestByKey) {
    if (!isUnprocessed(l)) continue;
    const parts = idKey.split("\u0000");
    const bucketKey = `${parts[0]}\u0000${parts[1]}`;
    (unprocessedIds[bucketKey] ??= new Set()).add(parts[2]);
  }

  const allKeys = new Set<string>();
  for (const zk of Object.keys(spend)) for (const p of Object.keys(spend[zk])) allKeys.add(`${zk}\u0000${p}`);
  for (const k of Object.keys(leadIds)) allKeys.add(k);

  const rawRows: { zhk: string; platform: string; spend: number; leads: number; qual: number; unprocessed: number }[] = [];
  for (const key of allKeys) {
    const [zk, platform] = key.split("\u0000");
    const sp = spend[zk]?.[platform] ?? 0;
    const ld = leadIds[key]?.size ?? 0;
    const q = qualIds[key]?.size ?? 0;
    const un = unprocessedIds[key]?.size ?? 0;
    if (!sp && !ld) continue;
    rawRows.push({ zhk: displayName[zk] ?? zk, platform, spend: sp, leads: ld, qual: q, unprocessed: un });
  }

  const benchByPlatform: Record<string, { cpl: number; crQual: number }> = {};
  for (const platform of PLATFORM_ORDER) {
    const rows = rawRows.filter((r) => r.platform === platform && r.spend > 0 && r.leads > 0);
    if (!rows.length) { benchByPlatform[platform] = { cpl: 0, crQual: 0 }; continue; }
    const cpls = rows.map((r) => r.spend / r.leads);
    const crs = rows.map((r) => r.qual / r.leads);
    benchByPlatform[platform] = {
      cpl: cpls.reduce((a, b) => a + b, 0) / cpls.length,
      crQual: crs.reduce((a, b) => a + b, 0) / crs.length,
    };
  }

  const money0 = (n: number) => Math.round(n).toLocaleString("ru-RU");
  const rows: MediaPlanRow[] = rawRows.map((r) => {
    const cpl = r.leads ? r.spend / r.leads : 0;
    const crQual = r.leads ? r.qual / r.leads : 0;
    const unprocessedPct = r.leads ? r.unprocessed / r.leads : 0;
    const bench = benchByPlatform[r.platform] ?? { cpl: 0, crQual: 0 };
    let recommendation = "Оставить как есть", suggestedBudget = r.spend, explanation = "";
    if (!r.spend || !r.leads || !bench.cpl) {
      recommendation = "Недостаточно данных";
      explanation = "Мало лидов или расхода за период для сравнения — рекомендация будет надёжнее на следующий месяц.";
    } else if (cpl >= bench.cpl * 2 && crQual <= bench.crQual * 0.5) {
      recommendation = "Рассмотреть отключение";
      suggestedBudget = 0;
      explanation = `CPL ${money0(cpl)} ₸ — почти вдвое выше среднего по площадке (${money0(bench.cpl)} ₸), а конверсия в квал ${(crQual * 100).toFixed(1)}% вдвое хуже среднего (${(bench.crQual * 100).toFixed(1)}%). Площадка стабильно приводит дорогих и некачественных лидов по этому ЖК.`;
    } else if (cpl >= bench.cpl * 1.3 || crQual < bench.crQual * 0.7) {
      recommendation = "Снизить бюджет (−30%)";
      suggestedBudget = r.spend * 0.7;
      explanation = `CPL ${money0(cpl)} ₸ выше среднего по площадке (${money0(bench.cpl)} ₸) или конверсия в квал (${(crQual * 100).toFixed(1)}%) ниже среднего (${(bench.crQual * 100).toFixed(1)}%) — эффективность ниже, чем у других ЖК на этой же площадке.`;
    } else if (cpl <= bench.cpl * 0.9 && crQual >= bench.crQual) {
      recommendation = "Поднять бюджет (+20%)";
      suggestedBudget = r.spend * 1.2;
      explanation = `CPL ${money0(cpl)} ₸ ниже среднего по площадке (${money0(bench.cpl)} ₸), конверсия в квал ${(crQual * 100).toFixed(1)}% не хуже среднего (${(bench.crQual * 100).toFixed(1)}%) — площадка эффективно приводит лидов по этому ЖК, есть смысл масштабировать.`;
    } else {
      explanation = `CPL ${money0(cpl)} ₸ и конверсия в квал ${(crQual * 100).toFixed(1)}% на уровне среднего по площадке — оснований менять бюджет нет.`;
    }
    if (unprocessedPct >= 0.3) {
      explanation += ` Внимание: ${(unprocessedPct * 100).toFixed(0)}% лидов этого ЖК/площадки до сих пор не дозвонились — прежде чем менять бюджет, стоит проверить обработку.`;
    }
    return {
      zhk: r.zhk, platform: r.platform, spend: r.spend, leads: r.leads, cpl,
      qual: r.qual, crQual, unprocessed: r.unprocessed, unprocessedPct,
      benchmarkCpl: bench.cpl, benchmarkCrQual: bench.crQual,
      recommendation, explanation, suggestedBudget,
    };
  });

  return rows.sort((a, b) => a.zhk.localeCompare(b.zhk) || a.platform.localeCompare(b.platform));
}
