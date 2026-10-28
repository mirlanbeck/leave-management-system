import { describe, expect, it } from 'vitest';
import type { Vacation } from '../api/types';
import { toVacationInput } from './submit-logic';
import { canTransfer, initialTransferForm, transferHint, transferSuccessText } from './transfer-logic';

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
    replacesId: null,
    transferPending: false,
    oldVacationKept: false,
    actions: ['cancel', 'transfer'],
    ...over,
  };
}

describe('«Перенести» в «Моих заявках»', () => {
  // RULES §5-1, §5-2: кнопка по подсказке сервера; пока перенос ждёт решения, её нет
  it('«Перенести» только если сервер разрешил transfer', () => {
    expect(canTransfer(vacation())).toBe(true);
    expect(canTransfer(vacation({ actions: ['cancel'] }))).toBe(false);
    expect(canTransfer(vacation({ actions: [], transferPending: true }))).toBe(false);
  });

  // RULES §5-2: backstopper старого отпуска подставлен; DECISIONS 2026-10-28 17:06: даты пустые
  it('форма: даты пустые, backstopper прежний, комментарий пустой', () => {
    expect(initialTransferForm(vacation())).toEqual({
      startDate: '',
      endDate: '',
      backstopperId: '8',
      comment: '',
    });
  });

  // RULES §5-2: тело переноса - те же поля, что у подачи; комментарий необязателен
  it('тело запроса из формы: backstopper числом, workDays не отправляется', () => {
    const body = toVacationInput({
      ...initialTransferForm(vacation()),
      startDate: '2026-11-16',
      endDate: '2026-11-20',
    });
    expect(body).toEqual({ startDate: '2026-11-16', endDate: '2026-11-20', backstopperId: 8, comment: '' });
  });

  // RULES §5-2: те же рабочие дни, начало не раньше сегодня
  it('подсказка называет число рабочих дней', () => {
    expect(transferHint(5)).toBe('Рабочих дней должно быть столько же: 5. Начало — не раньше сегодняшнего дня.');
  });

  // RULES §3-11: старый отпуск в силе, пока перенос ждёт решения
  it('итог подачи', () => {
    expect(transferSuccessText({ startDate: '2026-11-16', endDate: '2026-11-20' })).toBe(
      'Перенос подан: 16.11.2026–20.11.2026, статус «На согласовании». Старый отпуск действует до решения.',
    );
  });
});
