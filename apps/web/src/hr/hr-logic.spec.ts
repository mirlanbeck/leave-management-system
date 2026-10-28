import { describe, expect, it } from 'vitest';
import type { Vacation } from '../api/types';
import { canRecall, canSubmitRecall, recallBody, recallHint, recallSuccessText } from './hr-logic';

const period = { startDate: '2026-11-09', endDate: '2026-11-13' };

function vacation(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 7,
    employee: { id: 6, fullName: 'James Walker' },
    backstopper: { id: 8, fullName: 'Sophie Bennett' },
    ...period,
    workDays: 5,
    status: 'APPROVED',
    comment: null,
    replacesId: null,
    transferPending: false,
    oldVacationKept: false,
    actions: ['recall'],
    ...over,
  };
}

describe('экран HR «Все заявки»', () => {
  // RULES §5-5, §5-10: «Отзыв» только там, где сервер разрешил (до начала и после окончания - нет)
  it('«Отзыв» только по подсказке recall', () => {
    expect(canRecall(vacation())).toBe(true);
    expect(canRecall(vacation({ actions: [] }))).toBe(false);
    expect(canRecall(vacation({ actions: ['cancel'] }))).toBe(false);
  });

  // RULES §5-11: дата выхода обязательна и лежит в отпуске включительно
  it('подтвердить можно с датой от начала до окончания', () => {
    expect(canSubmitRecall('', period)).toBe(false);
    expect(canSubmitRecall('2026-11-08', period)).toBe(false);
    expect(canSubmitRecall('2026-11-09', period)).toBe(true);
    expect(canSubmitRecall('2026-11-13', period)).toBe(true);
    expect(canSubmitRecall('2026-11-14', period)).toBe(false);
  });

  // RULES §5-6: день выхода рабочий
  it('подсказка, тело запроса и итог', () => {
    expect(recallHint('2026-11-13')).toBe(
      'Возвращаются рабочие дни с даты выхода по 13.11.2026 включительно; день выхода — рабочий.',
    );
    expect(recallBody('2026-11-12')).toEqual({ returnDate: '2026-11-12' });
    expect(recallSuccessText('James Walker', '2026-11-12')).toBe('James Walker: отзыв оформлен, дата выхода 12.11.2026');
  });
});
