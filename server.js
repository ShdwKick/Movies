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
 *   AUTH_CLIENT_ID (по умолчанию films)     — идентификатор сервиса в auth
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
const selection = require("./selection");
const csv = require("./csv");

const PORT = parseInt(process.env.PORT || "8791", 10);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "store.db");
const APP_HTML = path.join(__dirname, "index.html");
const ASSETS_DIR = path.join(__dirname, "assets");

const AUTH_ISSUER = (process.env.AUTH_ISSUER || "").replace(/\/+$/, "");
const AUTH_CLIENT_ID = process.env.AUTH_CLIENT_ID || "films";
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

  -- История розыгрышей. method — точка расширения: сегодня weighted_random и
  -- wheel используют один и тот же взвешенный выбор (см. selection.js),
  -- позже elimination/battle_royale подключаются новым значением method без
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

const poiskkino = require("./poiskkino")({
  apiKey: process.env.POISKKINO_API_KEY || "",
  dailyCap: parseInt(process.env.POISKKINO_DAILY_CAP || "190", 10),
  db,
});
if (!poiskkino.enabled) {
  console.warn("POISKKINO_API_KEY не задан — поиск и добавление фильмов отвечают 503.");
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
    movies: stmt.roomMovies.all(room.id).map(r => ({
      id: r.rm_id, status: r.rm_status, weight: r.rm_weight,
      addedBy: r.rm_added_by, addedAt: r.rm_added_at, sortOrder: r.rm_sort_order,
      // watchedAt/watchedBy — история этой КОМНАТЫ (кто и когда тут отметил
      // просмотренным), отдельно от глобальной личной пометки в mark ниже.
      // watchedByUsername/Name фронт сматчит сам по members (см. план).
      watchedAt: r.rm_watched_at, watchedBy: r.rm_watched_by,
      movie: moviePayload(r),
      mark: markSummary(r.kinopoisk_id, userId),
    })),
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
  };
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
const CSV_COLUMNS = ["title", "kinopoisk_id", "year", "status", "rating"];

/** Все фильмы комнаты (очередь + история) → CSV-строка. rating — личная
    оценка ТЕКУЩЕГО пользователя (movie_marks), не средняя по всем. */
function exportRoomCsv(roomId, userId) {
  const rows = stmt.roomMovies.all(roomId).map(r => {
    const mark = stmt.markGet.get(userId, r.kinopoisk_id);
    return {
      title: r.title,
      kinopoisk_id: r.kinopoisk_id,
      year: r.year != null ? r.year : "",
      status: r.rm_status,
      rating: mark && mark.score != null ? mark.score : "",
    };
  });
  return csv.stringify(CSV_COLUMNS, rows);
}

/**
 * Импорт CSV в комнату — по паттерну normList/normTxList из
 * `Финансы/assets/core.js`: чинить что можно (обрезать пробелы, привести
 * rating к числу 1..10, status к queued|watched по умолчанию queued),
 * дропать строки без валидного kinopoisk_id или с фильмом, которого нет в
 * локальном кэше movies — сети на импорте принципиально не касаемся (это
 * может быть много строк, а сходить в poiskkino.dev на каждую — отдельный,
 * не заложенный сюда бюджет запросов; план явно требует именно так).
 * Апсерт по UNIQUE(room_id, kinopoisk_id): уже добавленный фильм не
 * дублируется, только обновляется статус; при валидном rating — апсерт
 * личной оценки (movie_marks) текущего пользователя.
 */
function importRoomCsv(roomId, userId, text) {
  const records = csv.parse(text);
  let imported = 0, skipped = 0;
  const errors = [];
  const ts = now();

  for (const rec of records) {
    const line = rec.__line;

    const kpId = parseInt(String(rec.kinopoisk_id ?? "").trim(), 10);
    if (!Number.isFinite(kpId) || kpId <= 0) {
      skipped++;
      errors.push({ line, reason: "нет корректного kinopoisk_id — нечем связать строку с фильмом" });
      continue;
    }
    const movie = stmt.movieByKpId.get(kpId);
    if (!movie) {
      skipped++;
      errors.push({ line, reason: `фильм kinopoisk_id=${kpId} отсутствует в локальном кэше — импорт не ходит в сеть, строка пропущена` });
      continue;
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

  return { imported, skipped, errors };
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
      const resultKinopoiskId = selection.METHODS[method](
        candidates.map(c => ({ kinopoiskId: c.kinopoiskId, weight: c.weight }))
      );
      const eventId = uid();
      stmt.insertDraw.run(
        eventId, roomId, method,
        JSON.stringify(candidates.map(c => ({ kinopoiskId: c.kinopoiskId, weight: c.weight }))),
        resultKinopoiskId, user.id, now()
      );
      return json(res, 200, { eventId, candidates, resultKinopoiskId });
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
      res.end(exportRoomCsv(roomId, user.id));
      return;
    }

    // POST .../import — тело CSV сырым текстом (не JSON), см. readBody ниже.
    if (tail[0] === "import" && tail.length === 1) {
      if (m !== "POST") return json(res, 405, { error: "method not allowed" });
      const raw = (await readBody(req, 2 * 1024 * 1024)).toString("utf8");
      return json(res, 200, importRoomCsv(roomId, user.id, raw));
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

        let movie = stmt.movieByKpId.get(kpId);
        if (!movie || !movie.detail_cached_at) {
          let raw;
          try { raw = await poiskkino.getById(kpId); }
          catch (e) { return poiskkinoError(res, e); }
          movie = upsertMovie(mapMovie(raw));
        }

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
      // (глобальный факт «я это видел»). DELETE трогает исключительно комнатный
      // статус: то, что кто-то в комнате вернул фильм в очередь, не отменяет
      // личный факт просмотра — это два разных факта (см. план, movie_marks).
      if (tail.length === 3 && tail[2] === "watched") {
        const kpId = parseInt(tail[1], 10);
        if (!Number.isFinite(kpId)) return json(res, 400, { error: "bad kinopoiskId" });
        if (!stmt.roomMovie.get(roomId, kpId)) return json(res, 404, { error: "not found" });
        if (m === "POST") {
          stmt.setRoomMovieWatched.run(now(), user.id, roomId, kpId);
          stmt.markSetWatched.run(user.id, kpId, now(), now());
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

    // Адрес auth отдаём фронту, чтобы он не был зашит в статику.
    if (p === "/api/config") {
      return json(res, 200, { authBase: AUTH_BASE, clientId: AUTH_CLIENT_ID });
    }

    const seg = p.split("/").filter(Boolean); // ["api", ...]
    if (seg[0] === "api" && seg[1] === "invite" && seg[2] && req.method === "GET") {
      return await invitePreview(req, res, seg[2]);
    }

    if (p.startsWith("/api/")) {
      // Вся авторизация — вот эти две строки. Подпись проверяется локально,
      // запроса в auth-сервис здесь не происходит.
      const user = await auth.userFromRequest(req);
      if (!user) return json(res, 401, { error: "unauthorized" });
      return await api(req, res, seg, user, url.searchParams);
    }

    if (req.method === "GET") {
      if (p !== "/" && serveStatic(res, p)) return;
      return serveApp(res);   // остальное — SPA с маршрутизацией по хэшу
    }
    res.writeHead(404); res.end();
  } catch (e) {
    if (e && e.tooLarge) return json(res, 413, { error: "too large" });
    console.error("Ошибка обработки запроса:", e);
    if (!res.headersSent) json(res, 500, { error: "server error" });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Что смотрим: http://${HOST}:${PORT}  (данные: ${DB_PATH})`);
  console.log(`Авторизация: ${AUTH_BASE} (клиент «${AUTH_CLIENT_ID}»)`);
});
