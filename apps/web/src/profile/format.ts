const EMPTY = '—';

/** YYYY-MM-DD → DD.MM.YYYY строкой, без Date (календарная дата не момент времени). */
export function formatHireDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
}

export function orEmpty(value: string | null | undefined): string {
  return value ? value : EMPTY;
}
