import { ApiError } from './problem';
import { parseApiDate } from './api-date';

function failure(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('ожидалась ошибка');
}

describe('parseApiDate (граница дат API)', () => {
  // RULES §1-4: календарная дата YYYY-MM-DD
  it('принимает корректную дату', () => {
    expect(parseApiDate('2026-10-21', 'on')).toBe('2026-10-21');
  });

  // RULES §1-4: диапазон годов 2000–2100 включительно (DECISIONS [S4], остаток F-4)
  it.each(['2000-01-01', '2100-12-31'])('границы диапазона: %s', (date) => {
    expect(parseApiDate(date, 'on')).toBe(date);
  });

  // RULES §1-4
  it.each(['1999-12-31', '2101-01-01', '9999-12-01', '0001-01-01'])(
    'год вне диапазона: %s -> 400 VALIDATION_FAILED',
    (date) => {
      const e = failure(() => parseApiDate(date, 'on'));
      expect(e.getStatus()).toBe(400);
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(e.details?.fields as object)).toEqual(['on']);
    },
  );

  // RULES §1-4: неканонический формат и несуществующие даты — тоже 400, а не RangeError (500)
  it.each(['2026-5-1', '2026-02-30', 'вчера', '', '2026-10-21T00:00:00Z'])(
    'неверный формат или несуществующая дата: "%s" -> 400',
    (date) => {
      const e = failure(() => parseApiDate(date, 'startDate'));
      expect(e.getStatus()).toBe(400);
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(Object.keys(e.details?.fields as object)).toEqual(['startDate']);
    },
  );
});
