// Переиспользование уже выгруженного периода вместо повторного похода в API.
//
// Зачем: раньше "↻ Обновить" всегда шёл в рекламные кабинеты, даже если выбранный
// период давно закрыт и уже лежит в базе — а цифры за закрытые дни больше не меняются.
// Теперь для такого периода просто копируем строки прошлого снапшота в новый.
//
// Почему копируем, а не отдаём старый снапшот как есть: интерфейс и все API-роуты
// читают ПОСЛЕДНИЙ снапшот (ORDER BY id DESC LIMIT 1). Если не создать новый, на
// экране останется предыдущий период. Копирование идёт одним INSERT ... SELECT на
// таблицу — целиком на стороне БД, без вычитывания строк в приложение.
//
// Важно про окно доатрибуции: свежие дни в кабинетах ещё «доезжают» (конверсии
// доклеиваются задним числом), поэтому период, который задевает последние
// reconDays дней, переиспользовать нельзя — его всегда тянем из API заново.

const todayIso = () => new Date().toISOString().slice(0, 10);
const minusDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

// Имена колонок таблицы. Нужны, чтобы скопировать строки под новым snapshot_id,
// не перечисляя колонки руками (у каждой площадки свои).
async function columnsOf(db, table) {
  const rs = await db.execute(`PRAGMA table_info(${table})`);
  return rs.rows.map((r) => String(r[1])); // [cid, name, type, ...]
}

/**
 * Ищет снапшот за точно такой же период и, если период закрытый, копирует его
 * в новый снапшот. Возвращает id нового снапшота или null, если переиспользовать нельзя.
 *
 * @param snapTable  таблица снапшотов (snapshots / google_snapshots / ...)
 * @param rowTables  таблицы со строками, привязанными к snapshot_id
 */
export async function reusePeriod(db, { snapTable, rowTables, periodStart, periodEnd, reconDays }) {
  // Период задевает окно доатрибуции — данные ещё могут измениться, переиспользовать нельзя.
  if (!periodEnd || periodEnd >= minusDays(todayIso(), reconDays)) return null;

  const found = await db.execute({
    sql: `SELECT id FROM ${snapTable} WHERE period_start=? AND period_end=? ORDER BY id DESC LIMIT 1`,
    args: [periodStart, periodEnd],
  });
  if (!found.rows.length) return null;
  const oldId = Number(found.rows[0][0]);

  // Пустой снапшот (синк упал на полпути) переиспользовать нельзя — иначе закрепим пустоту.
  const probe = await db.execute({ sql: `SELECT COUNT(*) FROM ${rowTables[0]} WHERE snapshot_id=?`, args: [oldId] });
  if (!Number(probe.rows[0][0])) return null;

  // Копия строки снапшота: всё, кроме id (новый) и created_at (сейчас).
  const snapCols = (await columnsOf(db, snapTable)).filter((c) => c !== "id" && c !== "created_at");
  const ins = await db.execute({
    sql: `INSERT INTO ${snapTable} (created_at, ${snapCols.join(",")})
          SELECT ?, ${snapCols.join(",")} FROM ${snapTable} WHERE id=?`,
    args: [new Date().toISOString(), oldId],
  });
  const newId = Number(ins.lastInsertRowid);

  for (const table of rowTables) {
    const rest = (await columnsOf(db, table)).filter((c) => c !== "snapshot_id");
    await db.execute({
      sql: `INSERT INTO ${table} (snapshot_id, ${rest.join(",")})
            SELECT ?, ${rest.join(",")} FROM ${table} WHERE snapshot_id=?`,
      args: [newId, oldId],
    });
  }
  return { snapshotId: newId, copiedFrom: oldId };
}
