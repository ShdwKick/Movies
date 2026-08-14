// Копия Shared/admin-internal.js — не редактировать здесь.
// Правки вносят в Shared/ и раскладывают: node Shared/sync.mjs
"use strict";
/**
 * Серверная часть подключения сервиса к Admin.
 *
 * Копируется в проект как есть (зависимостей нет), рядом с server.js — так же,
 * как auth-client.js. Два независимых куска:
 *
 *   checkAdminKey(req)   — проверка входящих вызовов от Admin. Это НЕ SSO:
 *                          Admin ходит за статистикой и логами server-to-server,
 *                          без пользовательского браузера и без JWT, поэтому
 *                          доверие — общий секрет в переменной окружения
 *                          ADMIN_INTERNAL_KEY (тот же самый — у Admin и у вас).
 *
 *   createAdminLog(db)  — лог сервиса в его же SQLite, который Admin потом
 *                          читает через /internal/logs. Таблица создаётся сама
 *                          при первом обращении, старые записи обрезаются, чтобы
 *                          лог не рос бесконечно на бесплатном диске.
 *
 * Использование:
 *
 *   const { checkAdminKey, createAdminLog } = require("./admin-internal");
 *   const adminLog = createAdminLog(db);
 *
 *   if (p === "/internal/stats" && method === "GET") {
 *     if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
 *     return json(res, 200, { ok: true, ...ваши счётчики });
 *   }
 *
 *   // в общем catch необработанных ошибок:
 *   adminLog.error("Необработанная ошибка", { message: e.message });
 */

const crypto = require("crypto");

/** true — заголовок X-Admin-Key совпал с ADMIN_INTERNAL_KEY. Пустой ключ в
 *  окружении — всегда false: лучше молча выключить /internal/*, чем поднять
 *  их с секретом по умолчанию, который никто не сменит. */
function checkAdminKey(req) {
  const want = String(process.env.ADMIN_INTERNAL_KEY || "");
  if (!want) return false;
  const got = String((req.headers && req.headers["x-admin-key"]) || "");
  const a = Buffer.from(got), b = Buffer.from(want);
  // timingSafeEqual требует равной длины буферов — сравниваем длину отдельно
  // (это само по себе не секрет, длину ключа скрывать незачем).
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Лог сервиса поверх уже открытого SQLite-соединения (db.js каждого сервиса).
 * table — имя таблицы, отдельное от бизнес-данных, чтобы не пересечься со
 * своими CREATE TABLE. limit — сколько последних записей хранить: старые
 * обрезаются при каждой записи, а не по таймеру, так проще и не требует
 * отдельного интервала на каждый сервис.
 */
function createAdminLog(db, { table = "admin_logs", limit = 1000 } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      INTEGER NOT NULL,
      level   TEXT NOT NULL,
      message TEXT NOT NULL,
      meta    TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_ts ON ${table}(ts)`);

  const insert = db.prepare(`INSERT INTO ${table} (ts, level, message, meta) VALUES (?, ?, ?, ?)`);
  const prune = db.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT id FROM ${table} ORDER BY id DESC LIMIT ?)`);
  const selectSince = db.prepare(`SELECT id, ts, level, message, meta FROM ${table} WHERE ts > ? ORDER BY id DESC LIMIT ?`);
  const selectAll = db.prepare(`SELECT id, ts, level, message, meta FROM ${table} ORDER BY id DESC LIMIT ?`);

  function write(level, message, meta) {
    // Запись в лог не должна ронять сервис из-за занятой базы или кривого meta.
    try {
      insert.run(Date.now(), level, String(message), meta === undefined ? null : JSON.stringify(meta));
      prune.run(limit);
    } catch { /* лучше потерять строку лога, чем упасть */ }
    const out = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    out(`[${level}]`, message, meta !== undefined ? meta : "");
  }

  return {
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
    /** { since?: мс-таймстамп, limit?: число } → записи новее-первыми. */
    recent({ since, limit: n = 200 } = {}) {
      const rows = since ? selectSince.all(since, n) : selectAll.all(n);
      return rows.map(r => ({ id: r.id, ts: r.ts, level: r.level, message: r.message, meta: r.meta ? JSON.parse(r.meta) : null }));
    },
  };
}

module.exports = { checkAdminKey, createAdminLog };
