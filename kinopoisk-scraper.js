"use strict";
/**
 * Скрейпер публичных страниц профиля Кинопоиска — у Кинопоиска нет
 * официального экспорта оценок/списков (см. обсуждение с пользователем),
 * но «Оценки и просмотры» и «Буду смотреть» у публичного профиля видны без
 * логина и отдаются готовым HTML на обычный GET — проверено вручную и
 * WebFetch'ем: JS выполнять не нужно, авторизация не нужна.
 *
 * Без npm-зависимостей (в этом стеке принципиально нет npm install) — весь
 * разбор регулярками по СТРУКТУРНЫМ признакам, а не по вёрстке:
 *   - href="/film/<id>/" или "/series/<id>/" — сам kinopoisk_id, повторяется
 *     дважды подряд на карточку (ссылка постера + ссылка подписи), берём
 *     только первое вхождение — то, что рядом с class, содержащим "posterLink".
 *   - alt-атрибут постера "Название. Год, жанры" — обычный
 *     accessibility-атрибут, не CSS-модуль с рандомным хэшем в имени класса
 *     (те у Кинопоиска пересобираются при каждом деплое и держаться за них
 *     точным совпадением нельзя — учтено даже там, где без класса не
 *     обойтись: матчим по СОДЕРЖАЩЕЙСЯ подстроке "posterLink"/"starIcon",
 *     не по полному имени класса).
 *   - рейтинг — соседняя пара <span class="…starIcon…"></span><span
 *     class="…">N</span> сразу после постера; у непроставленной оценки
 *     этой пары просто нет (см. пример: карточка "Гренландия 2: Миграция"
 *     в реальных данных — .overlaySlot пуст).
 */

const HOST = "https://www.kinopoisk.ru";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Ссылка на профиль (в любом виде) или голый username → username, либо null. */
function parseUsername(input) {
  const s = String(input || "").trim();
  if (!s) return null;
  const m = s.match(/kinopoisk\.ru\/user\/([^/?#]+)/i);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return m[1]; } }
  if (/^[A-Za-z0-9_.-]{2,64}$/.test(s)) return s;
  return null;
}

async function fetchHtml(path) {
  let res;
  try {
    res = await fetch(HOST + path, { headers: { "User-Agent": UA, "Accept-Language": "ru-RU,ru;q=0.9" } });
  } catch (e) {
    throw new Error(`Кинопоиск недоступен: ${e.message}`);
  }
  if (res.status === 404) {
    const e = new Error("Профиль не найден");
    e.notFound = true;
    throw e;
  }
  if (!res.ok) {
    const e = new Error(`Кинопоиск ответил ${res.status}`);
    e.status = res.status;
    throw e;
  }
  return res.text();
}

/** Разбирает одну страницу списка (оценки ИЛИ «буду смотреть» — разметка
    карточки одна и та же, разница только в наличии рейтинга) на массив
    {kinopoiskId, type, title, year, score}. score = null, если оценки нет
    (для «буду смотреть» — всегда null, там рейтинг вообще не выводится). */
function parseListPage(html) {
  const parts = html.split(/(?=href="\/(?:film|series)\/\d+\/"[^>]*class="[^"]*posterLink)/);
  const items = [];
  for (const part of parts) {
    const head = part.match(/href="\/(film|series)\/(\d+)\/"/);
    if (!head) continue;
    const altMatch = part.match(/<img[^>]*alt="([^"]*)"/);
    if (!altMatch) continue; // не карточка фильма — не наш кусок
    const [, type, idStr] = head;
    const kinopoiskId = parseInt(idStr, 10);
    if (!Number.isFinite(kinopoiskId)) continue;
    const titleYear = altMatch[1].match(/^(.*?)\.\s*(\d{4})/);
    const title = (titleYear ? titleYear[1] : altMatch[1]).trim();
    if (!title) continue;
    const year = titleYear ? parseInt(titleYear[2], 10) : null;
    const captionsIdx = part.indexOf("captions");
    const ratingWindow = part.slice(0, captionsIdx !== -1 ? captionsIdx : 600);
    const ratingMatch = ratingWindow.match(/starIcon[^"]*"[^>]*>\s*<\/span>\s*<span[^>]*>(\d+)</);
    items.push({ kinopoiskId, type, title, year, score: ratingMatch ? parseInt(ratingMatch[1], 10) : null });
  }
  return items;
}

/** true, если на странице вообще есть карточки фильмов (даже без рейтинга) —
    отличает «список реально пуст» от «страница есть, а разбор ничего не
    нашёл» (сломанная вёрстка) на уровне вызывающего кода. */
function hasAnyCard(html) {
  return /href="\/(?:film|series)\/\d+\/"[^>]*class="[^"]*posterLink/.test(html);
}

const MAX_PAGES = 60; // ~1200 фильмов при 20/страницу — щедрый предохранитель от бесконечного цикла

/** Тянет весь список постранично, пока страница отдаёт хотя бы одну
    карточку. path(username, page) — RATED_PATH или WATCHLIST_PATH ниже. */
async function fetchAllPages(pathFn, username) {
  const all = [];
  let sawAnyCardEver = false;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchHtml(pathFn(username, page));
    if (hasAnyCard(html)) sawAnyCardEver = true;
    const items = parseListPage(html);
    if (!items.length) break; // пустая страница — дальше делать нечего
    all.push(...items);
    if (items.length < 15) break; // меньше почти полной страницы — это была последняя
  }
  return { items: all, sawAnyCardEver };
}

const RATED_PATH = (username, page) =>
  `/user/${encodeURIComponent(username)}/movies/voted-watched/${page > 1 ? `?page=${page}` : ""}`;
const WATCHLIST_PATH = (username, page) =>
  `/user/${encodeURIComponent(username)}/movies/planned-to-watch/${page > 1 ? `?page=${page}` : ""}`;

/**
 * Главная точка входа: profileUrlOrUsername → {rated, watchlist}.
 * rated — [{kinopoiskId, type, title, year, score}], watchlist — то же самое
 * без score (в «буду смотреть» рейтинга не бывает по определению).
 * Кидает { privateOrEmpty: true }, если ни на одной странице не нашлось ни
 * одной карточки, хотя сам профиль существует — Кинопоиск не даёт
 * технически отличить «профиль закрыт» от «там правда пусто», честно
 * говорим об этом пользователю, а не гадаем.
 */
async function fetchProfileLists(profileUrlOrUsername) {
  const username = parseUsername(profileUrlOrUsername);
  if (!username) {
    const e = new Error("Не похоже на ссылку на профиль Кинопоиска или username");
    e.badInput = true;
    throw e;
  }

  // Профиль существует? (сама страница /user/<username>/ 404-ит на
  // несуществующий username даже без всяких списков)
  await fetchHtml(`/user/${encodeURIComponent(username)}/`);

  const [rated, watchlist] = await Promise.all([
    fetchAllPages(RATED_PATH, username),
    fetchAllPages(WATCHLIST_PATH, username),
  ]);

  if (!rated.sawAnyCardEver && !watchlist.sawAnyCardEver) {
    const e = new Error("Не удалось получить список фильмов — профиль закрыт либо в нём ничего нет");
    e.privateOrEmpty = true;
    throw e;
  }

  return { username, rated: rated.items, watchlist: watchlist.items };
}

module.exports = { parseUsername, fetchProfileLists, parseListPage };
