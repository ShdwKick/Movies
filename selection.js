"use strict";
/**
 * Реестр алгоритмов розыгрыша (`Movies/selection.js`) — pluggable-модуль,
 * точка расширения из плана: `weighted_random` и `wheel` используют один и
 * тот же взвешенный случайный выбор (разница только в анимации на фронте),
 * `elimination` — раундовое выбывание (свой алгоритм, см. pickElimination
 * ниже), `battle_royale` — сознательно вне MVP. `method` как строка и
 * `candidates` как JSON в selection_events уже готовы принять новое значение
 * метода без миграций схемы; сам `elimination` тоже схему не меняет — его
 * `rounds` в БД не пишутся, только уходят в HTTP-ответ (см. server.js).
 */

/** [{kinopoiskId, weight}] → выбранный kinopoiskId, вероятность пропорциональна весу. */
function pickWeighted(candidates) {
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  let r = Math.random() * total;
  for (const c of candidates) { if ((r -= c.weight) <= 0) return c.kinopoiskId; }
  return candidates[candidates.length - 1].kinopoiskId;
}

/**
 * Колесо с выбыванием: последовательность раундов, в каждом среди ещё
 * оставшихся кандидатов ВЗВЕШЕННО-случайно (тот же pickWeighted, что у
 * weighted_random/wheel) выбирается один — но не победитель, а выбывающий —
 * и убирается из набора. Раунды повторяются, пока не останется один
 * кандидат — он и есть результат. Вес трактуется как «шанс попасть под
 * выбывание» в конкретном раунде, а не «шанс выиграть» — механика
 * инвертирована по сравнению с pickWeighted, поэтому результат не
 * обязательно совпадёт с тем, что выбрал бы обычный взвешенный розыгрыш.
 *
 * В отличие от pickWeighted, возвращает не голый kinopoiskId, а
 * {rounds, resultKinopoiskId}: rounds — история для анимации на фронте
 * (кто выбыл и что осталось после каждого раунда), в БД не пишется (см.
 * server.js — в selection_events уходит только resultKinopoiskId, как и у
 * остальных методов).
 */
function pickElimination(candidates) {
  let remaining = candidates.slice();
  const rounds = [];
  while (remaining.length > 1) {
    const eliminated = pickWeighted(remaining);
    remaining = remaining.filter(c => c.kinopoiskId !== eliminated);
    rounds.push({ eliminated, remainingAfter: remaining.map(c => c.kinopoiskId) });
  }
  return { rounds, resultKinopoiskId: remaining[0].kinopoiskId };
}

const METHODS = {
  weighted_random: pickWeighted,
  wheel: pickWeighted,   // тот же алгоритм, другое визуальное представление
  elimination: pickElimination,
  // battle_royale: pickBattleRoyale,  // задел на будущее
};

module.exports = { METHODS, pickWeighted, pickElimination };
