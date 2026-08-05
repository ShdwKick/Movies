"use strict";
/**
 * Ручной CSV-парсер/сериализатор (RFC 4180) без внешних зависимостей — в
 * этом стеке принципиально нет npm install (см. план, раздел «CSV
 * импорт/экспорт»). Используется только для экспорта/импорта фильмов
 * комнаты (`server.js`, `POST /api/rooms/:id/import`, `GET
 * /api/rooms/:id/export.csv`).
 *
 * Формат полей: значение в кавычках, если внутри встречаются запятая,
 * кавычка или перевод строки; кавычка внутри такого поля экранируется
 * удвоением (`""`). Ровно то же самое умеют Excel/Google Sheets, так что
 * файл, экспортированный отсюда, открывается и правится там без сюрпризов,
 * а файл, сохранённый оттуда, разбирается здесь.
 *
 * Экспортируем два уровня:
 *   - parseRows(text)   → array of string[]        — сырые строки/поля
 *   - parse(text)       → array of {…, __line}      — объекты по заголовку
 *                          (__line — номер строки в исходном файле, считая
 *                          заголовок за строку 1, для отчётов об ошибках)
 *   - stringify(columns, rows) → CSV-строка
 */

/**
 * Разбирает CSV-текст в массив строк, каждая строка — массив полей.
 * Простой конечный автомат: вне кавычек запятая/перевод строки завершают
 * поле/строку, `"` открывает кавычки; внутри кавычек `""` — экранированная
 * кавычка, любая другая `"` закрывает кавычки. `\r\n` и голый `\n`
 * понимаются одинаково (BOM в начале файла срезается).
 */
function parseRows(text) {
  if (typeof text !== "string") text = String(text ?? "");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM — Excel любит его добавлять

  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let sawAny = false; // хоть один символ этой строки уже прочитан (иначе финальный \n даёт лишнюю пустую строку)

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      sawAny = true;
      continue;
    }
    if (c === '"') { inQuotes = true; sawAny = true; continue; }
    if (c === ",") { row.push(field); field = ""; sawAny = true; continue; }
    if (c === "\r") { continue; } // перевод строки добираем на \n
    if (c === "\n") {
      row.push(field); rows.push(row);
      row = []; field = ""; sawAny = false;
      continue;
    }
    field += c; sawAny = true;
  }
  if (sawAny || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Разбирает CSV в массив объектов по заголовку (первая строка — имена
 * колонок, лишние пробелы вокруг них обрезаются). Пустые строки (полностью
 * без содержимого) пропускаются. Каждый объект получает служебное поле
 * `__line` — номер строки в исходном файле (1 = заголовок), полезно для
 * отчёта об ошибках импорта. Значения — как есть, строки; вызывающий код
 * сам приводит их к нужным типам (см. `server.js: importRoomCsv`).
 */
function parse(text) {
  const rows = parseRows(text);
  if (!rows.length) return [];
  const header = rows[0].map(h => String(h).trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === "") continue; // пустая строка в файле
    const obj = { __line: i + 1 };
    header.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : ""; });
    out.push(obj);
  }
  return out;
}

/** Одно поле → CSV-представление: в кавычки берём, только если внутри есть запятая/кавычка/перевод строки. */
function csvField(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** `columns` — порядок и состав колонок, `rows` — массив объектов {колонка: значение}. `\r\n` — как того требует RFC 4180. */
function stringify(columns, rows) {
  const lines = [columns.map(csvField).join(",")];
  for (const row of rows) lines.push(columns.map(c => csvField(row[c])).join(","));
  return lines.join("\r\n") + "\r\n";
}

module.exports = { parseRows, parse, stringify, csvField };
