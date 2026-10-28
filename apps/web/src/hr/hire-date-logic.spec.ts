import { describe, expect, it } from 'vitest';
import { canSaveHireDate, HIRE_DATE_CHANGED, HIRE_DATE_WARNING, hireDateBody, isNewHireDate } from './hire-date-logic';

const current = '2022-03-15';

describe('смена даты выхода на экране HR', () => {
  // RULES §6-3: текст разового сообщения дословно
  it('сообщение после сохранения - текст RULES', () => {
    expect(HIRE_DATE_CHANGED).toBe('Дата изменена. Проверьте одобренные отпуска этого сотрудника');
  });

  // RULES §6-2: предупреждение при вводе (DECISIONS 2026-10-28 19:19)
  it('текст предупреждения', () => {
    expect(HIRE_DATE_WARNING).toBe(
      'Внимание: проверьте дату выхода: от неё пересчитаются начисления и остаток. Одобренные отпуска и списания не изменятся, остаток может стать отрицательным',
    );
  });

  // RULES §6-2: предупреждение появляется, как только введена новая дата
  it('предупреждение только для введённой даты, отличной от текущей', () => {
    expect(isNewHireDate('', current)).toBe(false);
    expect(isNewHireDate(current, current)).toBe(false);
    expect(isNewHireDate('2026-09-10', current)).toBe(true);
  });

  // RULES §6-1: в любую сторону; пустая и прежняя дата не сохраняются
  it('«Сохранить» доступна для новой даты раньше и позже текущей', () => {
    expect(canSaveHireDate('', current)).toBe(false);
    expect(canSaveHireDate(current, current)).toBe(false);
    expect(canSaveHireDate('2026-09-10', current)).toBe(true);
    expect(canSaveHireDate('2020-01-01', current)).toBe(true);
    expect(canSaveHireDate('2027-01-01', current)).toBe(true);
  });

  // RULES §6-1: границы дат API (architecture §7)
  it('дата вне 2000–2100 не сохраняется', () => {
    expect(canSaveHireDate('1999-12-31', current)).toBe(false);
    expect(canSaveHireDate('2000-01-01', current)).toBe(true);
    expect(canSaveHireDate('2100-12-31', current)).toBe(true);
    expect(canSaveHireDate('2101-01-01', current)).toBe(false);
  });

  // RULES §6-1: тело запроса - только дата
  it('тело запроса', () => {
    expect(hireDateBody('2026-09-10')).toEqual({ hireDate: '2026-09-10' });
  });
});
