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
