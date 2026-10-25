import { describe, expect, it } from 'vitest';
import { formatHireDate, orEmpty } from './format';

describe('профиль на чтение', () => {
  // RULES §7-2
  it('дата выхода форматируется строкой, без смещения часового пояса', () => {
    expect(formatHireDate('2022-03-15')).toBe('15.03.2022');
    expect(formatHireDate('2026-01-01')).toBe('01.01.2026');
  });

  // RULES §7-2
  it('непонятное значение даты показывается как есть', () => {
    expect(formatHireDate('вчера')).toBe('вчера');
  });

  // RULES §7-6
  it('пустое название команды и пустой руководитель (директор) показываются прочерком', () => {
    expect(orEmpty(null)).toBe('—');
    expect(orEmpty(undefined)).toBe('—');
    expect(orEmpty('Фронт-отдел')).toBe('Фронт-отдел');
  });
});
