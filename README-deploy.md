# Развёртывание «Что смотрим?» на своём сервере

Полноценный маленький сервер (`server.js`, чистый Node.js, без единой npm-зависимости
— даже хранилище встроенное, SQLite через `node:sqlite`), который отдаёт и статику
(`index.html` + `assets/`), и API с одного домена: открываете `https://ваш-домен` —
видите приложение, оно само стучится на `/api/...` за данными.

В отличие от «Моих финансов», у «Что смотрим?» нет офлайн-режима: данные (комнаты,
очередь, история просмотров) живут только на сервере, открыть `index.html` двойным
кликом и работать без сети не получится — сервис сразу уводит на вход.

Этот файл ещё не описывает реально работающий деплой (в отличие от аналогичных
`README-deploy.md` у «Финансов»/Auth) — сервис на момент написания этого гайда ещё не
выкатывался на боевой сервер. Ниже — то же самое пошагово, что нужно будет сделать
в первый раз; чек-лист короче (без пояснений) лежит в `README.md`.

## Ваши значения для этого деплоя

Инструкции ниже написаны с плейсхолдерами (`<домен>`, `<порт>` и т.д.), чтобы годились
для любого сервера. Что уже решено заранее (зашито в код/конфиги этого репозитория,
не плейсхолдер):

| Плейсхолдер | Значение здесь | Почему |
|---|---|---|
| `<домен>` | `movies.burninghouse.ru` | уже выбран, поддомен зарегистрирован |
| `<docker-образ>` | `shadowkick/movies:latest` | указано в `docker-compose.prod.yml` и `.github/workflows/deploy.yml` |
| `<client_id>` | `movies` | указано в `AUTH_CLIENT_ID` по умолчанию (`server.js`) и в `dev.mjs` |
| репозиторий | `github.com/ShdwKick/Movies` (ожидаемо) | **ещё не создан** — см. чек-лист в `README.md`, первый шаг деплоя |
| внутренний порт | `8792` (прод-образ) / `8791` (локальная разработка через `dev.mjs`) | `Dockerfile`/`docker-compose.prod.yml` |

`<порт>` наружу (443 или другой) — решается на месте, см. «Шаг 2. Проверьте порты».
Комнаты приглашаются по коду — открытой регистрации «для всех» тут нет по смыслу
сервиса (в отличие от «Финансов»), это не настройка, а часть логики приложения.

---

## Путь 1: Docker (рекомендуется)

### Шаг 0. Создайте репозиторий и запушьте код (если ещё не сделано)

```bash
cd Movies
git remote add origin https://github.com/<ваш-логин>/Movies.git
git add -A
git commit -m "Что смотрим? — первый коммит"
git push -u origin main
```

В настройках репозитория (Settings → Secrets and variables → Actions) добавьте
секреты `DOCKERHUB_USERNAME` и `DOCKERHUB_TOKEN` (это Access Token, не пароль
аккаунта — hub.docker.com → Account Settings → Security → New Access Token, права
Read & Write достаточно) — без них `.github/workflows/deploy.yml` не сможет
опубликовать образ. После пуша в `main` GitHub Actions сам соберёт и опубликует
`shadowkick/movies:latest` в Docker Hub — дальше шаги ниже просто ждут этот образ.

Если нужен образ прямо сейчас, не дожидаясь первого прогона Actions — соберите и
опубликуйте руками, с рабочей машины, где лежит код:

```bash
docker build -t <docker-hub-логин>/movies:latest .
docker login -u <docker-hub-логин>
docker push <docker-hub-логин>/movies:latest
```

### Шаг 1. Проверьте порты на сервере

Прежде чем занимать что-либо портом наружу — посмотрите, что уже слушает сервер:

```bash
sudo ss -tulpn
```

Если на сервере уже есть VPN (Hysteria2, 3x-ui/xray, WireGuard и т.п.) или другие
сервисы BurningHouse — вероятно, что-то уже сидит на 443. Правило простое:
**приложению не обязательно жить на 443**, любой свободный порт подойдёт — 8443,
9443, что угодно. Найдите в выводе `ss` порт, которого там нет.

Порт 80 обычно стоит оставить свободным — `certbot` использует его на секунду для
подтверждения домена.

### Шаг 2. Установите Docker (если ещё не установлен)

```bash
curl -fsSL https://get.docker.com | sudo sh
```

Если Docker на сервере уже стоит ради Auth/Trip/Финансов — этот шаг не нужен.

### Шаг 3. Скачайте и запустите контейнер

```bash
git clone https://github.com/<ваш-логин>/Movies.git ~/movies
cd ~/movies

sudo docker compose -f docker-compose.prod.yml pull
sudo docker compose -f docker-compose.prod.yml up -d
sudo docker compose -f docker-compose.prod.yml logs -f movies   # Ctrl+C выходит из просмотра, контейнер продолжает работать
curl -s http://127.0.0.1:8792/api/health   # ожидаем {"ok":true}
```

⚠️ **Не копируйте `docker-compose.prod.yml` поверх `docker-compose.yml`.**
`docker-compose.yml` в репозитории нужен для локальной разработки — он **собирает
образ из исходников**, а не тянет готовый. Перезаписав его, вы либо получите на
сервере локальную сборку вместо опубликованного образа, либо `git pull` начнёт
отказываться работать («local changes would be overwritten»). Если так уже вышло —
`git checkout -- docker-compose.yml`, и дальше везде используйте `-f docker-compose.prod.yml`.

Чтобы не писать `-f` каждый раз:
`echo 'alias dcmov="docker compose -f ~/movies/docker-compose.prod.yml"' >> ~/.bashrc`.

Контейнер слушает только `127.0.0.1:8792` — снаружи не виден напрямую, наружу его
выставит nginx на следующем шаге.

### Шаг 4. Ключ poiskkino.dev

Без него сервис поднимется и всё остальное будет работать — просто поиск и
добавление НОВЫХ (ещё не закэшированных) фильмов будет отвечать 503. Секрет —
рядом с `docker-compose.prod.yml`, в файле `.env` с правами 600 (он читается
подстановкой `${POISKKINO_API_KEY:-}` в самом compose-файле). Если в этом же
`.env` уже лежит `ADMIN_INTERNAL_KEY` или что-то ещё — не перезаписывайте файл
целиком (`printf ... > .env` сотрёт остальные строки), используйте
`Shared/set-env.sh` — он меняет только свою переменную:

```bash
cd ~/movies
bash set-env.sh POISKKINO_API_KEY 'ваш_ключ'   # добавит или заменит только эту строку
docker compose -f docker-compose.prod.yml up -d   # перечитать .env
```

`.env` не коммитьте — он и так в `.gitignore`, но проверить не лишнее.

### Шаг 5. DNS

У регистратора домена — **A-запись**: `movies` → IP сервера (тот же IP, что и у
остальных сервисов BurningHouse на этом сервере, это нормально — различаются
портами, не IP). Подождите, пока запись разойдётся: `ping movies.burninghouse.ru`.

### Шаг 6. Сертификат и nginx

```bash
sudo apt install -y nginx certbot
sudo certbot certonly --standalone -d movies.burninghouse.ru
# на секунду займёт порт 80 для проверки домена, затем освободит
```

Готовый конфиг уже лежит в `deploy/nginx-movies-443.conf` (порт 443, домен
`movies.burninghouse.ru`, `proxy_pass http://127.0.0.1:8792`) — если 443 свободен
(см. Шаг 1), берите как есть; если нет — поменяйте `listen 443 ssl;` (и IPv6-строку)
на выбранный порт.

```bash
sudo cp deploy/nginx-movies-443.conf /etc/nginx/sites-available/movies
sudo ln -s /etc/nginx/sites-available/movies /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo ufw allow 443/tcp   # или свой порт, если включён firewall
```

Готово: `https://movies.burninghouse.ru` должен открыть экран входа BurningHouse.

### Шаг 7. Зарегистрировать клиента в auth

Это единственный шаг, без которого «Войти» не сработает — сервис не заводит своих
аккаунтов, а проверяет, что запрос действительно пришёл от зарегистрированного
клиента:

```bash
cd ~/auth   # каталог, где поднят Auth-сервис
docker compose exec auth node server.js client-add movies "Что смотрим?" https://movies.burninghouse.ru/
```

`redirect_uri` (последний аргумент) сверяется побайтово — слэш на конце обязателен,
ровно как здесь. Проверить, что клиент завёлся: `docker compose exec auth node server.js clients`.

### Обновление в будущем

**Штатно ничего делать не нужно:** пуш в `main` → GitHub Actions собирает и публикует
образ → Watchtower на сервере подхватывает его в пределах интервала опроса (обычно
~15 минут, зависит от настройки на сервере). См. «CI/CD» ниже.

Если нужно прямо сейчас — `cd ~/movies && docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`. Данные (том `movies-data`) при этом не трогаются.

---

## CI/CD: сборка по пушу + автообновление на сервере

Модель **pull**, а не push: `.github/workflows/deploy.yml` при каждом пуше в `main`
(кроме правок в `*.md` и `deploy/`) собирает образ и пушит его в Docker Hub
(`shadowkick/movies:latest`) — и на этом останавливается. На сервер он не ходит
вообще. Новый образ забирает **Watchtower**, который крутится на сервере и раз в
интервал опроса проверяет, не изменился ли образ помеченных контейнеров.

Зачем так: в репозитории не нужно хранить SSH-ключ к серверу. Единственный секрет —
токен Docker Hub, который доступа к серверу не даёт.

**Секреты репозитория** (Settings → Secrets and variables → Actions, окружение `MyServerEnv` — см. Шаг 0):

| Секрет | Значение |
|---|---|
| `DOCKERHUB_USERNAME` | логин на Docker Hub |
| `DOCKERHUB_TOKEN` | Access Token, не пароль аккаунта |

**Watchtower ставится один раз на всю машину**, не на каждый проект — если он уже
крутится ради Auth/Trip/Финансов, отдельно для Movies ничего ставить не нужно.
Файл и инструкция — `deploy/watchtower-compose.yml` в репозитории Auth (там же в
`README-deploy.md` разъяснён выбор интервала и лимиты Docker Hub).

Обновляются только контейнеры с меткой — режим opt-in, чтобы Watchtower не полез
обновлять остальную инфраструктуру сервера. У Movies метка уже прописана в
`docker-compose.prod.yml`:

```yaml
labels:
  com.centurylinklabs.watchtower.enable: "true"
```

Что важно помнить:

- **Зелёный прогон Actions = «образ опубликован», а не «уже на проде».** Выкат
  произойдёт в пределах интервала опроса Watchtower. Нужно сейчас —
  `cd ~/movies && docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d`.
- **Правки самого `docker-compose.prod.yml` Watchtower не применяет** — он подменяет
  только образ, сохраняя текущую конфигурацию контейнера. Поменяли env/метки —
  нужен `git pull` на сервере и обычный `up -d`.
- **`deploy/` в образ не входит** — nginx-конфиг как раньше применяется вручную
  (`cp` + `nginx -t` + `reload`).
- Что и когда обновилось — `docker logs watchtower`.

## Если переименуете сервис в compose позже

Имя проекта (`name:` в начале `docker-compose.prod.yml`, сейчас `bh-movies`) участвует
в имени тома: `bh-movies` даёт `bh-movies_movies-data`. **Docker не переименовывает
тома при смене `name:`** — просто создаст новый пустой, а старый останется висеть в
стороне, и приложение молча откроется с пустой базой. Если решите переименовать —
переносите данные руками при остановленном контейнере:

```bash
docker compose -f docker-compose.prod.yml down   # СТАРЫМ именем, до переименования
docker volume create <новое-имя-тома>
docker run --rm -v <старый-том>:/from -v <новое-имя-тома>:/to alpine sh -c 'cd /from && cp -a . /to'
```

`cp -a` обязателен — сохраняет владельца (uid 1000, пользователь `node`). Старый том
не удаляйте сразу, это резервная копия на случай ошибки.

## Хранилище: SQLite

Данные лежат в `data/store.db` — SQLite через встроенный в Node.js модуль `node:sqlite`
(ничего дополнительно ставить не нужно, но версия Node важна: **24 и новее**, на более
старых модуль либо отсутствует, либо экспериментальный).

Кэш метаданных фильмов (таблица `movies`) общий для всех комнат и пользователей —
один и тот же фильм в разных комнатах не бьёт лимит poiskkino.dev повторно (см.
`server.js`, правило кэша разобрано в комментариях рядом с `ensureMovieCached`).

### Резервная копия

Файл активно используется сервером — не копируйте его как обычный файл, используйте
`.backup`, он даёт консистентный снимок на лету, без остановки сервиса:

```bash
# Docker:
docker run --rm -v bh-movies_movies-data:/data -v $(pwd):/backup alpine sh -c \
  "apk add --no-cache sqlite && sqlite3 /data/store.db '.backup /backup/movies-backup-$(date +%F).db'"

# без Docker:
sudo apt install -y sqlite3   # один раз
sqlite3 /opt/movies/data/store.db ".backup ~/movies-backup-$(date +%F).db"
```

---

## Путь 2: без Docker (bare-metal + systemd)

Если Docker на сервере не нужен или нежелателен — то же самое, но напрямую.

**1. Node.js 24+ и nginx:**

```bash
sudo apt update && sudo apt install -y nginx
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # v24.x — важно для SQLite, см. выше
```

**2. Скопируйте файлы приложения** в `/opt/movies` и заведите системного
пользователя без входа:

```bash
sudo mkdir -p /opt/movies/data
sudo cp -r server.js auth-client.js poiskkino.js selection.js csv.js index.html assets /opt/movies/
sudo useradd -r -s /usr/sbin/nologin movies
sudo chown -R movies:movies /opt/movies
```

**3. Ключ poiskkino.dev** — файл `/opt/movies/movies.env`, читается юнитом через
`EnvironmentFile` (см. шаблон ниже), права закрыты от посторонних:

```bash
printf 'POISKKINO_API_KEY=%s\n' 'ваш_ключ' | sudo tee /opt/movies/movies.env
sudo chown movies:movies /opt/movies/movies.env
sudo chmod 600 /opt/movies/movies.env
```

**4. Служба systemd** — шаблон уже готов в `deploy/movies.service`:

```bash
sudo cp deploy/movies.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now movies
sudo systemctl status movies      # active (running)
curl -s http://127.0.0.1:8792/api/health   # {"ok":true}
```

**5. DNS, сертификат, nginx** — те же шаги 5–6 из пути с Docker (проверка портов,
`certbot certonly --standalone`, `deploy/nginx-movies-443.conf` с `proxy_pass http://127.0.0.1:8792`).

**6. Зарегистрировать клиента в auth** — тот же Шаг 7 из пути с Docker.

### Обновление

Скопируйте изменившиеся файлы в `/opt/movies/`, затем `sudo systemctl restart movies`.
Данные (`data/store.db`) не трогаются.

---

## Полезные команды

```bash
# Docker:
docker compose -f docker-compose.prod.yml ps                 # статус
docker compose -f docker-compose.prod.yml logs -f movies      # логи
docker compose -f docker-compose.prod.yml down                 # остановить (данные сохранятся)
docker compose -f docker-compose.prod.yml down -v               # остановить И стереть данные (осторожно!)

# bare-metal:
sudo systemctl status movies
sudo journalctl -u movies -f

# База — CLI-команды со списком аккаунтов в server.js нет (в отличие от «Финансов»),
# смотреть напрямую через sqlite3, если понадобится:
sqlite3 /opt/movies/data/store.db "SELECT id, title FROM rooms;"   # bare-metal
docker exec movies sh -c "apk add --no-cache sqlite 2>/dev/null; sqlite3 data/store.db 'SELECT id, title FROM rooms;'"   # Docker

# аккаунты — в auth-сервисе:
docker compose exec auth node server.js users
docker compose exec auth node server.js passwd <логин> <пароль>
docker compose exec auth node server.js clients   # проверить, что client_id "movies" зарегистрирован
```

## Переменные окружения сервера

Полный список — в шапке `server.js`. Основные:

- `PORT`, `HOST`, `DATA_DIR` — где слушать и куда писать данные.
- `AUTH_ISSUER` — **обязательно**: адрес auth-сервиса. Он же попадает в токены как
  `iss` и сверяется побайтово; без него сервер не стартует.
- `AUTH_CLIENT_ID` (по умолчанию `movies`) — под каким именем сервис зарегистрирован в auth.
- `AUTH_BASE` — куда фронт уводит на вход, если он отличается от `AUTH_ISSUER`
  (нужно, только когда сервер ходит в auth по внутреннему адресу).
- `POISKKINO_API_KEY` — ключ поиска фильмов (api.poiskkino.dev). Без него поиск и
  добавление НОВЫХ фильмов отвечают 503, остальной сервис работает как обычно.
- `POISKKINO_DAILY_CAP` (по умолчанию 190) — мягкий потолок обращений к
  poiskkino.dev в сутки, ниже настоящего лимита провайдера (200/сутки).

## Как это работает вкратце

- Пароли этот сервис не видит вовсе: он получает подписанный токен и проверяет
  подпись локально по публичному ключу auth-сервиса. Токен доступа живёт 15 минут
  и обновляется молча; фоновый refresh-токен — 60 дней и отзывается из личного
  кабинета BurningHouse.
- Комната создаётся одним нажатием и сразу получает код приглашения — им делятся
  голосом или ссылкой, свою регистрацию/приглашения по почте сервис не ведёт.
- Постеры и метаданные фильмов отдаются напрямую с CDN poiskkino.dev — сервис их
  не копирует и не хранит у себя, только кэширует текстовые метаданные (таблица
  `movies` в `store.db`) для экономии дневного лимита API.
