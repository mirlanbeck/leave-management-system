import fc from 'fast-check';
import {
  accrualEvents,
  firstAccrualDate,
  firstAccrualHalfDays,
  workedDaysInFirstMonth,
} from './accrual';

/** Первое начисление в половинках дня по дате выхода. */
const firstFor = (hire: string) =>
  firstAccrualHalfDays(workedDaysInFirstMonth(hire));

describe('первое начисление', () => {
  // RULES §2-4 (таблица примеров, выход в октябре 2026)
  it.each([
    ['2026-10-01', 31, 5], // 31/30 × 2,5 → максимум 2,5
    ['2026-10-05', 27, 5], // 2,25 (ничья) → 2,5
    ['2026-10-12', 20, 3], // 1,667 → 1,5
    ['2026-10-15', 17, 3], // 1,417 → 1,5
    ['2026-10-31', 1, 0], // 0,083 → 0
  ])(
    'выход %s: отработано %i дней → %i половинок',
    (hire, worked, expected) => {
      expect(workedDaysInFirstMonth(hire)).toBe(worked);
      expect(firstFor(hire)).toBe(expected);
    },
  );

  // RULES §2-3 (ничья округляется вверх)
  it.each([
    [3, 1], // 0,25 → 0,5
    [9, 2], // 0,75 → 1,0
    [15, 3], // 1,25 → 1,5
    [21, 4], // 1,75 → 2,0
    [27, 5], // 2,25 → 2,5
  ])('тайбрейк n=%i → %i половинок', (n, expected) => {
    expect(firstAccrualHalfDays(n)).toBe(expected);
  });

  // RULES §2-3
  it.each([
    [1, 0],
    [2, 0],
    [4, 1],
    [8, 1],
    [10, 2],
    [14, 2],
    [16, 3],
    [26, 4],
    [29, 5],
    [30, 5],
    [31, 5],
  ])('вокруг границ: n=%i → %i половинок', (n, expected) => {
    expect(firstAccrualHalfDays(n)).toBe(expected);
  });

  // RULES §2-3 (делитель всегда 30, февраль и високосный год)
  it.each([
    ['2026-02-01', 28, 5], // 28/30 × 2,5 = 2,33 → 2,5
    ['2028-02-01', 29, 5],
    ['2026-02-15', 14, 2], // 14/30 × 2,5 = 1,17 → 1,0
    ['2028-02-15', 15, 3], // високосный: 15 дней — ничья → 1,5
    ['2026-12-31', 1, 0],
    ['2027-01-01', 31, 5],
  ])('выход %s: n=%i → %i половинок', (hire, worked, expected) => {
    expect(workedDaysInFirstMonth(hire)).toBe(worked);
    expect(firstFor(hire)).toBe(expected);
  });

  // RULES §2-3 (выход 29 февраля и 1-е число 30-дневного месяца)
  it('выход 2028-02-29: n=1 → 0, начисление 1 марта', () => {
    expect(workedDaysInFirstMonth('2028-02-29')).toBe(1);
    expect(firstFor('2028-02-29')).toBe(0);
    expect(firstAccrualDate('2028-02-29')).toBe('2028-03-01');
    expect(accrualEvents('2028-02-29', '2028-03-01')).toEqual([
      { date: '2028-03-01', kind: 'ACCRUAL', halfDays: 0 },
    ]);
  });

  // RULES §2-3
  it('выход 1-го числа 30-дневного месяца (2026-04-01): n=30 → 5, начисление 1 мая', () => {
    expect(workedDaysInFirstMonth('2026-04-01')).toBe(30);
    expect(firstFor('2026-04-01')).toBe(5);
    expect(firstAccrualDate('2026-04-01')).toBe('2026-05-01');
  });

  // RULES §2-3 (полный перебор n = 1…31 против независимого целочисленного эталона)
  // Эталон: k половинок, ближайшее к n/6 по |n − 6k|; ничья — большее k; не больше 5.
  const reference = (n: number): number => {
    let best = 0;
    for (let k = 1; k <= 5; k++) {
      if (Math.abs(n - 6 * k) <= Math.abs(n - 6 * best)) best = k;
    }
    return best;
  };
  it.each(Array.from({ length: 31 }, (_, i) => i + 1))('эталон: n=%i', (n) => {
    expect(firstAccrualHalfDays(n)).toBe(reference(n));
  });

  // RULES §2-3
  it.each([0, 32, 1.5, Number.NaN])('n=%s недопустимо', (n) => {
    expect(() => firstAccrualHalfDays(n)).toThrow(RangeError);
  });

  // RULES §2-3
  it('первое начисление приходит 1-го числа следующего месяца', () => {
    expect(firstAccrualDate('2026-10-12')).toBe('2026-11-01');
    expect(firstAccrualDate('2026-10-01')).toBe('2026-11-01');
    expect(firstAccrualDate('2026-12-31')).toBe('2027-01-01');
  });

  // RULES §2-3
  it('свойство: от 0 до 2,5 дней и не убывает с ростом n', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 30 }), (n) => {
        const v = firstAccrualHalfDays(n);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(5);
        expect(firstAccrualHalfDays(n + 1)).toBeGreaterThanOrEqual(v);
      }),
    );
  });
});

describe('accrualEvents', () => {
  // RULES §2-2
  it('первое начисление — по формуле, далее по 2,5 дня каждое 1-е число', () => {
    expect(accrualEvents('2026-10-12', '2026-12-31')).toEqual([
      { date: '2026-11-01', kind: 'ACCRUAL', halfDays: 3 },
      { date: '2026-12-01', kind: 'ACCRUAL', halfDays: 5 },
    ]);
  });

  // RULES §2-5
  it('1 января: начисление, затем обрезка', () => {
    expect(accrualEvents('2026-11-20', '2027-01-01')).toEqual([
      { date: '2026-12-01', kind: 'ACCRUAL', halfDays: 2 }, // n=11 → 1,0
      { date: '2027-01-01', kind: 'ACCRUAL', halfDays: 5 },
      { date: '2027-01-01', kind: 'TRIM' },
    ]);
  });

  // RULES §2-6
  it('до первого начисления событий нет', () => {
    expect(accrualEvents('2026-10-12', '2026-10-31')).toEqual([]);
    expect(accrualEvents('2027-03-01', '2026-12-31')).toEqual([]);
  });

  // RULES §2-3
  it('выход 31 декабря: 1 января начисление 0 и обрезка', () => {
    expect(accrualEvents('2026-12-31', '2027-01-01')).toEqual([
      { date: '2027-01-01', kind: 'ACCRUAL', halfDays: 0 },
      { date: '2027-01-01', kind: 'TRIM' },
    ]);
  });
});

describe('accrualEvents: проверка until', () => {
  // RULES §1-4
  it.each(['2026-5-1', '2026-02-30', 'abc', ''])(
    'until=%j даёт RangeError с переданным значением',
    (until) => {
      const call = () => accrualEvents('2026-04-01', until);
      expect(call).toThrow(RangeError);
      expect(call).toThrow(new RangeError(`Некорректная дата: ${until}`));
    },
  );
});
