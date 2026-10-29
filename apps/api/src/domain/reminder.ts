import { CalendarDate, compareDates } from './calendar-date';
import { reminderDate } from './work-days';

/**
 * Плановое напоминание пора поставить в очередь на проходе планировщика (architecture §10):
 * отпуск ещё не начался (RULES §8-4), дата напоминания прошла (просроченное, DECISIONS
 * 2026-10-22 15:35) или наступила и уже 09:00 по поясу компании (RULES §8-3).
 * `after9` — момент Clock не раньше 09:00 в день `today`.
 */
export function reminderDueOnPass(
  startDate: CalendarDate,
  n: number,
  today: CalendarDate,
  after9: boolean,
): boolean {
  if (compareDates(today, startDate) >= 0) return false;
  const c = compareDates(reminderDate(startDate, n), today);
  return c < 0 || (c === 0 && after9);
}

/**
 * Позднее одобрение (RULES §8-3): дата напоминания ≤ сегодня < даты начала — напоминание
 * уходит сразу после согласования, в любое время суток. Так же при утверждении переноса
 * по новым датам (RULES §8-3 «Перенос»).
 */
export function lateReminderDue(
  startDate: CalendarDate,
  n: number,
  today: CalendarDate,
): boolean {
  return (
    compareDates(today, startDate) < 0 &&
    compareDates(reminderDate(startDate, n), today) <= 0
  );
}
