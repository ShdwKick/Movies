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
# --append — для переменных со списком через запятую (сейчас это
# POISKKINO_API_KEY — несколько ключей poiskkino.dev, см. Movies/poiskkino.js):
# дописывает значение к уже существующему списку, а не заменяет его целиком —
# добавляя четвёртый ключ, не нужно помнить и переписывать первые три. Если
# значение уже есть в списке — no-op (не дублирует). Без --append (как раньше)
# — обычная перезапись, годится для одиночных секретов вроде ADMIN_INTERNAL_KEY.
#
# Использование:
#   ./set-env.sh POISKKINO_API_KEY 'SXK04WY-...'              # правит ./.env
#   ./set-env.sh --append POISKKINO_API_KEY 'ещё-один-ключ'   # добавляет к списку
#   ./set-env.sh ADMIN_INTERNAL_KEY 'abc123' /opt/admin/.env   # или другой файл
set -euo pipefail

append=0
if [ "${1:-}" = "--append" ]; then
  append=1
  shift
fi

key="${1:?Использование: set-env.sh [--append] KEY value [файл=.env]}"
val="${2:?Использование: set-env.sh [--append] KEY value [файл=.env]}"
file="${3:-.env}"

touch "$file"
chmod 600 "$file"

before="$(grep -m1 "^${key}=" "$file" 2>/dev/null || true)"

tmp="$(mktemp "${file}.XXXXXX")"
awk -v k="$key" -v v="$val" -v append="$append" '
  BEGIN { done = 0 }
  $0 ~ "^" k "=" {
    if (!append) { print k "=" v; done = 1; next }
    cur = substr($0, length(k) + 2)  # то, что после "KEY="
    n = split(cur, parts, ",")
    exists = 0
    for (i = 1; i <= n; i++) if (parts[i] == v) exists = 1
    print (exists ? $0 : k "=" (cur == "" ? v : cur "," v))
    done = 1; next
  }
  { print }
  END { if (!done) print k "=" v }
' "$file" > "$tmp"

chmod 600 "$tmp"
mv "$tmp" "$file"

if [ "$append" = "1" ]; then
  after="$(grep -m1 "^${key}=" "$file" 2>/dev/null || true)"
  if [ -n "$before" ] && [ "$before" = "$after" ]; then
    echo "Уже было: ${key} в ${file} уже содержит это значение — ничего не изменилось."
  else
    echo "Готово: значение добавлено к списку ${key} в ${file} (остальные строки не тронуты)."
  fi
else
  echo "Готово: ${key} записан в ${file} (остальные строки не тронуты)."
fi
