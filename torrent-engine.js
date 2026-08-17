"use strict";
/**
 * Обёртка над WebTorrent — единственная npm-зависимость во всём сервисе (см.
 * стрим-пайплайн §2: писать протокол торрентов с нуля нереалистично, внешний
 * демон ради сохранения принципа «без npm» тоже решили не заводить — так
 * решено сознательно, остальной сервис по-прежнему без зависимостей).
 *
 * webtorrent на npm — чистый ESM ("type":"module" в его package.json), а
 * весь server.js — CommonJS. Переписывать сервис в ESM ради одной
 * зависимости смысла нет, поэтому подключаем её динамическим import() внутри
 * обычной require()-функции — стандартный CJS/ESM интероп, никакой магии.
 *
 *   const engine = require("./torrent-engine")({ downloadDir });
 *   const file = await engine.getFile(magnetUri);
 *   file.createReadStream({ start, end })  // те же inclusive-байты, что и у HTTP Range
 *
 * Файл для стриминга — фаза 1 берёт просто САМЫЙ БОЛЬШОЙ файл в торренте:
 * почти всегда это и есть видео, а торренты с несколькими видеофайлами —
 * редкий случай, который эта фаза сознательно не решает (см. план).
 */

// Клиент один на процесс — второй WebTorrent-клиент занял бы тот же
// UDP/TCP-порт для DHT/пиров. Ленивая инициализация: если стриминг ни разу
// не понадобился, лишний ESM-импорт и сетевые сокеты не заводим вовсе.
let clientPromise = null;
function getClient() {
  if (!clientPromise) {
    clientPromise = import("webtorrent").then(({ default: WebTorrent }) => new WebTorrent());
  }
  return clientPromise;
}

const ADD_TIMEOUT_MS = 30000;

module.exports = function createTorrentEngine(options = {}) {
  const downloadDir = options.downloadDir;
  if (!downloadDir) throw new Error("torrent-engine: нужен downloadDir");

  // magnetUri/торрент-ссылка → Promise<torrent> — чтобы одну и ту же ссылку
  // за время жизни процесса не добавлять в клиент повторно на каждый запрос
  // (стрим дёргает getFile на каждый Range-запрос браузера, их может быть
  // много на один и тот же фильм).
  const torrents = new Map();

  function addTorrent(torrentId) {
    if (!torrents.has(torrentId)) {
      torrents.set(torrentId, getClient().then(client => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          torrents.delete(torrentId); // не кэшируем неудачу — вдруг пиры появятся при следующей попытке
          reject(new Error(`Торрент не вернул метаданные за ${ADD_TIMEOUT_MS / 1000} секунд — нет пиров или битая ссылка`));
        }, ADD_TIMEOUT_MS);
        client.add(torrentId, { path: downloadDir }, torrent => {
          clearTimeout(timer);
          resolve(torrent);
        });
      })));
    }
    return torrents.get(torrentId);
  }

  async function getFile(torrentId) {
    const torrent = await addTorrent(torrentId);
    const file = torrent.files.slice().sort((a, b) => b.length - a.length)[0];
    if (!file) throw new Error("В торренте нет файлов");
    return file;
  }

  return { getFile };
};
