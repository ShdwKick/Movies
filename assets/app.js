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
const kinopoiskCxUrl = (kinopoiskId) => `https://www.kinopoisk.cx/film/${kinopoiskId}/`;

// Настоящая страница фильма на kinopoisk.ru (карточка/рейтинг/отзывы) — НЕ то
// же самое, что kinopoiskCxUrl выше (тот открывает сторонний просмотр), две
// разные ссылки на два разных назначения, заведены отдельными функциями
// намеренно (см. план: «Страница на Кинопоиске»).
const kinopoiskRuUrl = (kinopoiskId) => `https://www.kinopoisk.ru/film/${kinopoiskId}/`;

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

// Витрина «Из базы» на главной — пагинация+сортировка (GET /api/movies?
// limit&offset&sort). total заполняется каждым ответом сервера, offset
// ОБЯЗАТЕЛЬНО сбрасывается на 0 при смене sort — иначе легко улететь на
// несуществующую страницу для новой сортировки (см. renderCachedMovies).
// genre — активный фильтр витрины с полки жанров ниже (см. renderGenreShelves/
// #cachedGenreChip); null — витрина без фильтра, как раньше.
let showcaseState = { offset: 0, limit: 24, sort: "recent", total: 0, genre: null };
// Вид витрины «Из базы»: общий список (по умолчанию) или разбивка по полкам
// жанров — переключатель #showcaseViewToggle (см. applyShowcaseView).
// Персональной настройкой/localStorage не делаем — та же логика, что и у
// showcaseState.sort: сброс на дефолт при обычной перезагрузке ожидаем.
let showcaseView = "all";

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
  $("globalSearchWrap").hidden = false;
  $("serviceProfileBtn").hidden = false;
  $("accountBtn").title = "Аккаунт — " + who(state.me);

  await route();
}

/** Экран «нужен вход» — только на случай сбоя: увести на auth не удалось. */
function showAuthScreen(title, note) {
  showOnly("authView");
  $("accountMenuWrap").hidden = true;
  $("globalSearchWrap").hidden = true;
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
  if (hash === "#/my-list/draw") return showMyListDraw();
  if (hash === "#/my-list") return showMyList();
  if (hash === "#/profile") return showProfile();
  return showRooms();
}
addEventListener("hashchange", () => { closeGlobalSearch(); route().catch(console.error); });

// ───────────────────────── список комнат ─────────────────────────
async function showRooms() {
  showOnly("roomsView");
  state.room = null;
  roomsPage = 0;
  document.title = "Что смотрим? — мои комнаты";
  // Поиск на главной сбрасывается при каждом заходе на страницу — иначе
  // после ухода на другой экран и возврата сюда осталась бы висеть чужая
  // сессия поиска, а не свежая витрина.
  $("homeSearchInput").value = "";
  $("homeSearchClearBtn").hidden = true;
  $("homeSearchResults").hidden = true;
  $("homeSearchResults").textContent = "";
  const data = await act(() => api("/rooms"));
  if (!data) return;
  state.me = data.me;
  state.rooms = data.rooms;
  renderRooms();
  refreshShowcase(state.rooms);
  maybeStartTour();
}

/** Общая точка входа для витрины «Из базы» — решает, есть ли вообще жанры (а
    значит, есть ли смысл показывать #showcaseViewToggle), и рендерит тот из
    двух видов (общий список / полки по жанрам), что выбран в showcaseView.
    Вызывается и при обычном заходе на главную (showRooms), и при возврате из
    поиска на главной (runHomeSearch — пустая строка снова показывает
    витрину). Жанры на каждый вызов запрашиваются заново, а не кэшируются —
    на масштабе личного проекта это дешевле, чем городить инвалидацию кэша. */
async function refreshShowcase(rooms) {
  const genresData = await act(() => api("/genres"));
  const hasGenres = !!(genresData && genresData.genres.length);
  $("showcaseViewToggle").hidden = !hasGenres;
  if (!hasGenres) showcaseView = "all"; // нечего переключать — жанров в кэше нет
  syncShowcaseViewButtons();
  if (showcaseView === "genres") {
    $("cachedMoviesWrap").hidden = true;
    renderGenreShelves(rooms, genresData);
  } else {
    $("genreShelvesWrap").hidden = true;
    renderCachedMovies(rooms);
  }
}

function syncShowcaseViewButtons() {
  $("showcaseViewAllBtn").classList.toggle("sel", showcaseView === "all");
  $("showcaseViewGenresBtn").classList.toggle("sel", showcaseView === "genres");
}

/** #showcaseToolbar (переключатель вида + сортировка/фильтр общего списка,
    см. index.html) — общий родитель для genreShelvesWrap/cachedMoviesWrap,
    поэтому его видимость и видимость #showcaseFlatControls внутри него
    (сортировка+чип, которые имеют смысл только для общего списка) не решает
    ни renderCachedMovies, ни renderGenreShelves сами по себе — только эта
    функция, вызываемая в конце обеих. Панель скрыта целиком, только когда
    показывать вообще нечего (жанров нет И общий список пуст). */
function updateShowcaseToolbarVisibility() {
  const hasGenres = !$("showcaseViewToggle").hidden;
  const hasFlatMovies = !$("cachedMoviesWrap").hidden;
  $("showcaseToolbar").hidden = !hasGenres && !hasFlatMovies;
  $("showcaseFlatControls").hidden = showcaseView !== "all";
}

$("showcaseViewAllBtn").onclick = () => {
  showcaseView = "all";
  syncShowcaseViewButtons();
  $("genreShelvesWrap").hidden = true;
  renderCachedMovies(state.rooms);
};
$("showcaseViewGenresBtn").onclick = () => {
  showcaseView = "genres";
  syncShowcaseViewButtons();
  $("cachedMoviesWrap").hidden = true;
  renderGenreShelves(state.rooms);
};

/** Витрина закэшированных фильмов (GET /api/movies?limit&offset&sort,
    состояние — showcaseState), без текстового заголовка — только визуальный
    разделитель (#cachedMoviesWrap в styles.css). Раньше тут стояла
    полноразмерная карточка результата поиска — слишком тяжело для главной;
    теперь компактная плитка (renderMovieTile), клик по которой открывает
    #movieInfoModalBackdrop с теми же данными (moviePayload уже полный,
    повторный запрос к сети не нужен). Секция скрыта целиком, пока кэш пуст —
    план явно требует не показывать пустой блок. Пейджер (#cachedPager)
    прячется отдельно, если все фильмы помещаются на одну страницу —
    сортировка (#cachedSortSelect) при этом остаётся видимой. Видимость
    относительно жанровых полок решает refreshShowcase/toggle-обработчики
    выше — сама функция ничего про showcaseView не знает. */
async function renderCachedMovies(rooms) {
  const { limit, offset, sort, genre } = showcaseState;
  let url = `/movies?limit=${limit}&offset=${offset}&sort=${encodeURIComponent(sort)}`;
  if (genre) url += `&genre=${encodeURIComponent(genre)}`;
  const data = await act(() => api(url));
  const wrap = $("cachedMoviesWrap");
  // Пустая витрина при активном фильтре — не прячем секцию целиком (иначе
  // непонятно, куда делся список и как вернуться), а показываем пустой грид
  // с чипом фильтра, который снимается тем же кликом, что и обычно.
  if (!data || (!data.movies.length && !genre)) { wrap.hidden = true; updateShowcaseToolbarVisibility(); return; }
  wrap.hidden = false;
  showcaseState.total = data.total;

  $("cachedSortSelect").value = sort;

  const chip = $("cachedGenreChip");
  if (genre) {
    chip.hidden = false;
    chip.textContent = `Жанр: ${genre} ×`;
    chip.onclick = () => { showcaseState.genre = null; showcaseState.offset = 0; renderCachedMovies(rooms); };
  } else {
    chip.hidden = true;
    chip.onclick = null;
  }

  const box = $("cachedMoviesList");
  box.textContent = "";
  openCardMenu = null; // старые плитки со своими меню-«…» уходят целиком
  if (!data.movies.length) box.append(el("p", "muted", "По этому жанру пока пусто."));
  for (const mv of data.movies) {
    box.append(renderMovieTile(mv, { menu: renderAddToMenu(mv.kinopoiskId, rooms) }));
  }

  // Пейджер прячется целиком, если всё помещается на одну страницу — но
  // #cachedSortSelect (уже видимый вместе со всем wrap) остаётся видимым
  // всегда, пока секция не пуста: сортировка полезна и на одной странице.
  const fitsOnOnePage = data.total <= limit;
  $("cachedPager").hidden = fitsOnOnePage;
  if (!fitsOnOnePage) {
    const pages = Math.max(1, Math.ceil(data.total / limit));
    const page = Math.floor(offset / limit) + 1;
    $("cachedPagerLabel").textContent = `Стр. ${page} из ${pages}`;
    $("cachedPrevBtn").disabled = offset <= 0;
    $("cachedNextBtn").disabled = offset + limit >= data.total;
  }
  updateShowcaseToolbarVisibility();
}

/** Полки по жанрам — альтернативный вид витрины «Из базы» (переключатель
    #showcaseViewToggle, видимость которого решает refreshShowcase; сама эта
    функция вызывается, только когда showcaseView === "genres"). Список
    жанров — GET /api/genres (топ по кэшу), затем по 10 недавних фильмов на
    жанр через уже существующий GET /api/movies?genre=. Список жанров не
    нормализуем и не фильтруем от опечаток — пользователь решил, что данные с
    poiskkino.dev достаточно чистые (в конечном счёте это Кинопоиск), заводить
    справочник/маппинг синонимов не нужно. genresList — опционально уже
    полученный refreshShowcase список (не дёргаем /api/genres второй раз при
    обычном заходе на главную); при переключении кнопкой #showcaseViewGenresBtn
    его нет — тогда запрашиваем сами. Клик по заголовку/«Показать все» не
    остаётся в этом виде, а переключает на общий список ниже через
    openGenreFilter — тот же переиспользуемый список, просто отфильтрованный
    (showcaseState.genre/#cachedGenreChip), без отдельного экрана под жанр. */
async function renderGenreShelves(rooms, genresList) {
  const wrap = $("genreShelvesWrap");
  const list = genresList || await act(() => api("/genres"));
  if (!list || !list.genres.length) { wrap.hidden = true; updateShowcaseToolbarVisibility(); return; }
  wrap.hidden = false;

  const shelves = await Promise.all(list.genres.map(g =>
    act(() => api(`/movies?limit=10&sort=recent&genre=${encodeURIComponent(g.genre)}`))
      .then(data => ({ genre: g.genre, movies: data ? data.movies : [] }))
  ));

  wrap.textContent = "";
  for (const shelf of shelves) {
    if (!shelf.movies.length) continue;
    wrap.append(renderGenreShelf(shelf.genre, shelf.movies, rooms));
  }
  wrap.hidden = !wrap.children.length;
  updateShowcaseToolbarVisibility();
}

async function openGenreFilter(genre) {
  showcaseView = "all";
  syncShowcaseViewButtons();
  $("genreShelvesWrap").hidden = true;
  showcaseState.genre = genre;
  showcaseState.offset = 0;
  await renderCachedMovies(state.rooms);
  $("cachedMoviesWrap").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderGenreShelf(genre, movies, rooms) {
  const section = el("div", "genre-shelf");
  const titleRow = el("div", "title-row");
  const heading = el("h2");
  const headingLink = el("button", "genre-shelf-link", genre);
  headingLink.type = "button";
  headingLink.onclick = () => openGenreFilter(genre);
  heading.append(headingLink);
  const moreBtn = el("button", "btn tonal sm", "Показать все");
  moreBtn.type = "button";
  moreBtn.onclick = () => openGenreFilter(genre);
  titleRow.append(heading, moreBtn);
  section.append(titleRow);

  const row = el("div", "genre-shelf-row");
  for (const mv of movies) {
    row.append(renderMovieTile(mv, { menu: renderAddToMenu(mv.kinopoiskId, rooms) }));
  }
  section.append(row);
  return section;
}

$("cachedSortSelect").onchange = e => {
  showcaseState.sort = e.target.value;
  showcaseState.offset = 0; // иначе можно улететь на несуществующую страницу новой сортировки
  renderCachedMovies(state.rooms);
};
$("cachedPrevBtn").onclick = () => {
  showcaseState.offset = Math.max(0, showcaseState.offset - showcaseState.limit);
  renderCachedMovies(state.rooms);
};
$("cachedNextBtn").onclick = () => {
  showcaseState.offset += showcaseState.limit;
  renderCachedMovies(state.rooms);
};

// Поиск фильмов прямо на главной, над витриной (#homeSearchWrap в index.html)
// — тот же /api/search и тот же renderSearchResultRow, что и у поиска в
// шапке (см. runGlobalSearch/renderGlobalSearchResults ниже по файлу, тот
// же принцип живого поиска), только тут результаты появляются под строкой
// поиска и уходят вниз страницы по мере ввода (принцип как в браузерных
// онлайн-кинотеатрах), а витрина «Из базы» на это время прячется — иначе на
// экране были бы одновременно два конкурирующих списка фильмов. Пустая
// строка возвращает как было — просто перерисовываем витрину заново
// (renderCachedMovies сама решает, показывать её или нет, ничего вручную не
// восстанавливаем).
let homeSearchDebounce = null;
$("homeSearchInput").addEventListener("input", () => {
  $("homeSearchClearBtn").hidden = !$("homeSearchInput").value;
  clearTimeout(homeSearchDebounce);
  homeSearchDebounce = setTimeout(runHomeSearch, 300);
});
$("homeSearchClearBtn").onclick = () => {
  $("homeSearchInput").value = "";
  $("homeSearchClearBtn").hidden = true;
  runHomeSearch();
};

async function runHomeSearch() {
  const q = $("homeSearchInput").value.trim();
  const results = $("homeSearchResults");
  clearTimeout(homeSearchDebounce);
  if (!q) {
    results.hidden = true;
    results.textContent = "";
    refreshShowcase(state.rooms);
    return;
  }
  const data = await act(() => api("/search?q=" + encodeURIComponent(q)));
  if (!data) return;
  // Запрос мог устареть, пока летел (строку успели стереть/поменять) —
  // не подсовываем результат уже не тому вводу.
  if ($("homeSearchInput").value.trim() !== q) return;
  renderHomeSearchResults(data.movies);
}

function renderHomeSearchResults(movies) {
  $("showcaseToolbar").hidden = true;
  $("genreShelvesWrap").hidden = true;
  $("cachedMoviesWrap").hidden = true;
  const box = $("homeSearchResults");
  box.hidden = false;
  box.textContent = "";
  if (!movies.length) { box.append(el("p", "muted", "Ничего не нашлось.")); return; }
  for (const mv of movies) box.append(renderSearchResultRow(mv));
}

// Иконка «Смотреть» на плитке витрины — тот же плей-треугольник, что и
// текстовая кнопка «Смотреть» карточки очереди (renderMovieCard), просто в
// виде компактной icon-btn.xs: там место для текста есть, тут нет.
const PLAY_ICON = '<svg class="icon" viewBox="0 0 24 24"><path d="M7 4l13 8-13 8V4z"/></svg>';
// Кнопка быстрого добавления в комнату (renderMovieResultCard) — тот же плюс,
// что у #addMovieBtn в шапке комнаты.
const PLUS_ICON = '<svg class="icon" viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';

/** Единая компактная карточка фильма — постер (с меню действий, бейджем в
    правом верхнем углу поверх обложки), кружок личной оценки слева от
    названия, название/год и кнопка «Смотреть» (kinopoiskCxUrl в новой
    вкладке) у правого края строки названия. Раньше это была только плитка
    витрины «Из базы» — теперь ЕДИНСТВЕННЫЙ вид карточки фильма по всему
    сервису (очередь комнаты, история, «Что мы смотрели», «Мой список» —
    см. renderMovieCard/renderHistoryCard/renderWatchedInto/renderMyListInto
    ниже, все четыре стали тонкими обёртками вокруг этой функции). Клик по
    САМОЙ карточке (не по вложенным кнопкам/меню/кружку оценки) открывает
    модалку «Фильм» (openMovieInfoModal — сама подгружает список комнат и
    недостающие подробности, повторного запроса тут заводить не нужно).
    tile — не <button> (внутри свои кнопки — <button> в <button> невалиден)
    — div[role=button][tabindex=0] со своим keydown на Enter/Space, тот же
    приём, что у .movie-card-pick (renderMovieResultCard).

    opts:
      menu      — готовый DOM-узел меню действий (renderAddToMenu ИЛИ
                  renderCardMenu со своим набором пунктов под конкретный
                  экран) — бейджем поверх постера.
      rating    — {kinopoiskId, score} — если передано, рисует кружок личной
                  оценки (renderRatingBadge) слева от названия.
      extraLine — доп. muted-строка под годом (например, дата просмотра у
                  истории) — просто текст, разметку сама не решает. */
function renderMovieTile(mv, opts = {}) {
  const tile = el("div", "movie-tile");
  tile.setAttribute("role", "button");
  tile.tabIndex = 0;
  tile.innerHTML = `
    <div class="movie-tile-poster-wrap">
      ${mv.posterUrl ? `<img class="movie-poster" src="${esc(mv.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
    </div>
    <div class="movie-tile-title-row">
      <div class="movie-tile-title-col">
        <div class="title">${esc(mv.title)}</div>
        ${mv.year ? `<div class="muted sub">${esc(mv.year)}</div>` : ""}
        ${opts.extraLine ? `<div class="muted sub">${esc(opts.extraLine)}</div>` : ""}
      </div>
    </div>`;

  const posterWrap = tile.querySelector(".movie-tile-poster-wrap");
  // Меню действий — бейджем в ВЕРХНЕМ правом углу поверх обложки (см.
  // .movie-tile-poster-wrap .menu-wrap в styles.css), renderCardMenu уже
  // гасит клики stopPropagation на всей обёртке — своего обработчика тут не
  // нужно.
  if (opts.menu) posterWrap.append(opts.menu);

  // Кружок оценки — НИЖНИМ правым углом поверх обложки, только когда оценка
  // реально есть (её не поставить с компактной карточки, это делают через
  // звёзды в модалке «Фильм» — renderMovieInfoModal; кружок тут просто
  // показывает уже стоящее число и даёт быстро его поменять/снять через
  // openRateModal). mv.myScore — единственный источник правды (а не снимок в
  // opts на момент рендера): syncRatingBadge() пересобирает бейдж заново по
  // текущему значению, поэтому её же можно звать и после того, как оценку
  // поставили/сняли/поменяли в модалке «Фильм» — плитка обновится на месте,
  // не дожидаясь перезагрузки всего экрана (см. openInfo ниже).
  let badge = null;
  const syncRatingBadge = () => {
    if (badge) { badge.remove(); badge = null; }
    if (mv.myScore) {
      badge = renderRatingBadge(mv.kinopoiskId, mv.myScore, score => { mv.myScore = score; });
      posterWrap.append(badge);
    }
  };
  syncRatingBadge();

  // opts.onChange — для мест, где просмотр/оценка из модалки «Фильм» может
  // изменить состав ИМЕННО этого списка (напр. «Отметить просмотренным» в
  // комнате переносит фильм из очереди в историю — см. renderMovieCard) —
  // необязателен: витрине/жанровым полкам/«Что мы смотрели» состав менять
  // неоткуда (это не queue/watched-разделение), там достаточно
  // syncRatingBadge() без полной перезагрузки.
  const openInfo = () => openMovieInfoModal(mv, () => {
    syncRatingBadge();
    if (opts.onChange) opts.onChange();
  });
  tile.onclick = e => { if (!e.target.closest("button")) openInfo(); };
  tile.addEventListener("keydown", e => {
    if (e.target.closest("button")) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openInfo(); }
  });

  const watchBtn = el("button", "icon-btn xs");
  watchBtn.type = "button";
  watchBtn.title = "Смотреть";
  watchBtn.setAttribute("aria-label", "Смотреть");
  watchBtn.innerHTML = PLAY_ICON;
  watchBtn.onclick = e => { e.stopPropagation(); window.open(kinopoiskCxUrl(mv.kinopoiskId), "_blank", "noopener"); };
  tile.querySelector(".movie-tile-title-row").append(watchBtn);

  return tile;
}

/** Модалка «Фильм» — открывается по клику на плитку витрины. Один и тот же
    DOM-узел #movieInfoModalBackdrop переиспользуется под любой фильм: тело
    перерисовывается целиком (body.innerHTML = ...) при каждом клике, новых
    id не плодим. Раскладка по эскизу пользователя: крупный постер во всю
    ширину модалки (.movie-info-poster, aspect-ratio:2/3 — сохраняет
    пропорции, поэтому блок стал выше, а не просто шире), под ним в одну
    строку название+год слева и чипы-рейтинги справа (.movie-info-caption),
    затем строка личной оценки (.movie-info-rating — обычная шкала из 10
    звёзд, renderStarRating, тот же компонент, что и в кружке-бейдже
    компактной карточки, см. renderRatingBadge/openRateModal ниже), затем
    разделитель, режиссёр/актёры/описание (тот же формат, что «Подробнее» у
    карточки очереди — renderMovieDetail, но тут без сворачивания, это и
    есть весь контент модалки), и внизу рядом друг с другом «Смотреть»/
    «Страница на Кинопоиске» (.movie-info-actions).
    Меню «Добавить в…» — по-прежнему в шапке модалки рядом с крестиком
    закрытия (см. ниже #movieInfoModalMenuWrap), не над постером.
    onChange (необязателен) — зовётся сразу после того, как что-то в модалке
    реально поменялось (оценка звёздами, «Отметить просмотренным», «Добавить
    в комнату/список»): карточка, с которой модалку открыли, реагирует сразу
    же, не дожидаясь закрытия модалки и тем более следующей полной
    перезагрузки экрана — см. renderMovieTile/openMovieInfoModal выше. */
function renderMovieInfoModal(mv, rooms, onChange) {
  const year = mv.year ? ` (${mv.year})` : "";
  $("movieInfoModalTitle").textContent = `${mv.title}${year}`;
  const body = $("movieInfoModalBody");
  body.innerHTML = `
    <div class="movie-info-poster">
      ${mv.posterUrl ? `<img src="${esc(mv.posterUrl)}" alt="">` : ""}
    </div>
    <div class="movie-info-caption">
      <div class="title">${esc(mv.title)}${esc(year)}</div>
      <div class="chip-row">${movieChipsHtml(mv)}</div>
    </div>
    <div class="movie-info-rating">
      <span class="muted">Ваша оценка</span>
      <div data-act="myRating"></div>
    </div>
    <div class="movie-info-sep"></div>
    <div class="movie-detail"></div>
    <div class="row movie-info-actions">
      <button class="btn filled" id="movieInfoWatchBtn">${PLAY_ICON}<span>Смотреть</span></button>
      <button class="btn outlined" id="movieInfoKpBtn">Страница на Кинопоиске</button>
    </div>`;

  // onRated не перерисовывает chip-row/avgScore здесь — сервер пересчитает
  // среднюю только при следующей полной загрузке данных (та же логика, что
  // раньше была у карточки истории, просто перенесённая в модалку). mv —
  // тот же объект, что держит вызвавшая карточка, поэтому mv.myScore = score
  // уже видно снаружи; onChange() досылает карточке сигнал перерисовать
  // СВОЙ бейдж оценки прямо сейчас, а не по следующей загрузке экрана.
  renderStarRating(body.querySelector('[data-act="myRating"]'), mv.kinopoiskId, mv.myScore, score => {
    mv.myScore = score;
    if (onChange) onChange();
  });

  const roles = [];
  if (mv.director) roles.push(`<p><b>Режиссёр:</b> ${esc(mv.director)}</p>`);
  if (mv.actors.length) roles.push(`<p><b>В ролях:</b> ${esc(mv.actors.join(", "))}</p>`);
  const desc = mv.description
    ? `<p class="movie-desc${roles.length ? " has-sep" : ""}">${esc(mv.description)}</p>`
    : "";
  body.querySelector(".movie-detail").innerHTML = roles.join("") + desc || '<p class="muted">Подробностей нет.</p>';

  // Кнопки добавления — тем же компактным меню «Добавить в…», что и на
  // плитке витрины (renderAddToMenu), но в шапке модалки рядом с крестиком
  // закрытия, а не бейджем поверх постера: постер тут узкий и лежит слева в
  // .movie-card-head (не на всю ширину, как у плитки), поэтому бейджу над
  // ним просто некуда раскрыть .menu, не вылезая за левый край окна.
  const menuWrapBox = $("movieInfoModalMenuWrap");
  menuWrapBox.textContent = "";
  menuWrapBox.append(renderAddToMenu(mv.kinopoiskId, rooms, onChange));
  body.querySelector("#movieInfoWatchBtn").onclick = () => window.open(kinopoiskCxUrl(mv.kinopoiskId), "_blank", "noopener");
  body.querySelector("#movieInfoKpBtn").onclick = () => window.open(kinopoiskRuUrl(mv.kinopoiskId), "_blank", "noopener");
}

/** Открывает модалку «Фильм» для ЛЮБОЙ карточки по всему сервису — очередь/
    история/watched/мой список (moviePayload у них и так уже полный,
    director/actors/description закэшированы сервером) И результаты поиска
    (renderMovieResultCard/renderSearchResultRow) — у результатов /api/search
    этих полей ещё нет (undefined, не пустой массив — так отличаем «не
    грузили» от «пусто»), поэтому сначала лениво подгружаем полную карточку
    через GET /api/movies/:id (тот же ensureMovieCached, что и добавление —
    заодно кэшируется на сервере) и пишем результат прямо в mv, чтобы
    повторное открытие той же карточки в этой сессии фронта уже не ходило в
    сеть. Список комнат для «Добавить в…» в шапке модалки — свежий при
    каждом открытии (могли создать комнату в другой вкладке). */
async function openMovieInfoModal(mv, onChange) {
  const hasSomething = mv.director || (mv.actors && mv.actors.length) || mv.description;
  if (!hasSomething && !mv.__detailsLoaded) {
    const data = await act(() => api(`/movies/${mv.kinopoiskId}`));
    if (!data) return;
    Object.assign(mv, data);
    mv.__detailsLoaded = true;
  }
  const roomsData = await act(() => api("/rooms"));
  renderMovieInfoModal(mv, roomsData ? roomsData.rooms : [], onChange);
  openModal("movieInfoModalBackdrop");
}

// Пагинация комнат — целиком на фронте (список и так уже загружен целиком
// через GET /api/rooms, свой лимит/оффсет на бэке заводить незачем: для
// личного проекта такого масштаба десятки комнат — уже много). page
// сбрасывается в showRooms() при каждом заходе на экран (см. там), чтобы
// после создания/выхода из комнаты не залипать на несуществующей странице.
const ROOMS_PAGE_SIZE = 5;
let roomsPage = 0;

function renderRooms() {
  const box = $("roomList");
  box.textContent = "";
  $("roomsEmpty").hidden = state.rooms.length > 0;

  const pages = Math.max(1, Math.ceil(state.rooms.length / ROOMS_PAGE_SIZE));
  roomsPage = Math.min(roomsPage, pages - 1);
  const start = roomsPage * ROOMS_PAGE_SIZE;
  const pageRooms = state.rooms.slice(start, start + ROOMS_PAGE_SIZE);

  for (const r of pageRooms) {
    const card = el("button", "card");
    card.innerHTML = `
      <div class="title">${esc(r.title)}</div>
      <div class="sub muted">${r.members} ${plural(r.members, "участник", "участника", "участников")}${r.myRole === "owner" ? " · вы владелец" : ""}</div>`;
    card.onclick = () => { location.hash = "#/room/" + r.id; };
    box.append(card);
  }

  const showPager = state.rooms.length > ROOMS_PAGE_SIZE;
  $("roomsPager").hidden = !showPager;
  if (showPager) {
    $("roomsPagerLabel").textContent = `Стр. ${roomsPage + 1} из ${pages}`;
    $("roomsPrevBtn").disabled = roomsPage <= 0;
    $("roomsNextBtn").disabled = roomsPage >= pages - 1;
  }
}
$("roomsPrevBtn").onclick = () => { roomsPage = Math.max(0, roomsPage - 1); renderRooms(); };
$("roomsNextBtn").onclick = () => { roomsPage += 1; renderRooms(); };

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
}

// Обе формы (создание/присоединение) теперь живут в своих модалках
// (#createRoomModalBackdrop/#joinRoomModalBackdrop, открываются широкими
// кнопками под списком комнат — см. index.html), сами поля/обработчики не
// изменились, только закрывают свою модалку при успешном действии.
$("createRoomBtn").onclick = async () => {
  const input = $("newRoomTitle");
  const title = input.value.trim();
  const data = await act(() => api("/rooms", { method: "POST", body: { title: title || "Новая комната" } }));
  if (!data) return;
  input.value = "";
  closeModal("createRoomModalBackdrop");
  location.hash = "#/room/" + data.room.id;
};
$("newRoomTitle").addEventListener("keydown", e => { if (e.key === "Enter") $("createRoomBtn").click(); });

function goToCode(raw) {
  const code = raw.trim().toUpperCase();
  if (!code) return;
  closeModal("joinRoomModalBackdrop");
  location.hash = "#/join/" + code;
}
$("joinCodeBtn").onclick = () => goToCode($("joinCodeInput").value);
$("joinCodeInput").addEventListener("keydown", e => { if (e.key === "Enter") goToCode(e.target.value); });
bindModal("createRoomModalBackdrop", "createRoomOpenBtn", "createRoomModalClose");
bindModal("joinRoomModalBackdrop", "joinRoomOpenBtn", "joinRoomModalClose");

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
    подкрашенным как .chip.rating. BH — средняя оценка внутри НАШЕГО
    сервиса (mv.avgScore, агрегат movie_marks, см. markSummary на бэке), не
    путать с kpRating/imdbRating — это Кинопоиск/IMDb, они приходят с
    poiskkino.dev и тут же рядом просто для сравнения. avgScore есть не у
    каждого mv — только там, где сервер сам его подобрал (см. комментарий у
    moviePayload в server.js), поэтому чип условный, как и остальные. */
function movieChipsHtml(mv) {
  const chips = [];
  if (mv.genres.length) chips.push(`<span class="chip">${esc(mv.genres.join(", "))}</span>`);
  if (mv.kpRating) chips.push(`<span class="chip rating">КП ${esc(mv.kpRating)}</span>`);
  if (mv.imdbRating) chips.push(`<span class="chip rating">IMDb ${esc(mv.imdbRating)}</span>`);
  if (mv.avgScore != null) chips.push(`<span class="chip rating">BH ${esc(mv.avgScore)}</span>`);
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
    кнопок действий: те разные у вызывающих (renderMovieResultCard — своя
    «+», renderSearchResultRow — вообще без кнопок, вся строка ведёт к
    подробностям, см. ниже). */
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
    известна из state.room) — как и везде по сервису, клик по самой карточке
    открывает подробности (openMovieInfoModal), а быстрое действие — своя
    кнопка сверху: тут это «+» (добавляет в текущую комнату сразу, без похода
    в подробности — именно ради этого и открыта эта модалка). Раньше клик по
    всей карточке добавлял фильм напрямую, а стрелка открывала подробности —
    поведение развернули ради единообразия с остальными списками (плитка
    витрины, строка глобального поиска — везде клик = подробности, действия
    своими кнопками). Настоящий <button> для всей карточки не подходит:
    внутри есть свой icon-btn «+», а <button> в <button> невалиден — поэтому
    div с role="button"/tabindex + свой keydown на Enter/Space. */
function renderMovieResultCard(mv) {
  const card = el("div", "movie-card movie-card-pick");
  card.setAttribute("role", "button");
  card.tabIndex = 0;

  const head = renderMovieResultRow(mv);
  const addBtn = el("button", "icon-btn xs");
  addBtn.type = "button";
  addBtn.title = "Добавить в комнату";
  addBtn.setAttribute("aria-label", "Добавить в комнату");
  addBtn.innerHTML = PLUS_ICON;
  // stopPropagation — клик по «+» не должен всплывать до card.onclick и
  // открывать подробности заодно с добавлением.
  addBtn.onclick = e => {
    e.stopPropagation();
    act(async () => {
      const roomId = state.room.room.id;
      const r = await api(`/rooms/${roomId}/movies`, { method: "POST", body: { kinopoiskId: mv.kinopoiskId } });
      closeModal("addMovieModalBackdrop");
      await openRoom(roomId);
      return r;
    }, "Фильм добавлен");
  };
  head.append(addBtn);
  card.append(head);

  const openInfo = () => openMovieInfoModal(mv);
  card.onclick = e => { if (!e.target.closest("button")) openInfo(); };
  card.addEventListener("keydown", e => {
    if (e.target.closest("button")) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openInfo(); }
  });

  return card;
}

function renderMovieResults(movies) {
  const box = $("movieSearchResults");
  box.textContent = "";
  if (!movies.length) { box.append(el("p", "muted", "Ничего не нашлось.")); return; }
  for (const mv of movies) box.append(renderMovieResultCard(mv));
}

/** Переиспользуемый блок «добавить в комнату» — список комнат пользователя,
    клик по названию сразу добавляет (без отдельного select+кнопки
    «Добавить» — раньше выбор и подтверждение были двумя шагами, теперь один),
    либо подсказка «Сначала создайте комнату», если комнат нет вовсе. Список
    ограничен по высоте (.room-pick-list в styles.css — примерно 5 строк,
    остальное через прокрутку), чтобы не разъезжаться на пол-экрана при
    большом числе комнат. Один и тот же компонент используется в пункте
    «Добавить в комнату» меню карточки личного списка (renderMyListInto) и
    меню renderAddToMenu (плитка витрины, модалка «Фильм» — единственное
    место, где теперь есть выбор комнаты у результатов поиска, см. план
    задачи «обновим вёрстку на главной»). onAdded(roomId) зовётся ПОСЛЕ
    успешного добавления — вызывающий код решает, как известить пользователя. */
function renderRoomPicker(container, kinopoiskId, rooms, onAdded) {
  container.textContent = "";
  if (!rooms.length) {
    container.append(el("span", "muted", "Сначала создайте комнату"));
    return;
  }
  const list = el("div", "room-pick-list");
  for (const r of rooms) {
    const btn = el("button", "menu-item", r.title);
    btn.type = "button";
    btn.onclick = () => act(async () => {
      await api(`/rooms/${r.id}/movies`, { method: "POST", body: { kinopoiskId } });
      if (onAdded) onAdded(r.id);
    }, "Фильм добавлен в комнату");
    list.append(btn);
  }
  container.append(list);
}

/** Строка результата поиска — общая для шапки (глобальный поиск) и главной
    (поиск на главной): та же шапка постер+инфо, что и у карточки локального
    поиска в комнате (renderMovieResultRow), но без своих кнопок действий —
    комната заранее не известна, поэтому «Отметить просмотренным»/«Добавить
    в…» доступны только через модалку «Фильм» (её собственное меню в шапке,
    см. renderMovieInfoModal), которую открывает клик по всей строке — тот
    же приём, что и у .movie-card-pick (renderMovieResultCard), только тут
    строка ведёт к подробностям, а не к добавлению. */
function renderSearchResultRow(mv) {
  const wrap = el("div", "movie-card movie-card-pick");
  wrap.setAttribute("role", "button");
  wrap.tabIndex = 0;
  wrap.append(renderMovieResultRow(mv));

  const openInfo = () => openMovieInfoModal(mv);
  wrap.onclick = openInfo;
  wrap.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openInfo(); }
  });

  return wrap;
}

function renderMovies() {
  const { room, movies } = state.room;
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
  for (const rm of history) historyList.append(renderHistoryCard(rm, room));

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
  // Число справа от звёзд: постоянно видимая цифра текущей оценки — не
  // только тултип на звезде. При наведении/фокусе показывает наведённое
  // значение (живой предпросмотр в паре с paint), при уходе курсора и
  // после клика откатывается/обновляется на реально сохранённый score.
  const scoreLabel = el("span", "star-rating-score muted");
  const paintScore = n => { scoreLabel.textContent = n ? String(n) : ""; };
  for (let i = 1; i <= 10; i++) {
    const btn = el("button", "star-btn", "★");
    btn.type = "button";
    btn.title = String(i);
    btn.setAttribute("aria-label", `Оценка ${i} из 10`);
    btn.onmouseenter = () => { paint(i); paintScore(i); };
    btn.onfocus = () => { paint(i); paintScore(i); };
    btn.onclick = () => act(async () => {
      const clear = score === i;
      if (clear) await api(`/movies/${kinopoiskId}/rating`, { method: "DELETE" });
      else await api(`/movies/${kinopoiskId}/rating`, { method: "PUT", body: { score: i } });
      score = clear ? 0 : i;
      paint(score);
      paintScore(score);
      if (onRated) onRated(score || null);
    }, score === i ? "Оценка снята" : "Оценка сохранена");
    stars.push(btn);
    container.append(btn);
  }
  container.onmouseleave = () => { paint(score); paintScore(score); };
  paint(score);
  paintScore(score);
  container.append(scoreLabel);
}

/** Кружок личной оценки нижним правым углом поверх обложки на компактной
    карточке (renderMovieTile) — только число, без звезды: показывается,
    только когда оценка реально есть (renderMovieTile сам решает, звать эту
    функцию или нет — см. её вызов). Поставить ПЕРВУЮ оценку с компактной
    карточки нельзя — для этого есть шкала звёзд в модалке «Фильм»
    (renderMovieInfoModal); этот кружок — быстрый способ увидеть и
    поменять/снять уже стоящую. Клик открывает #rateModalBackdrop
    (openRateModal) с той же шкалой и кнопкой «Готово». Если оценку сняли —
    кружку больше нечего показывать, убираем его из DOM целиком, а не
    откатываем на пустую звезду (её больше нет, см. правку). stopPropagation
    — клик по кружку не должен открывать модалку «Фильм» саму по себе
    (кружок сидит внутри кликабельной целиком плитки). */
function renderRatingBadge(kinopoiskId, score, onRated) {
  const badge = el("button", "rating-badge", String(score));
  badge.type = "button";
  const label = s => `Ваша оценка: ${s} из 10 — изменить`;
  badge.title = label(score);
  badge.setAttribute("aria-label", badge.title);
  badge.onclick = e => {
    e.stopPropagation();
    openRateModal(kinopoiskId, score, newScore => {
      score = newScore;
      if (!score) { badge.remove(); }
      else {
        badge.textContent = String(score);
        badge.title = label(score);
        badge.setAttribute("aria-label", badge.title);
      }
      if (onRated) onRated(score);
    });
  };
  return badge;
}

/** Окошко «Оценка» (#rateModalBackdrop, разметка — index.html) — открывается
    из renderRatingBadge. Тело каждый раз перерисовывается заново тем же
    renderStarRating, что и везде — «Готово» просто закрывает модалку, сама
    оценка уже сохранена на сервере кликом по звезде (see renderStarRating),
    отдельного «сохранить» не нужно. */
function openRateModal(kinopoiskId, currentScore, onRated) {
  const body = $("rateModalBody");
  body.textContent = "";
  renderStarRating(body, kinopoiskId, currentScore, score => { if (onRated) onRated(score); });
  openModal("rateModalBackdrop");
}

// Меню действий карточки очереди/истории (три точки в правом верхнем углу) —
// «Отметить просмотренным»/«Убрать из комнаты» (очередь) и «Вернуть в
// очередь» (история) переехали сюда из отдельных кнопок (см. планы задач
// «сетка очереди» и «карточки истории»). В отличие от
// roomMenu/csvMenu/accountMenu — по одному фиксированному id на всю
// страницу — карточек в списках может быть много, и у каждой своё меню.
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

/** Универсальное меню-«…» карточки (бейджем поверх постера у компактной
    плитки — renderMovieTile — или где ещё понадобится) — единая точка,
    из которой все конкретные меню по сервису (добавить в…, действия
    очереди/истории, действия «моего списка») собирают СВОЙ набор пунктов.
    items — [{label, danger, onClick(menu)}] в порядке показа. onClick
    получает сам DOM-узел .menu — нужно тем пунктам, что подменяют его
    содержимое (напр. «Добавить в комнату» → renderRoomPicker); остальные
    просто делают действие (обычно через act(...)) и сами вызывают
    closeCardMenu(), если её нужно закрыть сразу.

    Баг, который тут чинится централизованно (раньше правился в трёх местах
    по отдельности — renderAddToMenu/renderWatchedInto/renderMyListInto):
    .menu — один и тот же DOM-узел на всё время жизни меню, а некоторые
    пункты ПОДМЕНЯЮТ его содержимое. closeCardMenu() только прячет узел
    (menu.hidden = true), содержимое не сбрасывает — без явного сброса
    следующее открытие показывало бы застрявшее чужое содержимое вместо
    исходного списка items. Чиним оборачиванием onclick, который уже повесил
    bindMovieCardMenu: при переходе «было закрыто → стало открыто»
    перерисовываем .menu заново тем же items. wrap.onclick(stopPropagation) —
    чтобы клики внутри меню не всплывали до кликабельных родителей (плитка
    витрины целиком открывает модалку по клику). */
function renderCardMenu(items, opts = {}) {
  const wrap = el("div", "menu-wrap");
  const title = opts.title || "Действия с фильмом";
  wrap.innerHTML = `
    <button class="icon-btn xs" data-act="cardMenuBtn" type="button" title="${esc(title)}" aria-label="${esc(title)}" aria-haspopup="true" aria-expanded="false">
      <svg class="icon" viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/></svg>
    </button>
    <div class="menu" data-act="cardMenu" hidden></div>`;
  wrap.onclick = e => e.stopPropagation();

  const menu = wrap.querySelector('[data-act="cardMenu"]');
  const renderItems = () => {
    menu.innerHTML = "";
    for (const item of items) {
      const btn = el("button", "menu-item" + (item.danger ? " danger" : ""), item.label);
      btn.type = "button";
      btn.onclick = () => item.onClick(menu);
      menu.append(btn);
    }
  };
  renderItems();

  bindMovieCardMenu(wrap);
  const btn = wrap.querySelector('[data-act="cardMenuBtn"]');
  const toggle = btn.onclick;
  btn.onclick = e => {
    const wasHidden = menu.hidden;
    toggle(e);
    if (wasHidden && !menu.hidden) renderItems();
  };
  return wrap;
}

/** Меню действий с фильмом — компактная замена ВСЕГДА-видимого
    renderRoomPicker для мест, где место ЖАЛКО (узкая плитка) и для модалки
    «Фильм»: плитка витрины (renderMovieTile) и модалка (renderMovieInfoModal,
    там же раньше стояла отдельная кнопка «Отметить просмотренным» рядом со
    шкалой оценки — перенесена сюда, в дропдаун). Строки поиска
    (renderSearchResultRow) это меню больше НЕ используют — весь смысл
    строки поиска в том, что комната заранее не известна, поэтому там нет
    вообще никаких кнопок, только клик по строке в модалку, где это меню и
    доступно (см. план задачи «обновим вёрстку на главной»). «В личный
    список» — сразу выполняет действие (POST /my-list), «Добавить в
    комнату» подменяет содержимое .menu на renderRoomPicker (select комнат +
    кнопка) — сам пикер, без второй кнопки личного списка, она отдельным
    пунктом уровнем выше. Заголовок по умолчанию («Действия с фильмом» —
    см. renderCardMenu) тут ничем не переопределяем: раньше был «Добавить
    в…», но с «Отметить просмотренным» внутри это уже не только добавление.
    Каждый пункт сам закрывает меню (closeCardMenu()) после действия — раньше
    «Отметить просмотренным»/«В личный список» этого не делали (баг: меню
    оставалось открытым после успешного действия), а «Добавить в комнату»
    даже не закрывалось после выбора комнаты в пикере. onChange (необязателен,
    зовёт вызывающая карточка — renderMovieTile/renderMovieInfoModal) —
    сигнал «что-то поменялось» для реактивности карточки на месте, без
    полной перезагрузки экрана. */
function renderAddToMenu(kinopoiskId, rooms, onChange) {
  return renderCardMenu([
    {
      label: "Отметить просмотренным",
      onClick: () => act(async () => {
        closeCardMenu();
        await api(`/movies/${kinopoiskId}/watched`, { method: "POST" });
        if (onChange) onChange();
      }, "Отмечено просмотренным"),
    },
    {
      label: "Добавить в комнату",
      onClick: menu => renderRoomPicker(menu, kinopoiskId, rooms, () => {
        closeCardMenu();
        if (onChange) onChange();
      }),
    },
    {
      label: "В личный список",
      onClick: () => act(async () => {
        closeCardMenu();
        await api("/my-list", { method: "POST", body: { kinopoiskId } });
        if (onChange) onChange();
      }, "Добавлено в личный список"),
    },
  ]);
}

// Карточка очереди — только queued (watched теперь отдельным списком в
// renderHistoryCard ниже, см. renderMovies). Тонкая обёртка вокруг единой
// renderMovieTile (см. её шапку) — своё тут только меню действий
// («Отметить просмотренным»/«Убрать из комнаты»).
function renderMovieCard(rm, room) {
  const mv = rm.movie;
  const menu = renderCardMenu([
    {
      label: "Отметить просмотренным",
      onClick: () => act(async () => {
        closeCardMenu();
        await api(`/rooms/${room.id}/movies/${mv.kinopoiskId}/watched`, { method: "POST" });
        await openRoom(room.id);
      }, "Отмечено просмотренным"),
    },
    {
      label: "Убрать из комнаты", danger: true,
      onClick: () => act(async () => {
        closeCardMenu();
        await api(`/rooms/${room.id}/movies/${mv.kinopoiskId}`, { method: "DELETE" });
        await openRoom(room.id);
      }, "Фильм убран из комнаты"),
    },
  ]);
  // onChange — если оценку/«В личный список»/«Добавить в комнату» сделали
  // из модалки «Фильм» (не из этого меню), комната перечитывается так же,
  // как после действий из самого меню выше — карточка не остаётся в
  // устаревшем состоянии до следующего захода в комнату.
  return renderMovieTile(mv, { menu, onChange: () => openRoom(room.id) });
}

// Карточка истории — watched в ЭТОЙ комнате. Тоже тонкая обёртка вокруг
// renderMovieTile: своё тут только «Вернуть в очередь» в меню и дата
// просмотра доп. строкой (без «кем» — так попросили, у карточки для этого
// нет места; кто именно отметил, по-прежнему видно в самой комнате через
// watchedBy, если понадобится).
function renderHistoryCard(rm, room) {
  const mv = rm.movie;
  const whenText = rm.watchedAt ? new Date(rm.watchedAt).toLocaleDateString("ru") : "—";
  const menu = renderCardMenu([
    {
      label: "Вернуть в очередь",
      onClick: () => act(async () => {
        closeCardMenu();
        await api(`/rooms/${room.id}/movies/${mv.kinopoiskId}/watched`, { method: "DELETE" });
        await openRoom(room.id);
      }, "Возвращено в очередь"),
    },
  ]);
  return renderMovieTile(mv, {
    menu,
    onChange: () => openRoom(room.id),
    extraLine: `Просмотрено ${whenText}`,
  });
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
  const needsConfirm = report.needsConfirm || [];
  if (needsConfirm.length) parts.push(`требует подтверждения: ${needsConfirm.length}`);
  snack("CSV: " + parts.join(", "));
  if (needsConfirm.length) openImportConfirm(roomId, needsConfirm);
};

/** Строки импорта, где год из файла не совпал ни с одним найденным
    вариантом (сервер уже нашёл кандидата по названию — см.
    importRoomCsv/needsConfirm), но молча брать его не стали — попросили
    явно спрашивать «это тот фильм?» на каждую такую строку. «Это он»
    переиспользует обычное добавление в комнату (POST .../movies) +
    watched/rating из исходной строки CSV; «Пропустить» просто убирает
    строку из списка, ничего не добавляя. Когда список опустевает — модалка
    закрывается и комната перечитывается, чтобы подтверждённые фильмы сразу
    появились в очереди/истории. */
function openImportConfirm(roomId, items) {
  $("importConfirmHint").textContent = items.length === 1
    ? "Год из файла не совпал — вот что нашлось по названию."
    : `Год из файла не совпал у ${items.length} фильмов — вот что нашлось по названию.`;
  const list = $("importConfirmList");
  list.textContent = "";
  for (const item of items) list.append(renderImportConfirmRow(roomId, item));
  openModal("importConfirmModalBackdrop");
}

function renderImportConfirmRow(roomId, item) {
  const card = el("div", "movie-card");
  const foundYear = item.year ? ` (${item.year})` : "";
  const reqYear = item.requestedYear != null ? ` (${item.requestedYear})` : "";
  card.innerHTML = `
    <div class="movie-card-head">
      ${item.posterUrl ? `<img class="movie-poster" src="${esc(item.posterUrl)}" alt="">` : '<div class="movie-poster"></div>'}
      <div class="movie-info">
        <div class="muted">В файле: ${esc(item.requestedTitle)}${esc(reqYear)}</div>
        <div class="title">${esc(item.title || "")}${esc(foundYear)}</div>
      </div>
    </div>
    <div class="row">
      <button class="btn filled sm" type="button" data-act="yes">Это он</button>
      <button class="btn outlined sm" type="button" data-act="skip">Пропустить</button>
    </div>`;
  card.querySelector('[data-act="yes"]').onclick = () => act(async () => {
    await api(`/rooms/${roomId}/movies`, { method: "POST", body: { kinopoiskId: item.kinopoiskId } });
    if (item.status === "watched") await api(`/rooms/${roomId}/movies/${item.kinopoiskId}/watched`, { method: "POST" });
    if (item.rating != null) await api(`/movies/${item.kinopoiskId}/rating`, { method: "PUT", body: { score: item.rating } });
    finishImportConfirmRow(card, roomId);
  });
  card.querySelector('[data-act="skip"]').onclick = () => finishImportConfirmRow(card, roomId);
  return card;
}

function finishImportConfirmRow(card, roomId) {
  card.remove();
  if (!$("importConfirmList").children.length) {
    closeModal("importConfirmModalBackdrop");
    openRoom(roomId);
  }
}

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
  closeRoomMenu(); closeAccountMenu(); closeCsvMenu(); closeCardMenu(); closeGlobalSearch();
  if (openModalId) closeModal(openModalId);
  if (tourActive()) endTour();
});

$("accountMenuManage").onclick = () => { closeAccountMenu(); window.open(auth.accountUrl(), "_blank", "noopener"); };
$("accountMenuLogout").onclick = () => { closeAccountMenu(); auth.logout(); };
$("accountMenuTour").onclick = () => {
  closeAccountMenu();
  // Шаги обучения показывают только элементы главной — если сейчас другой
  // экран (комната/watched/…), сперва уводим на «#/» и даём route() время
  // отрисоваться, иначе цели первых шагов просто не найдутся (см. tourStepVisible).
  if (location.hash !== "#/" && location.hash !== "") {
    location.hash = "#/";
    setTimeout(startTour, 300);
  } else {
    startTour();
  }
};

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
bindModal("addMovieModalBackdrop", null, "addMovieModalClose");
bindModal("importConfirmModalBackdrop", null, "importConfirmModalClose");
// Свой обработчик открытия (не через bindModal) — сбрасывает старый
// запрос/результаты ПЕРЕД открытием, иначе повторное открытие в той же
// комнате показывало бы то, что искали в прошлый раз (тот же баг, что уже
// был у globalSearchBtn ниже, и там уже почищен точно так же).
$("addMovieBtn").onclick = () => {
  $("movieSearchInput").value = "";
  $("movieSearchResults").textContent = "";
  openModal("addMovieModalBackdrop");
};

// Модалка «Фильм» (плитка витрины «Из базы») — своей кнопки-открывашки нет,
// открывается из renderMovieTile() по клику на конкретную плитку.
bindModal("movieInfoModalBackdrop", null, "movieInfoModalClose");

// Модалка «Оценка» (кружок личной оценки на компактной карточке) — своей
// кнопки-открывашки нет, открывается из renderRatingBadge/openRateModal.
// «Готово» просто закрывает: сама оценка уже сохранена кликом по звезде.
bindModal("rateModalBackdrop", null, "rateModalClose");
$("rateModalDoneBtn").onclick = () => closeModal("rateModalBackdrop");

// ───────────────────────── импорт из IMDb (страница «Мои фильмы») ─────────────────────────
// Тело — сырой текст CSV-файла, тот же приём, что и у importCsvInput (импорт
// комнаты) выше: сервер ждёт text/csv, не JSON, поэтому мимо общего api().
async function postCsv(path, text) {
  const res = await auth.fetch("/api" + path, { method: "POST", headers: { "Content-Type": "text/csv" }, body: text });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

// Выключено до публикации расширения «Что смотрим: импорт с Кинопоиска»
// (см. KinopoiskImport/ — сейчас доступно только через «load unpacked» в
// режиме разработчика, обычным пользователям не поставить). IMDb-часть сама
// по себе уже рабочая и от расширения не зависит, но раз просили спрятать
// «Импорт» целиком одной кнопкой — выключаем оба сразу, а не только
// Кинопоиск, чтобы не путать наполовину активной кнопкой. Реактивация —
// один флаг, разметку/остальной код трогать не нужно.
const IMPORT_ENABLED = false;
if (!IMPORT_ENABLED) {
  const btn = $("importBtn");
  btn.disabled = true;
  btn.title = "Скоро будет";
  btn.append(el("span", "chip", "Скоро будет"));
}

bindModal("importModalBackdrop", null, "importModalClose");
$("importBtn").onclick = () => {
  $("importImdbRatingsInput").value = "";
  $("importImdbWatchlistInput").value = "";
  $("importImdbResult").textContent = "";
  $("importKinopoiskUrlInput").value = "";
  $("importKinopoiskResult").textContent = "";
  refreshKinopoiskExtensionStatus();
  openModal("importModalBackdrop");
};

/** Оба файла необязательны — можно загрузить только оценки, только
    watchlist, или оба разом. queued в отчёте — фильмы, для которых не
    хватило сегодняшней доли квоты poiskkino.dev: они не потеряны, лежат в
    очереди и докатятся сами в следующие дни (см. drainImportQueue на
    сервере), но сразу в списках их ещё не будет — стоит сказать об этом
    явно, а не оставлять полное число «импортировано» подвешенным в воздухе. */
$("importImdbSubmitBtn").onclick = async () => {
  const ratingsFile = $("importImdbRatingsInput").files[0];
  const watchlistFile = $("importImdbWatchlistInput").files[0];
  if (!ratingsFile && !watchlistFile) { snack("Выберите хотя бы один файл"); return; }

  const btn = $("importImdbSubmitBtn");
  btn.disabled = true;
  $("importImdbResult").textContent = "";
  const describe = (label, r) => {
    const parts = [`импортировано: ${r.imported}`];
    if (r.queued) parts.push(`в очереди на докачку: ${r.queued}`);
    if (r.skipped) parts.push(`пропущено: ${r.skipped}`);
    return `${label} — ${parts.join(", ")}`;
  };
  const lines = [];
  if (ratingsFile) {
    const text = await ratingsFile.text();
    const r = await act(() => postCsv("/import/imdb/ratings", text));
    if (r) lines.push(describe("Оценки", r));
  }
  if (watchlistFile) {
    const text = await watchlistFile.text();
    const r = await act(() => postCsv("/import/imdb/watchlist", text));
    if (r) lines.push(describe("Буду смотреть", r));
  }
  btn.disabled = false;

  $("importImdbResult").innerHTML = lines.length
    ? lines.map(l => `<p>${esc(l)}</p>`).join("")
    : '<p class="muted">Не удалось импортировать ни один из файлов.</p>';
  await showProfile(); // обновить списки под модалкой сразу же
};

// ───────────────────────── импорт с Кинопоиска (расширение) ─────────────────────────
// Прямой запрос с сервера к kinopoisk.ru блокирует антибот Яндекса по IP
// (проверено на практике — редирект на showcaptcha уже на голой главной),
// из JS этой же страницы — CORS (тоже проверено: "blocked by CORS policy").
// Решение — браузерное расширение (BurningHouse/KinopoiskImport), код
// которого выполняется в браузере пользователя: обычный IP снимает блок
// антибота, привилегированный контекст расширения снимает CORS. Общаемся с
// ним через chrome.runtime.sendMessage(EXTENSION_ID, ...) — работает только
// со страниц, перечисленных в его manifest.json → externally_connectable.
//
// ID ниже — от dev-ключа расширения (см. KinopoiskImport/README.md), стабилен
// при локальной загрузке через "Загрузить распакованное расширение", но
// Chrome Web Store при публикации назначит СВОЙ ID — тогда эту константу
// нужно будет обновить.
const KINOPOISK_EXTENSION_ID = "igmlehhgfmmkhnlbjidmpagbkedbdknp";

/** null, если расширения нет вовсе (chrome.runtime недоступен на странице —
    так бывает, если НИ ОДНО установленное расширение не объявило эту
    страницу в своём externally_connectable) или оно не ответило вовремя
    (chrome.runtime.lastError — например, расширение отключено). */
function extensionSendMessage(message) {
  return new Promise(resolve => {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) { resolve(null); return; }
    try {
      chrome.runtime.sendMessage(KINOPOISK_EXTENSION_ID, message, response => {
        if (chrome.runtime.lastError || !response) { resolve(null); return; }
        resolve(response);
      });
    } catch { resolve(null); }
  });
}

async function refreshKinopoiskExtensionStatus() {
  const pong = await extensionSendMessage({ type: "ping" });
  $("importKinopoiskNotInstalled").hidden = !!pong;
  $("importKinopoiskForm").hidden = !pong;
}

$("importKinopoiskSubmitBtn").onclick = async () => {
  const input = $("importKinopoiskUrlInput").value.trim();
  if (!input) { snack("Введите ссылку на профиль или username"); return; }

  const btn = $("importKinopoiskSubmitBtn");
  btn.disabled = true;
  $("importKinopoiskResult").textContent = "";

  const response = await extensionSendMessage({ type: "importKinopoisk", username: input });
  if (!response) {
    snack("Не удалось связаться с расширением — обновите страницу и проверьте, что оно включено");
    btn.disabled = false;
    return;
  }
  if (!response.ok) {
    const err = response.error || {};
    const message = err.privateOrEmpty ? "Профиль закрыт либо в нём ничего нет"
      : err.notFound ? "Профиль не найден"
      : err.message || "Не удалось получить данные с Кинопоиска";
    snack(message);
    btn.disabled = false;
    return;
  }

  const report = await act(() => api("/import/kinopoisk", {
    method: "POST",
    body: { rated: response.data.rated, watchlist: response.data.watchlist },
  }));
  btn.disabled = false;
  if (!report) return;

  $("importKinopoiskResult").innerHTML = [
    `<p>Оценки — импортировано: ${report.ratedImported}</p>`,
    `<p>Буду смотреть — добавлено: ${report.watchlistAdded}${report.watchlistSkipped ? `, пропущено (уже оценено/просмотрено/в списке): ${report.watchlistSkipped}` : ""}</p>`,
  ].join("");
  await showProfile();
};

// ───────────────────────── глобальный поиск (шапка, любая комната) ─────────────────────────
// Больше не модалка — тот же принцип, что у поиска на главной
// (runHomeSearch/renderHomeSearchResults выше): живой поиск по мере ввода
// (debounce), результаты сами всплывают под полем. Разница только в том,
// что здесь некуда «раздвинуть» страницу под результаты — шапка одна на
// весь сервис, поверх любого экрана, поэтому результаты — не часть потока
// страницы, а выпадающая панель (.header-search-results, position:absolute
// от .header-search, ширина ровно как у поля — см. styles.css), которая
// закрывается кликом снаружи, Escape или переходом на другой экран
// (hashchange). Каждая строка результата целиком кликабельна и открывает
// #movieInfoModalBackdrop (renderSearchResultRow) — там и «Отметить
// просмотренным», и «Добавить в…» (комната заранее не известна, поэтому не
// на самой строке — см. план задачи «обновим вёрстку на главной»).
// На узком экране (см. @media(max-width:30rem) в styles.css) поле+иконки
// шапки в один ряд не помещаются даже ужатыми — там виден только сам
// значок-лупа, а разворот на всю ширину шапки идёт через явный класс
// (а не просто :focus-within, как на десктопе), потому что открыть нужно
// ПО ТАПУ на саму лупу (значок не интерактивен без этого — inline input,
// пока закрыт, display:none и фокус поймать не может), а не по фокусу поля,
// которого ещё не видно.
const isMobileSearch = () => matchMedia("(max-width:30rem)").matches;
function openMobileSearch() {
  $("globalSearchWrap").classList.add("header-search-open");
  $("globalSearchInput").focus();
}
function closeGlobalSearch() {
  $("globalSearchResults").hidden = true;
  $("globalSearchWrap").classList.remove("header-search-open");
}

let globalSearchDebounce = null;
$("globalSearchWrap").addEventListener("click", () => {
  if (isMobileSearch() && !$("globalSearchWrap").classList.contains("header-search-open")) openMobileSearch();
});
$("globalSearchInput").addEventListener("input", () => {
  $("globalSearchClearBtn").hidden = !$("globalSearchInput").value;
  clearTimeout(globalSearchDebounce);
  globalSearchDebounce = setTimeout(runGlobalSearch, 300);
});
$("globalSearchInput").addEventListener("focus", () => {
  if ($("globalSearchInput").value.trim()) $("globalSearchResults").hidden = false;
});
$("globalSearchInput").addEventListener("keydown", e => {
  if (e.key === "Enter") { clearTimeout(globalSearchDebounce); runGlobalSearch(); }
  else if (e.key === "Escape") { e.target.blur(); closeGlobalSearch(); }
});
$("globalSearchClearBtn").onclick = e => {
  // Клик всплывает до обработчика на #globalSearchWrap (открытие по тапу на
  // мобильном, см. выше) — без stopPropagation закрытие тут же сменялось бы
  // повторным открытием тем же кликом.
  e.stopPropagation();
  $("globalSearchInput").value = "";
  $("globalSearchClearBtn").hidden = true;
  clearTimeout(globalSearchDebounce);
  closeGlobalSearch();
  $("globalSearchResults").textContent = "";
};
document.addEventListener("click", e => {
  if (!$("globalSearchWrap").contains(e.target)) closeGlobalSearch();
});

async function runGlobalSearch() {
  const q = $("globalSearchInput").value.trim();
  clearTimeout(globalSearchDebounce);
  if (!q) { closeGlobalSearch(); return; }
  const data = await act(() => api("/search?q=" + encodeURIComponent(q)));
  if (!data) return;
  // Запрос мог устареть, пока летел (строку успели стереть/поменять) — не
  // подсовываем результат уже не тому вводу (та же защита, что у
  // runHomeSearch).
  if ($("globalSearchInput").value.trim() !== q) return;
  renderGlobalSearchResults(data.movies);
}

function renderGlobalSearchResults(movies) {
  const box = $("globalSearchResults");
  box.textContent = "";
  box.hidden = false;
  if (!movies.length) { box.append(el("p", "muted", "Ничего не нашлось.")); return; }
  for (const mv of movies) box.append(renderSearchResultRow(mv));
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

// ───────────────────────── розыгрыш: настройки скорости ─────────────────────────
// Три отдельных значения в localStorage — тот же паттерн, что и
// "movies.theme"/ROUTE_KEY выше. Раньше диапазон (мин/макс) тоже был
// настраиваемым, попросили убрать — усложняло панель ради того, что почти
// никто не трогал, границы теперь просто фиксированные константы
// (DRAW_DURATION_BOUNDS), персистится только сама длительность.
// currentDrawDuration() читается ЗАНОВО в момент запуска каждой анимации
// (renderReel/spinWheelTo), а не кэшируется один раз при загрузке страницы —
// иначе смена настройки между прогонами не подхватывалась бы следующим
// «Крутить ещё раз».
const DRAW_DURATION_KEY = "movies.drawDuration";
// DEFAULT поднят с 3.2 до 6 — на старой скорости кандидаты пролетали мимо
// центра быстрее, чем успевал доиграть transform-переход укрупнения
// (.reel-item-focused, см. REEL_FOCUS_SCALE) — эффект просто не успевал
// стать заметным глазу. См. также REEL_LAPS ниже (меньше кругов — меньше
// суммарная дистанция на ту же длительность, то же самое соображение).
const DRAW_DURATION_BOUNDS = { min: 1, max: 10 };
const DRAW_DURATION_DEFAULT = 6;

function clampDrawDuration(value) {
  const v = Number.isFinite(value) ? value : DRAW_DURATION_DEFAULT;
  return Math.min(DRAW_DURATION_BOUNDS.max, Math.max(DRAW_DURATION_BOUNDS.min, v));
}
function loadDrawDuration() {
  return clampDrawDuration(parseFloat(localStorage.getItem(DRAW_DURATION_KEY)));
}
function saveDrawDuration(value) {
  const v = Math.round(clampDrawDuration(value) * 10) / 10;
  localStorage.setItem(DRAW_DURATION_KEY, String(v));
  return v;
}

/** Текущая длительность прокрутки в секундах — то, что реально читают
    renderReel/spinWheelTo перед стартом КАЖДОЙ анимации. */
function currentDrawDuration() { return loadDrawDuration(); }

// Масштаб колеса/карусели — в отличие от длительности, читается не в
// момент запуска анимации, а применяется напрямую к DOM как CSS-переменная
// --draw-scale на #drawStage (см. applyDrawScale ниже): и renderWheelSvg,
// и renderReel рисуют СВОИХ детей внутрь этого контейнера, а stage.innerHTML
// каждый раз перетирается заново (см. drawStartBtn.onclick), но сам атрибут
// style у #drawStage при этом не трогается — значит достаточно выставить
// переменную один раз при открытии экрана розыгрыша.
const DRAW_SCALE_KEY = "movies.drawScale";
const DRAW_SCALE_BOUNDS = { min: 0.6, max: 1.6 };
const DRAW_SCALE_DEFAULT = 1;
function clampDrawScale(value) {
  const v = Number.isFinite(value) ? value : DRAW_SCALE_DEFAULT;
  return Math.min(DRAW_SCALE_BOUNDS.max, Math.max(DRAW_SCALE_BOUNDS.min, v));
}
function loadDrawScale() {
  return clampDrawScale(parseFloat(localStorage.getItem(DRAW_SCALE_KEY)));
}
function saveDrawScale(value) {
  const v = Math.round(clampDrawScale(value) * 100) / 100;
  localStorage.setItem(DRAW_SCALE_KEY, String(v));
  return v;
}
// Масштаб — фича только для ПК (см. .draw-scale-field в styles.css, тот же
// брейкпоинт, что и у isMobileSearch выше): на телефоне и без того всё
// упирается в ширину экрана, а поле в панели настроек только мешает. Здесь
// откатываем к 1 принудительно, а не полагаемся на то, что пользователь не
// успеет сохранить другое значение с ПК, — иначе телефон унаследовал бы
// «десктопный» --draw-scale через тот же localStorage.
function applyDrawScale() {
  const scale = matchMedia("(max-width:30rem)").matches ? DRAW_SCALE_DEFAULT : loadDrawScale();
  $("drawStage").style.setProperty("--draw-scale", String(scale));
}

function closeDrawSettingsPanel() {
  const panel = $("drawSettingsPanel");
  if (!panel || panel.hidden) return;
  panel.hidden = true;
  $("drawSettingsBtn").setAttribute("aria-expanded", "false");
}
function syncDrawSettingsInputs() {
  const value = loadDrawDuration();
  $("drawDurationRange").min = DRAW_DURATION_BOUNDS.min;
  $("drawDurationRange").max = DRAW_DURATION_BOUNDS.max;
  $("drawDurationRange").value = value;
  $("drawDurationInput").min = DRAW_DURATION_BOUNDS.min;
  $("drawDurationInput").max = DRAW_DURATION_BOUNDS.max;
  $("drawDurationInput").value = value;

  const scale = loadDrawScale();
  $("drawScaleRange").min = DRAW_SCALE_BOUNDS.min;
  $("drawScaleRange").max = DRAW_SCALE_BOUNDS.max;
  $("drawScaleRange").value = scale;
  $("drawScaleInput").min = DRAW_SCALE_BOUNDS.min;
  $("drawScaleInput").max = DRAW_SCALE_BOUNDS.max;
  $("drawScaleInput").value = scale;
}
$("drawSettingsBtn").onclick = e => {
  e.stopPropagation();
  const panel = $("drawSettingsPanel");
  const willShow = panel.hidden;
  if (willShow) syncDrawSettingsInputs();
  panel.hidden = !willShow;
  $("drawSettingsBtn").setAttribute("aria-expanded", String(willShow));
};
document.addEventListener("click", e => {
  const panel = $("drawSettingsPanel");
  if (!panel || panel.hidden) return;
  if (!panel.contains(e.target) && e.target !== $("drawSettingsBtn") && !$("drawSettingsBtn").contains(e.target)) closeDrawSettingsPanel();
});
$("drawDurationRange").oninput = () => { saveDrawDuration(parseFloat($("drawDurationRange").value)); syncDrawSettingsInputs(); };
$("drawDurationInput").oninput = () => { saveDrawDuration(parseFloat($("drawDurationInput").value)); syncDrawSettingsInputs(); };
// Случайная длительность — равномерно в тех же фиксированных границах,
// округлена до .1с (тот же шаг, что у слайдера/поля).
$("drawRandomDurationBtn").onclick = () => {
  const rand = DRAW_DURATION_BOUNDS.min + Math.random() * (DRAW_DURATION_BOUNDS.max - DRAW_DURATION_BOUNDS.min);
  saveDrawDuration(rand);
  syncDrawSettingsInputs();
};
$("drawScaleRange").oninput = () => { saveDrawScale(parseFloat($("drawScaleRange").value)); syncDrawSettingsInputs(); applyDrawScale(); };
$("drawScaleInput").oninput = () => { saveDrawScale(parseFloat($("drawScaleInput").value)); syncDrawSettingsInputs(); applyDrawScale(); };

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
  $("drawBack").textContent = "← Комната";
  $("drawTitle").textContent = `Розыгрыш: ${state.room.room.title}`;
  drawState = { source: "room", roomId, method: "weighted_random" };
  renderDrawSetup();
}

/** Розыгрыш по личному списку — тот же экран #/room/:id/draw использует и
    комната, и это (drawState.source различает их, см. previewCandidates/
    drawStartBtn.onclick/showDrawResult ниже). Список перечитываем заново
    при каждом заходе (а не кэшируем в state) — тут нет своего экрана,
    который бы держал его свежим между заходами, как renderMovies у
    комнаты. */
async function showMyListDraw() {
  showOnly("drawView");
  const data = await act(() => api("/my-list"));
  if (!data) { location.hash = "#/my-list"; return; }
  state.myList = data.movies;
  document.title = "Розыгрыш — Мой список";
  $("drawBack").href = "#/my-list";
  $("drawBack").textContent = "← Мой список";
  $("drawTitle").textContent = "Розыгрыш: Мой список";
  drawState = { source: "myList", method: "weighted_random" };
  renderDrawSetup();
}

/** Кандидаты в том же виде, в каком их присылает POST .../draw ({kinopoiskId,
    weight, title, year, posterUrl}) — из уже загруженных данных источника
    (очередь комнаты ИЛИ личный список, см. drawState.source), без похода на
    сервер. Используются ТОЛЬКО для живого превью метода до запуска
    розыгрыша — реальный исход всегда решает сервер (см. план задачи 3 и
    шапку файла про правило сервера). */
function previewCandidates() {
  if (!drawState) return [];
  if (drawState.source === "myList") {
    return (state.myList || []).map(it => ({
      kinopoiskId: it.movie.kinopoiskId, weight: 1,
      title: it.movie.title, year: it.movie.year, posterUrl: it.movie.posterUrl,
    }));
  }
  if (!state.room) return [];
  return state.room.movies
    .filter(rm => rm.status === "queued")
    .map(rm => ({
      kinopoiskId: rm.movie.kinopoiskId, weight: rm.weight || 1,
      title: rm.movie.title, year: rm.movie.year, posterUrl: rm.movie.posterUrl,
    }));
}

/** Живое превью выбранного метода в области #drawStage: тот же самый
    компонент, что потом анимируется по «Крутить», просто в
    состоянии покоя (renderReel/renderWheelSvg умеют рисовать и без
    прокрутки) — рендерится сразу при переключении .mini-seg, без похода на
    сервер. Не трогает стадию, пока идёт сама прокрутка (drawState.spinning),
    чтобы не перебить анимацию. */
function renderMethodPreview() {
  if (!drawState || drawState.spinning) return;
  const stage = $("drawStage");
  stage.innerHTML = "";
  const candidates = previewCandidates();
  if (!candidates.length) return;
  if (drawState.method === "weighted_random") renderReel(stage, candidates, 0, false);
  else renderWheelSvg(stage, candidates);   // «Колесо» и «На выбывание» превьюшатся одним и тем же колесом в покое
}

function renderDrawSetup() {
  $("drawSetup").classList.remove("hidden");
  const stage = $("drawStage");
  stage.classList.remove("hidden");
  applyDrawScale();
  hideDrawResult();
  const btn = $("drawStartBtn");
  btn.disabled = false;
  btn.textContent = "Крутить";
  closeDrawSettingsPanel();
  updateMethodButtons();
}

/** Прячет и чистит панель с результатом (кнопки "Смотреть" и т.п.) —
    вызывается и при смене метода, и в начале новой прокрутки, чтобы
    под новым превью/новой прокруткой не оставались кнопки от ПРЕДЫДУЩЕГО
    результата (см. showDrawResult — сама панель, наоборот, никогда не
    скрывает #drawSetup, переключатель метода и «Крутить» теперь
    всегда на экране, план задачи «кнопки не должны пропадать»). */
function hideDrawResult() {
  const result = $("drawResult");
  result.classList.add("hidden");
  result.innerHTML = "";
}

function updateMethodButtons() {
  $("methodWeightedBtn").classList.toggle("sel", drawState.method === "weighted_random");
  $("methodWheelBtn").classList.toggle("sel", drawState.method === "wheel");
  $("methodEliminationBtn").classList.toggle("sel", drawState.method === "elimination");
  renderMethodPreview();
}
$("methodWeightedBtn").onclick = () => { if (!drawState || drawState.spinning) return; drawState.method = "weighted_random"; hideDrawResult(); updateMethodButtons(); };
$("methodWheelBtn").onclick = () => { if (!drawState || drawState.spinning) return; drawState.method = "wheel"; hideDrawResult(); updateMethodButtons(); };
$("methodEliminationBtn").onclick = () => { if (!drawState || drawState.spinning) return; drawState.method = "elimination"; hideDrawResult(); updateMethodButtons(); };

$("drawStartBtn").onclick = async () => {
  if (!drawState || drawState.spinning) return;
  const btn = $("drawStartBtn");
  drawState.spinning = true;
  btn.disabled = true;
  btn.textContent = "Крутим…";
  $("drawMethodRow").classList.add("disabled");
  closeDrawSettingsPanel();
  $("drawSettingsBtn").disabled = true;
  hideDrawResult();   // от ПРЕДЫДУЩЕГО прогона — иначе его кнопки видны поверх новой прокрутки
  const drawUrl = drawState.source === "myList" ? "/my-list/draw" : `/rooms/${drawState.roomId}/draw`;
  const data = await act(() => api(drawUrl, { method: "POST", body: { method: drawState.method } }));
  if (!data) { drawState.spinning = false; btn.disabled = false; btn.textContent = "Крутить"; $("drawMethodRow").classList.remove("disabled"); $("drawSettingsBtn").disabled = false; return; }

  // Переключатель метода и «Крутить» (#drawSetup) остаются на
  // экране ВСЕГДА — и во время прокрутки, и на финальном экране результата
  // (см. showDrawResult, который теперь #drawSetup не трогает вовсе — план
  // задачи «кнопки не должны пропадать»). #drawStage перерисовывается с нуля
  // на каждый прогон — старое превью/предыдущая прокрутка не может
  // «залипнуть» на экране.
  const stage = $("drawStage");
  stage.innerHTML = "";

  if (drawState.method === "wheel") await animateWheel(stage, data.candidates, data.resultKinopoiskId);
  else if (drawState.method === "elimination") await animateElimination(stage, data.candidates, data.rounds, data.resultKinopoiskId);
  else await animateWeightedRandom(stage, data.candidates, data.resultKinopoiskId);

  drawState.spinning = false;
  btn.disabled = false;
  btn.textContent = "Крутить";
  $("drawMethodRow").classList.remove("disabled");
  $("drawSettingsBtn").disabled = false;
  showDrawResult(data.candidates, data.resultKinopoiskId);
};

const prefersReducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

// Сколько полных кругов лента прокручивает мимо кандидатов, прежде чем
// доехать до результата — только для того, чтобы движение читалось как
// «крутится», сам результат уже известен (см. renderReel). PREVIEW_LEAD_LAPS
// — то же самое, но для ленты в покое (превью метода/финальный кадр после
// прокрутки): кругов перед целью меньше, крутить нечему, просто нужен запас
// слева от указателя. TRAIL_LAPS — кругов ПОСЛЕ цели, одинаково и в покое, и
// после прокрутки: без этого лента обрывалась ровно на приехавшем элементе и
// справа от указателя было пусто — та же дырка, что раньше была слева в
// покое, просто с другой стороны. Кругов с запасом с обеих сторон достаточно
// с большим отрывом, чтобы заполнить даже широкий viewport на любом экране.
// REEL_LAPS снижен с 5 до 3 — та же длительность прокрутки теперь тратится
// на меньшую дистанцию, а значит каждый постер проводит в центральном слоте
// заметно больше времени (см. DRAW_DURATION_DEFAULT выше и «coverflow»-фокус
// ниже — цель та же: дать эффекту укрупнения реально доиграть, а не мелькнуть).
const REEL_LAPS = 3;
const PREVIEW_LEAD_LAPS = 2;
const TRAIL_LAPS = 2;

// «Coverflow»-эффект, версия 2 (см. фидбек: раньше был плавный градиент по
// нескольким соседним элементам + ОТДЕЛЬНЫЙ ещё более крупный акцент у
// победителя после приземления — пользователь явно попросил ровно ОДНО
// состояние: крупнее только тот элемент, что СЕЙЧАС на линии .reel-pointer,
// ничего сверх этого отдельно не увеличиваем). REEL_FOCUS_SCALE — масштаб
// этого единственного элемента, один и тот же и во время прокрутки (кто
// сейчас пересекает линию), и в покое (превью метода/финальный кадр — тот,
// кто на линии, автоматически и есть победитель, settle() как раз и ставит
// его туда, отдельно помечать не нужно).
const REEL_FOCUS_SCALE = 1.5;

/** Солвер кубического безье (алгоритм UnitBezier — тот же, которым сами
    браузеры считают cubic-bezier() timing-function): по доле прошедшего
    ВРЕМЕНИ x∈[0,1] возвращает долю пройденного ПУТИ y∈[0,1]. Нужен, чтобы
    JS мог САМ знать, где сейчас лента, не читая это обратно из DOM — две
    предыдущие попытки (читать geometry каждого .reel-item через
    getBoundingClientRect, потом читать getComputedStyle(track).transform)
    оказались ненадёжны в реальных браузерах (см. баг-репорт: «первые два
    кандидата отрабатывают, дальше ничего» — во время самого перехода
    браузер может отдавать transform не в том виде/не с той регулярностью,
    на который расчёт полагался). Контрольные точки ДОЛЖНЫ совпадать с
    cubic-bezier(...) у .reel-track в styles.css — если поменяете кривую
    там, поменяйте и REEL_EASE ниже, иначе расчёт разойдётся с тем, что
    реально рисует CSS. */
function cubicBezierEase(p1x, p1y, p2x, p2y) {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const sampleX = t => ((ax * t + bx) * t + cx) * t;
  const sampleY = t => ((ay * t + by) * t + cy) * t;
  const sampleDerivX = t => (3 * ax * t + 2 * bx) * t + cx;
  function solveT(x) {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x;
      if (Math.abs(dx) < 1e-5) return t;
      const d = sampleDerivX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= dx / d;
    }
    let lo = 0, hi = 1;
    t = x;
    while (lo < hi) {
      const dx = sampleX(t) - x;
      if (Math.abs(dx) < 1e-5) return t;
      if (dx > 0) hi = t; else lo = t;
      t = (lo + hi) / 2;
    }
    return t;
  }
  return x => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solveT(x)));
}
const REEL_EASE = cubicBezierEase(0.16, 1, 0.3, 1);   // см. .reel-track в styles.css

/** Достаёт tx из инлайн-стиля вида "translateX(Npx)" — формат, который мы
    сами же и пишем в settle() ниже, поэтому парсинг тривиален и надёжен (в
    отличие от чтения обратно нормализованного getComputedStyle, см.
    REEL_EASE выше). */
function parseTranslateX(value) {
  const m = /translateX\(([-\d.]+)px\)/.exec(value || "");
  return m ? parseFloat(m[1]) : 0;
}

/** Ставит .reel-item-focused ровно на тот .reel-item (по индексу), чей
    центр при заданном tx ближе всего к центру viewport (в пределах
    половины ширины элемента — иначе не считается «на линии», между двумя
    элементами на полпути прокрутки может не быть ни одного
    сфокусированного, это ожидаемо). */
function applyReelFocusAt(items, itemW, vw, tx) {
  if (!items.length) return;
  const rawIndex = (vw / 2 - tx) / itemW - 0.5;
  const idx = Math.max(0, Math.min(items.length - 1, Math.round(rawIndex)));
  const centerOfIdx = tx + idx * itemW + itemW / 2;
  const onLine = Math.abs(centerOfIdx - vw / 2) < itemW / 2;
  for (let i = 0; i < items.length; i++) items[i].classList.toggle("reel-item-focused", onLine && i === idx);
}

/** Разовый пересчёт фокуса для состояния покоя (превью метода/финальный
    кадр после settle(), см. ниже) — tx читается из собственного же
    инлайн-стиля ленты (parseTranslateX), никакой анимации тут нет. Во
    время самой прокрутки используется не эта функция, а startReelFocusLoop
    (см. ниже) — там положение ленты считается аналитически по времени, не
    читается из DOM вообще. */
function applyReelFocusScale(viewport) {
  const track = viewport.querySelector(".reel-track");
  if (!track) return;
  const items = [...track.children];
  if (!items.length) return;
  const itemW = items[0].getBoundingClientRect().width || 1;
  const vw = viewport.getBoundingClientRect().width;
  applyReelFocusAt(items, itemW, vw, parseTranslateX(track.style.transform));
}

/** Стартует rAF-цикл, непрерывно пересчитывающий фокус-масштаб, пока едет
    лента (без этого элемент «на линии» менялся бы скачком только в конце).
    Положение ленты в момент tick НЕ читается из DOM — вычисляется
    аналитически из прошедшего времени (performance.now() - startTime) и
    той же кривой замедления, что и у самого CSS-перехода (REEL_EASE), от
    startTx к finalTx за duration секунд — то есть JS всегда точно знает,
    где визуально находится лента, независимо от того, как конкретный
    браузер в моменте представляет анимируемый transform. itemW/vw меряются
    один раз при старте (не меняются за время прокрутки). Возвращает
    stop() — renderReel вызывает её в finish(), когда прокрутка
    (transitionend/таймаут-подстраховка) завершилась. */
function startReelFocusLoop(viewport, startTx, finalTx, duration, startTime) {
  const track = viewport.querySelector(".reel-track");
  const items = track ? [...track.children] : [];
  const itemW = items.length ? (items[0].getBoundingClientRect().width || 1) : 1;
  const vw = viewport.getBoundingClientRect().width;
  let raf = requestAnimationFrame(function tick() {
    const elapsed = (performance.now() - startTime) / 1000;
    const progress = duration > 0 ? Math.max(0, Math.min(1, elapsed / duration)) : 1;
    const tx = startTx + (finalTx - startTx) * REEL_EASE(progress);
    applyReelFocusAt(items, itemW, vw, tx);
    raf = requestAnimationFrame(tick);
  });
  return () => cancelAnimationFrame(raf);
}

/** Горизонтальная карусель постеров-кандидатов: строит .reel-track из
    .reel-item (переиспользует и для живого превью метода в состоянии покоя,
    и для самой прокрутки, см. renderMethodPreview/animateWeightedRandom) и
    переводит её translateX-ом так, чтобы .reel-item под индексом targetIndex
    (в исходном массиве candidates) оказался ровно по центру, под
    неподвижным .reel-pointer. Лента всегда строится с запасом кругов ДО и
    ПОСЛЕ цели (см. константы выше) — и в покое, и на финальном кадре после
    прокрутки по обе стороны от указателя есть постеры, а не пустота с одной
    из сторон.
    - animate=false (превью) — лента сразу рисуется в покое на targetIndex,
      без transition.
    - animate=true (сам розыгрыш) — сначала строится несколько кругов по
      кандидатам (REEL_LAPS), затем лента с CSS-замедлением доезжает до того
      же targetIndex; конечный кадр совпадает с тем, что рисует превью для
      того же индекса — один и тот же .reel-item, тот же settle().
    При prefers-reduced-motion (или n<=1) анимация не проигрывается — сразу
    показывается финальное состояние. Каждый вызов строит трек заново, так
    что «Крутить ещё раз» не залипает на кадре предыдущего прогона. */
function renderReel(container, candidates, targetIndex, animate) {
  container.textContent = "";
  const n = candidates.length;
  const doAnimate = !!animate && !prefersReducedMotion() && n > 1;
  // Читаем длительность заново на КАЖДЫЙ вызов (не кэшируем при загрузке
  // страницы) — так смена настройки в панели подхватывается уже следующим
  // прогоном (см. план задачи «настройки продолжительности»).
  const duration = currentDrawDuration();

  const viewport = el("div", "reel-viewport");
  const pointer = el("div", "reel-pointer");
  const track = el("div", "reel-track");

  // n<=1 — кольцевать нечего (один кандидат или пусто), landIndex/sequence
  // тривиальны без модульной арифметики (n=0 сломал бы i % n).
  const leadLaps = doAnimate ? REEL_LAPS : PREVIEW_LEAD_LAPS;
  const landIndex = n > 1 ? leadLaps * n + targetIndex : targetIndex;
  const totalItems = n > 1 ? landIndex + 1 + TRAIL_LAPS * n : n;
  const sequence = [];
  for (let i = 0; i < totalItems; i++) sequence.push(n > 1 ? candidates[i % n] : candidates[i]);

  for (const c of sequence) {
    const item = el("div", "reel-item");
    item.innerHTML = c.posterUrl
      ? `<img class="movie-poster" src="${esc(c.posterUrl)}" alt="">`
      : '<div class="movie-poster"></div>';
    const year = c.year ? ` (${c.year})` : "";
    item.append(el("div", "title", `${c.title || ""}${year}`));
    track.append(item);
  }

  viewport.append(pointer, track);
  container.append(viewport);

  const settle = () => {
    const first = track.firstElementChild;
    const itemW = first ? first.getBoundingClientRect().width : 0;
    const vw = viewport.getBoundingClientRect().width;
    const tx = vw / 2 - (landIndex * itemW + itemW / 2);
    track.style.transform = `translateX(${tx}px)`;
    return tx;
  };

  if (!doAnimate) {
    // Состояние покоя (превью метода или финальный кадр под
    // prefers-reduced-motion) — считаем фокус-масштаб один раз сразу после
    // расстановки, без перехода (сам факт «центр крупнее» — не анимация, но
    // ПЕРЕХОД к нему тут не нужен, см. план задачи 6). Глобальное правило
    // prefers-reduced-motion в конце styles.css и так гасит transition на
    // .reel-item, лишний branch не нужен.
    track.style.transition = "none";
    settle();
    applyReelFocusScale(viewport);
    return Promise.resolve();
  }

  return new Promise(resolve => {
    // Стартуем с 0px без анимации, затем на следующем кадре включаем переход
    // к финальному сдвигу — тот же приём, что и spinWheelTo ниже, иначе
    // браузер схлопнёт оба состояния в один кадр.
    track.style.transition = "none";
    track.style.transform = "translateX(0px)";
    let stopFocusLoop = () => {};
    requestAnimationFrame(() => requestAnimationFrame(() => {
      track.style.transition = "";              // вернуть transition-property/timing-function из styles.css
      track.style.transitionDuration = duration + "s";   // ...но саму длительность — из настроек, не из CSS
      const finalTx = settle();
      // startTime — ровно в момент реального старта перехода (тот же кадр,
      // что и settle()), не раньше — иначе первые тики фокус-цикла посчитают
      // время, когда лента фактически ещё стояла на 0px (см. двойной rAF
      // выше), и разъедутся с реальной картинкой.
      stopFocusLoop = startReelFocusLoop(viewport, 0, finalTx, duration, performance.now());
    }));
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      track.removeEventListener("transitionend", onTrackTransitionEnd);
      stopFocusLoop();
      applyReelFocusScale(viewport);   // точный финальный расчёт — тот, кто на линии, и есть победитель, settle() уже поставил его туда
      resolve();
    };
    // transitionend БАББЛИТСЯ — у каждого .reel-item СВОЙ transform-переход
    // (.15s, см. .reel-item-focused в styles.css), и первый же завершившийся
    // переход укрупнения долетал сюда и триггерил finish() спустя ~150мс
    // после старта прокрутки, а не после реальных нескольких секунд самого
    // движения ленты — отсюда и «первые две карточки работают, дальше
    // ничего»: цикл фокуса убивался почти сразу, а обычный {once:true} на
    // track съедал слушатель именно на этом чужом всплывшем событии. Реагируем
    // только на переход СВОЕГО transform, у которого e.target === track.
    const onTrackTransitionEnd = (e) => { if (e.target === track) finish(); };
    track.addEventListener("transitionend", onTrackTransitionEnd);
    setTimeout(finish, duration * 1000 + 1000);   // подстраховка, если transitionend не пришёл — с запасом под настраиваемую длительность
  });
}

/** Тонкая обёртка над renderReel: находит индекс результата в candidates и
    едет к нему по-настоящему (animate=true) — сам результат уже прислан
    сервером, здесь только анимация. */
function animateWeightedRandom(container, candidates, resultId) {
  const resultIndex = Math.max(0, candidates.findIndex(c => c.kinopoiskId === resultId));
  return renderReel(container, candidates, resultIndex, true);
}

// Свой рендер колеса (SVG-секторы по числу кандидатов), не завязан на
// pointauc.com — размер сектора пропорционален весу кандидата, честно
// отражая вероятность, не только визуал.
const WHEEL_COLORS = ["#ff3d5a", "#7f1d1d", "#ff7a8f", "#c81e3a", "#a13350", "#ffb3c0", "#e0526d", "#5c1420"];

/** Рисует SVG-колесо (секторы по весу кандидата, с названиями фильмов прямо
    в секторах — см. ниже) в container, полностью заменяя его содержимое, и
    оставляет его в покое (без вращения) — так его же используют и как живое
    превью метода (renderMethodPreview), и как стартовый кадр перед
    spinWheelTo. Общая часть между обычным розыгрышем (animateWheel) и каждым
    раундом «На выбывание» (animateElimination) — выбывание крутит то же
    колесо, просто с уменьшающимся набором кандидатов на каждой итерации.
    Каждый <path> сектора помечен data-kp — по этому атрибуту
    animateElimination гасит ровно выбывший сектор. Возвращает {svg, mids} —
    mids нужен spinWheelTo ниже, чтобы знать угол остановки. */
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
      // Название читаем от центра наружу вдоль радиуса сектора: точка (lx,ly)
      // на радиусе 20 (около ступицы) и rotate вокруг ЭТОЙ ЖЕ точки на угол,
      // разворачивающий локальный «+x» текста вдоль направления mid (вывод:
      // rotate = mid-90, см. toXY). В левой половине колеса такой поворот
      // читался бы вверх ногами — там добавляем ещё 180° и меняем
      // text-anchor на end, тогда текст всё так же тянется от центра к краю,
      // но не перевёрнут (замена .wheel-legend, см. план задачи 4).
      const [lx, ly] = toXY(mid, 20);
      const rotBase = mid - 90;
      const norm = ((rotBase % 360) + 540) % 360 - 180; // нормализация к (-180,180]
      const flip = norm > 90 || norm < -90;
      const rot = flip ? norm + 180 : norm;
      const anchor = flip ? "end" : "start";
      // Лимит символов — грубо пропорционален углу сектора: у широких
      // секторов (мало кандидатов) название почти целиком, у узких —
      // короче, чтобы не наезжать на соседей. Текст идёт прямой линией от
      // ступицы к краю (не по дуге), поэтому реальный запас по длине почти
      // не зависит от ширины сектора — ограничивать его так жёстко, как
      // раньше, не было нужды; тесно может стать только у самой ступицы при
      // очень большом числе кандидатов, отсюда и остаётся мягкая привязка
      // к sweep, но с гораздо более щедрыми потолком/полом.
      const maxChars = Math.max(12, Math.min(30, Math.round(sweep / 2.2)));
      const title = c.title || "";
      const label = title.length > maxChars ? `${title.slice(0, maxChars - 1).trimEnd()}…` : title;
      const full = `${title}${c.year ? ` (${c.year})` : ""}`;
      labelsSvg.push(
        `<text class="sector-label" x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" text-anchor="${anchor}" ` +
        `transform="rotate(${rot.toFixed(2)} ${lx.toFixed(2)} ${ly.toFixed(2)})"><title>${esc(full)}</title>${esc(label)}</text>`
      );
    }
    angle = endA;
  });

  const wrap = el("div", "wheel-wrap");
  wrap.innerHTML = `
    <div class="wheel-pointer"></div>
    <svg viewBox="0 0 ${size} ${size}"><g>${sectorsSvg.join("")}${labelsSvg.join("")}</g></svg>`;
  container.append(wrap);

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
    // Читаем длительность заново на КАЖДЫЙ прогон (включая каждый раунд
    // animateElimination) — не кэшируем при загрузке страницы, см. план
    // задачи «настройки продолжительности».
    const duration = currentDrawDuration();

    if (reduced) { svg.style.transition = "none"; svg.style.transform = `rotate(${rotation}deg)`; return resolve(); }

    // Стартуем с 0deg без анимации, затем на следующем кадре включаем
    // переход к финальному углу — иначе браузер схлопнёт оба состояния.
    svg.style.transform = "rotate(0deg)";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      svg.style.transitionDuration = duration + "s";   // из настроек, не из CSS .wheel-wrap svg
      svg.style.transform = `rotate(${rotation}deg)`;
    }));
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      svg.removeEventListener("transitionend", onSvgTransitionEnd);
      resolve();
    };
    // transitionend бабблится — у секторов есть свой opacity-переход (см.
    // .wheel-wrap svg path в styles.css, гашение выбывшего в
    // animateElimination), поэтому реагируем только на переход СВОЕГО
    // transform у svg (та же защита, что и в renderReel/finish — см. план
    // задачи «карусель работает только для первых двух»).
    const onSvgTransitionEnd = (e) => { if (e.target === svg) finish(); };
    svg.addEventListener("transitionend", onSvgTransitionEnd);
    setTimeout(finish, duration * 1000 + 800);   // подстраховка, если transitionend не пришёл — с запасом под настраиваемую длительность
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
    выбыл. Колесо рисуется ОДИН раз на весь розыгрыш из полного исходного
    candidates (геометрия секторов и mids не пересчитываются между раундами)
    — выбывшие варианты остаются на колесе затемнёнными, а не пропадают, см.
    фидбек пользователя. Порядок и состав раундов сервер уже зафиксировал,
    фронт их не выбирает, только визуализирует. При prefers-reduced-motion
    раунды не проигрываются — колесо сразу встаёт на итоговый результат
    (resultId), без покруток. */
async function animateElimination(container, candidates, rounds, resultId) {
  const resultIndex = Math.max(0, candidates.findIndex(c => c.kinopoiskId === resultId));
  if (prefersReducedMotion() || !rounds || !rounds.length) {
    const { svg, mids } = renderWheelSvg(container, candidates);
    await spinWheelTo(svg, mids, resultIndex);
    return;
  }

  // Раунд = докрутка до выбывающего кандидата НА ТЕКУЩЕМ (ещё не уменьшенном)
  // колесе, короткая пауза с погашенным сектором — чтобы было видно, КТО
  // именно выбыл, — и только ПОСЛЕ этого колесо перерисовывается уже без
  // него (remaining), сектора соседей пересчитываются на освободившееся
  // место. Явно попросили именно так: выбывший должен реально убираться из
  // колеса, а не просто гаснуть навсегда среди остальных.
  let remaining = candidates.slice();
  let { svg, mids } = renderWheelSvg(container, remaining);
  for (const round of rounds) {
    const targetIndex = remaining.findIndex(c => c.kinopoiskId === round.eliminated);
    if (targetIndex === -1) continue;   // рассинхрон с сервером — пропускаем раунд, не роняем анимацию
    await spinWheelTo(svg, mids, targetIndex);
    const sector = svg.querySelector(`path[data-kp="${round.eliminated}"]`);
    if (sector) sector.style.opacity = ".25";
    await new Promise(r => setTimeout(r, 500));
    remaining = remaining.filter(c => c.kinopoiskId !== round.eliminated);
    // Последний раунд (2 -> 1) колесо больше НЕ пересобираем — сектор на
    // единственного оставшегося кандидата был бы просто сплошным кругом без
    // какой-либо интриги. Финальным кадром намеренно остаются эти 2
    // сектора: победитель ярко, последний выбывший — погашенным рядом с ним.
    if (remaining.length > 1) ({ svg, mids } = renderWheelSvg(container, remaining));
  }
}

function showDrawResult(candidates, resultId) {
  const mv = candidates.find(c => c.kinopoiskId === resultId) || {};
  const roomId = drawState.roomId;
  const isMyList = drawState.source === "myList";
  // Переключатель метода и «Крутить» (#drawSetup) остаются на
  // экране и здесь, на финальном экране результата — их больше НЕ прячем
  // (см. план задачи «кнопки не должны пропадать»): чтобы крутить ещё раз,
  // достаточно снова нажать «Крутить», отдельная кнопка «Крутить
  // ещё раз» стала избыточной и убрана. #drawStage (колесо/карусель) уже
  // остановлено на результате анимацией выше (см. план задачи «кнопки под
  // колесом/каруселью»), кнопки результата ложатся под ним.
  const box = $("drawResult");
  box.classList.remove("hidden");
  const year = mv.year ? ` (${mv.year})` : "";
  // «Случайный выбор» уже показывает победителя крупно прямо в самой ленте
  // (см. .reel-item-focused в renderReel/applyReelFocusScale) — отдельная
  // карточка с постером в #drawResult тут избыточна, оставляем только
  // кнопки. У колеса и «На выбывание» увеличить сектор победителя нечем —
  // там карточка с обложкой остаётся, как и раньше (см. план задачи 5).
  const showCard = drawState.method !== "weighted_random";
  box.innerHTML = `
    ${showCard ? `
    <div class="result-card">
      ${mv.posterUrl ? `<img src="${esc(mv.posterUrl)}" alt="">` : ""}
      <h2>${esc(mv.title || "")}${esc(year)}</h2>
    </div>` : ""}
    <div class="row result-actions">
      <button class="btn outlined" id="drawKpBtn">Смотреть</button>
      <button class="btn filled" id="drawWatchedBtn">Отметить просмотренным</button>
    </div>`;
  $("drawKpBtn").onclick = () => window.open(kinopoiskCxUrl(resultId), "_blank", "noopener");
  $("drawWatchedBtn").onclick = () => act(async () => {
    if (isMyList) {
      await api(`/movies/${resultId}/watched`, { method: "POST" });
      location.hash = "#/my-list";
    } else {
      await api(`/rooms/${roomId}/movies/${resultId}/watched`, { method: "POST" });
      location.hash = "#/room/" + roomId;
    }
  }, "Отмечено просмотренным");
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
// иконка #serviceProfileBtn в шапке ведёт на #/profile. Раньше страница была
// чистым хабом с двумя кнопками-вкладками на #/watched и #/my-list, теперь
// показывает сами списки сразу тут (первые PROFILE_PREVIEW_LIMIT штук каждый,
// см. renderWatchedInto/renderMyListInto ниже — те же функции рендерят и
// полные #/watched и #/my-list, просто в другой контейнер и без среза).
// «Показать все» — переход на полную страницу, виден только если рядов
// больше 4 — .queue-grid отзывчивая (auto-fill), точный подсчёт рядов
// зависел бы от текущей ширины экрана; пользователь явно попросил считать
// по столько же карточек, сколько при обычной для него ширине укладывается
// в 4 ряда (2 колонки × 4 ряда = 8), поэтому лимит — фиксированное число, не
// динамический расчёт по фактической раскладке.
$("serviceProfileBtn").onclick = () => { location.hash = "#/profile"; };

const PROFILE_PREVIEW_LIMIT = 8;

async function showProfile() {
  showOnly("profileView");
  document.title = "Что смотрим? — мои фильмы";
  const [watched, myList] = await Promise.all([
    act(() => api("/watched")),
    act(() => api("/my-list")),
  ]);
  if (watched) {
    $("profileWatchedEmpty").hidden = watched.movies.length > 0;
    // .hidden-КЛАСС тут не годится: у него та же специфичность (0,0,1,0), что
    // и у .btn, а .btn объявлен позже в styles.css — при равной специфичности
    // побеждает последнее правило по каскаду, и display:inline-flex у .btn
    // перебивал бы display:none (кнопка «Показать все» была видна всегда,
    // баг). [hidden]{display:none !important} — тот же идиом, что и везде в
    // этом файле ($("watchedEmpty").hidden = ...), !important гарантированно
    // выигрывает у любого компонентного класса.
    $("profileWatchedMoreBtn").hidden = watched.movies.length <= PROFILE_PREVIEW_LIMIT;
    renderWatchedInto($("profileWatchedList"), watched.movies.slice(0, PROFILE_PREVIEW_LIMIT));
  }
  if (myList) {
    $("profileMyListEmpty").hidden = myList.movies.length > 0;
    $("profileMyListMoreBtn").hidden = myList.movies.length <= PROFILE_PREVIEW_LIMIT;
    renderMyListInto($("profileMyListItems"), myList.movies.slice(0, PROFILE_PREVIEW_LIMIT), showProfile);
  }
}

// ───────────────────────── что мы смотрели ─────────────────────────
async function showWatched() {
  showOnly("watchedView");
  document.title = "Что смотрим? — что мы смотрели";
  const data = await act(() => api("/watched"));
  if (!data) return;
  $("watchedEmpty").hidden = data.movies.length > 0;
  renderWatchedInto($("watchedList"), data.movies);
}

// Тонкая обёртка вокруг renderMovieTile — своё тут только меню («Добавить в
// комнату», подгружает список комнат лениво при открытии) и merge personal
// myScore в mv: watchedList на бэке отдаёт его отдельным полем it.myScore
// (не внутри moviePayload — там уже занято avgScore/ratingCount из того же
// подзапроса), renderMovieTile/openMovieInfoModal читают его прямо с mv.
function renderWatchedInto(container, items) {
  container.textContent = "";
  for (const it of items) {
    const mv = Object.assign(it.movie, { myScore: it.myScore });
    const menu = renderCardMenu([
      {
        label: "Добавить в комнату",
        onClick: async menu => {
          menu.innerHTML = '<p class="muted" style="padding:.5em .8em">Загрузка…</p>';
          const data = await act(() => api("/rooms"));
          if (!data || menu.hidden) return;
          menu.innerHTML = "";
          renderRoomPicker(menu, mv.kinopoiskId, data.rooms, () => closeCardMenu());
        },
      },
    ]);
    container.append(renderMovieTile(mv, { menu }));
  }
}

// ───────────────────────── личный список на просмотр ─────────────────────────
// Глобально, без привязки к комнате (см. план задачи 1) — GET/POST/DELETE
// /api/my-list. Добавляют сюда через модалку «Фильм» (её меню
// renderAddToMenu, «В личный список» — открывается кликом по строке
// глобального поиска в шапке или на главной, см. renderSearchResultRow);
// открыть на Кинопоиске, убрать из списка или закинуть в конкретную комнату
// — всё через саму карточку (renderMyListInto).
async function showMyList() {
  showOnly("myListView");
  document.title = "Что смотрим? — мой список";
  const data = await act(() => api("/my-list"));
  if (!data) return;
  $("myListEmpty").hidden = data.movies.length > 0;
  renderMyListInto($("myListItems"), data.movies, showMyList);
  // Тот же порог, что и у «Крутить» в комнате (renderMovies) — розыгрыш
  // одного фильма ничего не решает, хоть сервер такое и не запрещает.
  $("myListDrawRow").hidden = data.movies.length < 2;
}
$("myListDrawBtn").onclick = () => { location.hash = "#/my-list/draw"; };

/** onChange зовётся после «Убрать из списка» — на полной странице #/my-list
    это showMyList (перечитать список), на превью #/profile — showProfile
    (иначе после удаления в превью карточка исчезла бы, а «Показать все»
    осталась бы в устаревшем состоянии, посчитанном по старому total).
    Тонкая обёртка вокруг renderMovieTile — своё тут только меню («Добавить
    в комнату»/«Убрать из списка»). avgScore/ratingCount/myScore уже внутри
    it.movie — personalList на бэке сама их подбирает (см. server.js), в
    отличие от watchedList мёржить тут ничего не нужно. */
function renderMyListInto(container, items, onChange) {
  container.textContent = "";
  for (const it of items) {
    const mv = it.movie;
    const menu = renderCardMenu([
      {
        label: "Отметить просмотренным",
        // Тот же глобальный эндпоинт, что и у «Отметить просмотренным» на
        // экране розыгрыша (см. showDrawResult) — сам убирает фильм из
        // личного списка на сервере, onChange() тут просто перечитывает
        // список, чтобы карточка пропала и с экрана.
        onClick: () => act(async () => {
          closeCardMenu();
          await api(`/movies/${mv.kinopoiskId}/watched`, { method: "POST" });
          await onChange();
        }, "Отмечено просмотренным"),
      },
      {
        label: "Добавить в комнату",
        onClick: async menu => {
          menu.innerHTML = '<p class="muted" style="padding:.5em .8em">Загрузка…</p>';
          const data = await act(() => api("/rooms"));
          if (!data || menu.hidden) return;   // закрыли меню, пока список комнат летел
          menu.innerHTML = "";
          renderRoomPicker(menu, mv.kinopoiskId, data.rooms, () => closeCardMenu());
        },
      },
      {
        label: "Убрать из списка", danger: true,
        onClick: () => act(async () => {
          closeCardMenu();
          await api(`/my-list/${mv.kinopoiskId}`, { method: "DELETE" });
          await onChange();
        }, "Убрано из списка"),
      },
    ]);
    container.append(renderMovieTile(mv, { menu, onChange }));
  }
}

// ───────────────────────── пошаговое обучение ─────────────────────────
// Автозапуск один раз для новых пользователей (localStorage-флаг —
// per-браузер, не per-аккаунт: сознательно, своего профиля настроек у
// сервиса нет, а заводить это ради одного флага избыточно). Флаг ставится
// СРАЗУ при автозапуске (maybeStartTour), а не по завершении — иначе уход
// с середины (клик по комнате, переход по ссылке) показывал бы тур заново
// при каждом следующем визите. Повторно посмотреть — «Показать обучение» в
// меню аккаунта (accountMenuTour выше), тот всегда стартует независимо от
// флага. Все цели шагов — статичная разметка главной, которая есть у любого
// пользователя сразу после входа, даже без единой комнаты/фильма в кэше
// (жанровые полки/витрину «Из базы» намеренно не подсвечиваем — у нового
// пользователя там пока пусто, см. tourStepVisible).
const TOUR_DONE_KEY = "movies.tour.done";
const TOUR_STEPS = [
  {
    title: "Добро пожаловать в «Что смотрим»",
    text: "Покажем в нескольких шагах, что где лежит — это займёт меньше минуты. В любой момент можно закрыть крестиком или Esc.",
  },
  {
    target: () => $("roomActionsRow"),
    title: "Комнаты",
    text: "Комната — общий список фильмов с друзьями: очередь, история просмотров и совместный выбор, что смотреть. Создайте свою или присоединитесь по коду приглашения.",
  },
  {
    target: () => $("homeSearchWrap"),
    title: "Поиск фильмов",
    text: "Ищите фильм по названию и сразу добавляйте в комнату или в свой личный список — без похода на отдельный экран.",
  },
  {
    target: () => $("globalSearchWrap"),
    title: "Поиск в любом месте",
    text: "Тот же поиск есть в шапке — доступен с любого экрана сервиса, не только с главной.",
  },
  {
    target: () => $("serviceProfileBtn"),
    title: "Мои фильмы",
    text: "Здесь — что вы уже посмотрели и что хотите посмотреть, отдельно от комнат: оценки, история и личный список.",
  },
  {
    target: () => $("accountMenuWrap"),
    title: "Аккаунт и тема",
    text: "Тема оформления и аккаунт — здесь же. Это обучение можно открыть снова через это меню, если понадобится.",
  },
  {
    title: "Готово",
    text: "Теперь вы знаете, что где искать. Приятного просмотра.",
  },
];

let tourStepIndex = -1; // -1 — тур не запущен
let tourReposition = null; // текущий обработчик resize/scroll, снимается в endTour
let tourEls = null;        // {spotlight, tooltip, stepLabel, title, text, backBtn, nextBtn} — см. buildTourDom

function tourActive() { return tourStepIndex >= 0; }

/** Строит DOM тура заново при каждом запуске и полностью удаляет его в
    endTour(), а не переиспользует статический узел через hidden (как
    остальные модалки в этом файле). Так обошли живьём обнаруженный баг:
    у #tourSpotlight/#tourTooltip, существовавших в разметке со старта
    страницы под [hidden], после снятия hidden И явной установки
    width/height инлайн-стилями offsetWidth/getBoundingClientRect
    продолжали отдавать 0 — при том, что те же самые width/height у
    СВЕЖЕСОЗДАННОГО через document.createElement узла считались верно сразу
    же. Пересоздание при каждом запуске — самый надёжный обход, а тур и так
    не настолько частая операция, чтобы экономить на пересборке DOM. */
function buildTourDom() {
  const spotlight = el("div");
  spotlight.id = "tourSpotlight";

  const tooltip = el("div");
  tooltip.id = "tourTooltip";
  tooltip.setAttribute("role", "dialog");
  tooltip.setAttribute("aria-modal", "true");
  tooltip.innerHTML = `
    <button class="icon-btn xs" type="button" title="Пропустить" aria-label="Пропустить обучение">
      <svg class="icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
    </button>
    <div class="muted tour-step-label"></div>
    <h3></h3>
    <p></p>
    <div class="tour-actions">
      <button class="btn" type="button">Назад</button>
      <button class="btn filled" type="button">Далее</button>
    </div>`;
  document.body.append(spotlight, tooltip);

  const closeBtn = tooltip.querySelector(".icon-btn");
  const [backBtn, nextBtn] = tooltip.querySelectorAll(".tour-actions .btn");
  closeBtn.onclick = endTour;
  backBtn.onclick = tourPrev;
  nextBtn.onclick = tourNext;

  return {
    spotlight, tooltip, backBtn, nextBtn,
    stepLabel: tooltip.querySelector(".tour-step-label"),
    title: tooltip.querySelector("h3"),
    text: tooltip.querySelector("p"),
  };
}

/** Шаг без target — всегда «видим» (приветствие/прощание, показываются по
    центру экрана). Шаг с target — виден, только если элемент существует и
    реально занимает место на экране (не hidden где-то выше по дереву, не
    свёрнут в 0×0) — тот же смысл, что у обычных .hidden-проверок в остальном
    коде, просто через getBoundingClientRect, а не сам DOM-атрибут: элемент
    технически присутствует всегда, скрывает его родительский <section>. */
function tourStepVisible(step) {
  if (!step.target) return true;
  const el = step.target();
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function tourFindVisible(from, dir) {
  let i = from;
  while (i >= 0 && i < TOUR_STEPS.length && !tourStepVisible(TOUR_STEPS[i])) i += dir;
  return i;
}

/** Позиционирует и подсветку, и подсказку под текущий tourStepIndex — общая
    точка, на которую опираются старт/далее/назад/resize/scroll: она ничего
    не решает про смену шага, только рисует уже выбранный. */
function tourRender() {
  const step = TOUR_STEPS[tourStepIndex];
  const targetEl = step.target ? step.target() : null;
  const { spotlight, tooltip, stepLabel, title, text, backBtn, nextBtn } = tourEls;

  let targetRect = null;
  if (targetEl) {
    spotlight.classList.remove("tour-no-target");
    const pad = 8;
    const r = targetEl.getBoundingClientRect();
    spotlight.style.left = `${r.left - pad}px`;
    spotlight.style.top = `${r.top - pad}px`;
    spotlight.style.width = `${r.width + pad * 2}px`;
    spotlight.style.height = `${r.height + pad * 2}px`;
    targetRect = r;
  } else {
    spotlight.classList.add("tour-no-target");
    spotlight.style.left = "0px";
    spotlight.style.top = "0px";
    spotlight.style.width = "0px";
    spotlight.style.height = "0px";
  }

  stepLabel.textContent = `Шаг ${tourStepIndex + 1} из ${TOUR_STEPS.length}`;
  title.textContent = step.title;
  text.textContent = step.text;
  backBtn.hidden = tourFindVisible(tourStepIndex - 1, -1) < 0;
  nextBtn.textContent = tourFindVisible(tourStepIndex + 1, 1) >= TOUR_STEPS.length ? "Готово" : "Далее";

  // Подсказку меряем ПОСЛЕ того, как проставили контент (высота зависит от
  // текста) — margin от края подсвеченного элемента, с проверкой краёв
  // экрана; без цели — просто по центру.
  const margin = 16;
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  let left, top;
  if (!targetRect) {
    left = (innerWidth - tw) / 2;
    top = (innerHeight - th) / 2;
  } else {
    top = targetRect.bottom + margin + 8; // +8 — с учётом внешнего отступа подсветки
    if (top + th > innerHeight - margin) top = targetRect.top - th - margin - 8;
    if (top < margin) top = Math.max(margin, (innerHeight - th) / 2);
    left = targetRect.left + targetRect.width / 2 - tw / 2;
    left = Math.min(Math.max(left, margin), innerWidth - tw - margin);
  }
  // Финальная защита от промаха мимо экрана — top/left в любом случае
  // зажаты в границы вьюпорта, независимо от ветки выше.
  left = Math.min(Math.max(left, margin), Math.max(margin, innerWidth - tw - margin));
  top = Math.min(Math.max(top, margin), Math.max(margin, innerHeight - th - margin));
  tooltip.style.left = `${Math.round(left)}px`;
  tooltip.style.top = `${Math.round(top)}px`;
}

function tourGo(index) {
  tourStepIndex = index;
  tourRender();
}

function tourNext() {
  const i = tourFindVisible(tourStepIndex + 1, 1);
  if (i >= TOUR_STEPS.length) { endTour(); return; }
  tourGo(i);
}
function tourPrev() {
  const i = tourFindVisible(tourStepIndex - 1, -1);
  if (i < 0) return;
  tourGo(i);
}

function startTour() {
  if (tourActive()) return;
  // Фоновая/невидимая вкладка отдаёт innerWidth/innerHeight нулями (сама
  // раскладка ещё не посчитана браузером, ему незачем это делать для того,
  // что не рисуется) — подсветка/подсказка тогда съехали бы в угол экрана.
  // Ждём реального возврата видимости вместо того, чтобы рисовать по
  // мусорным размерам.
  if (document.hidden) {
    document.addEventListener("visibilitychange", function onVisible() {
      if (document.hidden) return;
      document.removeEventListener("visibilitychange", onVisible);
      startTour();
    });
    return;
  }
  const first = tourFindVisible(0, 1);
  if (first >= TOUR_STEPS.length) return; // теоретически недостижимо — шаги 0 и последний без target
  tourEls = buildTourDom();
  tourGo(first);
  tourReposition = () => tourRender();
  addEventListener("resize", tourReposition);
  addEventListener("scroll", tourReposition, true);
}

function endTour() {
  if (!tourActive()) return;
  tourStepIndex = -1;
  if (tourEls) {
    tourEls.spotlight.remove();
    tourEls.tooltip.remove();
    tourEls = null;
  }
  if (tourReposition) {
    removeEventListener("resize", tourReposition);
    removeEventListener("scroll", tourReposition, true);
    tourReposition = null;
  }
}

function maybeStartTour() {
  if (localStorage.getItem(TOUR_DONE_KEY)) return;
  localStorage.setItem(TOUR_DONE_KEY, "1");
  setTimeout(startTour, 400);
}

init().catch(e => {
  console.error(e);
  showAuthScreen("Не удалось загрузить", "Обновите страницу — возможно, сервис ещё поднимается.");
});
