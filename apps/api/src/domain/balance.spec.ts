import fc from 'fast-check';
import {
  availableOn,
  balanceToday,
  BalanceInput,
  LedgerAction,
} from './balance';
import { addDays } from './calendar-date';

const TZ = 'Asia/Bishkek';
const debit = (halfDays: number, at: string): LedgerAction => ({
  kind: 'DEBIT',
  halfDays,
  occurredAt: new Date(at),
});
const refund = (halfDays: number, at: string): LedgerAction => ({
  kind: 'REFUND',
  halfDays,
  occurredAt: new Date(at),
});
const input = (
  hireDate: string,
  today: string,
  ledger: LedgerAction[] = [],
): BalanceInput => ({
  hireDate,
  today,
  ledger,
  tz: TZ,
});

// Выход 2026-04-01: первое начисление 1 мая = 5 (n=30), затем по 5 каждое 1-е число.
// На 2026-12-01 накоплено 8 начислений = 40 половинок (20 дней).
const HIRE = '2026-04-01';

describe('balanceToday: начисление', () => {
  // RULES §2-4, §2-6
  it.each([
    ['2026-10-31', 0], // до первого начисления остатка нет
    ['2026-11-01', 3], // выход 12 октября: 1,5 дня
    ['2026-12-01', 8],
    ['2027-01-01', 13],
  ])('выход 2026-10-12, сегодня %s → %i половинок', (today, expected) => {
    expect(balanceToday(input('2026-10-12', today))).toBe(expected);
  });

  // RULES §2-3
  it('выход 31 декабря: на 1 января 0, на 1 февраля 5', () => {
    expect(balanceToday(input('2026-12-31', '2027-01-01'))).toBe(0);
    expect(balanceToday(input('2026-12-31', '2027-02-01'))).toBe(5);
  });

  // RULES §2-3
  it('выход 1 января: первое начисление 2,5 дня приходит 1 февраля', () => {
    expect(balanceToday(input('2027-01-01', '2027-01-31'))).toBe(0);
    expect(balanceToday(input('2027-01-01', '2027-02-01'))).toBe(5);
  });

  // RULES §2-6
  it('дата выхода в будущем: остатка нет', () => {
    expect(balanceToday(input('2027-03-01', '2026-12-15'))).toBe(0);
  });
});

describe('balanceToday: обрезка 15 дней на 1 января', () => {
  // RULES §2-5 (пример: 20 − 5 + 2,5 → 15)
  it('на начало декабря 20 дней, в декабре взято 5, 1 января +2,5 → 17,5 → остаётся 15', () => {
    const ledger = [debit(10, '2026-12-10T05:00:00Z')];
    expect(balanceToday(input(HIRE, '2026-12-01', []))).toBe(40);
    expect(balanceToday(input(HIRE, '2027-01-01', ledger))).toBe(30);
  });

  // RULES §2-5, §6-6 (списание 31 декабря против 1 января)
  it('списание 31 декабря (17:59Z) идёт до обрезки: 40 − 10 + 5 = 35 → 30', () => {
    expect(
      balanceToday(
        input(HIRE, '2027-01-01', [debit(10, '2026-12-31T17:59:00Z')]),
      ),
    ).toBe(30);
  });

  // RULES §2-5, §6-6
  it('списание 1 января (18:00Z) идёт после обрезки: 40 + 5 = 45 → 30, затем − 10 = 20', () => {
    expect(
      balanceToday(
        input(HIRE, '2027-01-01', [debit(10, '2026-12-31T18:00:00Z')]),
      ),
    ).toBe(20);
  });

  // RULES §6-6 (G-1: возврат 31 декабря против 1 января)
  it('возврат 31 декабря (17:59Z) идёт до обрезки: 30 + 10 + 5 = 45 → 30', () => {
    const ledger = [
      debit(10, '2026-12-02T05:00:00Z'),
      refund(10, '2026-12-31T17:59:00Z'),
    ];
    expect(balanceToday(input(HIRE, '2027-01-01', ledger))).toBe(30);
  });

  // RULES §6-6 (G-1)
  it('возврат 1 января (18:00Z) идёт после обрезки: 30 + 5 → 30, затем + 10 = 40', () => {
    const ledger = [
      debit(10, '2026-12-02T05:00:00Z'),
      refund(10, '2026-12-31T18:00:00Z'),
    ];
    expect(balanceToday(input(HIRE, '2027-01-01', ledger))).toBe(40);
  });

  // RULES §2-5 (G-2: обрезка — ограничение сверху, 29 и 30 не меняются)
  it.each([
    [16, 29], // 40 − 16 + 5 = 29
    [15, 30], // 40 − 15 + 5 = 30
    [14, 30], // 40 − 14 + 5 = 31 → 30 (контроль)
  ])('списание %i до 1 января → остаток %i', (debited, expected) => {
    const ledger = [debit(debited, '2026-12-02T05:00:00Z')];
    expect(balanceToday(input(HIRE, '2027-01-01', ledger))).toBe(expected);
  });

  // RULES §6-6 (возврат после обрезки)
  it('возврат после обрезки не обрезается: 10 → 15 дней, возврат 30 → 45 половинок', () => {
    const ledger = [
      debit(30, '2026-12-02T05:00:00Z'),
      refund(30, '2027-01-05T05:00:00Z'),
    ];
    expect(balanceToday(input(HIRE, '2027-01-05', ledger))).toBe(45); // 40 − 30 = 10; +5 = 15; +30 = 45
  });

  // RULES §2-5, §6-4
  it('отрицательный остаток не обрезается', () => {
    const ledger = [debit(100, '2026-06-15T05:00:00Z')];
    expect(balanceToday(input(HIRE, '2027-01-01', ledger))).toBe(-55); // 40 + 5 − 100
  });

  // RULES §2-5
  it('обрезка срабатывает каждый год, перенос не накапливается', () => {
    // 2026-04-01: 40 на 1 декабря; 1 января 2027 → 30; к 1 января 2028: 30 + 11×5 = 85 → 30
    expect(balanceToday(input(HIRE, '2028-01-01'))).toBe(30);
  });
});

describe('balanceToday: журнал', () => {
  // RULES §6-6
  it('учитывает все списания и возвраты независимо от даты, в том числе после сегодня', () => {
    const ledger = [debit(10, '2027-03-15T05:00:00Z')];
    expect(balanceToday(input(HIRE, '2026-12-01', ledger))).toBe(30);
  });

  // RULES §6-6
  it('день события журнала определяется по поясу компании', () => {
    // 2026-12-31T18:30Z — это 1 января в Бишкеке, но 31 декабря в UTC
    const ledger = [debit(10, '2026-12-31T18:30:00Z')];
    expect(balanceToday(input(HIRE, '2027-01-01', ledger))).toBe(20);
    expect(
      balanceToday({ ...input(HIRE, '2027-01-01', ledger), tz: 'UTC' }),
    ).toBe(30);
  });

  // RULES §6-6 (G-7: обычное 1-е число, начисление и действие одного дня)
  it('списание в день начисления (1 декабря): 35 + 5 − 10 = 30', () => {
    const ledger = [debit(10, '2026-12-01T05:00:00Z')];
    expect(balanceToday(input(HIRE, '2026-11-30', []))).toBe(35);
    expect(balanceToday(input(HIRE, '2026-12-01', ledger))).toBe(30);
  });

  // RULES §6-6 (сдвиг даты выхода пересчитывает начисления, но не списания)
  it('сдвиг даты выхода меняет только начисления; списания остаются', () => {
    const ledger = [debit(10, '2026-12-01T05:00:00Z')];
    expect(balanceToday(input('2026-04-01', '2026-12-15', ledger))).toBe(30); // 40 − 10
    expect(balanceToday(input('2026-06-01', '2026-12-15', ledger))).toBe(20); // 30 − 10
  });

  // RULES §6-4, §6-5
  it('дата выхода сдвинута в будущее: остаток отрицательный, списание не потеряно', () => {
    const ledger = [debit(10, '2026-12-01T05:00:00Z')];
    expect(balanceToday(input('2027-03-01', '2026-12-15', ledger))).toBe(-10);
  });

  // RULES §6-6
  it('возврат закрывает списание', () => {
    const ledger = [
      debit(10, '2026-06-01T05:00:00Z'),
      refund(10, '2026-06-02T05:00:00Z'),
    ];
    expect(balanceToday(input(HIRE, '2026-12-01', ledger))).toBe(40);
  });
});

describe('availableOn («доступно на D»)', () => {
  // RULES §3-10
  it('D в прошлом или сегодня — баланс сегодня', () => {
    const i = input(HIRE, '2026-11-15');
    expect(availableOn(i, '2026-11-15')).toBe(35);
    expect(availableOn(i, '2026-01-01')).toBe(35);
  });

  // RULES §3-10 (D = 1 число: событие D входит)
  it('D = 1 число: начисление этого дня входит, накануне — нет', () => {
    const i = input(HIRE, '2026-11-15');
    expect(availableOn(i, '2026-11-30')).toBe(35);
    expect(availableOn(i, '2026-12-01')).toBe(40);
  });

  // RULES §3-10 (сегодня = 1 число: нет двойного счёта)
  it('сегодня = 1 число: начисление уже в балансе и повторно не считается', () => {
    const i = input(HIRE, '2026-12-01');
    expect(balanceToday(i)).toBe(40);
    expect(availableOn(i, '2026-12-01')).toBe(40);
    expect(availableOn(i, '2026-12-31')).toBe(40);
    expect(availableOn(i, '2027-01-01')).toBe(30); // 40 + 5 → обрезка 30, начисление ровно одно
    expect(availableOn(i, '2027-02-01')).toBe(35);
  });

  // RULES §3-10 (G-3: сегодня = 1 января, начисление и обрезка уже в балансе)
  it('сегодня = 1 января: начисление и обрезка повторно не считаются', () => {
    const i = input(HIRE, '2027-01-01');
    expect(balanceToday(i)).toBe(30);
    expect(availableOn(i, '2027-01-01')).toBe(30);
    expect(availableOn(i, '2027-01-02')).toBe(30);
    expect(availableOn(i, '2027-02-01')).toBe(35);
  });

  // RULES §3-10 (D = 1 января: начисление, затем обрезка)
  it('D = 1 января: начисление, затем обрезка; накануне обрезки нет', () => {
    const i = input(HIRE, '2026-11-15');
    expect(availableOn(i, '2026-12-31')).toBe(40);
    expect(availableOn(i, '2027-01-01')).toBe(30);
  });

  // RULES §3-10, §6-6 (учитывает все списания журнала)
  it('списания журнала вычтены, в том числе дальнего отпуска', () => {
    const i = input(HIRE, '2026-11-15', [debit(20, '2026-11-10T05:00:00Z')]);
    expect(availableOn(i, '2026-11-15')).toBe(15);
    expect(availableOn(i, '2027-02-01')).toBe(30); // 15 + 5 (дек) + 5 (янв, обрезки нет) + 5 (фев)
  });

  // RULES §3-10, §6-4 (отрицательный остаток не обрезается и в прогнозе)
  it('отрицательный остаток в прогнозе не обрезается', () => {
    const i = input(HIRE, '2026-12-15', [debit(100, '2026-06-15T05:00:00Z')]);
    expect(availableOn(i, '2027-01-01')).toBe(-55);
  });

  // RULES §3-10, §2-3
  it('первое начисление входит в прогноз до выхода на первое начисление', () => {
    const i = input('2026-10-12', '2026-10-21');
    expect(availableOn(i, '2026-10-31')).toBe(0);
    expect(availableOn(i, '2026-11-01')).toBe(3);
  });
});

describe('свойства баланса', () => {
  const ledgerArb = fc.array(
    fc.record({
      kind: fc.constantFrom<'DEBIT' | 'REFUND'>('DEBIT', 'REFUND'),
      halfDays: fc.integer({ min: 0, max: 60 }),
      occurredAt: fc
        .integer({ min: Date.UTC(2015, 0, 1), max: Date.UTC(2035, 0, 1) })
        .map((ms) => new Date(ms)),
    }),
    { maxLength: 12 },
  );
  const caseArb = fc.record({
    hire: fc
      .integer({ min: 0, max: 7000 })
      .map((n) => addDays('2015-01-01', n)),
    todayOffset: fc.integer({ min: 0, max: 4000 }),
    onOffset: fc.integer({ min: -400, max: 1500 }),
    ledger: ledgerArb,
  });

  // RULES §2-7 (остаток кратен 0,5 дня)
  it('остаток и «доступно на D» — целое число половинок, то есть кратны 0,5 дня', () => {
    fc.assert(
      fc.property(caseArb, ({ hire, todayOffset, onOffset, ledger }) => {
        const today = addDays('2020-01-01', todayOffset);
        const i = input(hire, today, ledger);
        const b = balanceToday(i);
        const a = availableOn(i, addDays(today, onOffset));
        expect(Number.isInteger(b)).toBe(true);
        expect(Number.isInteger(a)).toBe(true);
        expect(Math.abs((b / 2) % 0.5)).toBe(0);
        expect(Math.abs((a / 2) % 0.5)).toBe(0);
      }),
    );
  });

  // RULES §3-10
  it('для D ≤ сегодня «доступно» равно балансу сегодня', () => {
    fc.assert(
      fc.property(caseArb, ({ hire, todayOffset, onOffset, ledger }) => {
        const today = addDays('2020-01-01', todayOffset);
        const i = input(hire, today, ledger);
        expect(availableOn(i, addDays(today, -Math.abs(onOffset)))).toBe(
          balanceToday(i),
        );
      }),
    );
  });

  // RULES §2-5
  it('без журнала остаток после 1 января не больше 15 дней', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 7000 }),
        fc.integer({ min: 0, max: 20 }),
        (hireOffset, years) => {
          const hire = addDays('2015-01-01', hireOffset);
          const jan1 = `${2016 + years}-01-01`;
          expect(balanceToday(input(hire, jan1))).toBeLessThanOrEqual(30);
        },
      ),
    );
  });
});

describe('проверка дат-входов today и on', () => {
  const bad = ['2026-5-1', '2026-02-30', 'abc', ''];
  const message = (value: string) =>
    new RangeError(`Некорректная дата: ${value}`);

  // RULES §1-4
  it.each(bad)('balanceToday: today=%j даёт RangeError', (today) => {
    const call = () => balanceToday(input('2026-04-01', today));
    expect(call).toThrow(RangeError);
    expect(call).toThrow(message(today));
  });

  // RULES §1-4
  it.each(bad)('availableOn: today=%j даёт RangeError', (today) => {
    const call = () => availableOn(input('2026-04-01', today), '2026-12-01');
    expect(call).toThrow(RangeError);
    expect(call).toThrow(message(today));
  });

  // RULES §1-4
  it.each(bad)('availableOn: on=%j даёт RangeError', (on) => {
    const call = () => availableOn(input('2026-04-01', '2026-10-24'), on);
    expect(call).toThrow(RangeError);
    expect(call).toThrow(message(on));
  });
});
