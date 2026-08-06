// Копия Shared/brand.js — не редактировать здесь.
// Правки вносят в Shared/ и раскладывают: node Shared/sync.mjs
"use strict";
/**
 * Искры фирменного фона BurningHouse.
 *
 * Канонический файл — этот, сервисы копируют его к себе в assets/ без правок.
 * Разметке достаточно контейнера:
 *
 *   <div class="bh-layer bh-sparks" data-bh-sparks="6"></div>
 *
 * Повадку задаёт класс на том же контейнере (см. brand.css):
 *   bh-sparks--settle — оседают (финансы)
 *   bh-sparks--motes  — пылинки в луче (фильмы)
 *   bh-sparks--wind   — сносит вбок (поездки)
 *   без класса        — ровно поднимаются вверх (вход)
 *
 * Почему скриптом, а не разметкой: у каждой искры свои длительность, задержка
 * и снос. Одинаковые искры сразу читаются как один элемент, размноженный
 * копипастой, и весь эффект пропадает.
 */

(function () {
  const boxes = document.querySelectorAll("[data-bh-sparks]");
  if (!boxes.length) return;

  // При отключённой анимации искры остаются как статичная крупа — толку от
  // двух десятков неподвижных точек нет, хватает нескольких.
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  // На телефоне вдвое меньше — не ради кадров, а ради батареи.
  const coarse = matchMedia("(pointer: coarse)").matches;

  for (const box of boxes) {
    let n = parseInt(box.dataset.bhSparks, 10) || 0;
    if (coarse) n = Math.ceil(n / 2);
    if (still) n = Math.min(n, 4);

    const frag = document.createDocumentFragment();
    for (let i = 0; i < n; i++) {
      const s = document.createElement("i");
      s.className = "bh-spark";
      s.style.left = (4 + Math.random() * 92).toFixed(1) + "%";
      s.style.setProperty("--bh-dur", (9 + Math.random() * 8).toFixed(1) + "s");
      // Отрицательная задержка — чтобы искры уже были «в полёте» на первом
      // кадре, а не стартовали все разом от нижнего края.
      s.style.setProperty("--bh-delay", (-Math.random() * 14).toFixed(1) + "s");
      s.style.setProperty("--bh-drift", (Math.random() * 5 - 2.5).toFixed(1) + "rem");
      frag.append(s);
    }
    box.append(frag);
  }
})();
