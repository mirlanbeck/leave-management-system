// Правила смены даты выхода (RULES §6-1, §7-2) без БД и Nest. Факты собирает HrService.

export type HireDateChangeError = 'NOT_FOUND' | 'FORBIDDEN';

/**
 * Порядок проверок после тела запроса (architecture §8; DECISIONS 2026-10-28 19:19), как у отзыва:
 * невидимый или несуществующий сотрудник - NOT_FOUND, видимый, но зритель не HR - FORBIDDEN.
 * HR меняет дату любому, в том числе себе.
 */
export function hireDateChangeError(facts: {
  exists: boolean;
  visible: boolean;
  actorIsHr: boolean;
}): HireDateChangeError | null {
  if (!facts.exists || !facts.visible) return 'NOT_FOUND';
  if (!facts.actorIsHr) return 'FORBIDDEN';
  return null;
}
