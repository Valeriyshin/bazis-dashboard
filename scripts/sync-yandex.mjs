// Выгрузка Яндекс.Директа в БД. Запуск: npm run sync:yandex
import { runYandexSync } from "../src/lib/yandex.mjs";

runYandexSync()
  .then((r) => console.log(`Яндекс готово. Снапшот ${r.snapshotId}: ${r.days} дней, ${r.campaigns} кампаний за ${r.since}…${r.until}.`))
  .catch((e) => { console.error("Ошибка Яндекс sync:", e.message); process.exit(1); });
