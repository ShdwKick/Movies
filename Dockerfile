FROM node:24-alpine

WORKDIR /app

# До фазы 1 стрим-пайплайна зависимостей не было вовсе: SQLite — встроенный
# node:sqlite, проверка токенов — auth-client.js на 200 строк. Теперь одна
# осознанная npm-зависимость — webtorrent (см. torrent-engine.js) — писать
# протокол торрентов с нуля нереалистично, остальной сервис по-прежнему без
# зависимостей. package.json/lock — отдельным слоем ДО остального кода: он
# меняется реже, чем server.js, слой с node_modules переиспользуется кэшем
# докера между сборками, если зависимости не трогали.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Модули берём маской, а не по одному: перечисление уже подводило в Trip — новый
# gigachat.js забыли вписать, и контейнер падал в цикле с MODULE_NOT_FOUND.
# Маска захватывает server.js, auth-client.js, poiskkino.js, selection.js, csv.js,
# torrent-engine.js и всё, что появится дальше. Локальный запускатор dev.mjs
# сюда не попадает — он .mjs.
COPY *.js ./
COPY index.html ./
COPY assets/ ./assets/

# Проверка на этапе сборки: пропавший модуль ломает сборку, а не контейнер на
# сервере. Запускать сервер нельзя — он бы занял порт и повис, поэтому только
# наличие файлов и разбор синтаксиса.
RUN set -e; \
    for f in server.js auth-client.js admin-internal.js poiskkino.js selection.js csv.js torrent-engine.js index.html; do \
      test -f "$f" || { echo "В образе нет $f — проверьте COPY в Dockerfile"; exit 1; }; \
    done; \
    for f in server.js auth-client.js admin-internal.js poiskkino.js selection.js csv.js torrent-engine.js; do node --check "$f"; done

# Каталог данных: store.db. В контейнере он смонтирован томом —
# см. docker-compose.yml.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV HOST=0.0.0.0
ENV PORT=8792
ENV DATA_DIR=/app/data

EXPOSE 8792
VOLUME ["/app/data"]

CMD ["node", "server.js"]
