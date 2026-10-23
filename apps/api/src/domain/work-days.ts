import {
  addDays,
  CalendarDate,
  compareDates,
  diffDays,
  isoWeekday,
} from './calendar-date';

/** Рабочие дни — пн–пт, праздники не учитываются (RULES §1-1). */
export function isWorkDay(date: CalendarDate): boolean {
  return isoWeekday(date) <= 5;
}

/** Число рабочих дней в периоде `[from, to]` включительно. */
export function countWorkDays(from: CalendarDate, to: CalendarDate): number {
  if (compareDates(from, to) > 0)
    throw new RangeError(`Начало ${from} позже конца ${to}`);
  const total = diffDays(from, to) + 1;
  let count = 0;
  for (let i = 0; i < total; i++) if (isWorkDay(addDays(from, i))) count++;
  return count;
}

/**
 * Дата напоминания: N-й рабочий день, предшествующий дате начала;
 * сама дата начала не считается (RULES §8-3).
 */
export function reminderDate(startDate: CalendarDate, n: number): CalendarDate {
  if (!Number.isInteger(n) || n < 1)
    throw new RangeError(`N должно быть целым не меньше 1: ${n}`);
  let date = startDate;
  let left = n;
  while (left > 0) {
    date = addDays(date, -1);
    if (isWorkDay(date)) left--;
  }
  return date;
}

/**
 * Возврат при отзыве в половинках дня: рабочие дни от даты выхода до конца отпуска
 * включительно (RULES §5-6, §5-11). Выход в выходной даёт только последующие рабочие дни.
 */
export function refundHalfDays(
  startDate: CalendarDate,
  endDate: CalendarDate,
  returnDate: CalendarDate,
): number {
  if (
    compareDates(returnDate, startDate) < 0 ||
    compareDates(returnDate, endDate) > 0
  ) {
    throw new RangeError(
      `Дата выхода ${returnDate} вне отпуска ${startDate}..${endDate}`,
    );
  }
  return countWorkDays(returnDate, endDate) * 2;
}
