/** Календарная дата без времени: строка `YYYY-MM-DD` (RULES §1-4). */
export type CalendarDate = string;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseDate(date: CalendarDate): {
  year: number;
  month: number;
  day: number;
} {
  const m = DATE_RE.exec(date);
  if (!m) throw new RangeError(`Некорректная дата: ${date}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError(`Некорректная дата: ${date}`);
  }
  return { year, month, day };
}

export function formatDate(
  year: number,
  month: number,
  day: number,
): CalendarDate {
  const p = (n: number, w: number) => String(n).padStart(w, '0');
  return `${p(year, 4)}-${p(month, 2)}-${p(day, 2)}`;
}

/** Номер дня от 1970-01-01 (григорианский календарь, без Date и часовых поясов). */
function toEpochDay(date: CalendarDate): number {
  const { year, month, day } = parseDate(date);
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromEpochDay(epochDay: number): CalendarDate {
  const z = epochDay + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe -
      Math.floor(doe / 1460) +
      Math.floor(doe / 36524) -
      Math.floor(doe / 146096)) /
      365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return formatDate(year, month, day);
}

export function addDays(date: CalendarDate, days: number): CalendarDate {
  return fromEpochDay(toEpochDay(date) + days);
}

/** Разница `b - a` в календарных днях. */
export function diffDays(a: CalendarDate, b: CalendarDate): number {
  return toEpochDay(b) - toEpochDay(a);
}

/** День недели: 1 = понедельник … 7 = воскресенье. */
export function isoWeekday(date: CalendarDate): number {
  // 1970-01-01 — четверг (4)
  return ((((toEpochDay(date) + 3) % 7) + 7) % 7) + 1;
}

/** Сравнение корректных дат `YYYY-MM-DD`: <0, 0, >0. */
export function compareDates(a: CalendarDate, b: CalendarDate): number {
  return toEpochDay(a) - toEpochDay(b);
}

export function yearOf(date: CalendarDate): number {
  return parseDate(date).year;
}

/** 1-е число месяца, следующего за месяцем даты. */
export function firstOfNextMonth(date: CalendarDate): CalendarDate {
  const { year, month } = parseDate(date);
  return month === 12
    ? formatDate(year + 1, 1, 1)
    : formatDate(year, month + 1, 1);
}

/** Календарный день момента по часовому поясу `tz` (RULES §1-3). */
export function dayOf(instant: Date, tz: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Календарная дата из колонки DATE (Prisma отдаёт полночь UTC): без пояса компании и пояса процесса. */
export function fromDbDate(d: Date): CalendarDate {
  return formatDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** Значение для колонки DATE: полночь UTC (пара к `fromDbDate`), без пояса процесса. */
export function toDbDate(date: CalendarDate): Date {
  const { year, month, day } = parseDate(date);
  return new Date(Date.UTC(year, month - 1, day));
}
