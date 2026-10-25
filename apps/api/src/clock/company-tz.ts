import { dayOf } from '../domain/calendar-date';

export const DEFAULT_COMPANY_TZ = 'Asia/Bishkek';

/** Часовой пояс компании из COMPANY_TZ (RULES §1). */
export function companyTz(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMPANY_TZ || DEFAULT_COMPANY_TZ;
}

/** «Сегодня» по поясу компании, календарная дата YYYY-MM-DD (RULES §1). Момент даёт Clock. */
export function companyToday(now: Date, tz: string = companyTz()): string {
  return dayOf(now, tz);
}
