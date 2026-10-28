import { firstAccrualDate } from './accrual';
import { CalendarDate, compareDates, yearOf } from './calendar-date';
import { countWorkDays } from './work-days';

/** Коды из каталога ошибок (architecture.md, раздел 8); тексты — в слое API. */
export type VacationFormErrorCode =
  | 'VACATION_DATES_ORDER'
  | 'VACATION_CROSSES_YEAR'
  | 'VACATION_NO_WORK_DAYS'
  | 'NO_ACCRUAL_YET'
  | 'VACATION_BEFORE_HIRE'
  | 'PAST_START_YEAR'
  | 'PAST_COMMENT_REQUIRED';

export interface VacationFormInput {
  startDate: CalendarDate;
  endDate: CalendarDate;
  comment?: string | null;
  /** «Сегодня» по Clock и COMPANY_TZ. */
  today: CalendarDate;
  hireDate: CalendarDate;
}

/** Ошибки самого периода: порядок дат и правила дробления (RULES §3-4 п.1–2). */
export type PeriodShapeErrorCode =
  'VACATION_DATES_ORDER' | 'VACATION_CROSSES_YEAR' | 'VACATION_NO_WORK_DAYS';

/**
 * Проверки периода, общие для подачи и переноса (architecture §8): начало не позже окончания,
 * один календарный год, хотя бы один рабочий день. Перенос других проверок формы не проходит
 * (DECISIONS 2026-10-24 16:45).
 */
export function checkPeriodShape(
  startDate: CalendarDate,
  endDate: CalendarDate,
): PeriodShapeErrorCode | null {
  if (compareDates(startDate, endDate) > 0) return 'VACATION_DATES_ORDER';
  if (yearOf(startDate) !== yearOf(endDate)) return 'VACATION_CROSSES_YEAR'; // RULES §3-4 п.1
  if (countWorkDays(startDate, endDate) === 0) return 'VACATION_NO_WORK_DAYS'; // RULES §3-4 п.2
  return null;
}

/**
 * Чистые проверки формы заявки без БД. Возвращает первую ошибку в порядке
 * architecture.md (раздел 8) или `null`. Пересечения и остаток проверяет S4.
 */
export function checkVacationForm(
  input: VacationFormInput,
): VacationFormErrorCode | null {
  const { startDate, endDate, comment, today, hireDate } = input;
  const shape = checkPeriodShape(startDate, endDate);
  if (shape) return shape;
  if (compareDates(today, firstAccrualDate(hireDate)) < 0)
    return 'NO_ACCRUAL_YET'; // RULES §3-6
  if (compareDates(startDate, hireDate) < 0) return 'VACATION_BEFORE_HIRE'; // RULES §3-12
  if (compareDates(startDate, today) < 0) {
    // «в прошлом» = начало раньше сегодня; начало сегодня не считается (RULES §3-7)
    if (yearOf(startDate) < yearOf(today)) return 'PAST_START_YEAR';
    if (!comment || comment.trim() === '') return 'PAST_COMMENT_REQUIRED';
  }
  return null;
}
