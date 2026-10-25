const HOUR_MS = 3_600_000;

/** Смещение пояса от UTC в мс в данный момент (локальное «как UTC» минус момент). */
function offsetMs(instant: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * Дата и время в часовом поясе компании -> момент UTC (RULES §9-3).
 * null: нет такой даты или такого времени в поясе (пропуск при переходе на летнее время).
 * Неоднозначное время (обратный переход) даёт более раннее из двух.
 */
export function companyLocalToInstant(
  date: string,
  time: string,
  tz: string,
): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const [y, mo, day, h, mi] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
  const wanted = Date.UTC(y, mo - 1, day, h, mi);
  const check = new Date(wanted);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== day ||
    h > 23 ||
    mi > 59
  ) {
    return null;
  }
  const candidates = new Set<number>();
  for (const probe of [wanted - 24 * HOUR_MS, wanted + 24 * HOUR_MS]) {
    const instant = wanted - offsetMs(probe, tz);
    if (instant + offsetMs(instant, tz) === wanted) candidates.add(instant);
  }
  if (candidates.size === 0) return null;
  return new Date(Math.min(...candidates));
}
