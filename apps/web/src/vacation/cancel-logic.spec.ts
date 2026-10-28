import { describe, expect, it } from 'vitest';
import type { Vacation } from '../api/types';
import { canCancel, cancelConfirmText, cancelSuccessText } from './cancel-logic';

function vacation(over: Partial<Vacation> = {}): Vacation {
  return {
    id: 7,
    employee: { id: 6, fullName: 'James Walker' },
    backstopper: { id: 8, fullName: 'Sophie Bennett' },
    startDate: '2026-11-09',
    endDate: '2026-11-13',
    workDays: 5,
    status: 'APPROVED',
    comment: null,
    transferPending: false,
    oldVacationKept: false,
    actions: ['cancel'],
    ...over,
  };
}

describe('отмена в «Моих заявках»', () => {
  // RULES §5-4, §5-7: кнопка по подсказке сервера; после начала её нет
  it('«Отменить» только если сервер разрешил cancel', () => {
    expect(canCancel(vacation())).toBe(true);
    expect(canCancel(vacation({ actions: [] }))).toBe(false);
  });

  // RULES §5-4: у одобренного дни вернутся полностью
  it('вопрос у одобренного отпуска называет возвращаемые дни', () => {
    expect(cancelConfirmText(vacation())).toBe('Отменить отпуск 09.11.2026–13.11.2026? 5 раб. дн. вернутся в остаток.');
    expect(cancelSuccessText(vacation())).toBe('Отпуск отменён, дни возвращены в остаток');
  });

  // RULES §5-4: у заявки «На согласовании» возвращать нечего
  it('вопрос у заявки «На согласовании» - дни не списывались', () => {
    const pending = vacation({ status: 'PENDING' });
    expect(cancelConfirmText(pending)).toBe('Отменить заявку 09.11.2026–13.11.2026? Дни не списывались.');
    expect(cancelSuccessText(pending)).toBe('Заявка отменена');
  });
});
