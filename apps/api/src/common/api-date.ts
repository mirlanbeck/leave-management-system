import { CalendarDate, parseDate } from '../domain/calendar-date';
import { ApiError, MESSAGES } from './problem';

/** Границы годов для дат во входе API (DECISIONS [S4], остаток F-4 аудита S2). */
export const API_DATE_MIN_YEAR = 2000;
export const API_DATE_MAX_YEAR = 2100;

/**
 * Календарная дата из тела или query: формат YYYY-MM-DD, существующая дата, год 2000–2100.
 * Иначе 400 VALIDATION_FAILED с полем `field`; домен получает только проверенные даты (RULES §1-4).
 */
export function parseApiDate(value: string, field: string): CalendarDate {
  const invalid = (message: string): ApiError =>
    new ApiError(400, 'VALIDATION_FAILED', MESSAGES.VALIDATION_FAILED, {
      fields: { [field]: [message] },
    });
  let year: number;
  try {
    ({ year } = parseDate(value));
  } catch {
    throw invalid(`${field}: формат YYYY-MM-DD, существующая дата`);
  }
  if (year < API_DATE_MIN_YEAR || year > API_DATE_MAX_YEAR) {
    throw invalid(
      `${field}: год от ${API_DATE_MIN_YEAR} до ${API_DATE_MAX_YEAR}`,
    );
  }
  return value;
}

/** Несколько дат тела сразу: при ошибках все неверные поля попадают в один `details.fields`. */
export function parseApiDates<K extends string>(
  values: Record<K, string>,
): Record<K, CalendarDate> {
  const fields: Record<string, unknown> = {};
  const parsed = {} as Record<K, CalendarDate>;
  for (const key of Object.keys(values) as K[]) {
    try {
      parsed[key] = parseApiDate(values[key], key);
    } catch (e) {
      Object.assign(fields, (e as ApiError).details?.fields);
    }
  }
  if (Object.keys(fields).length > 0) {
    throw new ApiError(400, 'VALIDATION_FAILED', MESSAGES.VALIDATION_FAILED, {
      fields,
    });
  }
  return parsed;
}
