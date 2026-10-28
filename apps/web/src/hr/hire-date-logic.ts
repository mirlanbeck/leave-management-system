/** Предупреждение при вводе даты выхода (RULES §6-2; текст - DECISIONS 2026-10-28 19:19). */
export const HIRE_DATE_WARNING =
  'Внимание: проверьте дату выхода: от неё пересчитаются начисления и остаток. Одобренные отпуска и списания не изменятся, остаток может стать отрицательным';

/** Разовое сообщение после сохранения, дословно RULES §6-3; нигде не хранится. */
export const HIRE_DATE_CHANGED = 'Дата изменена. Проверьте одобренные отпуска этого сотрудника';

/** Границы дат API (architecture §7): за ними сервер отвечает 400. */
export const HIRE_DATE_MIN = '2000-01-01';
export const HIRE_DATE_MAX = '2100-12-31';

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Новая дата введена и отличается от текущей: показать предупреждение (RULES §6-2). */
export function isNewHireDate(value: string, current: string): boolean {
  return ISO.test(value) && value !== current;
}

/**
 * Можно ли нажать «Сохранить»: дата введена, в границах API и отличается от текущей. Только
 * подсказка кнопке; проверяет сервер. Даты ISO, поэтому строки сравниваются как даты.
 */
export function canSaveHireDate(value: string, current: string): boolean {
  return isNewHireDate(value, current) && value >= HIRE_DATE_MIN && value <= HIRE_DATE_MAX;
}

export function hireDateBody(hireDate: string): { hireDate: string } {
  return { hireDate };
}
