import { describe, expect, it } from 'vitest';
import { formatDays, isNegativeDays } from './format';

describe('дни на экране', () => {
  // RULES §2-7: шаг 0,5, дробная часть через запятую
  it('половинки дня пишутся через запятую, целые без дробной части', () => {
    expect(formatDays(2.5)).toBe('2,5');
    expect(formatDays(37.5)).toBe('37,5');
    expect(formatDays(40)).toBe('40');
    expect(formatDays(0)).toBe('0');
  });

  // RULES §6-4: минус только со знаком «−» (типографский) и цветной пометкой
  it('отрицательный остаток с типографским минусом и признаком для пометки', () => {
    expect(formatDays(-3)).toBe('−3');
    expect(formatDays(-0.5)).toBe('−0,5');
    expect(isNegativeDays(-3)).toBe(true);
  });

  // RULES §6-4: минус только после сдвига даты выхода, обычный остаток без пометки
  it('ноль и положительный остаток не помечаются', () => {
    expect(isNegativeDays(0)).toBe(false);
    expect(isNegativeDays(2.5)).toBe(false);
  });
});
