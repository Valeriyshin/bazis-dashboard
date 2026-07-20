// Выгрузка Google Ads в БД. Запуск: npm run sync:google
import { runGoogleAdsSync } from "../src/lib/google-ads.mjs";

runGoogleAdsSync()
  .then((r) => console.log(`Google Ads готово. Снапшот ${r.snapshotId}: ${r.days} дней, ${r.campaigns} кампаний за ${r.since}…${r.until}.`))
  .catch((e) => { console.error("Ошибка Google Ads sync:", e.message); process.exit(1); });
