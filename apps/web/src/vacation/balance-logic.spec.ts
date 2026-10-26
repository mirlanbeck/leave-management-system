import { describe, expect, it } from 'vitest';
import { balancePath, latestOnly, nextOnDate } from './balance-logic';

describe('запрос остатка', () => {
  // RULES §3-10: без даты только «сегодня», с датой D ещё «доступно на D»; считает сервер
  it('без даты /me/balance, с датой /me/balance?on=D', () => {
    expect(balancePath('')).toBe('/me/balance');
    expect(balancePath('2026-12-01')).toBe('/me/balance?on=2026-12-01');
  });
});

describe('дата «Доступно на дату» следует за началом заявки', () => {
  // RULES §3-10: по умолчанию дата начала заявки (DECISIONS 2026-10-26 00:43)
  it('пустая дата панели получает начало заявки', () => {
    expect(nextOnDate('', '2026-12-01', '')).toBe('2026-12-01');
  });

  // RULES §3-10
  it('дата панели, совпадающая с прежним началом, меняется вместе с ним', () => {
    expect(nextOnDate('2026-12-01', '2026-12-07', '2026-12-01')).toBe('2026-12-07');
  });

  // RULES §3-10: дату можно выбрать вручную
  it('выбранная вручную дата не перезаписывается, пока начало не совпадёт с ней', () => {
    expect(nextOnDate('2026-12-01', '2026-12-07', '2027-01-01')).toBe('2027-01-01');
  });

  // RULES §3-10
  it('очищенное начало очищает следующую за ним дату панели', () => {
    expect(nextOnDate('2026-12-01', '', '2026-12-01')).toBe('');
  });
});

describe('ответы остатка не по порядку', () => {
  // RULES §3-10: на экране значение для последней выбранной даты
  it('учитывается только последний начатый запрос', () => {
    const take = latestOnly();
    const first = take();
    const second = take();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });
});
