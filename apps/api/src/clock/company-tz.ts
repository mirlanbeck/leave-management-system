import { Clock } from './clock';

export const DEFAULT_COMPANY_TZ = 'Asia/Bishkek';

/** Часовой пояс компании из COMPANY_TZ (RULES §1). */
export function companyTz(env: NodeJS.ProcessEnv = process.env): string {
  return env.COMPANY_TZ || DEFAULT_COMPANY_TZ;
}

/** «Сегодня» по поясу компании, календарная дата YYYY-MM-DD (RULES §1). */
export function companyToday(clock: Clock, tz: string = companyTz()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(clock.now());
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
