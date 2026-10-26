import { describe, expect, it, vi } from 'vitest';
import { singleFlight, toVacationInput } from './submit-logic';

describe('тело заявки', () => {
  // RULES §3-2, §3-8: даты, backstopper и комментарий уходят на сервер как введены
  it('поля формы переводятся в VacationInput', () => {
    expect(
      toVacationInput({
        startDate: '2026-11-02',
        endDate: '2026-11-06',
        backstopperId: '7',
        comment: 'семейные дела',
      }),
    ).toEqual({
      startDate: '2026-11-02',
      endDate: '2026-11-06',
      backstopperId: 7,
      comment: 'семейные дела',
    });
  });

  // RULES §3-2, §3-4…§3-12: проверок на клиенте нет, причину объясняет сервер
  it('пустая форма не задерживается клиентом: backstopper null, пустые строки как есть', () => {
    expect(toVacationInput({ startDate: '', endDate: '', backstopperId: '', comment: '' })).toEqual({
      startDate: '',
      endDate: '',
      backstopperId: null,
      comment: '',
    });
  });
});

describe('«Подать» во время запроса', () => {
  // RULES §10-1: двойной клик даёт одну заявку
  it('второй вызов во время запроса не отправляет второй запрос', async () => {
    let release!: () => void;
    const send = vi.fn(() => new Promise<void>((r) => (release = r)));
    const submit = singleFlight(send);
    const a = submit();
    const b = submit();
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([a, b]);
  });

  // RULES §10-1
  it('после ответа, в том числе ошибки, можно отправить снова', async () => {
    const send = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('422'))
      .mockResolvedValueOnce(undefined);
    const submit = singleFlight(send);
    await expect(submit()).rejects.toThrow('422');
    await submit();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
