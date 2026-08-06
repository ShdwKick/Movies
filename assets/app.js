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
 * #/join/<код>, #/watched (лента просмотренного), #/my-list (личный список на
 * просмотр, без привязки к комнате), #/profile (хаб-страница с ссылками на
 * оба последних экрана — сама ничего не рендерит). Хэш выбран не случайно: redirect_uri в
 * auth сверяется побайтово, а хэш в него не входит — адрес возврата остаётся
 * одним и тем же для любой страницы.
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

// ───────────────────────── тема ─────────────────────────
// Ручной переключатель поверх системной настройки — тот же приём, что в Trip
// (assets/app.js там же): атрибут на <html>, а не класс, чтобы попадать в
// [data-theme="dark"]-правила в index.html без лишней специфичности.
const SUN = '<svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const MOON = '<svg class="icon" viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("movies.theme", theme);
  $("themeBtn").innerHTML = theme === "dark" ? SUN : MOON;
}
$("themeBtn").onclick = () => applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
applyTheme(localStorage.getItem("movies.theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"));

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
const ROUTE_KEY = "movies.route";   // куда вернуть человека после входа: хэш переживает редирект только так

async function init() {
  const cfg = await (await fetch("/api/config")).json();
  auth = createAuthClient({
    authBase: cfg.authBase,
    clientId: cfg.clientId,
    redirectUri: location.origin + location.pathname,   // ровно то, что зарегистрировано в auth
    storagePrefix: "movies",
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
  $("globalSearchBtn").hidden = false;
  $("serviceProfileBtn").hidden = false;
  $("accountBtn").title = "Аккаунт — " + who(state.me);

  await route();
}

/** Экран «нужен вход» — только на случай сбоя: увести на auth не удалось. */
function showAuthScreen(title, note) {
  showOnly("authView");
  $("accountMenuWrap").hidden = true;
  $("globalSearchBtn").hidden = true;
  $("serviceProfileBtn").hidden = true;
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
  for (const v of ["authView", "roomsView", "roomView", "drawView", "joinView", "watchedView", "myListView", "profileView"]) $(v).hidden = v !== id;
  // Пламя как фон целой страницы допустимо только на экране «нужен вход»
  // (см. BurningHouse/Design/palette.md) — на всех остальных экранах фон
  // нейтральный (--md-sys-color-surface).
  document.body.classList.toggle("auth-bg", id === "authView");
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
  if (hash === "#/my-list") return showMyList();
  if (hash === "#/profile") return showProfile();
  return showRooms();
}
addEventListener("hashchange", () => { route().catch(console.error); });

// ───────────────────────── список комнат ─────────────────────────
async function showRooms() {
  showOnly("roomsView");
  state.room = null;
  document.title = "Что смотрим? — мои комнаты";
  const data = await act(() => api("/rooms"));
  if (!data) return;
  state.me = data.me;
  state.rooms = data.rooms;
  renderRooms();
  renderCachedMovies(state.rooms);
}

/** Витрина «Из базы» — последние закэшированные фильмы (GET /api/movies).
    Раньше тут стояла полноразмерная карточка результата поиска — слишком
    тяжело для главной; теперь компактная плитка (renderMovieTile), клик по
    которой открывает #movieInfoModalBackdrop с теми же данными (moviePayload
    уже полный, повторный запрос к сети не нужен). Секция скрыта целиком, пока
    кэш пуст — план явно требует не показывать пустой блок с заголовком в никуда. */
async function renderCachedMovies(rooms) {
  const data = await act(() => api("/movies?limit=24"));
  const wrap = $("cachedMoviesWrap");
  if (!data || !data.movies.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const box = $("cachedMoviesList");
  box.textContent = "";
  for (const mv of data.movies) box.append(renderMovieTile(mv, rooms));
}

/** Компактная плитка витрины — постер+название(+год мелким текстом),
    кликабельна целиком (как .card у комнат: сам <button> — контейнер, без
    отдельной текст-ссылки внутри). rooms нужен только чтобы передать его
    дальше в модалку — сама плитка их не показывает. */
function renderMovieTile(mv, rooms) {
  const tile = el("button", "movie-tile");
  tile.type = "button";
  tile.innerHTML = `
    ${mv.posterUrl ? `<img class="movie-poster" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
    <div class="title">${esc(mv.title)}</div>
    ${mv.year ? `<div class="muted sub">${esc(mv.year)}</div>` : ""}`;
  tile.onclick = () => {
    renderMovieInfoModal(mv, rooms);
    openModal("movieInfoModalBackdrop");
  };
  return tile;
}

/** Модалка «Фильм» — открывается по клику на плитку витрины. Один и тот же
    DOM-узел #movieInfoModalBackdrop переиспользуется под любой фильм: тело
    перерисовывается целиком (body.innerHTML = ...) при каждом клике, новых
    id не плодим. Постер+название+чипы — те же данные из moviePayload, что
    уже на клиенте; режиссёр/актёры/описание — тот же формат, что и
    «Подробнее» у карточки очереди/истории (bindMovieDetailToggle), но без
    сворачивания — тут это и есть весь контент модалки. Блок действий —
    переиспользованный renderAddTargetActions (тот же компонент, что и в
    строке результата поиска), не копипаста. */
function renderMovieInfoModal(mv, rooms) {
  const year = mv.year ? ` (${mv.year})` : "";
  $("movieInfoModalTitle").textContent = `${mv.title}${year}`;
  const body = $("movieInfoModalBody");
  body.innerHTML = `
    <div class="movie-card-head">
      ${mv.posterUrl ? `<img class="movie-poster lg" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster lg"></div>'}
      <div class="movie-info">
        <div class="title">${esc(mv.title)}${esc(year)}</div>
        <div class="chip-row">${movieChipsHtml(mv)}</div>
      </div>
    </div>
    <div class="movie-detail"></div>
    <div class="row" id="movieInfoModalActions"></div>`;

  const roles = [];
  if (mv.director) roles.push(`<p><b>Режиссёр:</b> ${esc(mv.director)}</p>`);
  if (mv.actors.length) roles.push(`<p><b>В ролях:</b> ${esc(mv.actors.join(", "))}</p>`);
  const desc = mv.description
    ? `<p class="movie-desc${roles.length ? " has-sep" : ""}">${esc(mv.description)}</p>`
    : "";
  body.querySelector(".movie-detail").innerHTML = roles.join("") + desc || '<p class="muted">Подробностей нет.</p>';

  renderAddTargetActions(body.querySelector("#movieInfoModalActions"), mv.kinopoiskId, rooms);
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
  document.title = `${room.title} — Что смотрим?`;
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
    const right = el("span", "chip" + (m.role === "owner" ? " owner" : ""), m.role === "owner" ? "владелец" : "участник");
    li.append(left, right);
    list.append(li);
  }

  renderMovies();
}

// ───────────────────────── фильмы ─────────────────────────
/** Жанры и рейтинги — раньше одна строка текста через точку, теперь чипы
    (см. .chip в styles.css): жанры отдельным чипом, каждый рейтинг своим,
    подкрашенным как .chip.rating. */
function movieChipsHtml(mv) {
  const chips = [];
  if (mv.genres.length) chips.push(`<span class="chip">${esc(mv.genres.join(", "))}</span>`);
  if (mv.kpRating) chips.push(`<span class="chip rating">КП ${esc(mv.kpRating)}</span>`);
  if (mv.imdbRating) chips.push(`<span class="chip rating">IMDb ${esc(mv.imdbRating)}</span>`);
  return chips.join("");
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

/** Общая часть карточки результата поиска — постер+название+чипы, без
    кнопок действий: те разные в комнатной модалке «Добавить фильм» (одна
    кнопка «Добавить» — комната уже известна) и в глобальной модалке поиска
    (выбор комнаты + «В личный список», см. renderSearchResultRow ниже). */
function renderMovieResultRow(mv) {
  const row = el("div", "movie-card-head");
  const year = mv.year ? ` (${mv.year})` : "";
  row.innerHTML = `
    ${mv.posterUrl ? `<img class="movie-poster" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
    <div class="movie-info">
      <div class="title">${esc(mv.title)}${esc(year)}</div>
      <div class="chip-row">${movieChipsHtml(mv)}</div>
    </div>`;
  return row;
}

/** Карточка результата поиска в модалке «Добавить фильм» (комната уже
    известна из state.room) — кликабельна целиком, клик добавляет фильм в
    комнату и закрывает модалку (см. план: убрали кнопку «Добавить» и кнопку
    «Готово» разом — сценарий добавления нескольких фильмов подряд ушёл).
    Настоящий <button> для всей карточки не подходит: внутри есть icon-btn
    «Подробнее» (bindMovieDetailToggle), а <button> внутри <button> невалиден
    — поэтому div с role="button"/tabindex + свой keydown на Enter/Space.
    renderMovieResultRow — общая шапка (постер+инфо), её не трогаем: тот же
    компонент используют результаты ГЛОБАЛЬНОГО поиска (renderSearchResultRow),
    у которых кликабельности и стрелки-подробностей нет и не будет — там
    выбор комнаты через <select> остаётся как есть. */
function renderMovieResultCard(mv) {
  const card = el("div", "movie-card movie-card-pick");
  card.setAttribute("role", "button");
  card.tabIndex = 0;

  const head = renderMovieResultRow(mv);
  const moreBtn = el("button", "icon-btn xs");
  moreBtn.type = "button";
  moreBtn.dataset.act = "more";
  moreBtn.title = "Подробнее";
  moreBtn.setAttribute("aria-label", "Подробнее");
  moreBtn.setAttribute("aria-expanded", "false");
  moreBtn.innerHTML = CHEVRON_DOWN_ICON;
  head.append(moreBtn);
  card.append(head, el("div", "movie-detail hidden"));

  bindMovieDetailToggle(card, mv);

  const addMovie = () => act(async () => {
    const roomId = state.room.room.id;
    const r = await api(`/rooms/${roomId}/movies`, { method: "POST", body: { kinopoiskId: mv.kinopoiskId } });
    closeModal("addMovieModalBackdrop");
    await openRoom(roomId);
    return r;
  }, "Фильм добавлен");
  card.onclick = addMovie;
  card.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); addMovie(); }
  });

  return card;
}

function renderMovieResults(movies) {
  const box = $("movieSearchResults");
  box.textContent = "";
  if (!movies.length) { box.append(el("p", "muted", "Ничего не нашлось.")); return; }
  for (const mv of movies) box.append(renderMovieResultCard(mv));
}

/** Переиспользуемый блок «добавить в комнату»: <select> со списком комнат
    пользователя + кнопка, либо подсказка «Сначала создайте комнату», если
    комнат нет вовсе (см. план задачи 2). Один и тот же компонент используется
    и в строке результата глобального поиска (renderSearchResultRow), и в
    мини-пикере комнаты из личного списка (openRoomPicker). onAdded(roomId)
    зовётся ПОСЛЕ успешного добавления — вызывающий код решает, закрывать ли
    модалку и как известить пользователя. */
function renderRoomPicker(container, kinopoiskId, rooms, onAdded) {
  container.textContent = "";
  if (!rooms.length) {
    container.append(el("span", "muted", "Сначала создайте комнату"));
    return;
  }
  const select = el("select");
  for (const r of rooms) {
    const opt = el("option", null, r.title);
    opt.value = r.id;
    select.append(opt);
  }
  const addBtn = el("button", "btn tonal sm", "Добавить в комнату");
  addBtn.onclick = () => act(async () => {
    const roomId = select.value;
    await api(`/rooms/${roomId}/movies`, { method: "POST", body: { kinopoiskId } });
    if (onAdded) onAdded(roomId);
  }, "Фильм добавлен в комнату");
  container.append(select, addBtn);
}

/** Блок выбора цели — renderRoomPicker + отдельная кнопка «В личный список»
    (POST /my-list). Общий компонент для строки результата глобального поиска
    (renderSearchResultRow) и блока действий в модалке «Фильм»
    (renderMovieInfoModal) — вызывается, а не копируется. */
function renderAddTargetActions(container, kinopoiskId, rooms) {
  renderRoomPicker(container, kinopoiskId, rooms);
  const listBtn = el("button", "btn tonal sm", "В личный список");
  listBtn.onclick = () => act(async () => {
    await api("/my-list", { method: "POST", body: { kinopoiskId } });
  }, "Добавлено в личный список");
  container.append(listBtn);
}

/** Строка результата глобального поиска (шапка, любая комната) — та же
    строка постер+инфо, что и в комнатной модалке, плюс блок выбора цели
    (renderAddTargetActions). */
function renderSearchResultRow(mv, rooms) {
  const wrap = el("div", "movie-card");
  wrap.append(renderMovieResultRow(mv));
  const actions = el("div", "row");
  renderAddTargetActions(actions, mv.kinopoiskId, rooms);
  wrap.append(actions);
  return wrap;
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
  list.textContent = ""; // старые карточки со своими меню-«…» уходят целиком
  openCardMenu = null;   // не держать ссылку на меню отрисованной-и-удалённой карточки
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
    btn.title = String(i);
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
    для карточки очереди и карточки истории. Кнопка — компактная иконка-шеврон
    (не текстовая .btn, см. план задачи 2): переворачивается на 180° при
    разворачивании, .icon-btn.expanded .chevron{transform:rotate(180deg)} в
    styles.css; общий свитч prefers-reduced-motion там же гасит анимацию. */
function bindMovieDetailToggle(card, mv) {
  const btn = card.querySelector('[data-act="more"]');
  btn.onclick = e => {
    // Карточка результата поиска в модалке «Добавить фильм» кликабельна
    // целиком (см. renderMovieResultCard) — клик по стрелке не должен
    // всплывать до card.onclick и триггерить добавление фильма. Для
    // карточек очереди/истории (без клика на всей карточке) stopPropagation
    // безвреден.
    e.stopPropagation();
    const box = card.querySelector(".movie-detail");
    const willShow = box.classList.contains("hidden");
    box.classList.toggle("hidden");
    btn.classList.toggle("expanded", willShow);
    btn.setAttribute("aria-expanded", String(willShow));
    // Очередь — сетка .queue-grid: .expanded на самой карточке растягивает
    // её на всю ширину ряда (grid-column:1/-1 в styles.css), соседние
    // карточки сами переставляются грид-раскладкой, без JS-пересчёта. Вне
    // .queue-grid (история и другие списки, тоже через bindMovieDetailToggle)
    // класс ни на что не влияет — там такого CSS-правила нет.
    card.classList.toggle("expanded", willShow);
    const label = willShow ? "Свернуть" : "Подробнее";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    if (willShow) {
      const roles = [];
      if (mv.director) roles.push(`<p><b>Режиссёр:</b> ${esc(mv.director)}</p>`);
      if (mv.actors.length) roles.push(`<p><b>В ролях:</b> ${esc(mv.actors.join(", "))}</p>`);
      const desc = mv.description
        ? `<p class="movie-desc${roles.length ? " has-sep" : ""}">${esc(mv.description)}</p>`
        : "";
      box.innerHTML = roles.join("") + desc || '<p class="muted">Подробностей нет.</p>';
    }
  };
}

const CHEVRON_DOWN_ICON = '<svg class="icon chevron" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';

// Меню действий карточки очереди (три точки в правом верхнем углу) —
// «Отметить просмотренным»/«Убрать из комнаты» переехали сюда из отдельных
// текстовых кнопок в ряд (см. план задачи «сетка очереди»). В отличие от
// roomMenu/csvMenu/accountMenu — по одному фиксированному id на всю
// страницу — карточек в очереди может быть много, и у каждой своё меню.
// Вместо N независимых обработчиков document-клика держим одно
// module-level «какое меню сейчас открыто» и подключаем его к тому же
// общему закрытию (Escape/клик снаружи/открытие другого меню), что и три
// меню выше — см. вызовы closeCardMenu() рядом с closeRoomMenu()/
// closeCsvMenu()/closeAccountMenu() ниже по файлу.
let openCardMenu = null; // { menu, btn } открытого меню карточки, либо null
function closeCardMenu() {
  if (!openCardMenu) return;
  const { menu, btn } = openCardMenu;
  menu.hidden = true;
  btn.setAttribute("aria-expanded", "false");
  openCardMenu = null;
}
function bindMovieCardMenu(card) {
  const btn = card.querySelector('[data-act="cardMenuBtn"]');
  const menu = card.querySelector('[data-act="cardMenu"]');
  btn.onclick = e => {
    e.stopPropagation();
    const reopening = openCardMenu && openCardMenu.menu === menu;
    closeRoomMenu();
    closeCsvMenu();
    closeAccountMenu();
    closeCardMenu();
    if (reopening) return;
    menu.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    openCardMenu = { menu, btn };
  };
}
document.addEventListener("click", e => {
  if (!openCardMenu) return;
  const { menu, btn } = openCardMenu;
  if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeCardMenu();
});

// Карточка очереди — только queued (watched теперь отдельным списком в
// renderHistoryCard ниже, см. renderMovies). Раскладка — сетка .queue-grid
// (index.html): карточка у́же прежней, стрелка «Подробнее» и меню-«…»
// стоят в углу через .title-row/.title-actions, «Смотреть» — в футере
// справа (см. .movie-card-footer в styles.css).
function renderMovieCard(rm, room) {
  const mv = rm.movie;
  const card = el("div", "movie-card");
  const year = mv.year ? ` (${mv.year})` : "";
  card.innerHTML = `
    <div class="title-row">
      <div class="movie-card-head">
        ${mv.posterUrl ? `<img class="movie-poster" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
        <div class="movie-info">
          <div class="title">${esc(mv.title)}${esc(year)}</div>
          <div class="chip-row">${movieChipsHtml(mv)}</div>
        </div>
      </div>
      <div class="title-actions">
        <button class="icon-btn xs" data-act="more" type="button" title="Подробнее" aria-label="Подробнее" aria-expanded="false">${CHEVRON_DOWN_ICON}</button>
        <div class="menu-wrap">
          <button class="icon-btn xs" data-act="cardMenuBtn" type="button" title="Действия с фильмом" aria-label="Действия с фильмом" aria-haspopup="true" aria-expanded="false">
            <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/></svg>
          </button>
          <div class="menu" data-act="cardMenu" hidden>
            <button class="menu-item" data-act="watched">Отметить просмотренным</button>
            <button class="menu-item danger" data-act="remove">Убрать из комнаты</button>
          </div>
        </div>
      </div>
    </div>
    <div class="movie-detail hidden"></div>
    <div class="movie-card-footer">
      <button class="btn tonal" data-act="watch" type="button">Смотреть</button>
    </div>`;

  bindMovieDetailToggle(card, mv);
  bindMovieCardMenu(card);

  card.querySelector('[data-act="watched"]').onclick = () => act(async () => {
    closeCardMenu();
    await api(`/rooms/${room.id}/movies/${mv.kinopoiskId}/watched`, { method: "POST" });
    await openRoom(room.id);
  }, "Отмечено просмотренным");

  card.querySelector('[data-act="remove"]').onclick = () => act(async () => {
    closeCardMenu();
    await api(`/rooms/${room.id}/movies/${mv.kinopoiskId}`, { method: "DELETE" });
    await openRoom(room.id);
  }, "Фильм убран из комнаты");

  // «Смотреть» — прямой доступ к тому же kinopoisk.cx/film/<id>/, что и на
  // экране розыгрыша (drawKpBtn); функция не дублируется.
  card.querySelector('[data-act="watch"]').onclick = () => window.open(kinopoiskCxUrl(mv.kinopoiskId), "_blank", "noopener");

  return card;
}

// Карточка истории — watched в ЭТОЙ комнате: кто и когда отметил (watchedBy
// сматчен на фронте по members, т.к. на бэке джойна нет — см. план), плюс
// личная/средняя оценка (уместна тут же, раз фильм уже просмотрен).
function renderHistoryCard(rm, room, members) {
  const mv = rm.movie;
  const card = el("div", "movie-card");
  const year = mv.year ? ` (${mv.year})` : "";
  const watcher = members.find(m => m.userId === rm.watchedBy);
  const whoText = watcher ? who(watcher) : "кто-то из участников";
  const whenText = rm.watchedAt ? new Date(rm.watchedAt).toLocaleDateString("ru") : "—";
  card.innerHTML = `
    <div class="movie-card-head">
      ${mv.posterUrl ? `<img class="movie-poster" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
      <div class="movie-info">
        <div class="title">${esc(mv.title)}${esc(year)}</div>
        <div class="chip-row">${movieChipsHtml(mv)}</div>
        <div class="muted sub">Просмотрено ${esc(whenText)} · ${esc(whoText)}</div>
      </div>
    </div>
    <div class="movie-detail hidden"></div>
    <div class="row">
      <button class="icon-btn xs" data-act="more" type="button" title="Подробнее" aria-label="Подробнее" aria-expanded="false">${CHEVRON_DOWN_ICON}</button>
      <button class="btn tonal" data-act="watched">Вернуть в очередь</button>
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

$("importCsvBtn").onclick = () => { closeCsvMenu(); $("importCsvInput").click(); };
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

// «Перевыпустить код» — иконка рядом с самим кодом (в .code-box), не отдельная
// текстовая кнопка. Отключить приглашение из интерфейса теперь нельзя —
// когда оно уже отключено (для комнат, где это сделали раньше), включить
// его обратно можно текстовой кнопкой ниже.
const REFRESH_CODE_ICON = '<svg class="icon" viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.3L21 8"/><path d="M21 3v5h-5"/></svg>';

function renderCodeArea(room) {
  const box = $("codeArea");
  box.textContent = "";
  const isOwner = room.myRole === "owner";

  if (room.joinCode) {
    const wrap = el("div", "code-box");
    const link = `${location.origin}/#/join/${room.joinCode}`;
    const codeEl = el("code", null, room.joinCode);
    codeEl.title = "Скопировать код";
    codeEl.onclick = async () => {
      try { await navigator.clipboard.writeText(room.joinCode); snack("Код скопирован"); }
      catch { snack(room.joinCode); }
    };
    wrap.append(codeEl);
    const copyBtn = el("button", "btn tonal sm", "Скопировать ссылку");
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(link); snack("Ссылка скопирована"); }
      catch { snack(link); }
    };
    wrap.append(copyBtn);
    if (isOwner) {
      const reissue = el("button", "icon-btn xs");
      reissue.type = "button";
      reissue.title = "Перевыпустить код";
      reissue.setAttribute("aria-label", "Перевыпустить код");
      reissue.innerHTML = REFRESH_CODE_ICON;
      reissue.onclick = () => act(async () => {
        const r = await api(`/rooms/${room.id}/code`, { method: "POST" });
        state.room.room.joinCode = r.joinCode;
        renderCodeArea(state.room.room);
      }, "Новый код готов");
      wrap.append(reissue);
    }
    box.append(wrap);
  } else {
    box.append(el("p", "muted", "Приглашение отключено."));
    if (isOwner) {
      const enable = el("button", "btn tonal", "Включить приглашение");
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
  closeCsvMenu();
  closeCardMenu();
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

// Меню экспорта/импорта CSV — тот же паттерн, что и меню комнаты: раньше
// это были две отдельные кнопки в ряд, теперь один триггер-«…» рядом с
// заголовком «Фильмы» и выпадающий список из двух пунктов.
function closeCsvMenu() {
  const menu = $("csvMenu");
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  $("csvMenuBtn").setAttribute("aria-expanded", "false");
}
$("csvMenuBtn").onclick = e => {
  e.stopPropagation();
  closeRoomMenu();
  closeCardMenu();
  const menu = $("csvMenu");
  const willShow = menu.hidden;
  menu.hidden = !willShow;
  $("csvMenuBtn").setAttribute("aria-expanded", String(willShow));
};
document.addEventListener("click", e => {
  const menu = $("csvMenu");
  if (!menu || menu.hidden) return;
  if (!menu.contains(e.target) && e.target !== $("csvMenuBtn")) closeCsvMenu();
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
  closeCsvMenu();
  closeCardMenu();
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
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  closeRoomMenu(); closeAccountMenu(); closeCsvMenu(); closeCardMenu();
  if (openModalId) closeModal(openModalId);
});

$("accountMenuManage").onclick = () => { closeAccountMenu(); window.open(auth.accountUrl(), "_blank", "noopener"); };
$("accountMenuLogout").onclick = () => { closeAccountMenu(); auth.logout(); };

// ───────────────────────── модалки (участники, добавление фильма) ─────────────────────────
// Общий паттерн для двух модалок ниже: подложка на весь экран + карточка по
// центру, закрытие по крестику/клику по подложке/Escape (Escape — общий
// обработчик выше, вместе с закрытием меню). body.modal-open не даёт фону
// скроллиться, пока модалка открыта.
let openModalId = null; // id открытого .modal-backdrop — нужен для Escape
function openModal(backdropId) {
  closeRoomMenu(); closeAccountMenu(); closeCsvMenu(); closeCardMenu();
  $(backdropId).classList.remove("hidden");
  document.body.classList.add("modal-open");
  openModalId = backdropId;
}
function closeModal(backdropId) {
  const b = $(backdropId);
  if (!b || b.classList.contains("hidden")) return;
  b.classList.add("hidden");
  document.body.classList.remove("modal-open");
  if (openModalId === backdropId) openModalId = null;
}
function bindModal(backdropId, openBtnId, closeBtnId) {
  if (openBtnId) $(openBtnId).onclick = () => openModal(backdropId);
  if (closeBtnId) $(closeBtnId).onclick = () => closeModal(backdropId);
  $(backdropId).addEventListener("click", e => { if (e.target === $(backdropId)) closeModal(backdropId); });
}

bindModal("membersModalBackdrop", "membersBtn", "membersModalClose");
bindModal("addMovieModalBackdrop", "addMovieBtn", "addMovieModalClose");

// Модалка «Фильм» (плитка витрины «Из базы») — своей кнопки-открывашки нет,
// открывается из renderMovieTile() по клику на конкретную плитку.
bindModal("movieInfoModalBackdrop", null, "movieInfoModalClose");

// ───────────────────────── глобальный поиск (шапка, любая комната) ─────────────────────────
// По сути то же самое, что модалка «Добавить фильм» внутри комнаты выше, но
// без заранее известной комнаты: у каждого результата — выбор цели
// (renderRoomPicker) вместо одной кнопки «Добавить» (см. план задачи 2).
bindModal("globalSearchModalBackdrop", null, "globalSearchModalClose");
$("globalSearchDoneBtn").onclick = () => closeModal("globalSearchModalBackdrop");
$("globalSearchBtn").onclick = () => {
  $("globalSearchInput").value = "";
  $("globalSearchResults").textContent = "";
  openModal("globalSearchModalBackdrop");
};

async function runGlobalSearch() {
  const q = $("globalSearchInput").value.trim();
  if (!q) return;
  $("globalSearchResults").textContent = "";
  const data = await act(() => api("/search?q=" + encodeURIComponent(q)));
  if (!data) return;
  // Список комнат — свежий на каждый поиск: пока модалка открыта, человек
  // вполне мог создать новую комнату в другой вкладке/раньше в этой сессии.
  const roomsData = await act(() => api("/rooms"));
  renderGlobalSearchResults(data.movies, roomsData ? roomsData.rooms : []);
}
$("globalSearchSubmitBtn").onclick = runGlobalSearch;
$("globalSearchInput").addEventListener("keydown", e => { if (e.key === "Enter") runGlobalSearch(); });

function renderGlobalSearchResults(movies, rooms) {
  const box = $("globalSearchResults");
  box.textContent = "";
  if (!movies.length) { box.append(el("p", "muted", "Ничего не нашлось.")); return; }
  for (const mv of movies) box.append(renderSearchResultRow(mv, rooms));
}

// ───────────────────────── мини-пикер комнаты (из личного списка) ─────────────────────────
// Тот же renderRoomPicker, что и в глобальном поиске, но в отдельной модалке:
// на экране «Мой список» комната заранее неизвестна, а inline-строка выбора
// там неуместна (карточка уже итак насыщена действиями).
bindModal("roomPickModalBackdrop", null, "roomPickModalClose");
async function openRoomPicker(kinopoiskId) {
  openModal("roomPickModalBackdrop");
  const body = $("roomPickBody");
  body.textContent = "";
  body.append(el("p", "muted", "Загрузка…"));
  const data = await act(() => api("/rooms"));
  body.textContent = "";
  if (!data) return;
  renderRoomPicker(body, kinopoiskId, data.rooms, () => closeModal("roomPickModalBackdrop"));
}

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
  $("methodWeightedBtn").classList.toggle("sel", drawState.method === "weighted_random");
  $("methodWheelBtn").classList.toggle("sel", drawState.method === "wheel");
  $("methodEliminationBtn").classList.toggle("sel", drawState.method === "elimination");
}
$("methodWeightedBtn").onclick = () => { if (!drawState) return; drawState.method = "weighted_random"; updateMethodButtons(); };
$("methodWheelBtn").onclick = () => { if (!drawState) return; drawState.method = "wheel"; updateMethodButtons(); };
$("methodEliminationBtn").onclick = () => { if (!drawState) return; drawState.method = "elimination"; updateMethodButtons(); };

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
  else if (drawState.method === "elimination") await animateElimination(stage, data.candidates, data.rounds, data.resultKinopoiskId);
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

/** Рисует SVG-колесо (секторы по весу кандидата + легенда) в container,
    полностью заменяя его содержимое. Общая часть между обычным розыгрышем
    (animateWheel) и каждым раундом «На выбывание» (animateElimination) —
    выбывание крутит то же колесо, просто с уменьшающимся набором кандидатов
    на каждой итерации. Каждый <path> сектора помечен data-kp — по этому
    атрибуту animateElimination гасит ровно выбывший сектор. Возвращает
    {svg, mids} — mids нужен spinWheelTo ниже, чтобы знать угол остановки. */
function renderWheelSvg(container, candidates) {
  container.textContent = "";
  const n = candidates.length;
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
    sectorsSvg.push(`<path data-kp="${c.kinopoiskId}" d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${largeArc} 1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${color}" stroke="var(--md-sys-color-surface)" stroke-width="1.5"/>`);
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

  return { svg: wrap.querySelector("svg"), mids };
}

/** Крутит уже отрисованное renderWheelSvg колесо так, чтобы центр сектора
    targetIndex остановился под неподвижным указателем сверху (0°) — колесо
    крутится, указатель нет. При prefers-reduced-motion угол выставляется
    сразу, без перехода. Общая механика вращения для одиночного розыгрыша
    (animateWheel) и каждого раунда выбывания (animateElimination). */
function spinWheelTo(svg, mids, targetIndex) {
  return new Promise(resolve => {
    const reduced = prefersReducedMotion();
    const fullSpins = reduced ? 0 : 6;
    const rotation = fullSpins * 360 - mids[targetIndex];

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

function animateWheel(container, candidates, resultId) {
  const resultIndex = Math.max(0, candidates.findIndex(c => c.kinopoiskId === resultId));
  const { svg, mids } = renderWheelSvg(container, candidates);
  return spinWheelTo(svg, mids, resultIndex);
}

/** Колесо с выбыванием: один раунд из rounds (пришедших от сервера, см.
    POST /rooms/:id/draw и selection.pickElimination) — это одна прокрутка
    того же renderWheelSvg/spinWheelTo, что и обычное колесо, но целится не в
    результат, а в выбывающего кандидата ЭТОГО раунда; после остановки его
    сектор гасится (opacity), короткая пауза, чтобы можно было уследить, кто
    выбыл, — и колесо пересобирается уже без него для следующего раунда.
    Порядок и состав раундов сервер уже зафиксировал, фронт их не выбирает,
    только визуализирует. При prefers-reduced-motion раунды не проигрываются
    — колесо сразу встаёт на итоговый результат (resultId), без покруток. */
async function animateElimination(container, candidates, rounds, resultId) {
  const resultIndex = Math.max(0, candidates.findIndex(c => c.kinopoiskId === resultId));
  if (prefersReducedMotion() || !rounds || !rounds.length) {
    const { svg, mids } = renderWheelSvg(container, candidates);
    await spinWheelTo(svg, mids, resultIndex);
    return;
  }

  let remaining = candidates.slice();
  for (const round of rounds) {
    const targetIndex = remaining.findIndex(c => c.kinopoiskId === round.eliminated);
    if (targetIndex === -1) continue;   // рассинхрон с сервером — пропускаем раунд, не роняем анимацию
    const { svg, mids } = renderWheelSvg(container, remaining);
    await spinWheelTo(svg, mids, targetIndex);
    const sector = svg.querySelector(`path[data-kp="${round.eliminated}"]`);
    if (sector) sector.style.opacity = ".25";
    await new Promise(r => setTimeout(r, 500));
    remaining = remaining.filter(c => c.kinopoiskId !== round.eliminated);
  }
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
      <button class="btn outlined" id="drawKpBtn">Смотреть на Кинопоиске</button>
      <button class="btn filled" id="drawWatchedBtn">Отметить просмотренным</button>
    </div>
    <div class="row result-actions">
      <button class="btn outlined" id="drawAgainBtn">Крутить ещё раз</button>
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

// ───────────────────────── профиль сервиса (хаб) ─────────────────────────
// Личные фильмовые данные ВНУТРИ этого сервиса (не аккаунт BurningHouse) —
// раньше две невзрачные текстовые ссылки висели прямо на #roomsView, теперь
// иконка #serviceProfileBtn в шапке ведёт на #/profile, а сама страница
// только перенаправляет на уже существующие #/watched и #/my-list (см. план
// задачи 2) — их рендеринг не дублируем.
$("serviceProfileBtn").onclick = () => { location.hash = "#/profile"; };
$("profileWatchedBtn").onclick = () => { location.hash = "#/watched"; };
$("profileMyListBtn").onclick = () => { location.hash = "#/my-list"; };

async function showProfile() {
  showOnly("profileView");
  document.title = "Что смотрим? — мои фильмы";
}

// ───────────────────────── что мы смотрели ─────────────────────────
async function showWatched() {
  showOnly("watchedView");
  document.title = "Что смотрим? — что мы смотрели";
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
    const card = el("div", "movie-card");
    const year = mv.year ? ` (${mv.year})` : "";
    const scoreParts = [
      it.myScore ? `Моя оценка: ${it.myScore}` : "Без моей оценки",
      it.avgScore != null ? `средняя ${it.avgScore}${it.ratingCount > 1 ? ` (${it.ratingCount})` : ""}` : null,
    ].filter(Boolean).join(" · ");
    card.innerHTML = `
      <div class="movie-card-head">
        ${mv.posterUrl ? `<img class="movie-poster" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
        <div class="movie-info">
          <div class="title">${esc(mv.title)}${esc(year)}</div>
          <div class="chip-row">${movieChipsHtml(mv)}</div>
          <div class="muted sub">${esc(scoreParts)}</div>
        </div>
      </div>`;
    list.append(card);
  }
}

// ───────────────────────── личный список на просмотр ─────────────────────────
// Глобально, без привязки к комнате (см. план задачи 1) — GET/POST/DELETE
// /api/my-list. Добавляют сюда через глобальный поиск в шапке (см.
// renderSearchResultRow выше); на этом экране можно только убрать фильм или
// закинуть его в конкретную комнату через мини-пикер (openRoomPicker).
async function showMyList() {
  showOnly("myListView");
  document.title = "Что смотрим? — мой список";
  const data = await act(() => api("/my-list"));
  if (!data) return;
  renderMyList(data.movies);
}

function renderMyList(items) {
  $("myListEmpty").hidden = items.length > 0;
  const list = $("myListItems");
  list.textContent = "";
  for (const it of items) {
    const mv = it.movie;
    const card = el("div", "movie-card");
    const year = mv.year ? ` (${mv.year})` : "";
    card.innerHTML = `
      <div class="movie-card-head">
        ${mv.posterUrl ? `<img class="movie-poster" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
        <div class="movie-info">
          <div class="title">${esc(mv.title)}${esc(year)}</div>
          <div class="chip-row">${movieChipsHtml(mv)}</div>
        </div>
      </div>
      <div class="row">
        <button class="btn tonal" data-act="pick">Добавить в комнату</button>
        <button class="btn outlined danger" data-act="remove">Убрать из списка</button>
      </div>`;

    card.querySelector('[data-act="pick"]').onclick = () => openRoomPicker(mv.kinopoiskId);
    card.querySelector('[data-act="remove"]').onclick = () => act(async () => {
      await api(`/my-list/${mv.kinopoiskId}`, { method: "DELETE" });
      await showMyList();
    }, "Убрано из списка");

    list.append(card);
  }
}

init().catch(e => {
  console.error(e);
  showAuthScreen("Не удалось загрузить", "Обновите страницу — возможно, сервис ещё поднимается.");
});
