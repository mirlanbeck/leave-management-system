import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/problem';
import type { ApprovalItem } from '../api/types';
import {
  availableText,
  decisionBody,
  decisionButtons,
  decideThenReload,
  oneAtATime,
  overlapText,
  successText,
  transferLabel,
} from './approval-logic';

function item(over: Partial<ApprovalItem> = {}, actions: ApprovalItem['vacation']['actions'] = ['approve', 'reject']): ApprovalItem {
  return {
    vacation: {
      id: 7,
      employee: { id: 6, fullName: 'Sophie Bennett' },
      backstopper: { id: 8, fullName: 'Liam Turner' },
      startDate: '2026-11-11',
      endDate: '2026-11-17',
      workDays: 5,
      status: 'PENDING',
      comment: null,
      replacesId: null,
      transferPending: false,
      oldVacationKept: false,
      actions,
    },
    availableOnStart: 20,
    overlaps: [],
    canApprove: true,
    blockReason: null,
    ...over,
  };
}

const BLOCK = {
  statusCode: 422,
  code: 'APPROVE_INSUFFICIENT_BALANCE',
  message: 'Согласовать нельзя: осталось 7,5 дней, в заявке 9',
};

describe('пересечения в команде', () => {
  // RULES §4-6: предупреждение называет сотрудников и даты одобренных отпусков
  it('одно и несколько пересечений: имена и даты через точку с запятой', () => {
    expect(
      overlapText([{ vacationId: 1, employee: { id: 5, fullName: 'James Walker' }, startDate: '2026-11-09', endDate: '2026-11-13' }]),
    ).toBe('Пересекается с одобренными отпусками: James Walker 09.11.2026–13.11.2026');
    expect(
      overlapText([
        { vacationId: 1, employee: { id: 5, fullName: 'James Walker' }, startDate: '2026-11-09', endDate: '2026-11-13' },
        { vacationId: 2, employee: { id: 3, fullName: 'Daniel Brooks' }, startDate: '2026-11-16', endDate: '2026-11-16' },
      ]),
    ).toBe(
      'Пересекается с одобренными отпусками: James Walker 09.11.2026–13.11.2026; Daniel Brooks 16.11.2026–16.11.2026',
    );
  });

  // RULES §4-6: без пересечений блока предупреждения нет
  it('пересечений нет: текста нет', () => {
    expect(overlapText([])).toBeNull();
  });
});

describe('остаток на дату начала', () => {
  // RULES §4-7, §2-7: дни через запятую
  it('дни через запятую, целые без дробной части', () => {
    expect(availableText(7.5)).toEqual({ text: '7,5', negative: false });
    expect(availableText(40)).toEqual({ text: '40', negative: false });
  });

  // RULES §6-4: минус типографский и с цветной пометкой
  it('отрицательный остаток помечается', () => {
    expect(availableText(-3)).toEqual({ text: '−3', negative: true });
  });

  // RULES §5-2: null только у переноса, остаток не проверяется (DECISIONS 2026-10-28 17:06)
  it('перенос: «не проверяется (перенос)»', () => {
    expect(availableText(null)).toEqual({ text: 'не проверяется (перенос)', negative: false });
  });
});

describe('заявка-перенос на карточке', () => {
  // RULES §4-7, §5-2; DECISIONS 2026-10-28 17:06: плашка без старых дат
  it('плашка только у переноса', () => {
    expect(transferLabel({ replacesId: null })).toBeNull();
    expect(transferLabel({ replacesId: 3 })).toBe('Перенос одобренного отпуска');
  });

  // RULES §5-2: после начала старого отпуска подтвердить нельзя, отклонить можно; причина от сервера
  it('старый начался: «Подтвердить» недоступна, «Отклонить» доступна, причина видна', () => {
    const reason = 'Старый отпуск уже начался: перенос можно только отклонить';
    const b = decisionButtons(
      item({
        availableOnStart: null,
        canApprove: false,
        blockReason: { statusCode: 422, code: 'TRANSFER_APPROVE_AFTER_START', message: reason },
      }),
      false,
    );
    expect(b).toMatchObject({ approveEnabled: false, rejectEnabled: true, reason });
  });
});

describe('кнопки решения', () => {
  // RULES §4-1, §4-2: кнопки только у согласующего (подсказка actions сервера)
  it('кнопки видны только при actions approve/reject', () => {
    expect(decisionButtons(item(), false)).toEqual({
      approveVisible: true,
      approveEnabled: true,
      rejectVisible: true,
      rejectEnabled: true,
      reason: null,
    });
    const none = decisionButtons(item({}, []), false);
    expect(none.approveVisible).toBe(false);
    expect(none.rejectVisible).toBe(false);
  });

  // RULES §4-3: нехватка дней — подтвердить нельзя, причина сервера, отклонить можно
  it('canApprove false: «Подтвердить» недоступна, причина из blockReason, «Отклонить» доступна', () => {
    const b = decisionButtons(item({ canApprove: false, blockReason: BLOCK }), false);
    expect(b.approveVisible).toBe(true);
    expect(b.approveEnabled).toBe(false);
    expect(b.rejectEnabled).toBe(true);
    expect(b.reason).toBe('Согласовать нельзя: осталось 7,5 дней, в заявке 9');
  });

  // RULES §10-1: пока решение отправляется, обе кнопки карточки недоступны
  it('идёт запрос: обе кнопки недоступны', () => {
    const b = decisionButtons(item(), true);
    expect(b.approveEnabled).toBe(false);
    expect(b.rejectEnabled).toBe(false);
  });
});

describe('тело решения', () => {
  // RULES §4-1: комментарий необязателен; сервер сам обрезает пробелы
  it('пустой или из пробелов комментарий не отправляется, непустой — как введён', () => {
    expect(decisionBody('')).toEqual({});
    expect(decisionBody('   ')).toEqual({});
    expect(decisionBody(' Хорошего отдыха ')).toEqual({ comment: ' Хорошего отдыха ' });
  });
});

describe('итог решения', () => {
  // RULES §4-1
  it('текст успеха называет сотрудника и решение', () => {
    expect(successText('approve', 'Sophie Bennett')).toBe('Заявка Sophie Bennett одобрена');
    expect(successText('reject', 'Sophie Bennett')).toBe('Заявка Sophie Bennett отклонена');
  });

  // RULES §4-1: после успеха список перечитывается
  it('успех: итог ok и перечитывание списка', async () => {
    const reload = vi.fn();
    const outcome = await decideThenReload(() => Promise.resolve(), reload, 'Заявка Sophie Bennett одобрена');
    expect(outcome).toEqual({ tone: 'ok', text: 'Заявка Sophie Bennett одобрена' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // RULES §10-1: «уже обработана» — текст сервера с кодом, список перечитывается
  it('409: текст сервера с кодом и перечитывание списка', async () => {
    const reload = vi.fn();
    const outcome = await decideThenReload(
      () =>
        Promise.reject(
          new ApiRequestError({ status: 409, code: 'ALREADY_PROCESSED', message: 'Заявка уже обработана' }),
        ),
      reload,
      'не должно показываться',
    );
    expect(outcome).toEqual({ tone: 'error', text: 'Заявка уже обработана (ALREADY_PROCESSED)' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // RULES §4-3, §4-1, §4-2: 422, 403 и сеть тоже перечитывают список (DECISIONS [S5])
  it('422, 403 и ошибка сети: текст и перечитывание списка', async () => {
    for (const err of [
      new ApiRequestError({ status: 422, code: BLOCK.code, message: BLOCK.message }),
      new ApiRequestError({ status: 403, code: 'NOT_APPROVER', message: 'Эту заявку согласует другой сотрудник' }),
      new TypeError('fetch failed'),
    ]) {
      const reload = vi.fn();
      const outcome = await decideThenReload(() => Promise.reject(err), reload, '');
      expect(outcome.tone).toBe('error');
      expect(reload).toHaveBeenCalledTimes(1);
    }
  });
});

describe('одно решение на карточку', () => {
  // RULES §10-1: пока идёт решение, второе (в том числе другой кнопкой) не отправляется
  it('второй вызов во время первого не запускается, после завершения можно снова', async () => {
    const guard = oneAtATime();
    let release!: () => void;
    const approve = vi.fn(() => new Promise<void>((r) => (release = r)));
    const reject = vi.fn(() => Promise.resolve());

    const first = guard(approve);
    await guard(reject);
    expect(approve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();

    release();
    await first;
    await guard(reject);
    expect(reject).toHaveBeenCalledTimes(1);
  });

  // RULES §10-1: упавший запрос не блокирует карточку навсегда
  it('после ошибки охрана снимается', async () => {
    const guard = oneAtATime();
    await expect(guard(() => Promise.reject(new Error('x')))).rejects.toThrow('x');
    const next = vi.fn(() => Promise.resolve());
    await guard(next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
