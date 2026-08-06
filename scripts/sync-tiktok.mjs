// Выгрузка TikTok Ads в БД. Запуск: npm run sync:tiktok
import { runTiktokSync } from "../src/lib/tiktok.mjs";

runTiktokSync()
  .then((r) => console.log(`TikTok готово. Снапшот ${r.snapshotId}: ${r.days} дней, ${r.campaigns} кампаний за ${r.since}…${r.until}.`))
  .catch((e) => { console.error("Ошибка TikTok sync:", e.message); process.exit(1); });
