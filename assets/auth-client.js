"use strict";
/**
 * Браузерная часть подключения сервиса к BurningHouse Auth.
 *
 * Копируется в проект как есть. Реализует authorization code + PKCE со стороны
 * фронта: уводит на страницу входа, обменивает вернувшийся код на токены,
 * прозрачно обновляет протухший access-токен и повторяет запрос.
 *
 * Использование:
 *
 *   const auth = createAuthClient({ authBase: "https://auth.burninghouse.ru", clientId: "finance" });
 *   await auth.handleRedirect();                 // если вернулись с ?code=…
 *   if (!auth.isAuthenticated()) auth.login();   // иначе уводим на вход
 *   const res = await auth.fetch("/api/state");  // сам подставит токен и обновит его при 401
 */

const OFFLINE = Symbol("offline"); // tryRefresh(): до auth не достучались — вход не потерян

function createAuthClient(options) {
  const authBase = String(options.authBase || "").replace(/\/+$/, "");
  const clientId = options.clientId;
  const redirectUri = options.redirectUri || location.origin + location.pathname;
  const prefix = options.storagePrefix || "bh_auth";

  if (!authBase || !clientId) throw new Error("auth-client: нужны authBase и clientId");

  const K = {
    access: prefix + "_access",
    refresh: prefix + "_refresh",
    expires: prefix + "_expires",
    user: prefix + "_user",
    verifier: prefix + "_verifier",
    state: prefix + "_state",
  };

  const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

  async function challengeOf(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return b64url(digest);
  }

  /* ---------- хранилище токенов ---------- */

  function saveTokens(data) {
    localStorage.setItem(K.access, data.access_token);
    localStorage.setItem(K.refresh, data.refresh_token);
    // Минута запаса, чтобы не отправлять запрос с токеном, который протухнет в пути.
    localStorage.setItem(K.expires, String(Date.now() + (data.expires_in - 60) * 1000));
    if (data.user) localStorage.setItem(K.user, JSON.stringify(data.user));
  }
  function clearTokens() {
    for (const k of [K.access, K.refresh, K.expires, K.user]) localStorage.removeItem(k);
  }
  /** { id, username, name, email, phone } | null. name и phone — только
   *  если пользователь сам включил соответствующий показ в кабинете
   *  (независимо друг от друга); иначе null. */
  function getUser() {
    try { return JSON.parse(localStorage.getItem(K.user) || "null"); } catch { return null; }
  }
  const isAuthenticated = () => !!localStorage.getItem(K.refresh);

  /* ---------- вход ---------- */

  async function login({ prompt } = {}) {
    const verifier = randomString();
    const state = randomString();
    sessionStorage.setItem(K.verifier, verifier);
    sessionStorage.setItem(K.state, state);

    const u = new URL(authBase + "/authorize");
    u.searchParams.set("client_id", clientId);
    u.searchParams.set("redirect_uri", redirectUri);
    u.searchParams.set("state", state);
    u.searchParams.set("code_challenge", await challengeOf(verifier));
    u.searchParams.set("code_challenge_method", "S256");
    if (prompt) u.searchParams.set("prompt", prompt);
    location.assign(u.toString());
  }

  /**
   * Разбор возврата от auth. Возвращает true, если код был и обменялся успешно.
   * Код из адресной строки убирается в любом случае — он одноразовый, и оставлять
   * его в истории браузера незачем.
   */
  async function handleRedirect() {
    const q = new URLSearchParams(location.search);
    const code = q.get("code");
    if (!code) return false;

    const returnedState = q.get("state");
    const expectedState = sessionStorage.getItem(K.state);
    const verifier = sessionStorage.getItem(K.verifier);
    sessionStorage.removeItem(K.state);
    sessionStorage.removeItem(K.verifier);

    // Чистим адресную строку до любых проверок: код одноразовый, в истории ему не место.
    q.delete("code");
    q.delete("state");
    history.replaceState(null, "", location.pathname + (q.toString() ? "?" + q : "") + location.hash);

    if (!verifier) return false;
    if (returnedState !== expectedState) return false;

    const res = await fetch(authBase + "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: redirectUri,
        code,
        code_verifier: verifier,
      }),
    });
    if (!res.ok) return false;
    saveTokens(await res.json());
    return true;
  }

  /* ---------- обновление токена ---------- */

  let refreshing = null; // одна попытка на всех: параллельные запросы не должны гонять refresh наперегонки

  /** true — обновили; false — refresh-токена нет или auth его отверг (нужен
   * вход); OFFLINE — до auth не достучались (нет сети, auth лежит). Без сети
   * токены НЕ стираем: иначе поезд в тоннеле выглядит как разлогин, а
   * ответы, данные в это время, уходят «гостю». */
  async function tryRefresh() {
    if (refreshing) return refreshing;
    const token = localStorage.getItem(K.refresh);
    if (!token) return false;

    refreshing = (async () => {
      let res;
      try {
        res = await fetch(authBase + "/oauth/token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ grant_type: "refresh_token", client_id: clientId, refresh_token: token }),
        });
      } catch { return OFFLINE; }
      if (res.status >= 500) return OFFLINE;
      if (!res.ok) { clearTokens(); return false; }
      saveTokens(await res.json());
      return true;
    })().catch(() => false).finally(() => { refreshing = null; });

    return refreshing;
  }
  const refresh = async () => (await tryRefresh()) === true;

  /** Действующий токен, null — нужен вход, OFFLINE — нет связи с auth. */
  async function currentToken() {
    const access = localStorage.getItem(K.access);
    const expires = parseInt(localStorage.getItem(K.expires) || "0", 10);
    if (access && Date.now() < expires) return access;
    const r = await tryRefresh();
    return r === true ? localStorage.getItem(K.access) : r;
  }

  /** Действующий access-токен: обновляет заранее, если срок вышел. null —
   * токена сейчас нет (в том числе без сети — тогда токены целы, повторите позже). */
  async function getAccessToken() {
    const t = await currentToken();
    return typeof t === "string" ? t : null;
  }

  /**
   * fetch с авторизацией. При 401 один раз обновляет токен и повторяет запрос —
   * чтобы протухший access не выглядел для пользователя как разлогин.
   */
  async function authFetch(url, init = {}) {
    const send = async token => {
      const headers = new Headers(init.headers || {});
      headers.set("Authorization", "Bearer " + token);
      return fetch(url, { ...init, headers });
    };

    let token = await currentToken();
    if (token === OFFLINE) throw new AuthOfflineError();
    if (!token) throw new AuthRequiredError();

    let res = await send(token);
    if (res.status !== 401) return res;

    const r = await tryRefresh();
    if (r === OFFLINE) throw new AuthOfflineError();
    if (!r) throw new AuthRequiredError();
    token = localStorage.getItem(K.access);
    if (!token) throw new AuthRequiredError();
    res = await send(token);
    if (res.status === 401) { clearTokens(); throw new AuthRequiredError(); }
    return res;
  }

  /* ---------- выход ---------- */

  async function logout({ redirectTo } = {}) {
    const token = localStorage.getItem(K.refresh);
    if (token) {
      try {
        await fetch(authBase + "/oauth/revoke", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refresh_token: token }),
          keepalive: true,
        });
      } catch { /* сеть недоступна — локально всё равно выходим */ }
    }
    clearTokens();
    const u = new URL(authBase + "/logout");
    u.searchParams.set("post_logout_redirect_uri", redirectTo || location.origin + location.pathname);
    location.assign(u.toString());
  }

  /** Ссылка на управление аккаунтом — смена пароля и список устройств живут там. */
  const accountUrl = () => authBase + "/";

  return {
    login, logout, handleRedirect, refresh, getAccessToken,
    fetch: authFetch, isAuthenticated, getUser, clearTokens, accountUrl, authBase,
  };
}

/** Бросается, когда токены кончились и нужен новый вход. */
class AuthRequiredError extends Error {
  constructor() { super("auth required"); this.name = "AuthRequiredError"; }
}
/** Бросается, когда токен надо обновить, а до auth не достучаться (нет сети).
 * Вход при этом не потерян — как обычная сетевая ошибка: повторите позже. */
class AuthOfflineError extends Error {
  constructor() { super("auth unreachable"); this.name = "AuthOfflineError"; }
}

if (typeof module !== "undefined") module.exports = { createAuthClient, AuthRequiredError, AuthOfflineError };
