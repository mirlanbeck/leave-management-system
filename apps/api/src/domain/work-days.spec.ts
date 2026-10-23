import fc from 'fast-check';
import { addDays } from './calendar-date';
import {
  countWorkDays,
  isWorkDay,
  refundHalfDays,
  reminderDate,
} from './work-days';

describe('countWorkDays', () => {
  // RULES §1-1
  it.each([
    ['2026-10-19', '2026-10-30', 10], // две полные недели
    ['2026-10-24', '2026-10-25', 0], // суббота и воскресенье
    ['2026-10-23', '2026-10-26', 2], // пт и пн
    ['2026-10-21', '2026-10-21', 1],
    ['2026-10-24', '2026-10-24', 0],
    ['2026-02-23', '2026-03-02', 6], // через конец февраля 2026
    ['2028-02-25', '2028-03-01', 4], // високосный: пт 25, пн 28, вт 29, ср 1 марта
    ['2026-12-28', '2027-01-04', 6], // через Новый год
  ])('%s..%s = %i рабочих дней', (from, to, expected) => {
    expect(countWorkDays(from, to)).toBe(expected);
  });

  // RULES §1-1
  it('отвергает начало позже конца', () => {
    expect(() => countWorkDays('2026-10-02', '2026-10-01')).toThrow(RangeError);
  });

  // RULES §1-1
  it('свойство: подсчёт аддитивен при разбиении периода', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20000 }),
        fc.integer({ min: 0, max: 400 }),
        fc.integer({ min: 0, max: 400 }),
        (base, a, b) => {
          const from = addDays('2000-01-01', base);
          const mid = addDays(from, a);
          const to = addDays(mid, b + 1);
          expect(
            countWorkDays(from, mid) + countWorkDays(addDays(mid, 1), to),
          ).toBe(countWorkDays(from, to));
        },
      ),
    );
  });
});

describe('reminderDate', () => {
  // RULES §8-3
  it.each([
    ['2026-11-10', 3, '2026-11-05'], // вторник → четверг (пример RULES)
    ['2026-11-14', 3, '2026-11-11'], // суббота → среда (пример RULES)
    ['2026-11-15', 3, '2026-11-11'], // воскресенье → среда
    ['2026-11-16', 3, '2026-11-11'], // понедельник → среда
    ['2026-11-02', 1, '2026-10-30'], // N = 1, через выходные
    ['2026-11-03', 3, '2026-10-29'], // через границу месяца
    ['2027-01-04', 3, '2026-12-30'], // через границу года
    ['2028-03-01', 3, '2028-02-25'], // через 29 февраля
  ])('начало %s, N=%i → %s', (start, n, expected) => {
    expect(reminderDate(start, n)).toBe(expected);
  });

  // RULES §8-3
  it.each([0, -1, 2.5, Number.NaN])('N=%s недопустимо', (n) => {
    expect(() => reminderDate('2026-11-10', n)).toThrow(RangeError);
  });

  // RULES §8-3
  it('свойство: рабочий день до начала, ровно N рабочих дней до начала', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20000 }),
        fc.integer({ min: 1, max: 30 }),
        (base, n) => {
          const start = addDays('2000-01-01', base);
          const rem = reminderDate(start, n);
          expect(isWorkDay(rem)).toBe(true);
          expect(rem < start).toBe(true);
          expect(countWorkDays(rem, addDays(start, -1))).toBe(n);
        },
      ),
    );
  });
});

describe('refundHalfDays', () => {
  // RULES §5-6
  it('пример: отпуск 19–30 октября 2026, выход 27 октября → 4 дня (27, 28, 29, 30)', () => {
    expect(refundHalfDays('2026-10-19', '2026-10-30', '2026-10-27')).toBe(8);
  });

  // RULES §5-11
  it.each([
    ['2026-10-19', 20], // выход на дату начала — все рабочие дни
    ['2026-10-30', 2], // выход на дату окончания — один день
    ['2026-10-24', 10], // выход в субботу: считаются последующие рабочие дни (пн–пт)
  ])('выход %s → %i половинок', (returnDate, expected) => {
    expect(refundHalfDays('2026-10-19', '2026-10-30', returnDate)).toBe(
      expected,
    );
  });

  // RULES §5-11
  it('выход в выходной в конце отпуска даёт 0 (допустимо по схеме)', () => {
    expect(refundHalfDays('2026-10-19', '2026-10-25', '2026-10-24')).toBe(0);
  });

  // RULES §5-11
  it.each(['2026-10-18', '2026-10-31'])(
    'дата выхода %s вне отпуска отвергается',
    (returnDate) => {
      expect(() =>
        refundHalfDays('2026-10-19', '2026-10-30', returnDate),
      ).toThrow(RangeError);
    },
  );

  // RULES §5-6
  it('свойство: возврат не больше списанного и чётный (целые дни)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20000 }),
        fc.integer({ min: 0, max: 60 }),
        fc.nat(60),
        (base, len, off) => {
          const start = addDays('2000-01-01', base);
          const end = addDays(start, len);
          const ret = addDays(start, Math.min(off, len));
          const refund = refundHalfDays(start, end, ret);
          expect(refund).toBeLessThanOrEqual(countWorkDays(start, end) * 2);
          expect(refund % 2).toBe(0);
        },
      ),
    );
  });
});
