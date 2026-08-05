"use strict";
/**
 * Реестр алгоритмов розыгрыша (`Movies/selection.js`) — pluggable-модуль,
 * точка расширения из плана: сегодня `weighted_random` и `wheel` используют
 * один и тот же взвешенный случайный выбор (разница только в анимации на
 * фронте), `elimination`/`battle_royale` — сознательно вне MVP, но `method`
 * как строка и `candidates` как JSON в selection_events уже готовы принять
 * новое значение метода без миграций схемы.
 */

/** [{kinopoiskId, weight}] → выбранный kinopoiskId, вероятность пропорциональна весу. */
function pickWeighted(candidates) {
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  let r = Math.random() * total;
  for (const c of candidates) { if ((r -= c.weight) <= 0) return c.kinopoiskId; }
  return candidates[candidates.length - 1].kinopoiskId;
}

const METHODS = {
  weighted_random: pickWeighted,
  wheel: pickWeighted,   // тот же алгоритм, другое визуальное представление
  // elimination: pickElimination,     // задел на будущее
  // battle_royale: pickBattleRoyale,  // задел на будущее
};

module.exports = { METHODS, pickWeighted };
