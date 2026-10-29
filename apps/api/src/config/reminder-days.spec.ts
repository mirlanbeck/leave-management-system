import { DEFAULT_REMINDER_DAYS, reminderDays } from './app-config';

describe('reminderDays', () => {
  // RULES §8-3: N из REMINDER_DAYS, по умолчанию 3
  it.each([
    [undefined, DEFAULT_REMINDER_DAYS],
    ['', DEFAULT_REMINDER_DAYS],
    ['1', 1],
    ['3', 3],
    ['10', 10],
  ])('REMINDER_DAYS=%p → %i', (raw, expected) => {
    expect(reminderDays({ REMINDER_DAYS: raw })).toBe(expected);
  });

  // RULES §8-3: неверное значение не подменяется молча
  it.each(['0', '-1', '2.5', 'три', ' 3'])(
    'REMINDER_DAYS=%p → ошибка',
    (raw) => {
      expect(() => reminderDays({ REMINDER_DAYS: raw })).toThrow(
        'REMINDER_DAYS',
      );
    },
  );
});
