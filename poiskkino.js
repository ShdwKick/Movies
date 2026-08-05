"use strict";
/**
 * Клиент poiskkino.dev — поиск фильмов и карточка по kinopoisk_id.
 *
 *   const poiskkino = require("./poiskkino")({ apiKey, dailyCap, db });
 *   const { docs } = await poiskkino.search("матрица");
 *   const full = await poiskkino.getById(301);
 *
 * Авторизация заголовком X-API-KEY (не Bearer — так у этого провайдера).
 * Модуль сам ведёт счётчик обращений в таблице api_usage (сутки по UTC,
 * ключ — YYYY-MM-DD) и отказывает ДО сетевого похода, если за сутки уже было
 * dailyCap обращений — мягкий потолок ниже настоящего лимита провайдера
 * (200/сутки), чтобы отказ был предсказуемым тостом, а не молчаливым 429 от
 * poiskkino.dev в середине важного дня. Таблицу api_usage создаёт server.js
 * вместе с остальной схемой — этот модуль только читает и пишет в неё.
 *
 * Ссылку на db держим в объекте stmt (поле db), а не только в замыкании —
 * та же грабля, что и в server.js: если единственная живая ссылка на
 * DatabaseSync — переменная модуля, до которой JS больше не достаёт, GC
 * вправе её собрать, и подготовленные запросы начнут падать с «statement has
 * been finalized» (см. Trip/server.js:209-213).
 */

const API_BASE = "https://api.poiskkino.dev";

module.exports = function createPoiskKino(options = {}) {
  const apiKey = options.apiKey || "";
  const dailyCap = options.dailyCap || 190;
  const db = options.db;
  const enabled = !!apiKey;

  if (!db) throw new Error("poiskkino: нужен db (DatabaseSync) для учёта api_usage");

  const stmt = {
    db, // см. комментарий в шапке файла — не убирать
    usage: db.prepare("SELECT calls FROM api_usage WHERE day = ?"),
    bump: db.prepare(`
      INSERT INTO api_usage (day, calls) VALUES (?, 1)
      ON CONFLICT(day) DO UPDATE SET calls = calls + 1`),
  };

  const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD, UTC

  function usageToday() {
    const row = stmt.usage.get(utcDay(Date.now()));
    return row ? row.calls : 0;
  }

  /** Бросает ошибку с флагом quota:true, если сегодняшний счётчик уже у потолка. */
  function checkQuota() {
    if (usageToday() >= dailyCap) {
      const err = new Error(
        `Дневной лимит обращений к poiskkino.dev исчерпан (${dailyCap}/сутки, UTC). ` +
        `Уже добавленные фильмы продолжают работать — новый поиск и добавление станут доступны завтра.`
      );
      err.quota = true;
      throw err;
    }
  }

  /** Единственное место, откуда уходят HTTP-запросы к provider'у. */
  async function call(pathAndQuery) {
    if (!enabled) {
      const err = new Error("Поиск фильмов не настроен: не задан POISKKINO_API_KEY.");
      err.notConfigured = true;
      throw err;
    }
    checkQuota();
    // Считаем обращение сразу, до ожидания ответа: сетевой запрос уже ушёл и
    // потратил слот у провайдера независимо от того, что он нам ответит.
    // Между этой строкой и следующим await ничего больше не выполняется —
    // JS однопоточный, гонки внутри процесса тут нет.
    stmt.bump.run(utcDay(Date.now()));

    let res;
    try {
      res = await fetch(API_BASE + pathAndQuery, { headers: { "X-API-KEY": apiKey } });
    } catch (e) {
      throw new Error(`poiskkino.dev недоступен: ${e.message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error(`poiskkino.dev ответил ${res.status}${body ? ": " + body.slice(0, 200) : ""}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  return {
    enabled,
    usageToday,
    dailyCap,
    search: (q) => call(`/v1.4/movie/search?query=${encodeURIComponent(q)}&limit=10`),
    getById: (id) => call(`/v1.4/movie/${encodeURIComponent(id)}`),
  };
};
