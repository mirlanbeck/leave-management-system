import fc from 'fast-check';
import { addDays, compareDates } from './calendar-date';
import { lateReminderDue, reminderDueOnPass } from './reminder';
import { reminderDate } from './work-days';

// Отпуск со вторника 10 ноября 2026, N = 3: дата напоминания — четверг 5 ноября (RULES §8-3)
const START = '2026-11-10';
const N = 3;

describe('reminderDueOnPass', () => {
  // RULES §8-3, §8-4; DECISIONS 2026-10-22 15:35
  it.each([
    ['дата напоминания завтра', '2026-11-04', true, false],
    ['дата напоминания сегодня, до 09:00', '2026-11-05', false, false],
    ['дата напоминания сегодня, 09:00 и позже', '2026-11-05', true, true],
    ['дата напоминания вчера, до 09:00', '2026-11-06', false, true],
    ['дата напоминания вчера, после 09:00', '2026-11-06', true, true],
    ['накануне начала (выходной)', '2026-11-09', false, true],
    ['день начала', '2026-11-10', true, false],
    ['отпуск уже идёт', '2026-11-11', true, false],
  ])('%s (%s, after9=%s) → %s', (_name, today, after9, expected) => {
    expect(reminderDueOnPass(START, N, today, after9)).toBe(expected);
  });

  // RULES §8-3: начало в субботу 14 ноября, N = 3 → среда 11 ноября
  it('начало в субботу: пора со среды 09:00', () => {
    expect(reminderDueOnPass('2026-11-14', N, '2026-11-11', false)).toBe(false);
    expect(reminderDueOnPass('2026-11-14', N, '2026-11-11', true)).toBe(true);
    expect(reminderDueOnPass('2026-11-14', N, '2026-11-10', true)).toBe(false);
  });

  // RULES §8 (REMINDER_DAYS): N задаётся окружением
  it('N = 1: дата напоминания — предыдущий рабочий день', () => {
    expect(reminderDueOnPass(START, 1, '2026-11-09', true)).toBe(true);
    expect(reminderDueOnPass(START, 1, '2026-11-06', true)).toBe(false);
  });

  // RULES §8-3, §8-4
  it('свойство: пора ⇔ дата напоминания ≤ сегодня < начала, а в день напоминания — с 09:00', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 3000 }),
        fc.integer({ min: -20, max: 20 }),
        fc.integer({ min: 1, max: 10 }),
        fc.boolean(),
        (base, shift, n, after9) => {
          const start = addDays('2026-01-01', base);
          const today = addDays(start, shift);
          const rem = reminderDate(start, n);
          const expected =
            compareDates(today, start) < 0 &&
            (compareDates(rem, today) < 0 ||
              (compareDates(rem, today) === 0 && after9));
          expect(reminderDueOnPass(start, n, today, after9)).toBe(expected);
        },
      ),
    );
  });
});

describe('lateReminderDue', () => {
  // RULES §8-3: «одобрен слишком поздно», в любое время суток; §8-4: начало наступило — нет
  it.each([
    ['дата напоминания завтра', '2026-11-04', false],
    ['дата напоминания сегодня', '2026-11-05', true],
    ['дата напоминания прошла', '2026-11-06', true],
    ['накануне начала', '2026-11-09', true],
    ['день начала', '2026-11-10', false],
    ['после начала', '2026-11-12', false],
  ])('%s (%s) → %s', (_name, today, expected) => {
    expect(lateReminderDue(START, N, today)).toBe(expected);
  });
});
