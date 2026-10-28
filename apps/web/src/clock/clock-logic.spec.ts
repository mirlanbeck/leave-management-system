import { describe, expect, it, vi } from 'vitest';
import { ApiRequestError } from '../api/problem';
import { applyClock, companyDate, DEFAULT_TIME, formatCompanyMoment, loadStrip, setClock } from './clock-logic';

function fakeGet(responses: Record<string, unknown>) {
  return vi.fn(async (path: string) => {
    if (!(path in responses)) throw new Error(`неожиданный запрос ${path}`);
    return responses[path];
  });
}

describe('полоса часов: когда она нужна', () => {
  // RULES §9-2
  it('при demoMode=false полоса выключена и /clock не запрашивается', async () => {
    const get = fakeGet({ '/config': { demoMode: false, companyTz: 'Asia/Bishkek' } });
    expect(await loadStrip({ get } as never)).toEqual({ kind: 'off' });
    expect(get.mock.calls.map((c) => c[0])).toEqual(['/config']);
  });

  // RULES §9-2, §9-3
  it('при demoMode=true берёт пояс из /config и момент из /clock', async () => {
    const get = fakeGet({
      '/config': { demoMode: true, companyTz: 'Asia/Bishkek' },
      '/clock': { now: '2026-10-21T03:00:00.000Z', frozen: true },
    });
    expect(await loadStrip({ get } as never)).toEqual({
      kind: 'on',
      companyTz: 'Asia/Bishkek',
      now: '2026-10-21T03:00:00.000Z',
    });
  });
});

describe('полоса часов: сбои загрузки', () => {
  // RULES §9-2
  it('сбой /config отдаётся наверх (интерфейс покажет пометку), /clock не запрашивается', async () => {
    const get = vi.fn(async () => {
      throw new ApiRequestError({ status: 0, code: 'NETWORK', message: 'Нет связи с сервером' });
    });
    await expect(loadStrip({ get } as never)).rejects.toBeInstanceOf(ApiRequestError);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('значение часов в поясе компании', () => {
  // RULES §9-3
  it('21.10.2026 03:00 UTC это 09:00 в Бишкеке', () => {
    expect(formatCompanyMoment('2026-10-21T03:00:00.000Z', 'Asia/Bishkek')).toBe('21.10.2026 09:00');
    expect(companyDate('2026-10-21T03:00:00.000Z', 'Asia/Bishkek')).toBe('2026-10-21');
  });

  // RULES §9-3
  it('дата берётся по поясу компании, а не по UTC: 20:00 UTC уже следующий день в Бишкеке', () => {
    expect(companyDate('2026-10-20T20:00:00.000Z', 'Asia/Bishkek')).toBe('2026-10-21');
    expect(formatCompanyMoment('2026-10-20T20:00:00.000Z', 'Asia/Bishkek')).toBe('21.10.2026 02:00');
  });

  // RULES §9-3
  it('полночь показывается как 00:30, а не 24:30; результат не зависит от TZ процесса', () => {
    expect(formatCompanyMoment('2026-07-01T04:30:00.000Z', 'America/New_York')).toBe('01.07.2026 00:30');
    expect(companyDate('2026-07-01T04:30:00.000Z', 'America/New_York')).toBe('2026-07-01');
  });
});

describe('форма установки часов', () => {
  // RULES §9-3
  it('время по умолчанию 09:00', () => {
    expect(DEFAULT_TIME).toBe('09:00');
  });

  // RULES §9-3
  it('отправляет PUT /clock с {date, time} в поясе компании и возвращает ответ сервера', async () => {
    const put = vi.fn(async () => ({ now: '2026-11-05T03:00:00.000Z', frozen: true }));
    const view = await setClock({ put } as never, '2026-11-05', '09:00');
    expect(put).toHaveBeenCalledWith('/clock', { date: '2026-11-05', time: '09:00' });
    expect(view.now).toBe('2026-11-05T03:00:00.000Z');
  });

  // RULES §9-3, §3-10: после установки часов данные страницы считаются заново (перезагрузка)
  it('после успешной установки страница перезагружается', async () => {
    const put = vi.fn(async () => ({ now: '2026-11-01T03:00:00.000Z', frozen: true }));
    const reload = vi.fn();
    await applyClock({ put } as never, '2026-11-01', '09:00', reload);
    expect(put).toHaveBeenCalledWith('/clock', { date: '2026-11-01', time: '09:00' });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // RULES §9-3: ошибка показывается, перезагрузки нет
  it('при ошибке установки страница не перезагружается', async () => {
    const put = vi.fn(async () => {
      throw new ApiRequestError({ status: 400, code: 'VALIDATION_FAILED', message: 'x' });
    });
    const reload = vi.fn();
    await expect(applyClock({ put } as never, '', '09:00', reload)).rejects.toBeInstanceOf(ApiRequestError);
    expect(reload).not.toHaveBeenCalled();
  });
});
