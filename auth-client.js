"use strict";
/**
 * Серверная часть подключения сервиса к BurningHouse Auth.
 *
 * Копируется в проект как есть (зависимостей нет, ставить нечего). Проверка
 * access-токена — локальная: подпись сверяется по публичным ключам из
 * /.well-known/jwks.json, сетевого запроса в auth на каждый API-вызов не
 * происходит. Auth-сервис лежит ⇒ уже выданные токены продолжают работать.
 *
 * Использование:
 *
 *   const auth = require("./auth-client")({
 *     issuer:   process.env.AUTH_ISSUER,      // https://auth.burninghouse.ru
 *     audience: process.env.AUTH_CLIENT_ID,   // finance
 *   });
 *   const user = await auth.userFromRequest(req);  // { id, username, name, email, phone, sid, admin } | null
 */

const crypto = require("crypto");

const DEFAULTS = {
  cacheTtl: 60 * 60 * 1000,   // штатное обновление ключей — раз в час
  minRefetch: 30 * 1000,      // но не чаще, чем раз в полминуты при неизвестном kid
  // Допуск на расхождение часов между машинами. Применяется и к exp, то есть
  // ровно на столько же переживает свой срок каждый токен — потому и держим
  // небольшим. Сервисы на одном хосте с NTP спокойно живут и с 0.
  clockSkew: 30,
  timeout: 5000,
};

module.exports = function createAuthClient(options) {
  // Пропущенные (undefined) поля не должны затирать значения по умолчанию —
  // вызывающий код часто передаёт их прямо из process.env.
  const given = Object.fromEntries(Object.entries(options || {}).filter(([, v]) => v !== undefined && v !== null && v !== ""));
  const cfg = { ...DEFAULTS, ...given };
  if (!cfg.issuer) throw new Error("auth-client: не задан issuer");
  const issuer = cfg.issuer.replace(/\/+$/, "");
  const jwksUrl = cfg.jwksUrl || issuer + "/.well-known/jwks.json";

  let keys = new Map();       // kid -> crypto.KeyObject
  let fetchedAt = 0;
  let inflight = null;

  async function fetchJwks() {
    if (inflight) return inflight;
    inflight = (async () => {
      const res = await fetch(jwksUrl, { signal: AbortSignal.timeout(cfg.timeout) });
      if (!res.ok) throw new Error("JWKS: HTTP " + res.status);
      const body = await res.json();
      const next = new Map();
      for (const jwk of body.keys || []) {
        if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") continue;
        try {
          next.set(jwk.kid, crypto.createPublicKey({ key: jwk, format: "jwk" }));
        } catch { /* битый ключ пропускаем, остальные всё равно годятся */ }
      }
      if (!next.size) throw new Error("JWKS: не пришло ни одного пригодного ключа");
      keys = next;
      fetchedAt = Date.now();
    })().finally(() => { inflight = null; });
    return inflight;
  }

  /**
   * Ключ по kid. Кэш намеренно НЕ инвалидируется по ошибке сети: если auth
   * недоступен, старые ключи лучше протухшего кэша — иначе падение auth уронит
   * и все сервисы разом, ради чего локальная проверка и затевалась.
   */
  async function keyFor(kid) {
    const stale = Date.now() - fetchedAt > cfg.cacheTtl;
    if (!keys.size || (stale && Date.now() - fetchedAt > cfg.minRefetch)) {
      try { await fetchJwks(); } catch (e) { if (!keys.size) throw e; }
    }
    if (!keys.has(kid) && Date.now() - fetchedAt > cfg.minRefetch) {
      // Незнакомый kid — вероятно, ключ только что ротировали.
      try { await fetchJwks(); } catch { /* работаем с тем, что есть */ }
    }
    return keys.get(kid) || null;
  }

  /** Проверка токена. Возвращает payload или null — исключений не бросает. */
  async function verify(token) {
    const parts = String(token || "").split(".");
    if (parts.length !== 3) return null;

    let header, payload;
    try {
      header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    } catch { return null; }
    if (header.alg !== "EdDSA" || header.typ !== "JWT" || !header.kid) return null;

    let key;
    try { key = await keyFor(header.kid); } catch { return null; }
    if (!key) return null;

    let ok = false;
    try {
      ok = crypto.verify(null, Buffer.from(parts[0] + "." + parts[1]), key, Buffer.from(parts[2], "base64url"));
    } catch { return null; }
    if (!ok) return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== "number" || payload.exp + cfg.clockSkew < now) return null;
    if (typeof payload.nbf === "number" && payload.nbf - cfg.clockSkew > now) return null;
    if (payload.iss !== issuer) return null;
    if (cfg.audience && payload.aud !== cfg.audience) return null;
    return payload;
  }

  function bearer(req) {
    const h = (req.headers && req.headers["authorization"]) || "";
    return h.startsWith("Bearer ") ? h.slice(7) : null;
  }

  /** Пользователь запроса или null. Именно это и нужно в обработчиках. */
  async function userFromRequest(req) {
    const payload = await verify(bearer(req));
    if (!payload) return null;
    return {
      id: payload.sub,
      username: payload.preferred_username || null,
      // Есть, только если сам пользователь включил показ имени в кабинете
      // BurningHouse — иначе поле отсутствует в токене вовсе. Для "Вы вошли
      // как …" и подобного берите `user.name || user.username`.
      name: payload.name || null,
      email: payload.email || null,
      // Как и name — есть, только если пользователь в кабинете отдельно
      // разрешил делиться телефоном (независимо от показа имени). Задел
      // под переводы по номеру: например, Trip показывает его только
      // внутри своих собственных, уже проверенных групп — какому кругу
      // людей номер вообще виден, решает потребляющий сервис, не auth.
      phone: payload.phone_number || null,
      sid: payload.sid || null,
      clientId: payload.aud,
      expiresAt: payload.exp * 1000,
      // true только если пользователь помечен админом в кабинете BurningHouse
      // (см. Auth/lib/cli.js: make-admin). Claim отсутствует в токене вовсе,
      // если false — тот же приём, что и у name/email/phone выше.
      admin: !!payload.admin,
    };
  }

  /** Прогрев кэша на старте, чтобы первый же запрос не ждал сети. Ошибку не считаем фатальной. */
  function warmup() {
    return fetchJwks().catch(e => console.error("auth-client: не удалось загрузить JWKS —", e.message));
  }

  return { verify, userFromRequest, bearer, warmup, issuer, jwksUrl };
};
