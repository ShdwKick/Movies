"use strict";
/**
 * Клиент poiskkino.dev — поиск фильмов и карточка по kinopoisk_id.
 *
 *   const poiskkino = require("./poiskkino")({ apiKeys: [key1, key2], dailyCap, db });
 *   const { docs } = await poiskkino.search("матрица");
 *   const full = await poiskkino.getById(301);
 *
 * Авторизация заголовком X-API-KEY (не Bearer — так у этого провайдера).
 *
 * НЕСКОЛЬКО КЛЮЧЕЙ: apiKeys — массив, у каждого своя суточная квота
 * (dailyCap) у провайдера. Модуль ведёт счётчик каждого ключа ОТДЕЛЬНО (см.
 * poiskkino_key_usage — сутки по UTC + индекс ключа в массиве) и на каждый
 * вызов сам выбирает первый ещё не исчерпанный сегодня ключ (pickKey) — не
 * round-robin вперемешку, а именно «добить первый до конца, потом следующий»,
 * как и попросили: рвать один ключ по чуть-чуть смысла нет, только сложнее
 * понять, сколько реально осталось. «Текущий» ключ нигде не хранится
 * отдельной переменной — просто пересчитывается из счётчиков в БД на каждый
 * вызов, поэтому рестарт процесса ничего не сбрасывает и не путает.
 * Отказывает ДО сетевого похода, если ВСЕ ключи сегодня исчерпаны — мягкий
 * потолок на каждый ключ ниже настоящего лимита провайдера (обычно
 * 200/сутки), чтобы отказ был предсказуемым тостом, а не молчаливым 429 от
 * poiskkino.dev в середине важного дня. Таблицу поштучно создаёт server.js
 * вместе с остальной схемой — этот модуль только читает и пишет в неё.
 *
 * Индекс ключа в БД — НЕ сам ключ: секрет незачем хранить лишний раз (в т.ч.
 * ради того, чтобы он не всплыл в бэкапе БД или в админке — keysStatus()
 * ниже отдаёт только индекс и счётчик, не значение).
 *
 * Ссылку на db держим в объекте stmt (поле db), а не только в замыкании —
 * та же грабля, что и в server.js: если единственная живая ссылка на
 * DatabaseSync — переменная модуля, до которой JS больше не достаёт, GC
 * вправе её собрать, и подготовленные запросы начнут падать с «statement has
 * been finalized» (см. Trip/server.js:209-213).
 */

const API_BASE = "https://api.poiskkino.dev";

module.exports = function createPoiskKino(options = {}) {
  // apiKey (в единственном числе) — для обратной совместимости, если
  // кто-то передаст по-старому один ключ строкой, а не массивом.
  const apiKeys = Array.isArray(options.apiKeys)
    ? options.apiKeys.filter(Boolean)
    : (options.apiKey ? [options.apiKey] : []);
  const dailyCap = options.dailyCap || 190;
  const db = options.db;
  const enabled = apiKeys.length > 0;

  if (!db) throw new Error("poiskkino: нужен db (DatabaseSync) для учёта api_usage");

  const stmt = {
    db, // см. комментарий в шапке файла — не убирать
    usage: db.prepare("SELECT calls FROM poiskkino_key_usage WHERE day = ? AND key_idx = ?"),
    bump: db.prepare(`
      INSERT INTO poiskkino_key_usage (day, key_idx, calls) VALUES (?, ?, 1)
      ON CONFLICT(day, key_idx) DO UPDATE SET calls = calls + 1`),
    // Провайдер сам сказал 403 «суточный лимит исчерпан» — наш dailyCap это
    // ОЦЕНКА (обычно 190), не число от самого poiskkino.dev, реальный тариф
    // конкретного ключа может оказаться ниже. MAX(calls, excluded.calls), не
    // просто SET — если calls уже больше dailyCap (несколько параллельных
    // запросов успели сюда одновременно), не занижаем счётчик обратно.
    markExhausted: db.prepare(`
      INSERT INTO poiskkino_key_usage (day, key_idx, calls) VALUES (?, ?, ?)
      ON CONFLICT(day, key_idx) DO UPDATE SET calls = MAX(calls, excluded.calls)`),
  };

  const utcDay = (ts) => new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD, UTC

  function keyUsageToday(idx) {
    const row = stmt.usage.get(utcDay(Date.now()), idx);
    return row ? row.calls : 0;
  }

  /** Сумма по всем ключам — общее число обращений за сегодня, для отчётности
      (Admin /internal/stats) и для IMPORT_DAILY_CAP в server.js (тот
      специально держим отдельным фиксированным числом, не завязанным на
      количество ключей — см. обсуждение там). */
  function usageToday() {
    return apiKeys.reduce((sum, _key, idx) => sum + keyUsageToday(idx), 0);
  }

  /** Для админки — по каждому ключу отдельно (индекс + сколько потрачено),
      без самого значения ключа. */
  function keysStatus() {
    return apiKeys.map((_key, idx) => ({ index: idx, calls: keyUsageToday(idx), cap: dailyCap }));
  }

  /** Первый ключ, у которого сегодня ещё есть запас, или -1, если все
      исчерпаны. «Первый», а не «наименее использованный» — так один ключ
      добивается до конца, прежде чем распечатать следующий (см. шапку
      файла). */
  function pickKey() {
    for (let idx = 0; idx < apiKeys.length; idx++) {
      if (keyUsageToday(idx) < dailyCap) return idx;
    }
    return -1;
  }

  function quotaError() {
    const err = new Error(
      `Дневной лимит обращений к poiskkino.dev исчерпан${apiKeys.length > 1 ? ` по всем ${apiKeys.length} ключам` : ""} ` +
      `(${dailyCap}/сутки на ключ, UTC). ` +
      `Уже добавленные фильмы продолжают работать — новый поиск и добавление станут доступны завтра.`
    );
    err.quota = true;
    return err;
  }

  /** Единственное место, откуда уходят HTTP-запросы к provider'у.
      dailyCap (обычно 190) — НАША оценка лимита ключа, не число, которое
      реально гарантирует провайдер: настоящий тариф может оказаться ниже
      (или у части ключей отличаться от других). Раньше это значило, что
      pickKey() продолжал считать ключ рабочим (calls < dailyCap), запрос
      уходил, а provider отвечал 403 «суточный лимит исчерпан» — и это летело
      наверх голой ошибкой, ключ не переключался, хотя другие ключи рядом
      могли быть совершенно свободны. Теперь 403 от provider'а — сигнал
      «этот ключ исчерпан ПРЯМО СЕЙЧАС, независимо от того, что говорит наш
      счётчик»: помечаем его достигшим dailyCap и пробуем следующий ключ по
      кругу (pickKey уже пропустит помеченный), а не молча повторяем на нём
      же. Обычный `!res.ok` для остальных кодов (404/400/5xx) — как раньше,
      сразу наружу, это не про квоту. */
  async function call(pathAndQuery) {
    if (!enabled) {
      const err = new Error("Поиск фильмов не настроен: не задан POISKKINO_API_KEY.");
      err.notConfigured = true;
      throw err;
    }
    let idx = pickKey();
    if (idx === -1) throw quotaError();

    while (idx !== -1) {
      // Считаем обращение сразу, до ожидания ответа: сетевой запрос уже ушёл
      // и потратил слот у провайдера независимо от того, что он нам ответит.
      stmt.bump.run(utcDay(Date.now()), idx);

      let res;
      try {
        res = await fetch(API_BASE + pathAndQuery, { headers: { "X-API-KEY": apiKeys[idx] } });
      } catch (e) {
        throw new Error(`poiskkino.dev недоступен: ${e.message}`);
      }

      if (res.status === 403) {
        stmt.markExhausted.run(utcDay(Date.now()), idx, dailyCap);
        idx = pickKey();
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new Error(`poiskkino.dev ответил ${res.status}${body ? ": " + body.slice(0, 200) : ""}`);
        err.status = res.status;
        throw err;
      }
      return res.json();
    }
    // 403 добил и этот ключ, и все следующие по кругу — реально нечем.
    throw quotaError();
  }

  /** Живой опрос суточного лимита У САМОГО ПРОВАЙДЕРА (GET /v1.5/token) для
      ОДНОГО конкретного ключа — не через pickKey()/call(), это диагностика
      именно этого idx, не рабочий запрос. В отличие от keysStatus() (наш
      локальный счётчик + dailyCap-ОЦЕНКА, которая, как выяснилось, может не
      совпадать с реальным тарифом ключа — см. call() выше) тут настоящие
      числа от poiskkino.dev: requestsLimit/requestsUsed/requestsRemaining,
      ttl/resetAt. Запрос НЕ тратит лимит (сказано в документации
      /v1.5/token) — можно звать сколько угодно, специально для админки. */
  async function getTokenInfo(idx) {
    if (!(idx >= 0 && idx < apiKeys.length)) throw new Error("poiskkino: неверный индекс ключа");
    let res;
    try {
      res = await fetch(`${API_BASE}/v1.5/token`, { headers: { "X-API-KEY": apiKeys[idx] } });
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

  /** getTokenInfo для ВСЕХ ключей разом (параллельно — независимые запросы,
      один упавший не должен ронять остальные), для /internal/poiskkino/keys.
      Формат под тот же keysStatus() (index + локальные calls/cap), плюс
      live — реальные числа провайдера, либо liveError, если конкретно этот
      ключ не ответил (невалиден/провайдер недоступен). */
  async function keysLiveStatus() {
    const local = keysStatus();
    const live = await Promise.all(apiKeys.map((_key, idx) =>
      getTokenInfo(idx).then(info => ({ info })).catch(e => ({ error: e.message }))
    ));
    return local.map((row, idx) => ({
      ...row,
      live: live[idx].info || null,
      liveError: live[idx].error || null,
    }));
  }

  return {
    enabled,
    usageToday,
    dailyCap,
    // Суммарная суточная ёмкость по ВСЕМ ключам — для отчётности рядом с
    // usageToday() (dailyCap сам по себе теперь «на один ключ», не «всего»).
    totalDailyCap: dailyCap * apiKeys.length,
    keyCount: apiKeys.length,
    keysStatus,
    keysLiveStatus,
    search: (q) => call(`/v1.4/movie/search?query=${encodeURIComponent(q)}&limit=10`),
    getById: (id) => call(`/v1.4/movie/${encodeURIComponent(id)}`),
    // Коллекции кино (топ-250 и т.п.) — только на v1.4/v1.5 у provider'а вообще
    // есть; search/getById выше намеренно НЕ трогаем (живут на /v1.4, тот же
    // deprecated, но рабочий — миграция не в рамках этой задачи), а вот
    // /v1.4/list/{slug} (тоже deprecated) фильмы коллекции НЕ отдаёт вовсе —
    // только v1.5 умеет «коллекция + фильмы» одним запросом, так что тут
    // сразу на v1.5.
    listCollections: ({ category, limit, next } = {}) => {
      const qs = new URLSearchParams();
      if (category) qs.set("category", category);
      qs.set("limit", String(limit || 30));
      if (next) qs.set("next", next);
      return call(`/v1.5/list?${qs.toString()}`);
    },
    getCollection: (slug, { limit, next } = {}) => {
      const qs = new URLSearchParams();
      qs.set("limit", String(limit || 50));
      if (next) qs.set("next", next);
      return call(`/v1.5/list/${encodeURIComponent(slug)}?${qs.toString()}`);
    },
  };
};
