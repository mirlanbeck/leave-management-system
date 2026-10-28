import {
  actorError,
  approveBlock,
  overlapOwner,
  overlapsWith,
  transferApproveBlock,
} from './approval-rules';

const HR = 3;
const director = { id: 1, managerId: null };
const deputy = { id: 2, managerId: 1 };
const hr = { id: HR, managerId: 2 };
const manager = { id: 4, managerId: 2 };
const employee = { id: 6, managerId: 4 };

describe('actorError: кто решает по заявке', () => {
  // RULES §4-1: согласует непосредственный руководитель
  it('руководитель по заявке подчинённого - можно', () => {
    expect(actorError(manager.id, employee, HR)).toBeNull();
  });

  // RULES §4-2: заявки директора подтверждает HR («допуск HR»)
  it('HR по заявке директора - можно', () => {
    expect(actorError(HR, director, HR)).toBeNull();
  });

  // RULES §4-1: заявки HR согласует заместитель директора
  it('заместитель по заявке HR - можно', () => {
    expect(actorError(deputy.id, hr, HR)).toBeNull();
  });

  // RULES §4-1, §4-2; DECISIONS 2026-10-22 12:15: свою заявку согласовать нельзя никому
  it.each([
    ['сотрудник', employee],
    ['руководитель', manager],
    ['HR', hr],
    ['директор', director],
  ])('%s по своей заявке - APPROVE_OWN_REQUEST', (_, author) => {
    expect(actorError(author.id, author, HR)?.code).toBe('APPROVE_OWN_REQUEST');
  });

  // RULES §4-2: HR согласует только заявки директора
  it('HR по заявке сотрудника - NOT_APPROVER', () => {
    expect(actorError(HR, employee, HR)?.code).toBe('NOT_APPROVER');
  });

  // RULES §4-1: решает только непосредственный руководитель, вышестоящий - нет
  it('заместитель по заявке сотрудника чужой команды - NOT_APPROVER', () => {
    expect(actorError(deputy.id, employee, HR)?.code).toBe('NOT_APPROVER');
  });

  it('ошибки 403 с текстами каталога', () => {
    expect(actorError(HR, employee, HR)).toEqual({
      status: 403,
      code: 'NOT_APPROVER',
      message: 'Эту заявку согласует другой сотрудник',
    });
    expect(actorError(employee.id, employee, HR)).toEqual({
      status: 403,
      code: 'APPROVE_OWN_REQUEST',
      message: 'Свою заявку согласовать нельзя',
    });
  });
});

describe('overlapOwner: чья команда в предупреждении о пересечениях', () => {
  // RULES §4-6: прямые подчинённые руководителя и он сам
  it('у сотрудника - его руководитель', () => {
    expect(overlapOwner(employee)).toBe(manager.id);
  });

  // RULES §4-6; DECISIONS 2026-10-22 12:15: при допуске HR - команда директора и он сам
  it('у директора - сам директор', () => {
    expect(overlapOwner(director)).toBe(director.id);
  });
});

describe('overlapsWith: пересечение дат', () => {
  const target = { id: 10, startDate: '2026-11-09', endDate: '2026-11-13' };
  const v = (id: number, startDate: string, endDate: string) => ({
    id,
    startDate,
    endDate,
  });

  // RULES §4-6: пересекающиеся даты, включая касание границ
  it('оставляет пересекающиеся и касающиеся границ, сортирует по началу', () => {
    const result = overlapsWith(target, [
      v(1, '2026-11-13', '2026-11-20'),
      v(2, '2026-11-02', '2026-11-09'),
      v(3, '2026-11-02', '2026-11-06'),
      v(4, '2026-11-16', '2026-11-20'),
      v(5, '2026-11-10', '2026-11-11'),
    ]);
    expect(result.map((x) => x.id)).toEqual([2, 5, 1]);
  });

  it('саму заявку не считает', () => {
    expect(overlapsWith(target, [v(10, '2026-11-09', '2026-11-13')])).toEqual(
      [],
    );
  });
});

describe('approveBlock: повторная проверка остатка', () => {
  // RULES §4-3: дней хватает - согласовать можно
  it('хватает ровно - null', () => {
    expect(approveBlock(5, 5)).toBeNull();
  });

  // RULES §4-3: «осталось X дней, в заявке Y»; DECISIONS 2026-10-26 10:47: запятая, числа в details
  it('не хватает - APPROVE_INSUFFICIENT_BALANCE с текстом и числами', () => {
    expect(approveBlock(2.5, 5)).toEqual({
      status: 422,
      code: 'APPROVE_INSUFFICIENT_BALANCE',
      message: 'Согласовать нельзя: осталось 2,5 дней, в заявке 5',
      details: { available: 2.5, requested: 5 },
    });
  });

  // RULES §6-4: после сдвига даты выхода остаток отрицательный, минус типографский
  it('отрицательный остаток - с типографским минусом', () => {
    expect(approveBlock(-1, 3)?.message).toBe(
      'Согласовать нельзя: осталось −1 дней, в заявке 3',
    );
  });
});

describe('transferApproveBlock: утверждение переноса после начала старого отпуска', () => {
  // RULES §5-2 «Перенос нельзя утвердить, если старый отпуск уже начался»; §5-9
  it('накануне начала старого - можно', () => {
    expect(transferApproveBlock('2026-11-09', '2026-11-08')).toBeNull();
  });

  // RULES §5-2: согласующий может его только отклонить
  it('в день начала и позже - 422 TRANSFER_APPROVE_AFTER_START', () => {
    const expected = {
      status: 422,
      code: 'TRANSFER_APPROVE_AFTER_START',
      message: 'Старый отпуск уже начался: перенос можно только отклонить',
    };
    expect(transferApproveBlock('2026-11-09', '2026-11-09')).toEqual(expected);
    expect(transferApproveBlock('2026-11-09', '2026-11-20')).toEqual(expected);
  });
});
