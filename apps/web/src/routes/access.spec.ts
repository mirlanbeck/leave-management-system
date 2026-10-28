import { describe, expect, it } from 'vitest';
import { allowedRoutes, canAccess } from './access';

// Флаги соответствуют демо-пользователям (RULES §7, таблица): директор тоже руководитель,
// HR без подчинённых не руководитель.
const employee = { isHr: false, isManager: false };
const manager = { isHr: false, isManager: true };
const hr = { isHr: true, isManager: false };

describe('таблица «роль → маршруты»', () => {
  // RULES §7-2
  it('сотрудник видит профиль, «Отпуск» и календарь', () => {
    expect(allowedRoutes(employee)).toEqual(['home', 'vacation', 'calendar']);
    expect(canAccess('approvals', employee)).toBe(false);
    expect(canAccess('hr', employee)).toBe(false);
  });

  // RULES §7-2
  it('руководитель видит профиль, «Отпуск», согласование и календарь, но не экран HR', () => {
    expect(allowedRoutes(manager)).toEqual(['home', 'vacation', 'approvals', 'calendar']);
    expect(canAccess('hr', manager)).toBe(false);
  });

  // RULES §7-2; §7-1: у HR есть свои отпускные дни
  it('HR видит всё: заявки директора согласует HR', () => {
    expect(allowedRoutes(hr)).toEqual(['home', 'vacation', 'approvals', 'calendar', 'hr']);
  });
});
