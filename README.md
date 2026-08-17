# Что смотрим?

Компания друзей выбирает фильм на вечер, когда не может договориться:
общий список кандидатов на комнату, случайный выбор (взвешенный рандом или
SVG-колесо) и кнопка «Смотреть на Кинопоиске», которая собирает ссылку на
уже найденный фильм.

В разработке (см. `torrent-engine.js`) — собственный потоковый просмотр из
торрента прямо в сервисе, пока тестовый маршрут без плеера и без выбора
фильма (`GET /api/stream/test`, фаза 1 плана). До его завершения видео
сервис не хранит и не раздаёт — только помогает выбрать и открывает
сторонний сайт в новой вкладке.

Личная оценка и отметка «просмотрено» привязаны к паре (пользователь, фильм)
глобально, без привязки к конкретной комнате: посмотрели вместе — отметка
остаётся, даже если комнату потом распустили.

Домен: `movies.burninghouse.ru`. Аккаунты — общие, через
[BurningHouse Auth](../Auth/INTEGRATION.md); своей формы входа у сервиса нет.

## Что внутри

| Файл | Что это |
|---|---|
| `server.js` | весь бэкенд: SQLite, API, отдача статики |
| `auth-client.js` | проверка токена по JWKS (копия из `Auth/client/`) |
| `poiskkino.js` | клиент poiskkino.dev: поиск и карточка фильма, учёт суточного лимита |
| `selection.js` | pluggable-реестр алгоритмов розыгрыша (взвешенный рандом, колесо) |
| `csv.js` | ручной CSV-парсер/сериализатор списка комнаты, без зависимостей |
| `torrent-engine.js` | обёртка над `webtorrent` — потоковое скачивание для просмотра из торрента |
| `index.html` | разметка приложения, SPA-экраны как `<section hidden>` |
| `assets/app.js` | вся логика фронта |
| `assets/theme.css` | переменные `--flame-*`/`--night-*`/`--dawn-*` и локап |
| `assets/auth-client.js` | вход/обновление токена/`fetch` в браузере (копия из `Auth/client/`) |
| `assets/brand.css`, `assets/brand.js` | фирменный слой — **копии**, правят их в `Shared/` |
| `assets/favicon.svg` | `Shared/mark-small.svg` со вписанными цветами вещества |

Почти без зависимостей: SQLite — встроенный `node:sqlite`, ставить нечего.
Единственное исключение — `webtorrent` (`torrent-engine.js`), протокол
торрентов с нуля не пишем; `dev.mjs` сам ставит его при первом локальном
запуске. Нужен Node 24 (на Node 22 работает с флагом
`--experimental-sqlite`, `dev.mjs` подставляет его сам; `webtorrent`
требует Node ≥22).

## Локальный запуск

Одной командой — поднимает auth и сервис, регистрирует клиента и заводит
тестовый аккаунт:

```bash
node dev.mjs
```

Открывать `http://localhost:8791`, входить как `dev` / `dev-parol-2026`.
Начать с чистых данных — `node dev.mjs --reset`. Всё живёт в `.dev/` и не
коммитится; репозиторий `Auth` должен лежать рядом (`../Auth`).

Поиск фильмов локально работает, только если задан ключ poiskkino.dev:

```bash
POISKKINO_API_KEY=ваш_ключ node dev.mjs
```

Без ключа сервис поднимается и всё остальное работает — просто поиск и
добавление новых (некэшированных) фильмов будет отвечать ошибкой.

### Почему Live Server не подходит

Три причины, и каждой достаточно:

1. **Это не статика.** Данные и проверка токена — в `server.js`. Без него
   страница получит 401 на первом же запросе.
2. **`redirect_uri` сверяется побайтово.** Live Server отдаёт на порту 5500, а
   в auth зарегистрирован `http://localhost:8791/` — вход отобьётся ещё до формы.
3. **Кука сессии auth помечена `Secure`** и по `http://` браузером не
   сохраняется. Поэтому auth локально запускают с `DEV=1`; без него вход вроде
   бы проходит, но возвращает на исходную, будто ничего не было. `dev.mjs`
   ставит этот флаг сам.

## Переменные окружения

| Переменная | По умолчанию | Зачем |
|---|---|---|
| `PORT` | 8791 (в прод-образе — 8792) | порт |
| `HOST` | 127.0.0.1 | интерфейс (за nginx оставляем localhost) |
| `DATA_DIR` | `./data` | `store.db` |
| `AUTH_ISSUER` | — | **обязательна**; совпадает с `ISSUER` auth символ в символ |
| `AUTH_CLIENT_ID` | `movies` | идентификатор сервиса в auth |
| `AUTH_BASE` | `= AUTH_ISSUER` | куда фронт уводит на вход, если он отличается от внутреннего адреса |
| `AUTH_JWKS_URL` | `AUTH_ISSUER/.well-known/jwks.json` | если auth виден серверу по другому адресу, чем браузеру |
| `POISKKINO_API_KEY` | — | ключ poiskkino.dev; **без него поиск и добавление новых фильмов выключены** |
| `POISKKINO_DAILY_CAP` | 190 | мягкий потолок обращений к poiskkino.dev в сутки |

## Деплой

Схема общая для всех проектов BurningHouse: GitHub Actions собирает образ и
пушит в Docker Hub, на сервер не заходит; новый образ забирает Watchtower.
Подробный пошаговый гайд (Docker и bare-metal, DNS, nginx, сертификат,
регистрация в auth, бэкапы) — в [`README-deploy.md`](README-deploy.md).
Установка самого Watchtower — в `../Auth/README-deploy.md`.

Секреты репозитория: только `DOCKERHUB_USERNAME` и `DOCKERHUB_TOKEN`.
SSH-ключа в CI быть не должно.

nginx: готовый конфиг — `deploy/nginx-movies-443.conf`, проксирует на
`127.0.0.1:8792`. `client_max_body_size` оставлен дефолтным — сервис своих
файлов не принимает, постеры отдаются прямо с CDN poiskkino.dev.

## Чек-лист перед выкатом

Все шаги — вручную, на реальной инфраструктуре, этот репозиторий их не
выполняет и не автоматизирует:

- [ ] Создать GitHub-репозиторий, запушить в него ветку `main`
- [ ] В настройках репозитория добавить секреты `DOCKERHUB_USERNAME` и
      `DOCKERHUB_TOKEN` (без них workflow `.github/workflows/deploy.yml` не
      сможет опубликовать образ)
- [ ] Дождаться первой сборки — в Docker Hub должен появиться `shadowkick/movies:latest`
- [ ] На реальном auth-сервере зарегистрировать клиента:
      ```bash
      cd ~/auth && docker compose exec auth node server.js client-add movies "Что смотрим?" https://movies.burninghouse.ru/
      ```
      `redirect_uri` сверяется побайтово — со слэшем на конце, ровно как здесь
- [ ] На сервере рядом с `docker-compose.prod.yml` положить в `.env` ключ
      poiskkino.dev. Если в этом `.env` уже есть другие переменные (например
      `ADMIN_INTERNAL_KEY`) — не перезаписывайте файл целиком, используйте
      `Shared/set-env.sh`:
      ```bash
      bash set-env.sh POISKKINO_API_KEY 'ваш_ключ'
      ```
- [ ] Поднять nginx-конфиг и сертификат для `movies.burninghouse.ru`:
      ```bash
      sudo cp deploy/nginx-movies-443.conf /etc/nginx/sites-available/movies
      sudo ln -s /etc/nginx/sites-available/movies /etc/nginx/sites-enabled/
      sudo certbot --nginx -d movies.burninghouse.ru
      sudo nginx -t && sudo systemctl reload nginx
      ```
- [ ] Скопировать `docker-compose.prod.yml` на сервер (как `docker-compose.yml`
      в каталог сервиса, например `~/movies/`) и поднять:
      ```bash
      mkdir -p ~/movies && cd ~/movies
      # положить сюда docker-compose.prod.yml из репозитория как docker-compose.yml
      # и .env из шага выше
      docker compose up -d
      ```
      либо, если контейнер уже когда-то поднимался и метка Watchtower стоит,
      просто дождаться, пока Watchtower сам заберёт новый образ после первой
      сборки в Docker Hub
- [ ] Пройти общий чек-лист `../Auth/INTEGRATION.md#чек-лист-перед-выкатом`
      (redirect_uri, `AUTH_ISSUER` символ в символ, watchtower-метка,
      секреты только `DOCKERHUB_*`)
