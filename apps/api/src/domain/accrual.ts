import {
  CalendarDate,
  daysInMonth,
  firstOfNextMonth,
  formatDate,
  parseDate,
} from './calendar-date';

/** Начисление за месяц: 2,5 дня = 5 половинок (RULES §2-1, §2-2). */
export const MONTHLY_HALF_DAYS = 5;
/** Перенос остатка на следующий год: максимум 15 дней = 30 половинок (RULES §2-5). */
export const CARRYOVER_CAP_HALF_DAYS = 30;

/**
 * Первое начисление в половинках дня по числу отработанных календарных дней n
 * (включая день выхода): округление n/30 × 2,5 до 0,5, ничья вверх, не больше 2,5 (RULES §2-3).
 */
export function firstAccrualHalfDays(workedDays: number): number {
  if (!Number.isInteger(workedDays) || workedDays < 1 || workedDays > 31) {
    throw new RangeError(
      `Отработанные дни должны быть целым 1..31: ${workedDays}`,
    );
  }
  return Math.min(MONTHLY_HALF_DAYS, Math.floor((workedDays + 3) / 6));
}

/** Отработанные дни первого месяца: от даты выхода до конца месяца включительно. */
export function workedDaysInFirstMonth(hireDate: CalendarDate): number {
  const { year, month, day } = parseDate(hireDate);
  return daysInMonth(year, month) - day + 1;
}

/** Дата первого начисления: 1-е число месяца, следующего за месяцем выхода (RULES §2-3). */
export function firstAccrualDate(hireDate: CalendarDate): CalendarDate {
  return firstOfNextMonth(hireDate);
}

export type AccrualEvent =
  | { date: CalendarDate; kind: 'ACCRUAL'; halfDays: number }
  | { date: CalendarDate; kind: 'TRIM' };

/**
 * Начисления 1-го числа и обрезки на 1 января с первого начисления по `until` включительно.
 * Внутри одного дня начисление идёт раньше обрезки (RULES §2-5, §6-6).
 */
export function accrualEvents(
  hireDate: CalendarDate,
  until: CalendarDate,
): AccrualEvent[] {
  const events: AccrualEvent[] = [];
  let date = firstAccrualDate(hireDate);
  let halfDays = firstAccrualHalfDays(workedDaysInFirstMonth(hireDate));
  while (date <= until) {
    events.push({ date, kind: 'ACCRUAL', halfDays });
    if (date.endsWith('-01-01')) events.push({ date, kind: 'TRIM' });
    halfDays = MONTHLY_HALF_DAYS;
    const { year, month } = parseDate(date);
    date =
      month === 12
        ? formatDate(year + 1, 1, 1)
        : formatDate(year, month + 1, 1);
  }
  return events;
}
