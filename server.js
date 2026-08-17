#!/usr/bin/env node
/**
 * «Что смотрим» — backend розыгрыша фильма на вечер.
 * Чистый Node.js, без внешних зависимостей и без npm install
 * (SQLite — встроенный модуль node:sqlite, ставить нечего).
 *
 * Аккаунтов здесь нет: вход живёт в общем auth-сервисе (auth.burninghouse.ru),
 * сюда приходит подписанный access-токен, подпись которого проверяется ЛОКАЛЬНО
 * по JWKS. Сетевого запроса в auth на каждый вызов нет, и его недоступность не
 * мешает работать с уже выданными токенами. См. Auth/INTEGRATION.md.
 *
 * Фаза 6 (этот файл сейчас): auth-каркас (фаза 1) + комнаты/участники/
 * приглашения (фаза 2) + фильмы через poiskkino.dev с кэшем в movies и
 * очередью room_movies (фаза 3) + «просмотрено»/личные оценки (movie_marks,
 * глобально по паре пользователь+фильм, без привязки к комнате, фаза 4) +
 * розыгрыш (selection_events, pluggable-алгоритмы в selection.js, фаза 5) +
 * CSV-экспорт/импорт списка комнаты (csv.js, фаза 6). Деплой — следующая
 * фаза.
 *
 * Запуск: node server.js
 *
 * Переменные окружения:
 *   PORT           (по умолчанию 8791)      — порт
 *   HOST           (по умолчанию 127.0.0.1) — интерфейс (за nginx оставляем localhost)
 *   DATA_DIR       (по умолчанию ./data)    — store.db
 *   AUTH_ISSUER    ОБЯЗАТЕЛЬНО — адрес auth-сервиса, напр. https://auth.burninghouse.ru.
 *                  Он же claim iss внутри токенов: сверяется побайтово.
 *   AUTH_CLIENT_ID (по умолчанию movies)    — идентификатор сервиса в auth
 *   AUTH_BASE      (по умолчанию = AUTH_ISSUER) — куда фронт уводит на вход. Отличается
 *                  от ISSUER только если сервер ходит в auth по внутреннему адресу.
 *   AUTH_JWKS_URL  (по умолчанию AUTH_ISSUER + /.well-known/jwks.json)
 *   POISKKINO_API_KEY   — ключ поиска фильмов (api.poiskkino.dev). Без него
 *                  поиск/добавление фильмов отвечают 503 — остальной сервис
 *                  работает как обычно.
 *   POISKKINO_DAILY_CAP (по умолчанию 190) — мягкий потолок обращений в сутки
 *                  (UTC), ниже настоящего лимита провайдера (200/сутки).
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { checkAdminKey, createAdminLog } = require("./admin-internal");
const selection = require("./selection");
const csv = require("./csv");

const PORT = parseInt(process.env.PORT || "8791", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "store.db");
const APP_HTML = path.join(__dirname, "index.html");
const ASSETS_DIR = path.join(__dirname, "assets");

const AUTH_ISSUER = (process.env.AUTH_ISSUER || "").replace(/\/+$/, "");
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "movies";
const AUTH_BASE = (process.env.AUTH_BASE || AUTH_ISSUER).replace(/\/+$/, "");

if (!AUTH_ISSUER) {
  console.error("Не задан AUTH_ISSUER — проверять токены нечем. Пример: AUTH_ISSUER=http://localhost:8788");
  process.exit(1);
}

const auth = require("./auth-client")({
  issuer: AUTH_ISSUER,
  audience: AUTH_CLIENT_ID,
  jwksUrl: process.env.AUTH_JWKS_URL,
});
auth.warmup(); // прогреть кэш ключей, чтобы первый запрос не ждал сеть

// ───────────────────────── хранилище ─────────────────────────
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");   // конкурентные чтения не блокируют запись
db.exec("PRAGMA foreign_keys = ON");    // удаление комнаты уносит участников
db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    join_code   TEXT UNIQUE,
    created_by  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  -- Своей таблицы пользователей нет — ключ user_id из токена (как в Trip).
  CREATE TABLE IF NOT EXISTS room_members (
    room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    user_id   TEXT NOT NULL,
    username  TEXT,
    name      TEXT,
    role      TEXT NOT NULL DEFAULT 'member',   -- owner | member
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (room_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_room_members_user ON room_members(user_id);

  -- Глобальный кэш метаданных poiskkino.dev, ключ — числовой kinopoisk_id
  -- (тот же id идёт и в ссылку на kinopoisk.cx в следующих фазах). Общий на
  -- все комнаты и пользователей: один и тот же фильм в разных комнатах не
  -- бьёт API повторно — см. правило кэша в poiskkino.js и ниже по файлу.
  CREATE TABLE IF NOT EXISTS movies (
    kinopoisk_id      INTEGER PRIMARY KEY,
    imdb_id           TEXT,
    tmdb_id           INTEGER,
    title             TEXT NOT NULL,
    alt_title         TEXT,
    year              INTEGER,
    poster_url        TEXT,
    kp_rating         REAL,
    imdb_rating       REAL,
    duration_min      INTEGER,
    premiere_date     TEXT,
    description       TEXT,
    genres            TEXT NOT NULL DEFAULT '[]',  -- JSON-массив строк — список внутри
    countries         TEXT NOT NULL DEFAULT '[]',  -- атрибута карточки, не отдельная сущность
    director          TEXT,
    actors            TEXT NOT NULL DEFAULT '[]',
    cached_at         INTEGER NOT NULL,   -- когда обновлялись базовые поля (search/detail)
    detail_cached_at  INTEGER             -- когда ходили за persons/premiere; NULL = не ходили
  );

  -- Фильм в очереди конкретной комнаты.
  CREATE TABLE IF NOT EXISTS room_movies (
    id            TEXT PRIMARY KEY,
    room_id       TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    kinopoisk_id  INTEGER NOT NULL REFERENCES movies(kinopoisk_id),
    status        TEXT NOT NULL DEFAULT 'queued',  -- queued | watched
    weight        REAL NOT NULL DEFAULT 1,          -- задел под будущие механики (буст/штраф)
    added_by      TEXT NOT NULL,
    added_at      INTEGER NOT NULL,
    sort_order    REAL NOT NULL DEFAULT 0,
    UNIQUE (room_id, kinopoisk_id)
  );
  CREATE INDEX IF NOT EXISTS idx_room_movies_room  ON room_movies(room_id);
  CREATE INDEX IF NOT EXISTS idx_room_movies_movie ON room_movies(kinopoisk_id);

  -- Счётчик обращений к poiskkino.dev по суткам (UTC) — ведёт сам poiskkino.js,
  -- здесь только создаём таблицу вместе с остальной схемой.
  CREATE TABLE IF NOT EXISTS api_usage (
    day   TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0
  );

  -- Личное отношение (пользователь, фильм) — ГЛОБАЛЬНО, без room_id, как явно
  -- попросили при обсуждении: оценка и факт просмотра — свойство пары
  -- (человек, фильм), а не конкретной комнаты. Удаление комнаты (CASCADE у
  -- room_movies) эту таблицу не затрагивает — факт просмотра и оценка
  -- переживают роспуск комнаты.
  CREATE TABLE IF NOT EXISTS movie_marks (
    user_id       TEXT NOT NULL,
    kinopoisk_id  INTEGER NOT NULL REFERENCES movies(kinopoisk_id),
    watched       INTEGER NOT NULL DEFAULT 0,
    watched_at    INTEGER,
    score         INTEGER,          -- 1..10, привычная шкала кинопоиска/IMDb
    rated_at      INTEGER,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (user_id, kinopoisk_id)
  );
  CREATE INDEX IF NOT EXISTS idx_marks_movie ON movie_marks(kinopoisk_id);

  -- История розыгрышей. method — точка расширения: weighted_random и wheel
  -- используют один и тот же взвешенный выбор, elimination — раундовое
  -- выбывание (см. selection.js); result_kinopoisk_id один и тот же для
  -- любого метода, rounds elimination тут не хранятся (только в HTTP-ответе,
  -- для анимации), battle_royale подключается новым значением method без
  -- изменения схемы.
  CREATE TABLE IF NOT EXISTS selection_events (
    id                  TEXT PRIMARY KEY,
    room_id             TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    method              TEXT NOT NULL,
    candidates          TEXT NOT NULL,       -- JSON [{kinopoiskId, weight}]
    result_kinopoisk_id INTEGER NOT NULL,
    created_by          TEXT NOT NULL,
    created_at          INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_draws_room ON selection_events(room_id);

  -- Личный список «на просмотр» — глобально, без room_id: то же самое
  -- намеренное решение, что и у movie_marks (см. выше) — но это не оценка и
  -- не факт просмотра, а просто закладка «хочу посмотреть», независимая от
  -- какой-либо комнаты.
  CREATE TABLE IF NOT EXISTS personal_list (
    user_id      TEXT NOT NULL,
    kinopoisk_id INTEGER NOT NULL REFERENCES movies(kinopoisk_id),
    added_at     INTEGER NOT NULL,
    PRIMARY KEY (user_id, kinopoisk_id)
  );
  CREATE INDEX IF NOT EXISTS idx_personal_list_movie ON personal_list(kinopoisk_id);

  -- Импорт оценок/списков с IMDb/Кинопоиска (см. importKinopoisk/importImdb
  -- ниже) кладёт сюда те записи, которые не удалось сразу сопоставить с
  -- нашим кэшем movies и для которых не хватило сегодняшней ИМПОРТНОЙ доли
  -- квоты poiskkino.dev (см. IMPORT_DAILY_CAP) — drainImportQueue() достаёт
  -- их порциями по мере появления свободной квоты, в т.ч. на следующие сутки.
  -- У Кинопоиска в очередь ничего не попадает: там весь нужный минимум
  -- (title/year/poster) есть прямо со страницы профиля, сеть не нужна —
  -- source сейчас фактически всегда 'imdb', но поле не захардкожено на
  -- случай, если позже понадобится то же самое для чего-то ещё.
  CREATE TABLE IF NOT EXISTS import_queue (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    source     TEXT NOT NULL,
    imdb_id    TEXT,
    title      TEXT NOT NULL,
    year       INTEGER,
    category   TEXT NOT NULL,   -- watched | watchlist — куда положить после резолва
    score      INTEGER,         -- личная оценка (для category=watched), может быть NULL
    created_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_import_queue_user ON import_queue(user_id);

  -- Локальный справочник «кого мы видели» — username/display_name по
  -- user_id, для публичного профиля (GET /api/users/:username ниже).
  -- Auth НЕ отдаёт другим сервисам общий каталог пользователей (см.
  -- fetchFriends — /api/friends документирован как узкая подсказка, не
  -- контакты), поэтому своего словаря не избежать. Наполняется пассивно,
  -- без отдельных походов в сеть: username/name уже едут в JWT-токене
  -- каждого запроса (см. auth-client.js) — сохраняем их при каждом
  -- авторизованном обращении (см. знак вызова knownUserUpsert.run ниже по
  -- файлу) и при каждом fetchFriends (так попадают в словарь и друзья,
  -- которые сами ещё ни разу к нам не заходили). Тот же приём, что уже
  -- давно используется у room_members.username/name — просто не привязан к
  -- конкретной комнате.
  CREATE TABLE IF NOT EXISTS known_users (
    user_id      TEXT PRIMARY KEY,
    username     TEXT NOT NULL,
    display_name TEXT,
    updated_at   INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_known_users_username ON known_users(username);
`);
// Колонки, появившиеся позже своих таблиц: базы, созданные раньше, о них не
// знают, а CREATE TABLE IF NOT EXISTS их не тронет. История «когда и кем этот
// фильм отметили просмотренным именно в ЭТОЙ комнате» — в отличие от
// movie_marks (глобально, пользователь+фильм), это состояние конкретной
// room_movies-записи, поэтому и живёт прямо в её строке (см. план задачи).
for (const sql of [
  "ALTER TABLE room_movies ADD COLUMN watched_at INTEGER",
  "ALTER TABLE room_movies ADD COLUMN watched_by TEXT",
]) {
  try { db.exec(sql); } catch { /* уже есть */ }
}

// Лог для Admin (см. admin-internal.js) — своя таблица поверх той же базы.
const adminLog = createAdminLog(db);

const POISKKINO_DAILY_CAP = parseInt(process.env.POISKKINO_DAILY_CAP || "190", 10);
const poiskkino = require("./poiskkino")({
  apiKey: process.env.POISKKINO_API_KEY || "",
  dailyCap: POISKKINO_DAILY_CAP,
  db,
});
if (!poiskkino.enabled) {
  console.warn("POISKKINO_API_KEY не задан — поиск и добавление фильмов отвечают 503.");
}

// Импорт (сейчас — только резолв IMDb-записей, у которых нет ни локального
// совпадения, ни совпадения по title+year, см. importImdb/drainImportQueue)
// не должен вытеснять обычные запросы пользователей (поиск/добавление
// фильма) — тот же общий счётчик api_usage, что и у poiskkino.js, просто
// импорт сам останавливается раньше общего потолка (dailyCap выше),
// оставляя разницу свободной под обычное использование сервиса в течение
// дня. Проверяется через poiskkino.usageToday() — своего отдельного
// счётчика заводить не нужно, оба предела читают одно и то же значение.
const IMPORT_DAILY_CAP = parseInt(process.env.IMPORT_DAILY_CAP || "150", 10);
function importQuotaAvailable() {
  return poiskkino.usageToday() < IMPORT_DAILY_CAP;
}

const stmt = {
  // Ссылку на базу держим здесь намеренно. После инициализации `db` больше нигде
  // не упоминается, и V8 вправе выбросить переменную из контекста модуля — тогда
  // финализатор DatabaseSync закроет базу, и все подготовленные запросы начнут
  // падать с «statement has been finalized». Через stmt база остаётся достижимой.
  db,

  roomsOfUser: db.prepare(`
    SELECT r.*, m.role AS my_role,
           (SELECT COUNT(*) FROM room_members x WHERE x.room_id = r.id) AS members
      FROM rooms r JOIN room_members m ON m.room_id = r.id
     WHERE m.user_id = ?
     ORDER BY r.updated_at DESC`),
  room:       db.prepare("SELECT * FROM rooms WHERE id = ?"),
  roomByCode: db.prepare("SELECT * FROM rooms WHERE join_code = ?"),
  insertRoom: db.prepare("INSERT INTO rooms (id,title,join_code,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)"),
  deleteRoom: db.prepare("DELETE FROM rooms WHERE id = ?"),
  setCode:    db.prepare("UPDATE rooms SET join_code = ?, updated_at = ? WHERE id = ?"),

  member:      db.prepare("SELECT * FROM room_members WHERE room_id = ? AND user_id = ?"),
  members:     db.prepare("SELECT user_id, username, name, role, joined_at FROM room_members WHERE room_id = ? ORDER BY joined_at"),
  // role в SET-списке — намеренное отличие от Trip/server.js:235: там ON CONFLICT
  // не обновляет role, и PATCH .../members/:id молча не срабатывает. Здесь роль
  // должна меняться и при апдейте (смена владельца), и оставаться прежней при
  // обычном обновлении username/name из access() — вызывающий код в обоих
  // случаях передаёт актуальное значение role явно.
  addMember:   db.prepare(`INSERT INTO room_members (room_id,user_id,username,name,role,joined_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(room_id,user_id) DO UPDATE SET username = excluded.username, name = excluded.name, role = excluded.role`),
  dropMember:  db.prepare("DELETE FROM room_members WHERE room_id = ? AND user_id = ?"),
  countOwners: db.prepare("SELECT COUNT(*) AS n FROM room_members WHERE room_id = ? AND role = 'owner'"),

  movieByKpId: db.prepare("SELECT * FROM movies WHERE kinopoisk_id = ?"),
  // Для импорта IMDb (см. importImdb) — фильм, уже закэшированный РАНЬШЕ
  // через poiskkino.dev (там imdb_id есть всегда), находится без сети и без
  // расхода импортной квоты. Фильмы, попавшие в кэш из скрейпа Кинопоиска
  // (importKinopoisk), imdb_id не знают вовсе — на них эта проверка не
  // сработает, дальше в ход идёт findMovieByTitleYear ниже.
  movieByImdbId: db.prepare("SELECT * FROM movies WHERE imdb_id = ? LIMIT 1"),
  // Для CSV-импорта по title+year (см. importRoomCsv) — сверяемся с уже
  // закэшированными фильмами ДО похода в сеть. Сравнение без регистра (в
  // файле могут написать не так, как хранится после нормализации
  // poiskkino.dev), матчим и по alt_title (частый случай для переводных
  // названий). year — необязателен (?3/?4 IS NULL пропускает фильтр по
  // году); при нескольких совпадениях берём подробно закэшированный и
  // недавно добавленный, а не случайный.
  findMovieByTitleYear: db.prepare(`
    SELECT * FROM movies
     WHERE (LOWER(title) = LOWER(?) OR LOWER(alt_title) = LOWER(?))
       AND (? IS NULL OR year = ?)
     ORDER BY detail_cached_at IS NULL, cached_at DESC
     LIMIT 1`),
  // Витрина «Из базы» на главной (см. GET /api/movies ниже) — просто самые
  // недавно закэшированные фильмы (или в другом порядке — MOVIES_SORT_ORDER
  // ниже), без какой-либо персонализации. Общий счётчик — для пагинации на
  // фронте (сколько всего страниц), без LIMIT/OFFSET.
  moviesCount: db.prepare("SELECT COUNT(*) AS n FROM movies"),
  // kinopoisk_id — PRIMARY KEY, поэтому кэш обновляется UPSERT'ом: один и тот
  // же фильм, найденный заново через /refresh, просто перезаписывает поля.
  upsertMovie: db.prepare(`
    INSERT INTO movies (kinopoisk_id, imdb_id, tmdb_id, title, alt_title, year, poster_url,
                         kp_rating, imdb_rating, duration_min, premiere_date, description,
                         genres, countries, director, actors, cached_at, detail_cached_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(kinopoisk_id) DO UPDATE SET
      imdb_id = excluded.imdb_id, tmdb_id = excluded.tmdb_id, title = excluded.title,
      alt_title = excluded.alt_title, year = excluded.year, poster_url = excluded.poster_url,
      kp_rating = excluded.kp_rating, imdb_rating = excluded.imdb_rating,
      duration_min = excluded.duration_min, premiere_date = excluded.premiere_date,
      description = excluded.description, genres = excluded.genres, countries = excluded.countries,
      director = excluded.director, actors = excluded.actors,
      cached_at = excluded.cached_at, detail_cached_at = excluded.detail_cached_at`),

  roomMovie:  db.prepare("SELECT * FROM room_movies WHERE room_id = ? AND kinopoisk_id = ?"),
  // rm_-префикс у полей room_movies — чтобы не столкнуться с одноимёнными
  // столбцами movies (в т.ч. kinopoisk_id) при парсинге строки в moviePayload.
  roomMovies: db.prepare(`
    SELECT rm.id AS rm_id, rm.status AS rm_status, rm.weight AS rm_weight,
           rm.added_by AS rm_added_by, rm.added_at AS rm_added_at, rm.sort_order AS rm_sort_order,
           rm.watched_at AS rm_watched_at, rm.watched_by AS rm_watched_by,
           mv.*
      FROM room_movies rm JOIN movies mv ON mv.kinopoisk_id = rm.kinopoisk_id
     WHERE rm.room_id = ?
     ORDER BY rm.sort_order, rm.added_at`),
  insertRoomMovie: db.prepare("INSERT INTO room_movies (id,room_id,kinopoisk_id,status,weight,added_by,added_at,sort_order) VALUES (?,?,?,?,?,?,?,?)"),
  deleteRoomMovie: db.prepare("DELETE FROM room_movies WHERE room_id = ? AND kinopoisk_id = ?"),
  // Разведены на два запроса вместо одного параметризованного по status:
  // «просмотрено в этой комнате» пишет ещё и who/when, «вернуть в очередь» их
  // обнуляет — история отражает ТЕКУЩЕЕ состояние комнаты, а не архив всех
  // прошлых циклов (см. план задачи).
  setRoomMovieWatched: db.prepare("UPDATE room_movies SET status = 'watched', watched_at = ?, watched_by = ? WHERE room_id = ? AND kinopoisk_id = ?"),
  setRoomMovieQueued:  db.prepare("UPDATE room_movies SET status = 'queued', watched_at = NULL, watched_by = NULL WHERE room_id = ? AND kinopoisk_id = ?"),

  markGet: db.prepare("SELECT * FROM movie_marks WHERE user_id = ? AND kinopoisk_id = ?"),
  // «Отметить просмотренным»: если пометки ещё не было — заводим её (watched_at
  // = сейчас); если уже была просмотрена раньше — watched_at НЕ трогаем
  // (COALESCE берёт старое значение), повторная отметка не должна переписывать
  // историю. score/rated_at в UPDATE не участвуют — оценка независима от факта
  // просмотра и живёт своим апсертом (markSetRating) ниже.
  markSetWatched: db.prepare(`
    INSERT INTO movie_marks (user_id, kinopoisk_id, watched, watched_at, updated_at)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(user_id, kinopoisk_id) DO UPDATE SET
      watched = 1,
      watched_at = COALESCE(movie_marks.watched_at, excluded.watched_at),
      updated_at = excluded.updated_at`),
  // «Убрать из просмотренных» (случайно нажали «Отметить просмотренным») —
  // симметрично DELETE .../rating ниже: сбрасывает только watched/watched_at,
  // score/rated_at не трогает (оценка — независимый факт, см. markSetRating).
  // Строку из movie_marks не удаляем, даже если после этого она полностью
  // пустая (watched=0, score=NULL) — то же решение, что и у DELETE .../rating,
  // отдельный случай под «ничего не осталось» не заводим.
  markSetUnwatched: db.prepare(`
    UPDATE movie_marks SET watched = 0, watched_at = NULL, updated_at = ?
     WHERE user_id = ? AND kinopoisk_id = ?`),
  // Личная оценка — свой апсерт, не трогает watched/watched_at. score=NULL —
  // снятие оценки (DELETE .../rating), watched при этом сознательно не трогаем.
  markSetRating: db.prepare(`
    INSERT INTO movie_marks (user_id, kinopoisk_id, score, rated_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, kinopoisk_id) DO UPDATE SET
      score = excluded.score, rated_at = excluded.rated_at, updated_at = excluded.updated_at`),
  // Средняя оценка и число оценивших по фильму — по всем пользователям сервиса,
  // не только участникам конкретной комнаты (оценка ведь глобальная).
  movieAvgScore: db.prepare("SELECT AVG(score) AS avg_score, COUNT(*) AS rating_count FROM movie_marks WHERE kinopoisk_id = ? AND score IS NOT NULL"),
  // Лента «Что мы смотрели»: мои просмотренные фильмы + средняя/количество
  // оценок по каждому фильму отдельным подзапросом (глобально, не по комнате).
  // mm_-префикс — тот же приём, что rm_ у room_movies: не путать с одноимёнными
  // столбцами movies при парсинге строки в moviePayload.
  watchedList: db.prepare(`
    SELECT mm.watched_at AS mm_watched_at, mm.score AS mm_score, mm.rated_at AS mm_rated_at,
           (SELECT AVG(score) FROM movie_marks x WHERE x.kinopoisk_id = mm.kinopoisk_id AND x.score IS NOT NULL) AS avg_score,
           (SELECT COUNT(*) FROM movie_marks x WHERE x.kinopoisk_id = mm.kinopoisk_id AND x.score IS NOT NULL) AS rating_count,
           mv.*
      FROM movie_marks mm JOIN movies mv ON mv.kinopoisk_id = mm.kinopoisk_id
     WHERE mm.user_id = ? AND mm.watched = 1
     ORDER BY mm.watched_at DESC`),

  // Кандидаты розыгрыша — только «в очереди» этой комнаты, с весом (по
  // умолчанию 1 — равновероятно) и достаточным для карточки/колеса на фронте
  // набором полей фильма.
  queuedMovies: db.prepare(`
    SELECT rm.kinopoisk_id AS kinopoisk_id, rm.weight AS weight,
           mv.title AS title, mv.year AS year, mv.poster_url AS poster_url
      FROM room_movies rm JOIN movies mv ON mv.kinopoisk_id = rm.kinopoisk_id
     WHERE rm.room_id = ? AND rm.status = 'queued'`),
  // Кандидаты розыгрыша по личному списку (POST /my-list/draw) — тот же
  // принцип, что у queuedMovies выше, но без веса: у personal_list его
  // просто нет как понятия (весами там пока никто не просил управлять),
  // так что все кандидаты равновероятны — вес 1 подставляет сам JS.
  personalListMovies: db.prepare(`
    SELECT mv.kinopoisk_id AS kinopoisk_id,
           mv.title AS title, mv.year AS year, mv.poster_url AS poster_url
      FROM personal_list pl JOIN movies mv ON mv.kinopoisk_id = pl.kinopoisk_id
     WHERE pl.user_id = ?`),
  insertDraw: db.prepare(`
    INSERT INTO selection_events (id, room_id, method, candidates, result_kinopoisk_id, created_by, created_at)
    VALUES (?,?,?,?,?,?,?)`),
  // История розыгрышей комнаты — джойн с movies только ради title/year/poster
  // результата (кандидаты целиком уже лежат в JSON-колонке candidates).
  draws: db.prepare(`
    SELECT se.*, mv.title AS result_title, mv.year AS result_year, mv.poster_url AS result_poster_url
      FROM selection_events se JOIN movies mv ON mv.kinopoisk_id = se.result_kinopoisk_id
     WHERE se.room_id = ?
     ORDER BY se.created_at DESC
     LIMIT 20`),

  // Личный список на просмотр — глобально, без привязки к комнате (см. таблицу
  // personal_list выше). INSERT идемпотентен: повторное добавление уже
  // лежащего в списке фильма не должно падать ошибкой (план задачи).
  personalListInsert: db.prepare(`
    INSERT INTO personal_list (user_id, kinopoisk_id, added_at) VALUES (?,?,?)
    ON CONFLICT(user_id, kinopoisk_id) DO NOTHING`),
  personalListDelete: db.prepare("DELETE FROM personal_list WHERE user_id = ? AND kinopoisk_id = ?"),
  // pl_-префикс — тот же приём, что rm_/mm_ у room_movies/movie_marks: не
  // путать с одноимёнными столбцами movies при парсинге строки в moviePayload.
  // avg_score/rating_count/my_score — та же тройка подзапросов, что и у
  // moviesShowcasePage, но без лишнего bind-параметра: my_score коррелирует
  // прямо с pl.user_id (эта выборка и так уже per-user), отдельный ? для
  // него не нужен.
  personalList: db.prepare(`
    SELECT pl.added_at AS pl_added_at,
           (SELECT AVG(score) FROM movie_marks x WHERE x.kinopoisk_id = pl.kinopoisk_id AND x.score IS NOT NULL) AS avg_score,
           (SELECT COUNT(*) FROM movie_marks x WHERE x.kinopoisk_id = pl.kinopoisk_id AND x.score IS NOT NULL) AS rating_count,
           (SELECT score FROM movie_marks x WHERE x.user_id = pl.user_id AND x.kinopoisk_id = pl.kinopoisk_id) AS my_score,
           (SELECT watched FROM movie_marks x WHERE x.user_id = pl.user_id AND x.kinopoisk_id = pl.kinopoisk_id) AS my_watched,
           mv.*
      FROM personal_list pl JOIN movies mv ON mv.kinopoisk_id = pl.kinopoisk_id
     WHERE pl.user_id = ?
     ORDER BY pl.added_at DESC`),

  // Справочник known_users (см. таблицу выше) — апсертится при каждом
  // авторизованном запросе (текущий пользователь) и при каждом fetchFriends
  // (его друзья), читается публичным GET /api/users/:username.
  knownUserUpsert: db.prepare(`
    INSERT INTO known_users (user_id, username, display_name, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      username = excluded.username, display_name = excluded.display_name, updated_at = excluded.updated_at`),
  knownUserByUsername: db.prepare("SELECT * FROM known_users WHERE username = ?"),
  // Публичный профиль — «Оценки» (только реально оценённые, не просто
  // watched — то же разграничение, что «Оценки» на Кинопоиске: это витрина
  // ЧУЖИХ оценок для постороннего посетителя, а не полная история просмотров).
  publicRatings: db.prepare(`
    SELECT mm.score AS mm_score, mm.rated_at AS mm_rated_at, mv.*
      FROM movie_marks mm JOIN movies mv ON mv.kinopoisk_id = mm.kinopoisk_id
     WHERE mm.user_id = ? AND mm.score IS NOT NULL
     ORDER BY mm.rated_at DESC`),

  // Очередь импорта (см. import_queue выше и drainImportQueue ниже).
  importQueueInsert: db.prepare(`
    INSERT INTO import_queue (id,user_id,source,imdb_id,title,year,category,score,created_at,attempts)
    VALUES (?,?,?,?,?,?,?,?,?,0)`),
  importQueueBatch: db.prepare("SELECT * FROM import_queue ORDER BY created_at LIMIT ?"),
  importQueueDelete: db.prepare("DELETE FROM import_queue WHERE id = ?"),
  importQueueBumpAttempts: db.prepare("UPDATE import_queue SET attempts = attempts + 1 WHERE id = ?"),
  importQueueCountForUser: db.prepare("SELECT COUNT(*) AS n FROM import_queue WHERE user_id = ?"),
};

// Обновление полей комнаты собирается динамически, как в Trip/server.js:290-295.
function updateRow(table, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sql = `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(", ")} WHERE id = ?`;
  db.prepare(sql).run(...keys.map(k => fields[k]), id);
}

// ───────────────────────── мелкие утилиты ─────────────────────────
const now = () => Date.now();
const uid = () => crypto.randomUUID();

/** Код приглашения: без похожих друг на друга символов — его диктуют голосом. */
function newJoinCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (const b of crypto.randomBytes(8)) code += alphabet[b % alphabet.length];
  return code;
}

const str = (v, max) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};
const oneOf = (v, list) => (list.includes(v) ? v : null);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("too large"), { tooLarge: true })); req.destroy(); }
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
const readJson = async (req, limit = 64 * 1024) => JSON.parse((await readBody(req, limit)).toString("utf8") || "{}");

/** Участие пользователя в комнате. Единственная точка проверки доступа. */
function access(roomId, user) {
  const room = stmt.room.get(roomId);
  if (!room) return null;
  const member = stmt.member.get(roomId, user.id);
  if (!member) return null;
  // Раз пользователь пришёл — заодно освежаем логин и имя: они живут в auth и
  // могли измениться там (имя ещё и включается-выключается пользователем),
  // поэтому сверяем в обе стороны — выключил показ, копия обязана исчезнуть.
  if ((user.username || null) !== member.username || (user.name || null) !== member.name) {
    stmt.addMember.run(roomId, user.id, user.username || null, user.name || null, member.role, member.joined_at);
    member.username = user.username || null;
    member.name = user.name || null;
  }
  return { room, member, isOwner: member.role === "owner" };
}

function roomPayload(room, me, userId) {
  return {
    room: {
      id: room.id, title: room.title, joinCode: room.join_code,
      createdBy: room.created_by, createdAt: room.created_at, updatedAt: room.updated_at,
      myRole: me.role,
    },
    members: stmt.members.all(room.id).map(m => ({
      userId: m.user_id, username: m.username, name: m.name,
      role: m.role, joinedAt: m.joined_at,
    })),
    movies: stmt.roomMovies.all(room.id).map(r => {
      const mark = markSummary(r.kinopoisk_id, userId);
      return {
        id: r.rm_id, status: r.rm_status, weight: r.rm_weight,
        addedBy: r.rm_added_by, addedAt: r.rm_added_at, sortOrder: r.rm_sort_order,
        // watchedAt/watchedBy — история этой КОМНАТЫ (кто и когда тут отметил
        // просмотренным), отдельно от глобальной личной пометки в mark ниже.
        // watchedByUsername/Name фронт сматчит сам по members (см. план).
        watchedAt: r.rm_watched_at, watchedBy: r.rm_watched_by,
        // avgScore/ratingCount/myScore продублированы ВНУТРЬ movie (а не
        // только в mark) — единая карточка (renderMovieTile) читает их прямо
        // с объекта фильма одинаково везде (витрина/очередь/история/
        // просмотрено/мой список), без разбора «а тут они лежат отдельным
        // полем» по каждому экрану отдельно. mark оставлен как есть — им всё
        // ещё пользуется renderHistoryCard (watched-флаг конкретной комнаты
        // тут ни при чём, это ГЛОБАЛЬНАЯ пометка).
        movie: { ...moviePayload(r), avgScore: mark.avgScore, ratingCount: mark.ratingCount, myScore: mark.myScore },
        mark,
      };
    }),
  };
}

// ───────────────────────── фильмы (poiskkino.dev) ─────────────────────────

/**
 * Ответ poiskkino.dev (и /search, и /movie/{id} — одна и та же форма записи,
 * вторая просто добавляет persons/premiere) → наша схема movies. Проверено на
 * живом ответе GET /v1.4/movie/301 (Матрица): у persons есть enProfession —
 * "director" и "actor" — надёжнее сверять по нему, чем по русским названиям
 * профессий ("режиссёры"/"актёры"), которые к тому же не всегда стоят в
 * ожидаемом падеже/числе.
 */
function mapMovie(raw) {
  const persons = Array.isArray(raw.persons) ? raw.persons : [];
  const director = persons
    .filter(p => p.enProfession === "director")
    .map(p => p.name || p.enName)
    .filter(Boolean)
    .join(", ") || null;
  const actors = persons
    .filter(p => p.enProfession === "actor")
    .map(p => p.name || p.enName)
    .filter(Boolean)
    .slice(0, 10);
  const premiereDate = raw.premiere?.russia || raw.premiere?.world || null;

  return {
    kinopoiskId: raw.id,
    imdbId: raw.externalId?.imdb || null,
    tmdbId: Number.isFinite(raw.externalId?.tmdb) ? raw.externalId.tmdb : null,
    title: raw.name || raw.alternativeName || String(raw.id),
    altTitle: raw.alternativeName || null,
    year: Number.isFinite(raw.year) ? raw.year : null,
    posterUrl: raw.poster?.url || raw.poster?.previewUrl || null,
    kpRating: Number.isFinite(raw.rating?.kp) ? raw.rating.kp : null,
    imdbRating: Number.isFinite(raw.rating?.imdb) ? raw.rating.imdb : null,
    durationMin: Number.isFinite(raw.movieLength) ? raw.movieLength : null,
    premiereDate: premiereDate ? String(premiereDate).slice(0, 10) : null,
    description: raw.description || raw.shortDescription || null,
    genres: (raw.genres || []).map(g => g.name).filter(Boolean),
    countries: (raw.countries || []).map(c => c.name).filter(Boolean),
    director,
    actors,
  };
}

/** Пишет карточку в кэш movies (INSERT/UPDATE по kinopoisk_id) и возвращает свежую строку. */
function upsertMovie(mapped) {
  const ts = now();
  stmt.upsertMovie.run(
    mapped.kinopoiskId, mapped.imdbId, mapped.tmdbId, mapped.title, mapped.altTitle, mapped.year,
    mapped.posterUrl, mapped.kpRating, mapped.imdbRating, mapped.durationMin, mapped.premiereDate,
    mapped.description, JSON.stringify(mapped.genres), JSON.stringify(mapped.countries),
    mapped.director, JSON.stringify(mapped.actors), ts, ts
  );
  return stmt.movieByKpId.get(mapped.kinopoiskId);
}

/**
 * Гарантирует, что фильм kpId есть в кэше movies и подробности (persons/
 * premiere) подгружены — сеть трогаем, только если записи ещё нет ИЛИ
 * detail_cached_at пуст (то же правило кэша, что раньше жило прямо в
 * обработчике POST /rooms/:id/movies, и теперь общее для него и личного
 * списка). Ошибку poiskkino.js бросает как есть — здесь нет `res`, чтобы
 * превратить её в HTTP-ответ, это делает вызывающий код через poiskkinoError().
 */
async function ensureMovieCached(kpId) {
  let movie = stmt.movieByKpId.get(kpId);
  if (!movie || !movie.detail_cached_at) {
    const raw = await poiskkino.getById(kpId);
    movie = upsertMovie(mapMovie(raw));
  }
  return movie;
}

/** Строка movies (или movies-часть join'а с room_movies) → JSON для фронта. */
function moviePayload(row) {
  return {
    kinopoiskId: row.kinopoisk_id,
    imdbId: row.imdb_id,
    tmdbId: row.tmdb_id,
    title: row.title,
    altTitle: row.alt_title,
    year: row.year,
    posterUrl: row.poster_url,
    kpRating: row.kp_rating,
    imdbRating: row.imdb_rating,
    durationMin: row.duration_min,
    premiereDate: row.premiere_date,
    description: row.description,
    genres: JSON.parse(row.genres || "[]"),
    countries: JSON.parse(row.countries || "[]"),
    director: row.director,
    actors: JSON.parse(row.actors || "[]"),
    cachedAt: row.cached_at,
    detailCachedAt: row.detail_cached_at,
    // avg_score/rating_count присутствуют только у строк, которые их сами
    // подобрали подзапросом (moviesShowcasePage/watchedList) — moviePayload
    // переиспользуется и для строк без этих полей (напр. movieByKpId),
    // тогда оба поля остаются undefined и просто не попадают в JSON.
    // Округление — та же формула, что у roundScore ниже по файлу (null,
    // если поле есть, но ещё ни одной оценки; не 0 — AVG(NULL) не значит
    // «оценка ноль»).
    avgScore: row.avg_score !== undefined ? (row.avg_score == null ? null : Math.round(row.avg_score * 10) / 10) : undefined,
    ratingCount: row.rating_count,
    // Тот же приём, что у avgScore чуть выше — поле есть, только если сам
    // запрос его подобрал (moviesShowcasePage/personalList ниже), иначе
    // остаётся undefined и не попадает в JSON.
    myScore: row.my_score !== undefined ? row.my_score : undefined,
    // Тот же приём — есть только у строк, где сам запрос подобрал my_watched
    // (moviesShowcasePage/personalList ниже); GET /movies/:id вместо этого
    // просто перезаписывает поле снаружи (см. там), moviePayload там его не
    // видит вовсе. Нужно фронту, чтобы не предлагать «Отметить
    // просмотренным» для уже просмотренного (см. renderAddToMenu в app.js).
    watched: row.my_watched !== undefined ? !!row.my_watched : undefined,
  };
}

// Whitelist сортировок витрины «Из базы» (GET /api/movies) — ORDER BY
// собирается ТОЛЬКО из этой карты по ключу, сырой query-параметр sort в SQL
// никогда не попадает. «x IS NULL, x DESC/ASC» уводит NULL-ы (нет года/пока
// никто не оценил) в конец списка независимо от направления сортировки —
// для title это не нужно (NOT NULL), для year/avg_score — обязательно, иначе
// пустые значения перемешивались бы с осмысленными как попало.
const MOVIES_SORT_ORDER = {
  recent: "cached_at DESC",
  title_asc: "title ASC",
  title_desc: "title DESC",
  year_desc: "year IS NULL, year DESC",
  year_asc: "year IS NULL, year ASC",
  rating_desc: "avg_score IS NULL, avg_score DESC",
  rating_asc: "avg_score IS NULL, avg_score ASC",
};

/**
 * Страница витрины «Из базы» — ORDER BY берётся из MOVIES_SORT_ORDER по
 * ключу (whitelist, не конкатенация сырого query-параметра), LIMIT/OFFSET —
 * обычные bind-параметры. avg_score/rating_count — та же пара
 * коррелированных подзапросов, что и у watchedList (НАША средняя оценка
 * пользователей сервиса, movie_marks, а не kp_rating/imdb_rating с
 * Кинопоиска/IMDb) — добавлены ВСЕГДА, не только когда sort того требует:
 * так moviePayload стабильно отдаёт avgScore/ratingCount независимо от
 * текущей сортировки, а лишний подзапрос на масштабе личного проекта не
 * стоит того, чтобы городить два разных SELECT. db.prepare() вызывается тут
 * же, не на инициализации — вариантов ORDER BY несколько, кэшировать
 * подготовленные запросы на личном проекте такого масштаба не имеет смысла.
 */
// genre — опциональный фильтр витрины по жанру (см. GET /api/genres/GET
// /api/movies?genre=): жанры не отдельная таблица, а JSON-массив в
// movies.genres, поэтому фильтр — EXISTS по json_each, а не обычный JOIN/WHERE.
function moviesShowcasePage(limit, offset, sort, userId, genre) {
  const orderBy = MOVIES_SORT_ORDER[sort] || MOVIES_SORT_ORDER.recent;
  const genreFilter = genre ? "AND EXISTS (SELECT 1 FROM json_each(movies.genres) je WHERE je.value = ?)" : "";
  const params = genre ? [userId, userId, genre, limit, offset] : [userId, userId, limit, offset];
  const rows = db.prepare(`
    SELECT movies.*,
           (SELECT AVG(score) FROM movie_marks x WHERE x.kinopoisk_id = movies.kinopoisk_id AND x.score IS NOT NULL) AS avg_score,
           (SELECT COUNT(*) FROM movie_marks x WHERE x.kinopoisk_id = movies.kinopoisk_id AND x.score IS NOT NULL) AS rating_count,
           (SELECT score FROM movie_marks x WHERE x.user_id = ? AND x.kinopoisk_id = movies.kinopoisk_id) AS my_score,
           (SELECT watched FROM movie_marks x WHERE x.user_id = ? AND x.kinopoisk_id = movies.kinopoisk_id) AS my_watched
      FROM movies
     WHERE 1=1 ${genreFilter}
     ORDER BY ${orderBy}
     LIMIT ? OFFSET ?
  `).all(...params);
  return rows;
}

function moviesCountFiltered(genre) {
  if (!genre) return stmt.moviesCount.get().n;
  return db.prepare(`
    SELECT COUNT(*) AS n FROM movies
     WHERE EXISTS (SELECT 1 FROM json_each(movies.genres) je WHERE je.value = ?)
  `).get(genre).n;
}

// Топ жанров для блоков-подборок на главной (см. GET /api/genres) — считаем
// динамически по факту наполнения кэша, а не заводим отдельную таблицу или
// фиксированный список: пользователь решил, что данные с poiskkino.dev (а
// значит, в конечном счёте с Кинопоиска) достаточно чистые, чтобы не
// городить нормализацию/маппинг синонимов жанров.
function topGenres(limit) {
  return db.prepare(`
    SELECT je.value AS genre, COUNT(*) AS n
      FROM movies, json_each(movies.genres) je
     WHERE je.value IS NOT NULL AND je.value != ''
     GROUP BY je.value
     ORDER BY n DESC, je.value ASC
     LIMIT ?
  `).all(limit);
}

// Меньше отметок — жанровый профиль ещё слишком шумный, чтобы из него
// получались осмысленные рекомендации (см. GET /api/recommendations).
const RECOMMENDATIONS_MIN_MARKS = 10;
// Из скольких лучших кандидатов реально берём случайные RECOMMENDATIONS_SHOW —
// шире, чем показываем, специально: кнопка «обновить» на фронте перетасовывает
// внутри этого же пула, а не пересчитывает профиль заново, поэтому повторное
// нажатие почти всегда показывает другой набор, даже если вкусы не менялись
// ни на йоту с прошлого раза.
const RECOMMENDATIONS_POOL_SIZE = 60;
const RECOMMENDATIONS_SHOW = 24;

// Доп. сигналы поверх жанрового affinity (см. buildRecommendations) — сами
// по себе кандидата в пул не добавляют, только переупорядочивают уже
// прошедших жанровый фильтр (score > 0). Веса подобраны так, чтобы жанровый
// профиль оставался основным сигналом, а не перевешивался парой хороших
// оценок КП/IMDb или одним друг-фанатом жанра, до которого пользователю дела нет.
const RECOMMENDATIONS_FRIEND_SCORE_WEIGHT = 0.6; // множитель на (оценка друга − 5.5)
const RECOMMENDATIONS_FRIEND_WATCHED_BONUS = 1.2; // фикс. бонус, если друг смотрел без оценки
const RECOMMENDATIONS_QUALITY_WEIGHT = 0.5; // множитель на (среднерейтинг − BASELINE)
const RECOMMENDATIONS_QUALITY_BASELINE = 6.5; // типичная оценка "нормального" фильма на 10-балльной шкале
const RECOMMENDATIONS_QUALITY_MIN_MARKS = 3; // меньше — своя avg_score в BH ещё слишком шумная, не берём её в расчёт

function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Рекомендации на главной — жанровый affinity-профиль пользователя,
 * построенный целиком из того, что уже закэшировано (movies), без единого
 * нового запроса к poiskkino.dev: пользователь явно не хочет тратить деньги
 * на сторонние API, а квоту poiskkino.dev на «рекомендации» тем более не
 * разумно жечь, когда это просто перестановка уже известного.
 *
 * Профиль строится из movie_marks: для каждого жанра каждого ОЦЕНЁННОГО
 * фильма прибавляем (score − 5.5) — высокие оценки жанр реально поднимают,
 * низкие реально опускают (не просто «меньше плюса»), середина шкалы почти
 * не влияет. Для ПРОСМОТРЕННЫХ БЕЗ ОЦЕНКИ прибавляем фиксированные +1 за
 * жанр — сам факт просмотра тоже сигнал интереса, просто слабее явной
 * оценки. rated-но-не-watched фильмы тоже участвуют в профиле (рейтинг
 * ставится независимо от отметки «просмотрено», см. PUT .../rating) —
 * профиль строится по ЛЮБОМУ сигналу, watched или score.
 *
 * Кандидаты — все закэшированные фильмы, КРОМЕ уже отмеченных (watched
 * и/или оценённых — то же множество, что построило профиль) и уже лежащих
 * в личном списке: и то, и другое пользователь и так уже знает, рекомендовать
 * нечего. Фильм ПРОХОДИТ отбор только по жанровому affinity (score > 0) —
 * это не «слабая рекомендация», а «мы ничего не знаем о том, что вам
 * понравится в этом фильме», что не одно и то же. Прошедших отбор уже
 * ДОРАНЖИРУЕМ двумя доп. сигналами (см. константы RECOMMENDATIONS_FRIEND_...
 * и RECOMMENDATIONS_QUALITY_... выше): бонус за то, что друзья (Auth "Друзья")
 * посмотрели/оценили фильм, и бонус за общий рейтинг (КП, IMDb и, если
 * накопилось достаточно отметок, наша собственная avg_score) — центрируем
 * относительно BASELINE, чтобы вознаграждались действительно хорошие
 * фильмы, а не любые с рейтингом выше нуля. Оба сигнала — только
 * тай-брейк/переранжирование внутри уже жанрово-релевантного пула, не
 * замена жанровому профилю.
 *
 * Пересборка — ПОЛНАЯ на каждый вызов, отдельного кэша под неё не заводим
 * (масштаб личного проекта этого не требует, см. аналогичное решение у
 * topGenres/moviesShowcasePage).
 */
function buildRecommendations(userId, limit, friends = []) {
  const markedRows = db.prepare(`
    SELECT mm.kinopoisk_id, mm.score, m.genres
      FROM movie_marks mm JOIN movies m ON m.kinopoisk_id = mm.kinopoisk_id
     WHERE mm.user_id = ? AND (mm.watched = 1 OR mm.score IS NOT NULL)
  `).all(userId);

  if (markedRows.length < RECOMMENDATIONS_MIN_MARKS) return { eligible: false, movies: [] };

  const affinity = new Map();
  for (const row of markedRows) {
    const weight = row.score != null ? row.score - 5.5 : 1;
    for (const g of JSON.parse(row.genres || "[]")) affinity.set(g, (affinity.get(g) || 0) + weight);
  }

  const excluded = new Set(markedRows.map(r => r.kinopoisk_id));
  for (const r of db.prepare("SELECT kinopoisk_id FROM personal_list WHERE user_id = ?").all(userId)) {
    excluded.add(r.kinopoisk_id);
  }

  const allMovies = db.prepare(`
    SELECT movies.*,
           (SELECT AVG(score) FROM movie_marks x WHERE x.kinopoisk_id = movies.kinopoisk_id AND x.score IS NOT NULL) AS avg_score,
           (SELECT COUNT(*) FROM movie_marks x WHERE x.kinopoisk_id = movies.kinopoisk_id AND x.score IS NOT NULL) AS rating_count
      FROM movies
  `).all();

  const friendsByMovie = friendsMarksByMovie(friends);

  const scored = [];
  for (const row of allMovies) {
    if (excluded.has(row.kinopoisk_id)) continue;
    let genreScore = 0;
    for (const g of JSON.parse(row.genres || "[]")) genreScore += affinity.get(g) || 0;
    if (genreScore <= 0) continue;

    let score = genreScore;

    const friendMarks = friendsByMovie.get(row.kinopoisk_id);
    if (friendMarks) {
      for (const fm of friendMarks) {
        score += fm.score != null
          ? (fm.score - 5.5) * RECOMMENDATIONS_FRIEND_SCORE_WEIGHT
          : RECOMMENDATIONS_FRIEND_WATCHED_BONUS;
      }
    }

    const quality = qualityRating(row);
    if (quality != null) score += (quality - RECOMMENDATIONS_QUALITY_BASELINE) * RECOMMENDATIONS_QUALITY_WEIGHT;

    scored.push({ row, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.row.kp_rating || b.row.imdb_rating || 0) - (a.row.kp_rating || a.row.imdb_rating || 0));

  const pool = shuffleInPlace(scored.slice(0, RECOMMENDATIONS_POOL_SIZE));
  return { eligible: true, movies: pool.slice(0, limit).map(s => moviePayload(s.row)) };
}

/** Средний "общий" рейтинг фильма (КП, IMDb, своя avg_score из BH — если по
    ней накопилось RECOMMENDATIONS_QUALITY_MIN_MARKS+ отметок) — простое
    среднее того, что есть, без взвешивания источников: расхождение КП/IMDb
    для одного фильма обычно небольшое, городить нормализацию под личный
    проект избыточно. null, если вообще нет ни одной оценки ниоткуда. */
function qualityRating(row) {
  const parts = [];
  if (row.kp_rating != null) parts.push(row.kp_rating);
  if (row.imdb_rating != null) parts.push(row.imdb_rating);
  if (row.avg_score != null && row.rating_count >= RECOMMENDATIONS_QUALITY_MIN_MARKS) parts.push(row.avg_score);
  if (!parts.length) return null;
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

// ───────────────────────── друзья (BurningHouse Auth) ─────────────────────────
const FRIENDS_ACTIVITY_SHOW = 24;

/**
 * Список друзей — проксируем GET /api/friends у Auth ровно тем же
 * Bearer-токеном, которым уже пришёл запрос к нам: этот маршрут у Auth
 * специально открыт для других сервисов без дополнительных прав/ключей (см.
 * Auth/INTEGRATION.md) — сам Auth и решает, чей токен чьи данные видит.
 * Своего кэша не заводим — вызывается редко (карточка фильма, подборка
 * «Друзья»), а устаревший список друзей надёжнее не иметь вообще, чем
 * показать бывшего друга. Любая сетевая/HTTP-ошибка — не 500 у нас, а
 * просто «друзей нет» (пустой массив): фича необязательная, не должна
 * ронять всё остальное на странице, если Auth недоступен.
 */
async function fetchFriends(req) {
  const token = auth.bearer(req);
  if (!token) return [];
  try {
    const res = await fetch(`${AUTH_BASE}/api/friends`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = await res.json();
    const friends = Array.isArray(data.friends) ? data.friends : [];
    // Заодно пополняем known_users (см. таблицу выше) — так друзья, которые
    // сами ещё ни разу к нам не заходили, всё равно становятся доступны по
    // публичной ссылке на профиль, как только их увидел хоть один наш
    // пользователь через «Друзья».
    const ts = now();
    for (const f of friends) {
      if (f.username) stmt.knownUserUpsert.run(f.userId, f.username, f.name || null, ts);
    }
    return friends;
  } catch (e) {
    console.error("Auth /api/friends:", e);
    return [];
  }
}

/** Оценки/просмотры друзей — карточка конкретного фильма (см. GET
    .../friends-marks ниже). friends уже получены (см. вызов) — тут только
    join с movie_marks по их userId, без сети. */
function friendsMarksForMovie(kinopoiskId, friends) {
  if (!friends.length) return [];
  const ids = friends.map(f => f.userId);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT user_id, watched, score FROM movie_marks
     WHERE kinopoisk_id = ? AND user_id IN (${placeholders}) AND (watched = 1 OR score IS NOT NULL)
  `).all(kinopoiskId, ...ids);
  const byUser = new Map(rows.map(r => [r.user_id, r]));
  return friends
    .filter(f => byUser.has(f.userId))
    .map(f => {
      const r = byUser.get(f.userId);
      return { name: f.name || f.username, username: f.username, watched: !!r.watched, score: r.score };
    });
}

/** То же самое, что friendsMarksForMovie, но сразу по ВСЕМ фильмам одним
    запросом (kinopoisk_id → массив отметок друзей) — нужна buildRecommendations,
    чтобы не гонять по запросу на кандидата. Возвращает пустую Map без похода
    в базу, если друзей нет вовсе (частый случай — не у всех пользователей
    сервиса вообще есть друзья в Auth). */
function friendsMarksByMovie(friends) {
  if (!friends.length) return new Map();
  const ids = friends.map(f => f.userId);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT kinopoisk_id, watched, score FROM movie_marks
     WHERE user_id IN (${placeholders}) AND (watched = 1 OR score IS NOT NULL)
  `).all(...ids);
  const byMovie = new Map();
  for (const r of rows) {
    if (!byMovie.has(r.kinopoisk_id)) byMovie.set(r.kinopoisk_id, []);
    byMovie.get(r.kinopoisk_id).push(r);
  }
  return byMovie;
}

/**
 * Подборка «Друзья» на главной — фильмы, которые друзья оценили или
 * посмотрели, а сам пользователь ещё нет (watched/score/личный список —
 * то же исключение, что и у своих собственных рекомендаций, см.
 * buildRecommendations выше). Сортировка — по свежести отметки друга
 * (COALESCE(rated_at, watched_at)), самое недавнее сверху: это лента
 * активности, а не ранжирование по вкусу, шафл тут не нужен. Каждый фильм
 * несёт список friendMarks — кто из друзей и что поставил, показываем на
 * плитке/в модалке на фронте.
 */
function buildFriendsActivity(userId, friends, limit) {
  if (!friends.length) return [];
  const friendById = new Map(friends.map(f => [f.userId, f]));
  const ids = friends.map(f => f.userId);
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT kinopoisk_id, user_id, watched, score, COALESCE(rated_at, watched_at) AS at
      FROM movie_marks
     WHERE user_id IN (${placeholders}) AND (watched = 1 OR score IS NOT NULL)
  `).all(...ids);

  const excluded = new Set(
    db.prepare("SELECT kinopoisk_id FROM movie_marks WHERE user_id = ? AND (watched = 1 OR score IS NOT NULL)").all(userId).map(r => r.kinopoisk_id)
  );
  for (const r of db.prepare("SELECT kinopoisk_id FROM personal_list WHERE user_id = ?").all(userId)) excluded.add(r.kinopoisk_id);

  const byMovie = new Map();
  for (const r of rows) {
    if (excluded.has(r.kinopoisk_id)) continue;
    const friend = friendById.get(r.user_id);
    if (!friend) continue;
    if (!byMovie.has(r.kinopoisk_id)) byMovie.set(r.kinopoisk_id, []);
    byMovie.get(r.kinopoisk_id).push({ name: friend.name || friend.username, watched: !!r.watched, score: r.score, at: r.at || 0 });
  }
  if (!byMovie.size) return [];

  const ranked = [...byMovie.entries()]
    .sort((a, b) => Math.max(...b[1].map(x => x.at)) - Math.max(...a[1].map(x => x.at)))
    .slice(0, limit);

  const ids2 = ranked.map(([kpId]) => kpId);
  const movieRows = db.prepare(`SELECT * FROM movies WHERE kinopoisk_id IN (${ids2.map(() => "?").join(",")})`).all(...ids2);
  const movieById = new Map(movieRows.map(m => [m.kinopoisk_id, m]));

  return ranked
    .filter(([kpId]) => movieById.has(kpId))
    .map(([kpId, marks]) => ({
      ...moviePayload(movieById.get(kpId)),
      friendMarks: marks.map(({ name, watched, score }) => ({ name, watched, score })),
    }));
}

/** Единая обработка ошибок poiskkino.js — квота/не настроено/апстрим в осмысленные HTTP-коды. */
function poiskkinoError(res, e) {
  if (e && e.quota) return json(res, 429, { error: "quota", message: e.message });
  if (e && e.notConfigured) return json(res, 503, { error: "not configured", message: e.message });
  if (e && e.status === 404) return json(res, 404, { error: "not found", message: "Фильм с таким kinopoisk_id не найден в poiskkino.dev." });
  if (e && e.status === 400) return json(res, 400, { error: "bad request", message: "poiskkino.dev не принял запрос — проверьте kinopoisk_id." });
  console.error("poiskkino.dev:", e);
  return json(res, 502, { error: "upstream", message: "poiskkino.dev недоступен, попробуйте позже." });
}

// ───────────────────────── просмотрено / личные оценки ─────────────────────────
const roundScore = v => (v == null ? null : Math.round(v * 10) / 10);

/** Строка movie_marks → JSON для фронта (ответ на watched/rating-эндпоинты). */
function markPayload(row) {
  if (!row) return { watched: false, watchedAt: null, score: null, ratedAt: null };
  return {
    watched: !!row.watched,
    watchedAt: row.watched_at,
    score: row.score,
    ratedAt: row.rated_at,
  };
}

/** Сводка по фильму для карточки в комнате: моя пометка + средняя оценка по всем пользователям сервиса. */
function markSummary(kinopoiskId, userId) {
  const mine = userId ? stmt.markGet.get(userId, kinopoiskId) : null;
  const agg = stmt.movieAvgScore.get(kinopoiskId);
  return {
    watched: !!(mine && mine.watched),
    myScore: mine ? mine.score : null,
    avgScore: roundScore(agg.avg_score),
    ratingCount: agg.rating_count,
  };
}

// ───────────────────────── CSV экспорт/импорт ─────────────────────────
// Формат — ровно 2 колонки: title, year. Явно так попросили упростить:
// раньше требовался ещё и kinopoisk_id, который обычный человек в руках не
// держит. status/rating в экспорт больше не идут (это была персональная
// проекция «моей» комнаты и «моих» оценок, а не то, чем реально делятся
// списком), но importRoomCsv ниже их всё ещё ПОНИМАЕТ как необязательные
// колонки — старые экспорты и файлы, где их дописали руками, не ломаются.
const CSV_COLUMNS = ["title", "year"];

/** Все фильмы комнаты (очередь + история) → CSV-строка вида title,year. */
function exportRoomCsv(roomId) {
  const rows = stmt.roomMovies.all(roomId).map(r => ({
    title: r.title,
    year: r.year != null ? r.year : "",
  }));
  return csv.stringify(CSV_COLUMNS, rows);
}

/**
 * csv.parse() безусловно считает первую строку шапкой и берёт имена колонок
 * как есть (без приведения регистра) — две проблемы для файла, который
 * реально принесёт человек:
 *   1. Файл без шапки (сразу "Матрица,1999" с первой строки) терял бы
 *      первую запись (её "съедало" бы в заголовок) и разваливал ВСЕ
 *      остальные строки на «нет названия» — объект получался бы с ключами
 *      вроде {"Матрица": "1999"}, а не {title, year}.
 *   2. Шапка не в точности "title,year" (например "Title,Year" — так и
 *      Excel, и человек от руки вполне могут написать) — rec.title/rec.year
 *      ниже читаются строго нижним регистром, ключ "Title" их не найдёт, и
 *      снова все строки уйдут в «нет названия».
 * Поэтому парсим сами через csv.parseRows: определяем шапку по первой
 * ячейке первой строки (без регистра — "title" в любом написании), если
 * шапки нет — читаем ВСЕ строки как данные по фиксированному порядку
 * CSV_COLUMNS (лишние колонки без шапки всё равно нечем опознать по
 * позиции — не пытаемся, только title/year), если шапка есть — её имена
 * тоже приводим к нижнему регистру перед тем, как использовать как ключи.
 */
function parseImportRecords(text) {
  const rows = csv.parseRows(text);
  if (!rows.length) return [];

  const hasHeader = String(rows[0][0] || "").trim().toLowerCase() === "title";
  const header = hasHeader ? rows[0].map(h => String(h).trim().toLowerCase()) : CSV_COLUMNS;
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const startLine = hasHeader ? 2 : 1; // __line — номер строки в исходном файле, 1 = первая строка

  const out = [];
  dataRows.forEach((r, i) => {
    if (r.length === 1 && r[0] === "") return; // пустая строка в файле
    const obj = { __line: startLine + i };
    header.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ""; });
    out.push(obj);
  });
  return out;
}

/**
 * Импорт CSV в комнату — по паттерну normList/normTxList из
 * `Финансы/assets/core.js`: чинить что можно, дропать то, что нечем
 * починить, отчитаться отдельной строкой на каждую пропущенную запись.
 *
 * Обязательное поле — только title (год сужает поиск, но необязателен).
 * Фильм ищем в таком порядке:
 *   1. kinopoisk_id, если он всё же есть в файле (старый экспорт/ручная
 *      правка) и такой фильм уже закэширован — самый точный и дешёвый путь,
 *      сеть не трогаем вообще, импортируется сразу.
 *   2. Локальный кэш movies по title+year (без регистра, см.
 *      findMovieByTitleYear) — тоже без сети. Если год указан и нашлось
 *      ТОЧНОЕ совпадение title+year — импортируется сразу.
 *   3. Если точного совпадения по году нет — поиск по title на
 *      poiskkino.dev (по объявленному дневному лимиту, см. checkQuota в
 *      poiskkino.js). Опять же: точное совпадение по year среди
 *      результатов — сразу в импорт.
 *   4. Если год в файле не указан вовсе — берём первое найденное по
 *      названию (локально или первый результат поиска) и импортируем
 *      сразу: сверять точно не с чем, спрашивать не о чем.
 *   5. А вот если год В ФАЙЛЕ БЫЛ, но точного совпадения по нему не
 *      нашлось (ни локально, ни в poiskkino.dev) — фильм по названию при
 *      этом всё равно есть (локально по title без года, либо просто первый
 *      результат поиска) — такую строку НЕ импортируем молча, а кладём в
 *      needsConfirm: попросили явно спрашивать «это тот фильм?», а не
 *      тихо брать первый попавшийся с несовпадающим годом. Подтверждение
 *      — отдельный шаг на фронте (см. importCsvInput.onchange в app.js),
 *      использует уже готовые POST /rooms/:id/movies + watched/rating.
 *
 * Апсерт по UNIQUE(room_id, kinopoisk_id): уже добавленный фильм не
 * дублируется, только обновляется статус; при валидном rating (если такая
 * колонка есть в файле) — апсерт личной оценки (movie_marks) текущего
 * пользователя. Для needsConfirm status/rating из строки прикладываются к
 * элементу отчёта и применяются фронтом уже ПОСЛЕ подтверждения.
 */
async function importRoomCsv(roomId, userId, text) {
  const records = parseImportRecords(text);
  let imported = 0, skipped = 0;
  const errors = [];
  const needsConfirm = [];
  const ts = now();

  for (const rec of records) {
    const line = rec.__line;

    const title = str(rec.title, 300);
    if (!title) {
      skipped++;
      errors.push({ line, reason: "нет названия — нечем связать строку с фильмом" });
      continue;
    }

    const yearRaw = str(rec.year, 10);
    let year = null;
    if (yearRaw !== null) {
      year = parseInt(yearRaw, 10);
      if (!Number.isFinite(year)) {
        skipped++;
        errors.push({ line, reason: `некорректный год «${yearRaw}»` });
        continue;
      }
    }

    let movie = null;      // точное совпадение — импортируем сразу
    let candidate = null;  // совпадение по названию, год не подтверждён — на согласование

    const kpIdRaw = str(rec.kinopoisk_id, 20);
    const kpIdHint = kpIdRaw !== null ? parseInt(kpIdRaw, 10) : NaN;
    if (Number.isFinite(kpIdHint) && kpIdHint > 0) movie = stmt.movieByKpId.get(kpIdHint);

    if (!movie) {
      if (year != null) {
        movie = stmt.findMovieByTitleYear.get(title, title, year, year);
        if (!movie) candidate = stmt.findMovieByTitleYear.get(title, title, null, null);
      } else {
        movie = stmt.findMovieByTitleYear.get(title, title, null, null);
      }
    }

    if (!movie && !candidate) {
      let data;
      try {
        data = await poiskkino.search(title);
      } catch (e) {
        skipped++;
        errors.push({
          line,
          reason: e && e.quota
            ? "дневной лимит обращений к poiskkino.dev исчерпан — остаток файла можно импортировать завтра"
            : `poiskkino.dev недоступен: ${e.message}`,
        });
        continue;
      }
      const found = Array.isArray(data.docs) ? data.docs.map(mapMovie) : [];
      if (!found.length) {
        skipped++;
        errors.push({ line, reason: `фильм «${title}»${year != null ? ` (${year})` : ""} не найден на poiskkino.dev` });
        continue;
      }
      const exact = year != null ? found.find(mv => mv.year === year) : found[0];
      if (exact) {
        try {
          movie = await ensureMovieCached(exact.kinopoiskId);
        } catch (e) {
          skipped++;
          errors.push({ line, reason: `не удалось получить карточку фильма «${title}»: ${e.message}` });
          continue;
        }
      } else {
        const first = found[0];
        candidate = { kinopoisk_id: first.kinopoiskId, title: first.title, year: first.year, poster_url: first.posterUrl };
      }
    }

    const statusRaw = str(rec.status, 20);
    const status = oneOf(statusRaw, ["queued", "watched"]) || "queued";

    let score = null;
    const scoreRaw = str(rec.rating, 10);
    if (scoreRaw !== null) {
      const n = parseInt(scoreRaw, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 10) score = n;
      // иначе — некорректная оценка молча отбрасывается (не дропает всю строку, план: "чинить что можно")
    }

    if (!movie) {
      // Год в файле был, но точного совпадения не нашлось — candidate тут
      // всегда есть (иначе строка уже отсеялась бы выше по errors).
      needsConfirm.push({
        line,
        requestedTitle: title,
        requestedYear: year,
        kinopoiskId: candidate.kinopoisk_id,
        title: candidate.title,
        year: candidate.year,
        posterUrl: candidate.poster_url,
        status,
        rating: score,
      });
      continue;
    }

    const kpId = movie.kinopoisk_id;

    const already = stmt.roomMovie.get(roomId, kpId);
    if (!already) {
      stmt.insertRoomMovie.run(uid(), roomId, kpId, status, 1, userId, ts, 0);
      // watched_at/watched_by у INSERT не заполняются (их нет среди колонок
      // insertRoomMovie) — импортированная «история этой комнаты» иначе
      // осталась бы без даты/автора, ломая тот же экран, что и обычная
      // отметка «просмотрено» (см. renderHistoryCard в assets/app.js).
      if (status === "watched") stmt.setRoomMovieWatched.run(ts, userId, roomId, kpId);
    } else if (status === "watched" && already.status !== "watched") {
      stmt.setRoomMovieWatched.run(ts, userId, roomId, kpId);
    } else if (status === "queued" && already.status !== "queued") {
      stmt.setRoomMovieQueued.run(roomId, kpId);
    }

    if (score !== null) stmt.markSetRating.run(userId, kpId, score, ts, ts);

    imported++;
  }

  return { imported, skipped, errors, needsConfirm };
}

// ───────────────────────── импорт оценок/списков (IMDb, Кинопоиск) ─────────────────────────
// Пишут в ГЛОБАЛЬНЫЕ movie_marks/personal_list (как и обычные watched/rating/
// my-list эндпоинты) — импорт не привязан ни к какой комнате, только к
// пользователю. См. kinopoisk-scraper.js (сбор данных — букмарклет на
// стороне kinopoisk.ru) и IMDB_CSV_COLUMNS ниже (парсинг официального
// CSV-экспорта IMDb).

/** Фильм из скрейпа Кинопоиска (kinopoisk_id уже известен) → гарантирует
    строку в movies БЕЗ похода в poiskkino.dev: title/year/постера со
    страницы профиля достаточно, чтобы карточка нормально работала везде
    (жанры/рейтинги КП-IMDb/описание останутся пустыми, пока кто-нибудь не
    откроет «Обновить» на карточке или фильм не докешируется другим путём).
    Уже закэшированный (в т.ч. полностью, через poiskkino.dev) — не трогаем. */
function ensureMovieFromKinopoiskScrape(item) {
  const existing = stmt.movieByKpId.get(item.kinopoiskId);
  if (existing) return existing;
  const ts = now();
  stmt.upsertMovie.run(
    item.kinopoiskId, null, null, item.title, null, item.year || null,
    item.posterUrl || null, null, null, null, null, null, "[]", "[]", null, "[]", ts, null
  );
  return stmt.movieByKpId.get(item.kinopoiskId);
}

/** IMDb-запись (imdb_id известен, kinopoisk_id — нет) → фильм в movies, в
    таком порядке (без сети, если получится): (1) уже закэширован по этому
    imdb_id (кто-то другой уже привёл его через poiskkino.dev — там imdb_id
    есть всегда); (2) уже закэширован по title+year (в т.ч. только что
    заведённый бесплатно через импорт с Кинопоиска — оттуда imdb_id не
    знаем, только title/year, поэтому шаг 1 его не находит, а этот находит);
    (3) квота на сегодня ещё есть — ищем на poiskkino.dev (тот же паттерн
    search→ensureMovieCached, что и importRoomCsv выше). Возвращает
    {movie} при успехе или {movie:null} — тогда запись уходит в очередь
    (см. enqueueImdbEntry). */
async function resolveImdbEntry(entry) {
  let movie = entry.imdbId ? stmt.movieByImdbId.get(entry.imdbId) : null;
  if (!movie) {
    movie = entry.year != null
      ? stmt.findMovieByTitleYear.get(entry.title, entry.title, entry.year, entry.year)
      : stmt.findMovieByTitleYear.get(entry.title, entry.title, null, null);
  }
  if (movie) return { movie };
  if (!importQuotaAvailable()) return { movie: null };

  let data;
  try {
    data = await poiskkino.search(entry.title);
  } catch {
    return { movie: null }; // сеть/квота подвели именно сейчас — не валим весь импорт, в очередь
  }
  const found = Array.isArray(data.docs) ? data.docs.map(mapMovie) : [];
  const exact = entry.year != null ? found.find(mv => mv.year === entry.year) : found[0];
  if (!exact) return { movie: null };
  try {
    movie = await ensureMovieCached(exact.kinopoiskId);
  } catch {
    return { movie: null };
  }
  return { movie };
}

/** «Просмотрено/оценено» (и с Кинопоиска, и с IMDb) — один и тот же апсерт
    movie_marks, что и у обычной ручной отметки. */
function applyRatedMark(userId, kinopoiskId, score, ts) {
  stmt.markSetWatched.run(userId, kinopoiskId, ts, ts);
  if (score != null) stmt.markSetRating.run(userId, kinopoiskId, score, ts, ts);
}

/** «Буду смотреть» → personal_list, но НЕ безусловно — пользователь явно
    попросил не тащить туда то, что и так уже отмечено просмотренным/
    оценено (в т.ч. только что этим же импортом) и не дублировать то, что в
    списке уже лежит. Возвращает, что реально произошло — для отчёта. */
function applyWatchlistEntry(userId, kinopoiskId, ts) {
  const mark = stmt.markGet.get(userId, kinopoiskId);
  if (mark && (mark.watched || mark.score != null)) return "alreadyWatchedOrRated";
  const already = db.prepare("SELECT 1 FROM personal_list WHERE user_id = ? AND kinopoisk_id = ?").get(userId, kinopoiskId);
  if (already) return "alreadyInList";
  stmt.personalListInsert.run(userId, kinopoiskId, ts);
  return "added";
}

/** Данные сюда приходят от расширения (см. POST /api/import/kinopoisk) —
    границу доверия ПОНИЖЕ, чем у остального содержимого server.js: тело
    запроса технически может прислать кто угодно, у кого есть валидный
    Bearer-токен нашего же сервиса (не обязательно настоящее расширение).
    Портит это в худшем случае только СОБСТВЕННЫЕ данные приславшего —
    movie_marks/personal_list ключуются его же user_id — но валидируем
    форму полей всё равно, чтобы кривой kinopoisk_id/title не улетел в БД
    как есть. */
function sanitizeScrapedItem(item) {
  if (!item || typeof item !== "object") return null;
  const kinopoiskId = parseInt(item.kinopoiskId, 10);
  if (!Number.isInteger(kinopoiskId) || kinopoiskId <= 0) return null;
  const title = str(item.title, 300);
  if (!title) return null;
  const year = Number.isInteger(item.year) && item.year > 1800 && item.year < 2200 ? item.year : null;
  const score = Number.isInteger(item.score) && item.score >= 1 && item.score <= 10 ? item.score : null;
  return { kinopoiskId, title, year, score };
}

/** Импорт «плоских» записей с Кинопоиска — все kinopoisk_id уже известны из
    скрейпа, сеть вообще не нужна (см. ensureMovieFromKinopoiskScrape).
    rated обрабатывается ПЕРЕД watchlist — так applyWatchlistEntry увидит
    уже проставленные этим же импортом оценки и не продублирует их же
    фильмы в личный список (план: «убираем из буду смотреть те, для
    которых уже есть оценка»). */
function importKinopoiskCollected(userId, rated, watchlist) {
  const ts = now();
  let ratedImported = 0;
  for (const raw of rated) {
    const item = sanitizeScrapedItem(raw);
    if (!item) continue;
    const movie = ensureMovieFromKinopoiskScrape(item);
    applyRatedMark(userId, movie.kinopoisk_id, item.score, ts);
    ratedImported++;
  }
  let watchlistAdded = 0, watchlistSkipped = 0;
  for (const raw of watchlist) {
    const item = sanitizeScrapedItem(raw);
    if (!item) continue;
    const movie = ensureMovieFromKinopoiskScrape(item);
    const outcome = applyWatchlistEntry(userId, movie.kinopoisk_id, ts);
    if (outcome === "added") watchlistAdded++; else watchlistSkipped++;
  }
  return { ratedImported, watchlistAdded, watchlistSkipped };
}

/** Официальный CSV-экспорт IMDb — и «Your ratings», и «Your watchlist»
    отдают разные названия колонок в разных версиях экспорта, поэтому имена
    ищем по алиасам без регистра, а не по фиксированной позиции (в отличие
    от csv.js, который сам не знает про конкретные форматы). */
const IMDB_COLUMN_ALIASES = {
  imdbId: ["const", "tconst"],
  title: ["title"],
  year: ["year"],
  score: ["your rating", "rating"],
};
function findImdbColumn(header, aliases) {
  const lower = header.map(h => h.toLowerCase());
  for (const alias of aliases) {
    const idx = lower.indexOf(alias);
    if (idx !== -1) return header[idx];
  }
  return null;
}

/** category — 'watched' (файл «Your ratings») | 'watchlist' (файл «Your
    watchlist», score там не бывает). Реальные новые фильмы (не нашедшиеся
    ни локально по imdb_id/title+year, ни через квоту poiskkino.dev)
    уходят в import_queue — drainImportQueue() ниже их докатит, когда
    появится свободная квота (в т.ч. на следующие сутки). */
async function importImdbCsv(userId, text, category) {
  const rows = csv.parse(text);
  if (!rows.length) return { imported: 0, queued: 0, skipped: 0 };
  const header = Object.keys(rows[0]).filter(k => k !== "__line");
  const col = {
    imdbId: findImdbColumn(header, IMDB_COLUMN_ALIASES.imdbId),
    title: findImdbColumn(header, IMDB_COLUMN_ALIASES.title),
    year: findImdbColumn(header, IMDB_COLUMN_ALIASES.year),
    score: findImdbColumn(header, IMDB_COLUMN_ALIASES.score),
  };
  if (!col.title) {
    const e = new Error("Не похоже на CSV-экспорт IMDb — нет колонки Title.");
    e.badInput = true;
    throw e;
  }

  const ts = now();
  let imported = 0, queued = 0, skipped = 0;
  for (const row of rows) {
    const title = str(col.title ? row[col.title] : null, 300);
    if (!title) { skipped++; continue; }
    const imdbId = col.imdbId ? str(row[col.imdbId], 20) : null;
    const yearRaw = col.year ? str(row[col.year], 10) : null;
    const year = yearRaw != null ? parseInt(yearRaw, 10) : null;
    const scoreRaw = category === "watched" && col.score ? str(row[col.score], 10) : null;
    const score = scoreRaw != null && Number.isFinite(parseInt(scoreRaw, 10)) ? parseInt(scoreRaw, 10) : null;

    const { movie } = await resolveImdbEntry({ imdbId, title, year: Number.isFinite(year) ? year : null });
    if (!movie) {
      stmt.importQueueInsert.run(uid(), userId, "imdb", imdbId, title, Number.isFinite(year) ? year : null, category, score, ts);
      queued++;
      continue;
    }
    if (category === "watched") {
      applyRatedMark(userId, movie.kinopoisk_id, score, ts);
      imported++;
    } else {
      // "added" — реально попал в личный список; alreadyWatchedOrRated/
      // alreadyInList — намеренно НЕ считаем импортом (план: не тащить в
      // «буду смотреть» то, что уже оценено/просмотрено или там и так
      // лежит), но это не ошибка — просто в skipped, не в отдельный счётчик.
      const outcome = applyWatchlistEntry(userId, movie.kinopoisk_id, ts);
      if (outcome === "added") imported++; else skipped++;
    }
  }
  return { imported, queued, skipped };
}

/** Догоняет import_queue порциями по мере появления свободной импортной
    квоты — вызывается периодически (см. setInterval у server.listen ниже),
    а не сразу после исчерпания квоты: смысла торопиться нет, quota
    обновляется раз в сутки по UTC. batchSize — с запасом на то, что часть
    записей всё ещё не срезолвится (плохое совпадение по названию) и не
    потратит квоту вовсе. */
async function drainImportQueue(batchSize = 20) {
  if (!poiskkino.enabled || !importQuotaAvailable()) return;
  const ts = now();
  const batch = stmt.importQueueBatch.all(batchSize);
  for (const row of batch) {
    if (!importQuotaAvailable()) break;
    const { movie } = await resolveImdbEntry({ imdbId: row.imdb_id, title: row.title, year: row.year });
    if (!movie) {
      stmt.importQueueBumpAttempts.run(row.id);
      // Пять попыток на разных днях (когда действительно появлялась
      // квота) — и хватит: скорее всего, это просто не находится на
      // poiskkino.dev под этим названием, а не «квоты не хватило».
      if (row.attempts + 1 >= 5) stmt.importQueueDelete.run(row.id);
      continue;
    }
    if (row.category === "watched") applyRatedMark(row.user_id, movie.kinopoisk_id, row.score, ts);
    else applyWatchlistEntry(row.user_id, movie.kinopoisk_id, ts);
    stmt.importQueueDelete.run(row.id);
  }
}

// ───────────────────────── HTTP ─────────────────────────
function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".ico": "image/x-icon", ".woff2": "font/woff2",
};

/** Отдаём только index.html и assets/. store.db и server.js снаружи недоступны. */
function serveStatic(res, pathname) {
  if (pathname !== "/index.html" && !pathname.startsWith("/assets/")) return false;
  const file = path.join(__dirname, path.normalize(pathname).replace(/^([\\/])+/, ""));
  if (file !== APP_HTML && !file.startsWith(ASSETS_DIR + path.sep)) return false;
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
  return true;
}
function serveApp(res) {
  try {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(APP_HTML));
  } catch {
    res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("index.html не найден рядом с server.js");
  }
}

/**
 * Превью приглашения — единственный /api/* эндпоинт, доступный без токена:
 * посмотреть, куда зовут, нужно ДО решения входить ли вообще (человек мог ещё
 * не иметь аккаунта BurningHouse). Само присоединение (POST) токен требует —
 * им и определяется, кого дописать в участники.
 */
async function invitePreview(req, res, rawCode) {
  const code = String(rawCode).toUpperCase().slice(0, 16);
  const room = stmt.roomByCode.get(code);
  if (!room) return json(res, 404, { error: "no such invite" });
  // Токен необязателен, но если он всё же пришёл (уже вошедший просто
  // перешёл по чужой ссылке) — заодно скажем, не состоит ли он в комнате.
  const user = await auth.userFromRequest(req).catch(() => null);
  return json(res, 200, {
    roomId: room.id,
    title: room.title,
    // Показываем имя, если человек включил его показ, иначе логин. Только
    // отображаемое имя — не user_id и не список ролей (план: не палить лишнее).
    members: stmt.members.all(room.id).map(m => m.name || m.username).filter(Boolean),
    alreadyMember: user ? !!stmt.member.get(room.id, user.id) : false,
  });
}

// Единственное место, где решается, какие GET можно смотреть без токена
// (см. вызов в основном обработчике ниже) — сознательно узкий список: то,
// что уже лежит в нашем кэше и ничего не стоит показать (список/карточка
// фильма, жанры), а не «любой GET». /search сюда намеренно НЕ входит — это
// живой запрос к poiskkino.dev, тратит общую суточную квоту, доступ к нему
// остаётся только по токену.
function isPublicGetRoute(seg) {
  if (seg.length === 2 && seg[1] === "movies") return true;   // список/витрина
  if (seg.length === 3 && seg[1] === "movies") return true;   // карточка одного фильма (#/movie/:id)
  if (seg.length === 2 && seg[1] === "genres") return true;
  if (seg.length === 3 && seg[1] === "users") return true;    // публичный профиль (#/user/:username)
  return false;
}

async function api(req, res, seg, user, query) {
  const m = req.method;

  // ── поиск фильмов (poiskkino.dev) ───────────────────────────
  // Отдельный запрос каждый раз, кэш не трогаем — правило описано в poiskkino.js.
  if (seg.length === 2 && seg[1] === "search") {
    if (m !== "GET") return json(res, 405, { error: "method not allowed" });
    const q = str(query.get("q"), 200);
    if (!q) return json(res, 400, { error: "bad query", message: "Введите название фильма." });
    let data;
    try { data = await poiskkino.search(q); }
    catch (e) { return poiskkinoError(res, e); }
    const docs = Array.isArray(data.docs) ? data.docs : [];
    return json(res, 200, { movies: docs.map(mapMovie).map(mv => ({
      kinopoiskId: mv.kinopoiskId, title: mv.title, altTitle: mv.altTitle, year: mv.year,
      posterUrl: mv.posterUrl, kpRating: mv.kpRating, imdbRating: mv.imdbRating, genres: mv.genres,
    })) });
  }

  // ── витрина «Из базы» на главной: последние закэшированные фильмы ─
  // Обычная авторизация, без привязки к комнате — тот же глобальный кэш
  // movies, что используют поиск/комнаты/личный список.
  if (seg.length === 2 && seg[1] === "movies") {
    if (m !== "GET") return json(res, 405, { error: "method not allowed" });
    let limit = parseInt(query.get("limit"), 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 24;
    limit = Math.min(limit, 60);
    let offset = parseInt(query.get("offset"), 10);
    if (!Number.isFinite(offset) || offset < 0) offset = 0;
    // Неизвестный/отсутствующий sort — молча падаем на recent (не 400):
    // whitelist проверяется внутри moviesShowcasePage через MOVIES_SORT_ORDER.
    const sort = query.get("sort") || "recent";
    const genre = str(query.get("genre"), 100) || null;
    const rows = moviesShowcasePage(limit, offset, sort, user ? user.id : null, genre);
    const total = moviesCountFiltered(genre);
    return json(res, 200, { movies: rows.map(moviePayload), total, limit, offset, genre });
  }

  // ── жанровые подборки на главной: топ жанров с количеством фильмов ─
  // Список сам по себе дешёвый (одна агрегация по всему кэшу), карточки
  // каждой полки фронт подгружает отдельно через уже существующий
  // GET /api/movies?genre=... — здесь только заголовки блоков.
  if (seg.length === 2 && seg[1] === "genres") {
    if (m !== "GET") return json(res, 405, { error: "method not allowed" });
    const rows = topGenres(12);
    return json(res, 200, { genres: rows.map(r => ({ genre: r.genre, count: r.n })) });
  }

  // ── рекомендации на главной — см. buildRecommendations выше ─────
  // eligible:false (недостаточно отметок) — валидный, не ошибочный ответ:
  // фронт по нему прячет вкладку целиком, а не показывает пустой экран.
  if (seg.length === 2 && seg[1] === "recommendations") {
    if (m !== "GET") return json(res, 405, { error: "method not allowed" });
    const friends = await fetchFriends(req);
    return json(res, 200, buildRecommendations(user.id, RECOMMENDATIONS_SHOW, friends));
  }

  // ── подборка «Друзья» на главной — см. buildFriendsActivity выше ─
  // Пустой friends (нет друзей в Auth или сам Auth недоступен) — валидный
  // ответ {movies:[]}, фронт по нему просто прячет вкладку, как и у
  // рекомендаций при eligible:false.
  if (seg.length === 3 && seg[1] === "friends" && seg[2] === "activity") {
    if (m !== "GET") return json(res, 405, { error: "method not allowed" });
    const friends = await fetchFriends(req);
    return json(res, 200, { movies: buildFriendsActivity(user.id, friends, FRIENDS_ACTIVITY_SHOW) });
  }

  // ── оценки/просмотры друзей у конкретного фильма (карточка «Фильм») ─
  if (seg.length === 4 && seg[1] === "movies" && seg[3] === "friends-marks") {
    if (m !== "GET") return json(res, 405, { error: "method not allowed" });
    const kpId = parseInt(seg[2], 10);
    if (!Number.isFinite(kpId) || kpId <= 0) return json(res, 400, { error: "bad kinopoiskId" });
    const friends = await fetchFriends(req);
    return json(res, 200, { friends: friendsMarksForMovie(kpId, friends) });
  }

  // ── публичный профиль пользователя (#/user/:username) ─────────
  // Полностью публичный маршрут (см. isPublicGetRoute) — доступен и анониму:
  // пользователь явно решил не скрывать оценки/список даже от друзей, так
  // что скрывать их от чужих тем более незачем. username резолвим через
  // known_users (свой справочник — Auth общего каталога пользователей не
  // отдаёт, см. комментарий у таблицы), 404 — если ни разу его тут не
  // видели (не заходил сам и не оказался ничьим другом).
  if (seg.length === 3 && seg[1] === "users") {
    if (m !== "GET") return json(res, 405, { error: "method not allowed" });
    const known = stmt.knownUserByUsername.get(seg[2]);
    if (!known) return json(res, 404, { error: "not found", message: "Пользователь не найден." });
    const ratings = stmt.publicRatings.all(known.user_id).map(r => ({
      ...moviePayload(r), score: r.mm_score, ratedAt: r.mm_rated_at,
    }));
    // personalList заодно тянет my_score/my_watched (= оценка/просмотр
    // ВЛАДЕЛЬЦА профиля, тот же подзапрос, что и у обычного personalList для
    // себя самого) — на чужом публичном профиле оба поля удаляем:
    // moviePayload называет их myScore/watched, а тут это не «ваша оценка»/
    // «вы посмотрели» — этих полей на чужом профиле в ответе быть не должно.
    const wishlist = stmt.personalList.all(known.user_id).map(r => {
      const payload = moviePayload(r);
      delete payload.myScore;
      delete payload.watched;
      return { ...payload, addedAt: r.pl_added_at };
    });
    return json(res, 200, {
      username: known.username,
      name: known.display_name,
      ratings, wishlist,
    });
  }

  // ── карточка фильма целиком (используется «Подробнее» у результатов
  // /api/search — те приходят БЕЗ director/actors/description, полная карточка
  // появляется только через poiskkino.getById/movie/{id}) ──────
  // Тот же ensureMovieCached, что и POST /rooms/:id/movies и POST /my-list —
  // отдельного лимита/пути в API не заводим: сеть трогаем, только если записи
  // нет ИЛИ detail_cached_at пуст, иначе просто отдаём уже закэшированное.
  if (seg.length === 3 && seg[1] === "movies") {
    if (m !== "GET") return json(res, 405, { error: "method not allowed" });
    const kpId = parseInt(seg[2], 10);
    if (!Number.isFinite(kpId) || kpId <= 0) return json(res, 400, { error: "bad kinopoiskId" });
    let movie;
    try { movie = await ensureMovieCached(kpId); }
    catch (e) { return poiskkinoError(res, e); }
    // Ответ — moviePayload() как есть, без обёртки {movie: ...}: фронт
    // (openMovieInfoModal) делает Object.assign(mv, data) прямо поверх
    // объекта результата поиска — обёртка потребовала бы data.movie и
    // отдельного разбора на вызывающей стороне без всякой пользы.
    // avgScore/ratingCount/myScore домешаны отдельно (markSummary) — сам
    // ensureMovieCached отдаёт голую строку movies без этих подзапросов, а
    // именно этот эндпоинт — единственное место, где карточка результата
    // поиска (ещё нигде не оценённая с фронта) подтягивает оценку впервые.
    const mark = markSummary(kpId, user ? user.id : null);
    return json(res, 200, { ...moviePayload(movie), avgScore: mark.avgScore, ratingCount: mark.ratingCount, myScore: mark.myScore, watched: mark.watched });
  }

  // ── лента «Что мы смотрели» (мои просмотренные, глобально) ───
  if (seg.length === 2 && seg[1] === "watched") {
    if (m !== "GET") return json(res, 405, { error: "method not allowed" });
    const rows = stmt.watchedList.all(user.id);
    return json(res, 200, { movies: rows.map(r => ({
      movie: moviePayload(r),
      watchedAt: r.mm_watched_at,
      myScore: r.mm_score,
      ratedAt: r.mm_rated_at,
      avgScore: roundScore(r.avg_score),
      ratingCount: r.rating_count,
    })) });
  }

  // ── личная оценка фильма (глобально, без привязки к комнате) ─
  // Требует только существования фильма в кэше movies — не членства в
  // какой-либо комнате, оценка ставится на фильм как таковой.
  if (seg.length === 4 && seg[1] === "movies" && seg[3] === "rating") {
    const kpId = parseInt(seg[2], 10);
    if (!Number.isFinite(kpId)) return json(res, 400, { error: "bad kinopoiskId" });
    if (!stmt.movieByKpId.get(kpId)) return json(res, 404, { error: "not found" });
    if (m === "PUT") {
      const body = await readJson(req);
      const score = parseInt(body.score, 10);
      if (!Number.isFinite(score) || score < 1 || score > 10) {
        return json(res, 400, { error: "bad score", message: "Оценка — целое число от 1 до 10." });
      }
      const ts = now();
      stmt.markSetRating.run(user.id, kpId, score, ts, ts);
      return json(res, 200, { mark: markPayload(stmt.markGet.get(user.id, kpId)) });
    }
    if (m === "DELETE") {
      stmt.markSetRating.run(user.id, kpId, null, null, now());
      return json(res, 200, { mark: markPayload(stmt.markGet.get(user.id, kpId)) });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // ── глобальная отметка «просмотрено» вне комнаты ─────────────
  // Нужна розыгрышу по личному списку (см. POST /my-list/draw ниже) — там
  // нет никакой комнаты, через которую обычно идёт отметка просмотренного
  // (POST /rooms/:id/movies/:kpId/watched). Эффект тот же — movie_marks
  // глобально, плюс убираем фильм из личного списка: он был там как «хочу
  // посмотреть», после этого действия это уже не так.
  // DELETE — отмена (см. markSetUnwatched выше): случайно нажали в меню
  // «Отметить просмотренным», нужно убрать без похода в комнату. Обратно в
  // личный список фильм не возвращаем — это было бы уже не «отмена», а
  // отдельное действие, пользователь явно об этом не просил.
  if (seg.length === 4 && seg[1] === "movies" && seg[3] === "watched") {
    const kpId = parseInt(seg[2], 10);
    if (!Number.isFinite(kpId)) return json(res, 400, { error: "bad kinopoiskId" });
    if (!stmt.movieByKpId.get(kpId)) return json(res, 404, { error: "not found" });
    if (m === "POST") {
      const ts = now();
      stmt.markSetWatched.run(user.id, kpId, ts, ts);
      stmt.personalListDelete.run(user.id, kpId);
      return json(res, 200, { mark: markPayload(stmt.markGet.get(user.id, kpId)) });
    }
    if (m === "DELETE") {
      stmt.markSetUnwatched.run(now(), user.id, kpId);
      return json(res, 200, { mark: markPayload(stmt.markGet.get(user.id, kpId)) });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // ── личный список на просмотр (глобально, без привязки к комнате) ─
  // Не проходит через access(roomId,...) намеренно — список не привязан ни к
  // какой комнате, достаточно просто быть вошедшим пользователем.
  if (seg.length === 2 && seg[1] === "my-list") {
    if (m === "GET") {
      const rows = stmt.personalList.all(user.id);
      return json(res, 200, { movies: rows.map(r => ({
        movie: moviePayload(r),
        addedAt: r.pl_added_at,
      })) });
    }
    if (m === "POST") {
      const body = await readJson(req);
      const kpId = parseInt(body.kinopoiskId, 10);
      if (!Number.isFinite(kpId) || kpId <= 0) return json(res, 400, { error: "bad kinopoiskId" });
      let movie;
      try { movie = await ensureMovieCached(kpId); }
      catch (e) { return poiskkinoError(res, e); }
      stmt.personalListInsert.run(user.id, kpId, now());
      return json(res, 200, { movie: moviePayload(movie) });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // POST /my-list/draw {method} — тот же розыгрыш, что и у комнаты
  // (POST /rooms/:id/draw ниже), но кандидаты — личный список текущего
  // пользователя, а не очередь комнаты. Историю (selection_events) сюда
  // намеренно не пишем — та таблица привязана к room_id (NOT NULL), заводить
  // отдельную схему только ради истории для личного списка, которую никто
  // ещё не просил, — преждевременно.
  if (seg.length === 3 && seg[1] === "my-list" && seg[2] === "draw") {
    if (m !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readJson(req);
    const method = oneOf(body.method, Object.keys(selection.METHODS));
    if (!method) return json(res, 400, { error: "bad method", message: "Неизвестный способ розыгрыша." });

    const rows = stmt.personalListMovies.all(user.id);
    if (!rows.length) {
      return json(res, 409, { error: "empty list", message: "В личном списке нет фильмов — сначала добавьте хотя бы один." });
    }
    const candidates = rows.map(r => ({
      kinopoiskId: r.kinopoisk_id, weight: 1,
      title: r.title, year: r.year, posterUrl: r.poster_url,
    }));
    const outcome = selection.METHODS[method](
      candidates.map(c => ({ kinopoiskId: c.kinopoiskId, weight: c.weight }))
    );
    const isObjectOutcome = outcome && typeof outcome === "object";
    const resultKinopoiskId = isObjectOutcome ? outcome.resultKinopoiskId : outcome;
    const rounds = isObjectOutcome ? outcome.rounds : null;
    return json(res, 200, { candidates, resultKinopoiskId, rounds });
  }

  if (seg.length === 3 && seg[1] === "my-list") {
    if (m !== "DELETE") return json(res, 405, { error: "method not allowed" });
    const kpId = parseInt(seg[2], 10);
    if (!Number.isFinite(kpId)) return json(res, 400, { error: "bad kinopoiskId" });
    stmt.personalListDelete.run(user.id, kpId);
    return json(res, 200, { ok: true });
  }

  // ── импорт оценок/списков с IMDb/Кинопоиска (см. «Мои фильмы») ──
  // POST /api/import/kinopoisk {rated, watchlist} — данные уже собраны и
  // разобраны браузерным расширением (см. KinopoiskImport рядом с этим
  // репозиторием — его background.js ходит на kinopoisk.ru с обычным IP
  // пользователя, поэтому не упирается ни в CORS, ни в антибот-блок по IP,
  // с которым падал прямой запрос с нашего сервера) и присланы обычным
  // POST со страницы «Мои фильмы» — авторизация тут самая обычная
  // (Bearer), никакого отдельного токена не нужно: расширение возвращает
  // результат НАШЕЙ ЖЕ странице (chrome.runtime.sendMessage), а не сайту
  // kinopoisk.ru, так что обычный auth.fetch() уже подставляет токен сам.
  if (seg.length === 3 && seg[1] === "import" && seg[2] === "kinopoisk") {
    if (m !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readJson(req);
    const rated = Array.isArray(body.rated) ? body.rated : [];
    const watchlist = Array.isArray(body.watchlist) ? body.watchlist : [];
    const result = importKinopoiskCollected(user.id, rated, watchlist);
    return json(res, 200, result);
  }

  // Официальный CSV-экспорт IMDb — тело CSV сырым текстом, как и у
  // POST /rooms/:id/import (см. выше), тот же формат передачи с фронта.
  if (seg.length === 4 && seg[1] === "import" && seg[2] === "imdb" && (seg[3] === "ratings" || seg[3] === "watchlist")) {
    if (m !== "POST") return json(res, 405, { error: "method not allowed" });
    const raw = (await readBody(req, 8 * 1024 * 1024)).toString("utf8");
    try {
      const result = await importImdbCsv(user.id, raw, seg[3] === "ratings" ? "watched" : "watchlist");
      return json(res, 200, result);
    } catch (e) {
      if (e.badInput) return json(res, 400, { error: "bad csv", message: e.message });
      throw e;
    }
  }

  // ── список комнат и создание ────────────────────────────────
  if (seg.length === 2 && seg[1] === "rooms") {
    if (m === "GET") {
      const rows = stmt.roomsOfUser.all(user.id);
      return json(res, 200, {
        me: { id: user.id, username: user.username, name: user.name || null },
        rooms: rows.map(r => ({
          id: r.id, title: r.title, myRole: r.my_role, members: r.members,
          createdAt: r.created_at, updatedAt: r.updated_at,
        })),
      });
    }
    if (m === "POST") {
      const body = await readJson(req);
      const id = uid(), ts = now();
      stmt.insertRoom.run(id, str(body.title, 200) || "Новая комната", newJoinCode(), user.id, ts, ts);
      stmt.addMember.run(id, user.id, user.username || null, user.name || null, "owner", ts);
      return json(res, 200, roomPayload(stmt.room.get(id), { role: "owner" }, user.id));
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // ── присоединение по коду (превью — см. invitePreview выше, без токена) ──
  if (seg[1] === "invite" && seg[2]) {
    const code = String(seg[2]).toUpperCase().slice(0, 16);
    const room = stmt.roomByCode.get(code);
    if (!room) return json(res, 404, { error: "no such invite" });
    if (m === "POST") {
      const already = stmt.member.get(room.id, user.id);
      if (!already) stmt.addMember.run(room.id, user.id, user.username || null, user.name || null, "member", now());
      return json(res, 200, { roomId: room.id, joined: !already });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  // ── одна комната ─────────────────────────────────────────────
  if (seg[1] === "rooms" && seg[2]) {
    const roomId = seg[2];
    const ctx = access(roomId, user);
    if (!ctx) return json(res, 404, { error: "not found" });   // 404, а не 403: чужая комната не должна даже подтверждаться
    const tail = seg.slice(3);

    if (!tail.length) {
      if (m === "GET") return json(res, 200, roomPayload(ctx.room, ctx.member, user.id));
      if (m === "PATCH") {
        const body = await readJson(req);
        const f = {};
        if ("title" in body) f.title = str(body.title, 200) || ctx.room.title;
        f.updated_at = now();
        updateRow("rooms", roomId, f);
        return json(res, 200, roomPayload(stmt.room.get(roomId), ctx.member, user.id));
      }
      if (m === "DELETE") {
        // Удалять может только владелец: для остальных есть «выйти из комнаты».
        if (!ctx.isOwner) return json(res, 403, { error: "owner only" });
        stmt.deleteRoom.run(roomId);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // приглашение: перевыпустить или закрыть
    if (tail[0] === "code") {
      if (!ctx.isOwner) return json(res, 403, { error: "owner only" });
      if (m === "POST")   { const code = newJoinCode(); stmt.setCode.run(code, now(), roomId); return json(res, 200, { joinCode: code }); }
      if (m === "DELETE") { stmt.setCode.run(null, now(), roomId); return json(res, 200, { joinCode: null }); }
      return json(res, 405, { error: "method not allowed" });
    }

    if (tail[0] === "leave" && m === "POST") {
      // Последний владелец уйти не может — иначе комнату будет некому ни
      // удалить, ни переименовать, ни передать.
      if (ctx.isOwner && stmt.countOwners.get(roomId).n <= 1) {
        return json(res, 409, { error: "last owner", message: "Вы единственный владелец: передайте комнату или удалите её." });
      }
      stmt.dropMember.run(roomId, user.id);
      return json(res, 200, { ok: true });
    }

    if (tail[0] === "members" && tail[1]) {
      if (!ctx.isOwner) return json(res, 403, { error: "owner only" });
      if (m === "DELETE") {
        if (tail[1] === user.id) return json(res, 409, { error: "self", message: "Себя убрать нельзя — используйте «выйти»." });
        stmt.dropMember.run(roomId, tail[1]);
        return json(res, 200, { ok: true });
      }
      if (m === "PATCH") {
        const body = await readJson(req);
        const role = oneOf(body.role, ["owner", "member"]);
        if (!role) return json(res, 400, { error: "bad role" });
        const target = stmt.member.get(roomId, tail[1]);
        if (!target) return json(res, 404, { error: "no such member" });
        stmt.addMember.run(roomId, target.user_id, target.username, target.name || null, role, target.joined_at);
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: "method not allowed" });
    }

    // ── розыгрыш ─────────────────────────────────────────────────
    // POST /rooms/:id/draw {method} — весь выбор сервер решает сам и
    // однократно пишет в selection_events; фронт только раскладывает
    // присланные candidates и останавливает анимацию на resultKinopoiskId,
    // чтобы анимация и итог никогда не расходились (см. план).
    if (tail[0] === "draw" && tail.length === 1) {
      if (m !== "POST") return json(res, 405, { error: "method not allowed" });
      const body = await readJson(req);
      const method = oneOf(body.method, Object.keys(selection.METHODS));
      if (!method) return json(res, 400, { error: "bad method", message: "Неизвестный способ розыгрыша." });

      const rows = stmt.queuedMovies.all(roomId);
      if (!rows.length) {
        return json(res, 409, { error: "empty queue", message: "В очереди нет фильмов — сначала добавьте хотя бы один." });
      }
      const candidates = rows.map(r => ({
        kinopoiskId: r.kinopoisk_id, weight: r.weight || 1,
        title: r.title, year: r.year, posterUrl: r.poster_url,
      }));
      // weighted_random/wheel возвращают голый kinopoiskId; elimination —
      // {rounds, resultKinopoiskId} (rounds нужны только фронту для анимации
      // выбывания по раундам, в БД не идут — схему selection_events это не
      // меняет, см. selection.js).
      const outcome = selection.METHODS[method](
        candidates.map(c => ({ kinopoiskId: c.kinopoiskId, weight: c.weight }))
      );
      const isObjectOutcome = outcome && typeof outcome === "object";
      const resultKinopoiskId = isObjectOutcome ? outcome.resultKinopoiskId : outcome;
      const rounds = isObjectOutcome ? outcome.rounds : null;
      const eventId = uid();
      stmt.insertDraw.run(
        eventId, roomId, method,
        JSON.stringify(candidates.map(c => ({ kinopoiskId: c.kinopoiskId, weight: c.weight }))),
        resultKinopoiskId, user.id, now()
      );
      return json(res, 200, { eventId, candidates, resultKinopoiskId, rounds });
    }

    // GET /rooms/:id/draws — история последних розыгрышей (недорого, не
    // блокирует MVP, но и не обязательна фронту).
    if (tail[0] === "draws" && tail.length === 1) {
      if (m !== "GET") return json(res, 405, { error: "method not allowed" });
      const rows = stmt.draws.all(roomId);
      return json(res, 200, { draws: rows.map(r => ({
        id: r.id, method: r.method, resultKinopoiskId: r.result_kinopoisk_id,
        resultTitle: r.result_title, resultYear: r.result_year, resultPosterUrl: r.result_poster_url,
        createdBy: r.created_by, createdAt: r.created_at,
      })) });
    }

    // ── CSV экспорт/импорт ──────────────────────────────────────
    // GET .../export.csv — все фильмы комнаты (очередь + история) с личной
    // оценкой текущего пользователя. Скачивание требует Bearer-токена, значит
    // ссылкой <a href> не обойтись — фронт тянет через auth.fetch()+blob (см.
    // assets/app.js), отсюда Content-Disposition: attachment с именем файла.
    if (tail[0] === "export.csv" && tail.length === 1) {
      if (m !== "GET") return json(res, 405, { error: "method not allowed" });
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="room-export.csv"',
        "Cache-Control": "no-store",
      });
      res.end(exportRoomCsv(roomId));
      return;
    }

    // POST .../import — тело CSV сырым текстом (не JSON), см. readBody ниже.
    if (tail[0] === "import" && tail.length === 1) {
      if (m !== "POST") return json(res, 405, { error: "method not allowed" });
      const raw = (await readBody(req, 2 * 1024 * 1024)).toString("utf8");
      return json(res, 200, await importRoomCsv(roomId, user.id, raw));
    }

    // ── фильмы комнаты ─────────────────────────────────────────
    if (tail[0] === "movies") {
      // POST /rooms/:id/movies {kinopoiskId} — добавить в очередь. Кэш movies
      // трогаем сетью только если записи нет ИЛИ detail_cached_at пуст (см.
      // правило кэша в poiskkino.js/плане) — иначе просто читаем из БД.
      if (tail.length === 1) {
        if (m !== "POST") return json(res, 405, { error: "method not allowed" });
        const body = await readJson(req);
        const kpId = parseInt(body.kinopoiskId, 10);
        if (!Number.isFinite(kpId) || kpId <= 0) return json(res, 400, { error: "bad kinopoiskId" });

        let movie;
        try { movie = await ensureMovieCached(kpId); }
        catch (e) { return poiskkinoError(res, e); }

        const already = stmt.roomMovie.get(roomId, kpId);
        if (!already) stmt.insertRoomMovie.run(uid(), roomId, kpId, "queued", 1, user.id, now(), 0);
        return json(res, 200, { movie: moviePayload(movie), alreadyInRoom: !!already });
      }

      // DELETE /rooms/:id/movies/:kinopoiskId — убрать из очереди ЭТОЙ комнаты.
      // Глобальный кэш movies не трогаем: тот же фильм может быть в других
      // комнатах, да и повторное добавление не должно снова бить API.
      if (tail.length === 2) {
        if (m !== "DELETE") return json(res, 405, { error: "method not allowed" });
        const kpId = parseInt(tail[1], 10);
        if (!Number.isFinite(kpId)) return json(res, 400, { error: "bad kinopoiskId" });
        stmt.deleteRoomMovie.run(roomId, kpId);
        return json(res, 200, { ok: true });
      }

      // POST /rooms/:id/movies/:kinopoiskId/refresh — принудительное обновление
      // карточки, не чаще раза в сутки (защита от случайных повторных кликов).
      if (tail.length === 3 && tail[2] === "refresh") {
        if (m !== "POST") return json(res, 405, { error: "method not allowed" });
        const kpId = parseInt(tail[1], 10);
        if (!Number.isFinite(kpId)) return json(res, 400, { error: "bad kinopoiskId" });
        if (!stmt.roomMovie.get(roomId, kpId)) return json(res, 404, { error: "not found" });
        const movie = stmt.movieByKpId.get(kpId);
        if (!movie) return json(res, 404, { error: "not found" });
        const dayMs = 24 * 3600 * 1000;
        if (movie.detail_cached_at && now() - movie.detail_cached_at < dayMs) {
          return json(res, 409, { error: "too fresh", message: "Уже обновлялось меньше суток назад — попробуйте позже." });
        }
        let raw;
        try { raw = await poiskkino.getById(kpId); }
        catch (e) { return poiskkinoError(res, e); }
        const updated = upsertMovie(mapMovie(raw));
        return json(res, 200, { movie: moviePayload(updated) });
      }

      // POST/DELETE /rooms/:id/movies/:kinopoiskId/watched — статус ЭТОЙ комнаты
      // (queued|watched) плюс, только на POST, апсерт личной пометки movie_marks
      // (глобальный факт «я это видел») ВСЕМ ТЕКУЩИМ участникам комнаты —
      // посмотрели вместе, значит для каждого. watched_by у room_movies при этом
      // остаётся именно тем, кто нажал (факт «кто отметил»), а не размножается.
      // DELETE трогает исключительно комнатный статус: то, что кто-то в комнате
      // вернул фильм в очередь, не отменяет личный факт просмотра ни у кого из
      // участников — это два разных факта (см. план, movie_marks).
      if (tail.length === 3 && tail[2] === "watched") {
        const kpId = parseInt(tail[1], 10);
        if (!Number.isFinite(kpId)) return json(res, 400, { error: "bad kinopoiskId" });
        if (!stmt.roomMovie.get(roomId, kpId)) return json(res, 404, { error: "not found" });
        if (m === "POST") {
          stmt.setRoomMovieWatched.run(now(), user.id, roomId, kpId);
          for (const member of stmt.members.all(roomId)) {
            stmt.markSetWatched.run(member.user_id, kpId, now(), now());
          }
          return json(res, 200, { status: "watched", mark: markPayload(stmt.markGet.get(user.id, kpId)) });
        }
        if (m === "DELETE") {
          stmt.setRoomMovieQueued.run(roomId, kpId);
          return json(res, 200, { status: "queued" });
        }
        return json(res, 405, { error: "method not allowed" });
      }

      return json(res, 404, { error: "not found" });
    }

    return json(res, 404, { error: "not found" });
  }

  return json(res, 404, { error: "not found" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  try {
    if (p === "/api/health") return json(res, 200, { ok: true });

    // Сервис личный, а не публичный витрина — поисковикам тут делать нечего.
    // <meta name="robots"> в index.html дублирует запрет для тех краулеров,
    // что игнорируют robots.txt, но уважают meta-тег на самой странице.
    if (p === "/robots.txt") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("User-agent: *\nDisallow: /\n");
    }

    // Для Admin: server-to-server по общему ключу (см. admin-internal.js), не SSO.
    if (p === "/internal/stats" && req.method === "GET") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      const since7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
      return json(res, 200, {
        ok: true,
        rooms: db.prepare("SELECT COUNT(*) AS n FROM rooms").get().n,
        movies: db.prepare("SELECT COUNT(*) AS n FROM movies").get().n,
        selectionEvents: db.prepare("SELECT COUNT(*) AS n FROM selection_events").get().n,
        apiUsage: poiskkino.enabled ? `${poiskkino.usageToday()}/${POISKKINO_DAILY_CAP}` : "выключен",
        roomsCreated7d: db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE created_at > ?").get(since7d).n,
        selectionEvents7d: db.prepare("SELECT COUNT(*) AS n FROM selection_events WHERE created_at > ?").get(since7d).n,
      });
    }
    if (p === "/internal/logs" && req.method === "GET") {
      if (!checkAdminKey(req)) return json(res, 403, { error: "forbidden" });
      const since = url.searchParams.get("since");
      const limit = url.searchParams.get("limit");
      return json(res, 200, {
        logs: adminLog.recent({ since: since ? Number(since) : undefined, limit: limit ? Number(limit) : undefined }),
      });
    }

    // Адрес auth отдаём фронту, чтобы он не был зашит в статику.
    if (p === "/api/config") {
      return json(res, 200, { authBase: AUTH_BASE, clientId: AUTH_CLIENT_ID });
    }

    const seg = p.split("/").filter(Boolean); // ["api", ...]
    if (seg[0] === "api" && seg[1] === "invite" && seg[2] && req.method === "GET") {
      return await invitePreview(req, res, seg[2]);
    }

    if (p.startsWith("/api/")) {
      // Подпись токена проверяется локально, запроса в auth-сервис здесь не
      // происходит. user может оказаться null — сервис теперь не требует
      // входа просто чтобы посмотреть каталог (см. isPublicGetRoute выше):
      // без токена доступны только чтения из уже закэшированного (список
      // фильмов, карточка конкретного фильма — это же и есть то, что
      // открывается по расшариваемой ссылке #/movie/:id, — и список жанров).
      // Поиск (живой запрос к poiskkino.dev, тратит общую квоту) и всё, что
      // пишет или отдаёт личные данные, по-прежнему требует токена — эти
      // маршруты сами уже полагаются на user.id и без него просто упадут,
      // поэтому 401 тут и дальше их не пускает.
      const user = await auth.userFromRequest(req);
      if (!user && !(req.method === "GET" && isPublicGetRoute(seg))) {
        return json(res, 401, { error: "unauthorized" });
      }
      // Пополняем known_users (см. таблицу выше) текущим пользователем — без
      // отдельного похода в сеть, username/name уже есть в декодированном
      // токене. Один лишний UPSERT на авторизованный запрос, зато публичный
      // профиль сразу доступен по ссылке даже тем, у кого пока нет друзей в
      // сервисе (единственный другой источник словаря — fetchFriends).
      if (user && user.username) stmt.knownUserUpsert.run(user.id, user.username, user.name || null, now());
      return await api(req, res, seg, user, url.searchParams);
    }

    if (req.method === "GET") {
      // Некоторые краулеры/тулы запрашивают /favicon.ico напрямую с корня,
      // игнорируя <link rel="icon"> в index.html — отдаём тот же файл, что
      // и из assets/, без отдельного правила в allowlist serveStatic.
      if (p === "/favicon.ico" && serveStatic(res, "/assets/favicon.ico")) return;
      if (p !== "/" && serveStatic(res, p)) return;
      return serveApp(res);   // остальное — SPA с маршрутизацией по хэшу
    }
    res.writeHead(404); res.end();
  } catch (e) {
    if (e && e.tooLarge) return json(res, 413, { error: "too large" });
    console.error("Ошибка обработки запроса:", e);
    adminLog.error("Ошибка обработки запроса", { path: p, method: req.method, message: e.message });
    if (!res.headersSent) json(res, 500, { error: "server error" });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Что смотрим: http://${HOST}:${PORT}  (данные: ${DB_PATH})`);
  console.log(`Авторизация: ${AUTH_BASE} (клиент «${AUTH_CLIENT_ID}»)`);
});

// Догоняем очередь импорта раз в 15 минут, пока процесс жив — квота
// освобождается раз в сутки по UTC, чаще проверять смысла нет, реже —
// свежая квота после полуночи простаивала бы неоправданно долго. Ошибку
// одного прогона (сеть легла и т.п.) не валим процесс — просто попробуем
// на следующем тике.
setInterval(() => { drainImportQueue().catch(e => console.error("drainImportQueue:", e)); }, 15 * 60 * 1000);
