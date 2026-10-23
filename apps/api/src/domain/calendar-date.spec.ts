import fc from 'fast-check';
import {
  addDays,
  dayOf,
  daysInMonth,
  diffDays,
  firstOfNextMonth,
  isoWeekday,
  parseDate,
} from './calendar-date';

describe('calendar-date', () => {
  // RULES §1-4
  it.each([
    ['2026-02-28', 1, '2026-03-01'],
    ['2028-02-28', 1, '2028-02-29'],
    ['2028-02-29', 1, '2028-03-01'],
    ['2026-12-31', 1, '2027-01-01'],
    ['2027-01-01', -1, '2026-12-31'],
    ['2026-10-19', 11, '2026-10-30'],
  ])('addDays(%s, %i) = %s', (date, n, expected) => {
    expect(addDays(date, n)).toBe(expected);
  });

  // RULES §1-1
  it.each([
    ['2026-11-10', 2], // вторник (пример §8-3)
    ['2026-11-14', 6], // суббота
    ['2026-11-15', 7],
    ['2026-11-16', 1],
    ['1970-01-01', 4],
  ])('isoWeekday(%s) = %i', (date, expected) => {
    expect(isoWeekday(date)).toBe(expected);
  });

  // RULES §1-4
  it.each([
    [2026, 2, 28],
    [2028, 2, 29],
    [1900, 2, 28],
    [2000, 2, 29],
    [2026, 4, 30],
    [2026, 12, 31],
  ])('daysInMonth(%i, %i) = %i', (y, m, expected) => {
    expect(daysInMonth(y, m)).toBe(expected);
  });

  // RULES §1-4
  it.each([
    '2026-02-30',
    '2026-13-01',
    '2026-1-01',
    '2026-02-29',
    'abc',
    '2026-00-10',
  ])('отвергает некорректную дату %s', (date) => {
    expect(() => parseDate(date)).toThrow(RangeError);
  });

  // RULES §2-3
  it('firstOfNextMonth переходит через конец года', () => {
    expect(firstOfNextMonth('2026-12-31')).toBe('2027-01-01');
    expect(firstOfNextMonth('2026-10-12')).toBe('2026-11-01');
  });

  describe('dayOf', () => {
    // RULES §1-3
    it('граница 1 января в Бишкеке: 17:59Z — 31 декабря, 18:00Z — 1 января', () => {
      expect(dayOf(new Date('2026-12-31T17:59:00Z'), 'Asia/Bishkek')).toBe(
        '2026-12-31',
      );
      expect(dayOf(new Date('2026-12-31T18:00:00Z'), 'Asia/Bishkek')).toBe(
        '2027-01-01',
      );
    });

    // RULES §1-3
    it('не зависит от TZ процесса, только от переданного пояса', () => {
      const instant = new Date('2026-12-31T18:00:00Z');
      expect(dayOf(instant, 'America/New_York')).toBe('2026-12-31');
      expect(dayOf(instant, 'UTC')).toBe('2026-12-31');
    });
  });

  // RULES §1-4
  it('свойство: addDays и diffDays согласованы, неделя циклична', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -40000, max: 40000 }),
        fc.integer({ min: -4000, max: 4000 }),
        (base, n) => {
          const start = addDays('2000-01-01', base);
          const end = addDays(start, n);
          expect(diffDays(start, end)).toBe(n);
          expect(isoWeekday(addDays(start, 7))).toBe(isoWeekday(start));
          expect(isoWeekday(addDays(start, 1))).toBe(
            (isoWeekday(start) % 7) + 1,
          );
        },
      ),
    );
  });
});
