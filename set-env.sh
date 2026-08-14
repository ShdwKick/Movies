#!/usr/bin/env bash
# Копия Shared/set-env.sh — не редактировать здесь.
# Правки вносят в Shared/ и раскладывают: node Shared/sync.mjs
# Безопасно проставить/обновить одну переменную в .env, не трогая остальные.
#
# Копируется на сервер как есть (это не npm-пакет, зависимостей нет — так же,
# как admin-internal.js). `printf 'KEY=val' > .env` перезаписывает файл
# целиком: если там уже лежали другие секреты (ADMIN_INTERNAL_KEY рядом с
# POISKKINO_API_KEY и т.п.), они пропадают. Этот скрипт меняет только свою
# строку, остальные оставляет как есть, и правит .env атомарно — через
# временный файл и mv, а не через sed -i (GNU/BSD sed этот флаг понимают по-разному).
#
# Использование:
#   ./set-env.sh POISKKINO_API_KEY 'SXK04WY-...'            # правит ./.env
#   ./set-env.sh ADMIN_INTERNAL_KEY 'abc123' /opt/admin/.env # или другой файл
set -euo pipefail

key="${1:?Использование: set-env.sh KEY value [файл=.env]}"
val="${2:?Использование: set-env.sh KEY value [файл=.env]}"
file="${3:-.env}"

touch "$file"
chmod 600 "$file"

tmp="$(mktemp "${file}.XXXXXX")"
awk -v k="$key" -v v="$val" '
  BEGIN { done = 0 }
  $0 ~ "^" k "=" { print k "=" v; done = 1; next }
  { print }
  END { if (!done) print k "=" v }
' "$file" > "$tmp"

chmod 600 "$tmp"
mv "$tmp" "$file"

echo "Готово: ${key} записан в ${file} (остальные строки не тронуты)."
