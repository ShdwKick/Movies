"use strict";
/**
 * Что смотрим — фронтенд.
 *
 * Одностраничное приложение без сборки. Фаза 6: комнаты, участники,
 * приглашения, поиск/добавление фильмов через poiskkino.dev, «отметить
 * просмотренным»/личные оценки (movie_marks, глобально по паре пользователь+
 * фильм), лента «Что мы смотрели», розыгрыш («Крутить»): сервер решает
 * результат и отдаёт candidates+resultKinopoiskId, фронт только раскладывает
 * анимацию на уже присланном результате (см. selection.js/server.js) — и
 * CSV-экспорт/импорт списка комнаты (csv.js на сервере, кнопки в #/room/:id
 * ниже). Деплой — следующая фаза.
 *
 * Маршрутизация — по хэшу: #/ (список комнат), #/room/<id>, #/room/<id>/draw,
 * #/join/<код>, #/watched (лента просмотренного). Хэш выбран не случайно:
 * redirect_uri в auth сверяется побайтово, а хэш в него не входит — адрес
 * возврата остаётся одним и тем же для любой страницы.
 */

const $ = id => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Единственное место, где собирается ссылка на kinopoisk.cx — сервис видео не
// хранит и не раздаёт, только переиспользует уже известный по /film/<id>/ путь
// kinopoisk.ru (см. план).
const kinopoiskCxUrl = (kinopoiskId) => `https://kinopoisk.cx/film/${kinopoiskId}/`;

let auth = null;
let state = {
  me: null,     // { id, username, name }
  rooms: [],    // список моих комнат
  room: null,   // открытая комната целиком ({ room, members })
};

// Розыгрыш — отдельное маленькое состояние экрана #/room/:id/draw. method —
// какая механика выбрана (не отправлена ещё), candidates/resultKinopoiskId
// заполняются ответом сервера уже ПОСЛЕ нажатия «Крутить».
let drawState = null;

/** Как подписывать человека: имя показывается, только если он сам включил его
    показ в общем кабинете BurningHouse — иначе остаётся логин. */
const who = u => (u && (u.name || u.username)) || "участник";

let snackTimer = null;
function snack(text) {
  const s = $("snack");
  s.textContent = text;
  s.classList.add("show");
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => s.classList.remove("show"), 3200);
}

// ───────────────────────── запросы ─────────────────────────
class ApiError extends Error {
  constructor(status, body) { super(body?.message || body?.error || "ошибка запроса"); this.status = status; this.body = body; }
}

async function api(path, { method = "GET", body } = {}) {
  let res;
  try {
    res = await auth.fetch("/api" + path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    // Единственный случай, когда пользователя надо вернуть на вход: access
    // протух И обновить его не удалось. Своей формы входа у сервиса нет —
    // сразу уводим на общую.
    if (e && e.name === "AuthRequiredError") { auth.clearTokens(); state.me = null; goLogin(); throw e; }
    throw e;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

/** Обёртка для действий: сама показывает причину отказа, не роняя приложение. */
async function act(fn, okText) {
  try {
    const r = await fn();
    if (okText) snack(okText);
    return r;
  } catch (e) {
    if (e instanceof ApiError) snack(e.message);
    else if (e && e.name !== "AuthRequiredError") snack("Не получилось — проверьте связь");
    return null;
  }
}

// ───────────────────────── старт и маршрутизация ─────────────────────────
const ROUTE_KEY = "films.route";   // куда вернуть человека после входа: хэш переживает редирект только так

async function init() {
  const cfg = await (await fetch("/api/config")).json();
  auth = createAuthClient({
    authBase: cfg.authBase,
    clientId: cfg.clientId,
    redirectUri: location.origin + location.pathname,   // ровно то, что зарегистрировано в auth
    storagePrefix: "films",
  });

  // Обязательно ДО первого запроса к своему API: обменивает ?code=… на токены.
  const returned = await auth.handleRedirect();
  if (returned) {
    const saved = sessionStorage.getItem(ROUTE_KEY);
    sessionStorage.removeItem(ROUTE_KEY);
    if (saved && saved !== location.hash) location.hash = saved;
  }

  // Своей страницы входа у сервиса нет: аккаунт общий, форма живёт на
  // auth-домене. Неавторизованного уводим туда молча.
  if (!auth.isAuthenticated()) return goLogin();

  // Кто я — знаем сразу из токена, не дожидаясь списка комнат.
  state.me = auth.getUser() || state.me;

  $("accountMenuWrap").hidden = false;
  $("accountBtn").title = "Аккаунт — " + who(state.me);

  await route();
}

/** Экран «нужен вход» — только на случай сбоя: увести на auth не удалось. */
function showAuthScreen(title, note) {
  showOnly("authView");
  $("accountMenuWrap").hidden = true;
  closeAccountMenu();
  $("authTitle").textContent = title;
  $("authNote").textContent = note;
}

function goLogin() {
  if (!auth) return showAuthScreen("Сервер недоступен", "Не удалось узнать адрес входа. Обновите страницу — возможно, сервис ещё поднимается.");
  // Хэш не входит в redirect_uri (тот сверяется побайтово), поэтому открытая
  // страница переживает вход только так. Особенно важно для ссылки-приглашения.
  sessionStorage.setItem(ROUTE_KEY, location.hash || "#/");
  auth.login();
}
$("loginBtn").onclick = goLogin;

function showOnly(id) {
  for (const v of ["authView", "roomsView", "roomView", "drawView", "joinView", "watchedView"]) $(v).hidden = v !== id;
}

async function route() {
  if (!auth || !auth.isAuthenticated()) return goLogin();
  const hash = location.hash || "#/";
  const join = hash.match(/^#\/join\/([A-Za-z0-9]+)/);
  const draw = hash.match(/^#\/room\/([0-9a-f-]{36})\/draw/i);
  const room = hash.match(/^#\/room\/([0-9a-f-]{36})$/i);

  if (join) return showJoin(join[1].toUpperCase());
  if (draw) return showDraw(draw[1]);
  if (room) return openRoom(room[1]);
  if (hash === "#/watched") return showWatched();
  return showRooms();
}
addEventListener("hashchange", () => { route().catch(console.error); });

// ───────────────────────── список комнат ─────────────────────────
async function showRooms() {
  showOnly("roomsView");
  state.room = null;
  document.title = "Что смотрим — мои комнаты";
  const data = await act(() => api("/rooms"));
  if (!data) return;
  state.me = data.me;
  state.rooms = data.rooms;
  renderRooms();
}

function renderRooms() {
  const box = $("roomList");
  box.textContent = "";
  $("roomsEmpty").hidden = state.rooms.length > 0;
  for (const r of state.rooms) {
    const card = el("button", "card");
    card.innerHTML = `
      <div class="title">${esc(r.title)}</div>
      <div class="sub muted">${r.members} ${plural(r.members, "участник", "участника", "участников")}${r.myRole === "owner" ? " · вы владелец" : ""}</div>`;
    card.onclick = () => { location.hash = "#/room/" + r.id; };
    box.append(card);
  }
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}

$("createRoomBtn").onclick = async () => {
  const input = $("newRoomTitle");
  const title = input.value.trim();
  const data = await act(() => api("/rooms", { method: "POST", body: { title: title || "Новая комната" } }));
  if (!data) return;
  input.value = "";
  location.hash = "#/room/" + data.room.id;
};
$("newRoomTitle").addEventListener("keydown", e => { if (e.key === "Enter") $("createRoomBtn").click(); });

function goToCode(raw) {
  const code = raw.trim().toUpperCase();
  if (!code) return;
  location.hash = "#/join/" + code;
}
$("joinCodeBtn").onclick = () => goToCode($("joinCodeInput").value);
$("joinCodeInput").addEventListener("keydown", e => { if (e.key === "Enter") goToCode(e.target.value); });

// ───────────────────────── одна комната ─────────────────────────
async function openRoom(id) {
  showOnly("roomView");
  // Поиск сбрасываем только при переходе в ДРУГУЮ комнату: после добавления/
  // удаления фильма openRoom() дёргается снова за свежим списком, и терять
  // введённый запрос и уже найденное в этот момент было бы неприятно.
  if (!state.room || state.room.room.id !== id) {
    $("movieSearchInput").value = "";
    $("movieSearchResults").textContent = "";
  }
  const data = await act(() => api("/rooms/" + id));
  if (!data) { location.hash = "#/"; return; }
  state.room = data;
  renderRoom();
}

function renderRoom() {
  const { room, members } = state.room;
  document.title = `${room.title} — Что смотрим`;
  $("roomTitle").textContent = room.title;
  closeRoomMenu();
  $("deleteRoomBtn").classList.toggle("hidden", room.myRole !== "owner");
  $("leaveRoomBtn").disabled = room.myRole === "owner" && members.filter(m => m.role === "owner").length <= 1;

  renderCodeArea(room);

  const list = $("memberList");
  list.textContent = "";
  for (const m of members) {
    const li = el("li");
    const left = el("span", null, who(m) + (m.userId === state.me.id ? " (вы)" : ""));
    const right = el("span", "chip", m.role === "owner" ? "владелец" : "участник");
    li.append(left, right);
    list.append(li);
  }

  renderMovies();
}

// ───────────────────────── фильмы ─────────────────────────
function movieMeta(mv) {
  const parts = [];
  if (mv.genres.length) parts.push(mv.genres.join(", "));
  const ratings = [mv.kpRating ? `КП ${mv.kpRating}` : null, mv.imdbRating ? `IMDb ${mv.imdbRating}` : null].filter(Boolean);
  if (ratings.length) parts.push(ratings.join(" · "));
  return parts.join(" · ");
}

async function runMovieSearch() {
  const q = $("movieSearchInput").value.trim();
  if (!q) return;
  $("movieSearchResults").textContent = "";
  const data = await act(() => api("/search?q=" + encodeURIComponent(q)));
  if (!data) return;
  renderMovieResults(data.movies);
}
$("movieSearchBtn").onclick = runMovieSearch;
$("movieSearchInput").addEventListener("keydown", e => { if (e.key === "Enter") runMovieSearch(); });

function renderMovieResults(movies) {
  const box = $("movieSearchResults");
  box.textContent = "";
  if (!movies.length) { box.append(el("p", "muted", "Ничего не нашлось.")); return; }
  for (const mv of movies) {
    const row = el("div", "movie-row");
    const year = mv.year ? ` (${mv.year})` : "";
    row.innerHTML = `
      ${mv.posterUrl ? `<img class="movie-poster" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
      <div class="movie-info">
        <div class="title">${esc(mv.title)}${esc(year)}</div>
        <div class="muted">${esc(movieMeta(mv))}</div>
      </div>`;
    const addBtn = el("button", null, "Добавить");
    addBtn.onclick = () => act(async () => {
      const roomId = state.room.room.id;
      const r = await api(`/rooms/${roomId}/movies`, { method: "POST", body: { kinopoiskId: mv.kinopoiskId } });
      await openRoom(roomId);
      return r;
    }, "Фильм добавлен");
    row.append(addBtn);
    box.append(row);
  }
}

function renderMovies() {
  const { room, members, movies } = state.room;
  // Очередь и история — разные списки: очередь только queued, история —
  // только watched, самое недавнее сверху (см. план задачи «история
  // просмотров по комнатам»). watchedAt/watchedBy тут — состояние ИМЕННО
  // этой комнаты, а не глобальная личная пометка (та в rm.mark).
  const queued = movies.filter(rm => rm.status === "queued");
  const history = movies.filter(rm => rm.status === "watched")
    .slice().sort((a, b) => (b.watchedAt || 0) - (a.watchedAt || 0));

  $("moviesEmpty").hidden = queued.length > 0;
  const list = $("movieList");
  list.textContent = "";
  for (const rm of queued) list.append(renderMovieCard(rm, room));

  $("movieHistoryEmpty").hidden = history.length > 0;
  const historyList = $("movieHistoryList");
  historyList.textContent = "";
  for (const rm of history) historyList.append(renderHistoryCard(rm, room, members));

  // «Крутить» видна только когда есть из чего реально выбирать — розыгрыш
  // одного фильма ничего не решает, хоть сервер такое и не запрещает.
  $("drawLinkRow").hidden = queued.length < 2;
  $("drawLinkBtn").onclick = () => { location.hash = "#/room/" + room.id + "/draw"; };
}

/** Ряд из 10 звёзд — переиспользуемый компонент оценки, дёргает
    PUT/DELETE /api/movies/:kinopoiskId/rating сам. Наведение красит
    предпросмотр от начала до звезды под курсором, клик ставит оценку,
    повторный клик по уже закрашенной звезде снимает её (DELETE).
    onRated(newScoreOrNull) зовётся ПОСЛЕ успешного сохранения — на нём
    вызывающий код обычно перезагружает комнату (обновить среднюю оценку). */
function renderStarRating(container, kinopoiskId, currentScore, onRated) {
  container.textContent = "";
  container.classList.add("star-rating");
  let score = currentScore || 0;
  const stars = [];
  const paint = upTo => stars.forEach((b, i) => b.classList.toggle("filled", i < upTo));
  for (let i = 1; i <= 10; i++) {
    const btn = el("button", "star-btn", "★");
    btn.type = "button";
    btn.setAttribute("aria-label", `Оценка ${i} из 10`);
    btn.onmouseenter = () => paint(i);
    btn.onfocus = () => paint(i);
    btn.onclick = () => act(async () => {
      const clear = score === i;
      if (clear) await api(`/movies/${kinopoiskId}/rating`, { method: "DELETE" });
      else await api(`/movies/${kinopoiskId}/rating`, { method: "PUT", body: { score: i } });
      score = clear ? 0 : i;
      paint(score);
      if (onRated) onRated(score || null);
    }, score === i ? "Оценка снята" : "Оценка сохранена");
    stars.push(btn);
    container.append(btn);
  }
  container.onmouseleave = () => paint(score);
  paint(score);
}

/** «Подробнее» — раскрывающийся блок с режиссёром/актёрами/описанием, общий
    для карточки очереди и карточки истории. */
function bindMovieDetailToggle(card, mv) {
  card.querySelector('[data-act="more"]').onclick = () => {
    const box = card.querySelector(".movie-detail");
    const willShow = box.classList.contains("hidden");
    box.classList.toggle("hidden");
    if (willShow) {
      const parts = [];
      if (mv.director) parts.push(`<p><b>Режиссёр:</b> ${esc(mv.director)}</p>`);
      if (mv.actors.length) parts.push(`<p><b>В ролях:</b> ${esc(mv.actors.join(", "))}</p>`);
      if (mv.description) parts.push(`<p>${esc(mv.description)}</p>`);
      box.innerHTML = parts.join("") || '<p class="muted">Подробностей нет.</p>';
    }
  };
}

// Карточка очереди — только queued (watched теперь отдельным списком в
// renderHistoryCard ниже, см. renderMovies).
function renderMovieCard(rm, room) {
  const mv = rm.movie;
  const card = el("div", "card");
  card.style.cursor = "default"; // .card рассчитан на кликабельную кнопку целиком — тут кликабельны только вложенные кнопки
  const year = mv.year ? ` (${mv.year})` : "";
  card.innerHTML = `
    <div class="movie-card-head">
      ${mv.posterUrl ? `<img class="movie-poster" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
      <div class="movie-info">
        <div class="title">${esc(mv.title)}${esc(year)}</div>
        <div class="sub muted">${esc(movieMeta(mv))}</div>
      </div>
    </div>
    <div class="movie-detail hidden"></div>
    <div class="row">
      <button class="ghost" data-act="more">Подробнее</button>
      <button data-act="watched">Отметить просмотренным</button>
      <button class="danger" data-act="remove">Убрать из комнаты</button>
    </div>`;

  bindMovieDetailToggle(card, mv);

  card.querySelector('[data-act="watched"]').onclick = () => act(async () => {
    await api(`/rooms/${room.id}/movies/${mv.kinopoiskId}/watched`, { method: "POST" });
    await openRoom(room.id);
  }, "Отмечено просмотренным");

  card.querySelector('[data-act="remove"]').onclick = () => act(async () => {
    await api(`/rooms/${room.id}/movies/${mv.kinopoiskId}`, { method: "DELETE" });
    await openRoom(room.id);
  }, "Фильм убран из комнаты");

  return card;
}

// Карточка истории — watched в ЭТОЙ комнате: кто и когда отметил (watchedBy
// сматчен на фронте по members, т.к. на бэке джойна нет — см. план), плюс
// личная/средняя оценка (уместна тут же, раз фильм уже просмотрен).
function renderHistoryCard(rm, room, members) {
  const mv = rm.movie;
  const card = el("div", "card");
  card.style.cursor = "default";
  const year = mv.year ? ` (${mv.year})` : "";
  const watcher = members.find(m => m.userId === rm.watchedBy);
  const whoText = watcher ? who(watcher) : "кто-то из участников";
  const whenText = rm.watchedAt ? new Date(rm.watchedAt).toLocaleDateString("ru") : "—";
  card.innerHTML = `
    <div class="movie-card-head">
      ${mv.posterUrl ? `<img class="movie-poster" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
      <div class="movie-info">
        <div class="title">${esc(mv.title)}${esc(year)}</div>
        <div class="sub muted">${esc(movieMeta(mv))}</div>
        <div class="muted">Просмотрено ${esc(whenText)} · ${esc(whoText)}</div>
      </div>
    </div>
    <div class="movie-detail hidden"></div>
    <div class="row">
      <button class="ghost" data-act="more">Подробнее</button>
      <button class="ghost" data-act="watched">Вернуть в очередь</button>
    </div>
    <div class="score-row">
      <div data-act="score"></div>
      <span class="muted">${rm.mark.avgScore != null ? `Средняя: ${rm.mark.avgScore}${rm.mark.ratingCount > 1 ? ` (${rm.mark.ratingCount})` : ""}` : "Средней оценки пока нет"}</span>
    </div>`;

  bindMovieDetailToggle(card, mv);

  card.querySelector('[data-act="watched"]').onclick = () => act(async () => {
    await api(`/rooms/${room.id}/movies/${mv.kinopoiskId}/watched`, { method: "DELETE" });
    await openRoom(room.id);
  }, "Возвращено в очередь");

  renderStarRating(card.querySelector('[data-act="score"]'), mv.kinopoiskId, rm.mark.myScore, () => openRoom(room.id));

  return card;
}

// ───────────────────────── CSV экспорт/импорт ─────────────────────────
// Скачивание требует Bearer-токена, поэтому обычная ссылка <a href> не
// подходит — тянем через auth.fetch()+blob() и открываем как временный
// файл через URL.createObjectURL (паттерн для авторизованного скачивания,
// своего готового примера в проекте раньше не было).
$("exportCsvBtn").onclick = () => act(async () => {
  closeCsvMenu();
  const roomId = state.room.room.id;
  const res = await auth.fetch(`/api/rooms/${roomId}/export.csv`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = el("a");
  a.href = url;
  a.download = "room-export.csv";
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}, "CSV экспортирован");

$("importCsvBtn").onclick = () => $("importCsvInput").click();
$("importCsvInput").onchange = async () => {
  const input = $("importCsvInput");
  const file = input.files && input.files[0];
  input.value = ""; // тот же файл можно выбрать повторно
  if (!file) return;
  const text = await file.text();
  const roomId = state.room.room.id;
  const report = await act(async () => {
    const res = await auth.fetch(`/api/rooms/${roomId}/import`, {
      method: "POST",
      headers: { "Content-Type": "text/csv" },
      body: text,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  });
  if (!report) return;
  await openRoom(roomId);
  const parts = [`импортировано: ${report.imported}`, `пропущено: ${report.skipped}`];
  if (report.errors && report.errors.length) parts.push(`ошибок: ${report.errors.length}`);
  snack("CSV: " + parts.join(", "));
};

function renderCodeArea(room) {
  const box = $("codeArea");
  box.textContent = "";
  const isOwner = room.myRole === "owner";

  if (room.joinCode) {
    const wrap = el("div", "code-box");
    const link = `${location.origin}/#/join/${room.joinCode}`;
    const codeEl = el("code", null, room.joinCode);
    codeEl.title = "Нажмите, чтобы скопировать код";
    codeEl.onclick = async () => {
      try { await navigator.clipboard.writeText(room.joinCode); snack("Код скопирован"); }
      catch { snack(room.joinCode); }
    };
    wrap.append(codeEl);
    const copyBtn = el("button", "ghost btn-sm", "Скопировать ссылку");
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(link); snack("Ссылка скопирована"); }
      catch { snack(link); }
    };
    wrap.append(copyBtn);
    box.append(wrap);
    if (isOwner) {
      const row = el("div", "row");
      const reissue = el("button", "ghost", "Перевыпустить код");
      reissue.onclick = () => act(async () => {
        const r = await api(`/rooms/${room.id}/code`, { method: "POST" });
        state.room.room.joinCode = r.joinCode;
        renderCodeArea(state.room.room);
      }, "Новый код готов");
      const revoke = el("button", "danger", "Отключить приглашение");
      revoke.onclick = () => act(async () => {
        await api(`/rooms/${room.id}/code`, { method: "DELETE" });
        state.room.room.joinCode = null;
        renderCodeArea(state.room.room);
      }, "Приглашение отключено");
      row.append(reissue, revoke);
      box.append(row);
    }
  } else {
    box.append(el("p", "muted", "Приглашение отключено."));
    if (isOwner) {
      const enable = el("button", "ghost", "Включить приглашение");
      enable.onclick = () => act(async () => {
        const r = await api(`/rooms/${room.id}/code`, { method: "POST" });
        state.room.room.joinCode = r.joinCode;
        renderCodeArea(state.room.room);
      }, "Приглашение включено");
      box.append(enable);
    }
  }
}

// Действия с комнатой собраны под кнопкой с тремя точками рядом с названием —
// раньше три кнопки висели в ряд под заголовком и спорили за внимание с
// самой комнатой; теперь редкие/опасные действия убраны в выпадающее меню.
function closeRoomMenu() {
  const menu = $("roomMenu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $("roomMenuBtn").setAttribute("aria-expanded", "false");
}
$("roomMenuBtn").onclick = e => {
  e.stopPropagation();
  const menu = $("roomMenu");
  const willShow = menu.hidden;
  menu.hidden = !willShow;
  $("roomMenuBtn").setAttribute("aria-expanded", String(willShow));
};
document.addEventListener("click", e => {
  const menu = $("roomMenu");
  if (!menu || menu.hidden) return;
  if (!menu.contains(e.target) && e.target !== $("roomMenuBtn")) closeRoomMenu();
});

// Меню профиля (шапка) — тот же паттерн, что у меню комнаты выше: клик
// открывает/закрывает, клик снаружи и Escape закрывают. Живёт в appbar, а не
// в конкретной секции, поэтому вешаем рядом, а не внутри renderRoom().
function closeAccountMenu() {
  const menu = $("accountMenu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $("accountBtn").setAttribute("aria-expanded", "false");
}
$("accountBtn").onclick = e => {
  e.stopPropagation();
  closeRoomMenu();
  const menu = $("accountMenu");
  const willShow = menu.hidden;
  if (willShow) {
    $("accountMenuName").textContent = who(state.me);
    $("accountMenuMeta").textContent = (state.me && state.me.email) || "";
  }
  menu.hidden = !willShow;
  $("accountBtn").setAttribute("aria-expanded", String(willShow));
};
document.addEventListener("click", e => {
  const menu = $("accountMenu");
  if (!menu || menu.hidden) return;
  if (!menu.contains(e.target) && e.target !== $("accountBtn")) closeAccountMenu();
});
document.addEventListener("keydown", e => { if (e.key === "Escape") { closeRoomMenu(); closeAccountMenu(); } });

$("accountMenuManage").onclick = () => { closeAccountMenu(); window.open(auth.accountUrl(), "_blank", "noopener"); };
$("accountMenuLogout").onclick = () => { closeAccountMenu(); auth.logout(); };

$("renameRoomBtn").onclick = () => act(async () => {
  closeRoomMenu();
  const title = prompt("Название комнаты", state.room.room.title);
  if (title === null) return;
  const data = await api(`/rooms/${state.room.room.id}`, { method: "PATCH", body: { title } });
  state.room = data;
  renderRoom();
}, "Сохранено");

$("leaveRoomBtn").onclick = async () => {
  closeRoomMenu();
  if (!confirm("Выйти из комнаты?")) return;
  const r = await act(() => api(`/rooms/${state.room.room.id}/leave`, { method: "POST" }), "Вы вышли из комнаты");
  if (r) location.hash = "#/";
};

$("deleteRoomBtn").onclick = async () => {
  closeRoomMenu();
  if (!confirm("Удалить комнату целиком? Отменить нельзя.")) return;
  const r = await act(() => api(`/rooms/${state.room.room.id}`, { method: "DELETE" }), "Комната удалена");
  if (r) location.hash = "#/";
};

// ───────────────────────── розыгрыш (#/room/:id/draw) ─────────────────────────
// Сервер решает результат ОДНИМ вызовом POST /draw и присылает и candidates,
// и resultKinopoiskId вместе — вся анимация здесь клиентская, но раскладывает
// уже готовый ответ и обязана остановиться ровно на нём: сам выбор фронт
// никогда не делает (см. план).
async function showDraw(roomId) {
  showOnly("drawView");
  // Комнату можно открыть по прямой ссылке на розыгрыш, минуя #/room/:id —
  // тогда данных о ней ещё нет.
  if (!state.room || state.room.room.id !== roomId) {
    const data = await act(() => api("/rooms/" + roomId));
    if (!data) { location.hash = "#/"; return; }
    state.room = data;
  }
  document.title = `Розыгрыш — ${state.room.room.title}`;
  $("drawBack").href = "#/room/" + roomId;
  $("drawTitle").textContent = `Розыгрыш: ${state.room.room.title}`;
  drawState = { roomId, method: "weighted_random" };
  renderDrawSetup();
}

function renderDrawSetup() {
  $("drawSetup").classList.remove("hidden");
  const stage = $("drawStage");
  stage.classList.add("hidden");
  stage.innerHTML = "";
  const result = $("drawResult");
  result.classList.add("hidden");
  result.innerHTML = "";
  updateMethodButtons();
  const btn = $("drawStartBtn");
  btn.disabled = false;
  btn.textContent = "Крутить";
}

function updateMethodButtons() {
  $("methodWeightedBtn").classList.toggle("active", drawState.method === "weighted_random");
  $("methodWheelBtn").classList.toggle("active", drawState.method === "wheel");
}
$("methodWeightedBtn").onclick = () => { if (!drawState) return; drawState.method = "weighted_random"; updateMethodButtons(); };
$("methodWheelBtn").onclick = () => { if (!drawState) return; drawState.method = "wheel"; updateMethodButtons(); };

$("drawStartBtn").onclick = async () => {
  if (!drawState) return;
  const btn = $("drawStartBtn");
  btn.disabled = true;
  btn.textContent = "Крутим…";
  const data = await act(() => api(`/rooms/${drawState.roomId}/draw`, { method: "POST", body: { method: drawState.method } }));
  if (!data) { btn.disabled = false; btn.textContent = "Крутить"; return; }

  $("drawSetup").classList.add("hidden");
  const stage = $("drawStage");
  stage.classList.remove("hidden");
  stage.innerHTML = "";

  if (drawState.method === "wheel") await animateWheel(stage, data.candidates, data.resultKinopoiskId);
  else await animateWeightedRandom(stage, data.candidates, data.resultKinopoiskId);

  showDrawResult(data.candidates, data.resultKinopoiskId);
};

const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Перелистывание карточек-кандидатов, замедляющееся к финалу, останавливается
    ровно на resultId (индекс вычислен так, чтобы последний кадр = результат). */
function animateWeightedRandom(container, candidates, resultId) {
  return new Promise(resolve => {
    const track = el("div", "draw-reel");
    container.append(track);
    const n = candidates.length;
    const resultIndex = Math.max(0, candidates.findIndex(c => c.kinopoiskId === resultId));

    function showCard(idx) {
      const c = candidates[idx];
      const year = c.year ? ` (${c.year})` : "";
      track.innerHTML = c.posterUrl
        ? `<img class="movie-poster" src="${esc(c.posterUrl)}" alt="">`
        : '<div class="movie-poster"></div>';
      track.append(el("div", "title", `${c.title || ""}${year}`));
    }

    if (n <= 1 || prefersReducedMotion()) { showCard(resultIndex); return resolve(); }

    const steps = Math.max(16, n * 3);
    const start = (((resultIndex - (steps - 1)) % n) + n) % n;
    let k = 0;
    (function tick() {
      showCard((start + k) % n);
      if (k >= steps - 1) return resolve();
      const t = k / (steps - 1);
      const delay = 70 + t * t * 380;   // ease-out: быстро в начале, медленно к финалу
      k++;
      setTimeout(tick, delay);
    })();
  });
}

// Свой рендер колеса (SVG-секторы по числу кандидатов), не завязан на
// pointauc.com — размер сектора пропорционален весу кандидата, честно
// отражая вероятность, не только визуал.
const WHEEL_COLORS = ["#ff3d5a", "#7f1d1d", "#ff7a8f", "#c81e3a", "#a13350", "#ffb3c0", "#e0526d", "#5c1420"];

function animateWheel(container, candidates, resultId) {
  return new Promise(resolve => {
    const n = candidates.length;
    const resultIndex = Math.max(0, candidates.findIndex(c => c.kinopoiskId === resultId));
    const totalWeight = candidates.reduce((s, c) => s + (c.weight || 1), 0) || 1;

    const size = 260, r = 122, cx = 130, cy = 130;
    const toXY = (deg, radius) => {
      const rad = (deg * Math.PI) / 180;
      return [cx + radius * Math.sin(rad), cy - radius * Math.cos(rad)];
    };

    let angle = 0;
    const sectorsSvg = [];
    const labelsSvg = [];
    const legendItems = [];
    const mids = [];
    candidates.forEach((c, i) => {
      const sweep = 360 * ((c.weight || 1) / totalWeight);
      const startA = angle, endA = angle + sweep;
      const mid = (startA + endA) / 2;
      mids.push(mid);
      const color = WHEEL_COLORS[i % WHEEL_COLORS.length];
      const [x1, y1] = toXY(startA, r);
      const [x2, y2] = toXY(endA, r);
      const largeArc = sweep > 180 ? 1 : 0;
      sectorsSvg.push(`<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${largeArc} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${color}" stroke="var(--dawn-1)" stroke-width="1.5"/>`);
      if (n <= 24) {
        const [lx, ly] = toXY(mid, r * 0.62);
        labelsSvg.push(`<text class="sector-label" x="${lx.toFixed(2)}" y="${ly.toFixed(2)}">${i + 1}</text>`);
      }
      legendItems.push(`<span><span class="dot" style="background:${color}"></span>${i + 1}. ${esc(c.title || "")}${c.year ? ` (${c.year})` : ""}</span>`);
      angle = endA;
    });

    const wrap = el("div", "wheel-wrap");
    wrap.innerHTML = `
      <div class="wheel-pointer"></div>
      <svg viewBox="0 0 ${size} ${size}"><g>${sectorsSvg.join("")}${labelsSvg.join("")}</g></svg>`;
    container.append(wrap);
    const legend = el("div", "wheel-legend");
    legend.innerHTML = legendItems.join("");
    container.append(legend);

    const svg = wrap.querySelector("svg");
    const reduced = prefersReducedMotion();
    const fullSpins = reduced ? 0 : 6;
    // Поворачиваем так, чтобы центр сектора результата оказался под
    // неподвижным указателем сверху (0°) — колесо крутится, указатель нет.
    const rotation = fullSpins * 360 - mids[resultIndex];

    if (reduced) { svg.style.transition = "none"; svg.style.transform = `rotate(${rotation}deg)`; return resolve(); }

    // Стартуем с 0deg без анимации, затем на следующем кадре включаем
    // переход к финальному углу — иначе браузер схлопнёт оба состояния.
    svg.style.transform = "rotate(0deg)";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      svg.style.transform = `rotate(${rotation}deg)`;
    }));
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    svg.addEventListener("transitionend", finish, { once: true });
    setTimeout(finish, 5000);   // подстраховка, если transitionend не пришёл
  });
}

function showDrawResult(candidates, resultId) {
  const mv = candidates.find(c => c.kinopoiskId === resultId) || {};
  const roomId = drawState.roomId;
  const box = $("drawResult");
  box.classList.remove("hidden");
  const year = mv.year ? ` (${mv.year})` : "";
  box.innerHTML = `
    <div class="result-card">
      ${mv.posterUrl ? `<img src="${esc(mv.posterUrl)}" alt="">` : ""}
      <h2>${esc(mv.title || "")}${esc(year)}</h2>
    </div>
    <div class="row result-actions">
      <button class="ghost" id="drawKpBtn">Смотреть на Кинопоиске</button>
      <button id="drawWatchedBtn">Отметить просмотренным</button>
    </div>
    <div class="row result-actions">
      <button class="ghost" id="drawAgainBtn">Крутить ещё раз</button>
    </div>`;
  $("drawKpBtn").onclick = () => window.open(kinopoiskCxUrl(resultId), "_blank", "noopener");
  $("drawWatchedBtn").onclick = () => act(async () => {
    await api(`/rooms/${roomId}/movies/${resultId}/watched`, { method: "POST" });
    location.hash = "#/room/" + roomId;
  }, "Отмечено просмотренным");
  $("drawAgainBtn").onclick = () => { drawState = { roomId, method: drawState.method }; renderDrawSetup(); };
}

// ───────────────────────── приглашение ─────────────────────────
async function showJoin(code) {
  showOnly("joinView");
  const data = await act(() => api("/invite/" + code));
  if (!data) { location.hash = "#/"; return; }
  $("joinTitle").textContent = data.title;
  $("joinMembers").textContent = data.members.length
    ? `Участники: ${data.members.join(", ")}`
    : "Участников пока нет.";
  $("joinAlready").classList.toggle("hidden", !data.alreadyMember);
  $("joinBtn").classList.toggle("hidden", data.alreadyMember);
  $("joinBtn").onclick = async () => {
    const r = await act(() => api("/invite/" + code, { method: "POST" }), "Вы в комнате");
    if (r) location.hash = "#/room/" + r.roomId;
  };
}

// ───────────────────────── что мы смотрели ─────────────────────────
async function showWatched() {
  showOnly("watchedView");
  document.title = "Что смотрим — что мы смотрели";
  const data = await act(() => api("/watched"));
  if (!data) return;
  renderWatched(data.movies);
}

function renderWatched(items) {
  $("watchedEmpty").hidden = items.length > 0;
  const list = $("watchedList");
  list.textContent = "";
  for (const it of items) {
    const mv = it.movie;
    const row = el("div", "movie-row");
    const year = mv.year ? ` (${mv.year})` : "";
    const scoreParts = [
      it.myScore ? `Моя оценка: ${it.myScore}` : "Без моей оценки",
      it.avgScore != null ? `средняя ${it.avgScore}${it.ratingCount > 1 ? ` (${it.ratingCount})` : ""}` : null,
    ].filter(Boolean).join(" · ");
    row.innerHTML = `
      ${mv.posterUrl ? `<img class="movie-poster" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
      <div class="movie-info">
        <div class="title">${esc(mv.title)}${esc(year)}</div>
        <div class="muted">${esc(movieMeta(mv))}</div>
        <div class="muted">${esc(scoreParts)}</div>
      </div>`;
    list.append(row);
  }
}

init().catch(e => {
  console.error(e);
  showAuthScreen("Не удалось загрузить", "Обновите страницу — возможно, сервис ещё поднимается.");
});
