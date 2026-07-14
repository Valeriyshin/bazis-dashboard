// Локальная выгрузка в БД (файл или Turso). Запуск: npm run sync
// Период: env FB_SINCE/FB_UNTIL или FB_DAYS (умолчание 60) в .env.local.
import { runSync } from "../src/lib/sync.mjs";

runSync()
  .then((r) => console.log(`Готово. Снапшот ${r.snapshotId}: ${r.days} дней, ${r.campaigns} кампаний, ${r.adsets} групп, ${r.ads} объявлений за ${r.since}…${r.until}.`))
  .catch((e) => { console.error("Ошибка sync:", e.message); process.exit(1); });
