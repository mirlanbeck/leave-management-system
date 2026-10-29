import fc from 'fast-check';
import {
  approverOf,
  calendarScope,
  canDecide,
  canSee,
  rolesOf,
  scope,
  type OrgUser,
} from './policy';

// Структура RULES §7: директор <- зам <- (HR, Р1, Р2); Р1 <- С1; Р2 <- С2
const users: OrgUser[] = [
  { id: 1, isHr: false, managerId: null }, // директор
  { id: 2, isHr: false, managerId: 1 }, // заместитель
  { id: 3, isHr: true, managerId: 2 }, // HR
  { id: 4, isHr: false, managerId: 2 }, // Р1
  { id: 5, isHr: false, managerId: 2 }, // Р2
  { id: 6, isHr: false, managerId: 4 }, // С1
  { id: 7, isHr: false, managerId: 5 }, // С2
];
const byId = (id: number) => users.find((u) => u.id === id)!;
const directOf = (id: number) =>
  users.filter((u) => u.managerId === id).map((u) => u.id);
const ids = (id: number) => {
  const s = scope(byId(id), directOf(id));
  return s === 'ALL' ? s : [...s].sort((a, b) => a - b);
};

describe('rolesOf', () => {
  // RULES §7-1
  it('HR, руководитель, сотрудник, директор', () => {
    expect(rolesOf(byId(3), directOf(3))).toEqual({
      isHr: true,
      isManager: false,
      isDirector: false,
    });
    expect(rolesOf(byId(4), directOf(4))).toEqual({
      isHr: false,
      isManager: true,
      isDirector: false,
    });
    expect(rolesOf(byId(6), directOf(6))).toEqual({
      isHr: false,
      isManager: false,
      isDirector: false,
    });
    expect(rolesOf(byId(1), directOf(1)).isDirector).toBe(true);
  });
});

describe('scope', () => {
  // RULES §7-2
  it('HR видит всех', () => {
    expect(ids(3)).toBe('ALL');
  });

  // RULES §7-2
  it('руководитель видит себя и прямых подчинённых', () => {
    expect(ids(4)).toEqual([4, 6]);
  });

  // RULES §7-2
  it('сотрудник видит только себя', () => {
    expect(ids(6)).toEqual([6]);
  });

  // RULES §7-3
  it('вложенные подчинённые не входят: директор не видит сотрудников', () => {
    expect(ids(1)).toEqual([1, 2]);
  });

  // RULES §7-3
  it('заместитель видит себя, HR, Р1, Р2, но не сотрудников Р1', () => {
    expect(ids(2)).toEqual([2, 3, 4, 5]);
    expect(canSee(byId(2), directOf(2), 6)).toBe(false);
  });

  // RULES §7-2
  it('HR, у которого есть подчинённые, всё равно видит всех', () => {
    expect(scope({ id: 3, isHr: true, managerId: 2 }, [9])).toBe('ALL');
  });

  // RULES §7-2, §7-3
  it('canSee(v, id) тогда и только тогда, когда id ∈ scope(v)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 7 }),
        fc.integer({ min: 1, max: 9 }),
        (viewerId, target) => {
          const viewer = byId(viewerId);
          const s = scope(viewer, directOf(viewerId));
          const expected = s === 'ALL' ? true : s.has(target);
          return canSee(viewer, directOf(viewerId), target) === expected;
        },
      ),
    );
  });
});

describe('calendarScope', () => {
  // Та же структура и второй сотрудник команды 1: С1' (8) <- Р1
  const org = [...users, { id: 8, isHr: false, managerId: 4 }];
  const reportsOf = (id: number) =>
    org.filter((u) => u.managerId === id).map((u) => u.id);
  const cal = (id: number) => {
    const viewer = org.find((u) => u.id === id)!;
    const peers = viewer.managerId === null ? [] : reportsOf(viewer.managerId);
    const s = calendarScope(viewer, reportsOf(id), peers);
    return s === 'ALL' ? s : [...s].sort((a, b) => a - b);
  };

  // RULES §7-2: сотрудник - коллеги с тем же руководителем и сам руководитель
  it('сотрудник команды 1 видит себя, коллегу и Р1, но не команду 2', () => {
    expect(cal(6)).toEqual([4, 6, 8]);
    expect(cal(8)).toEqual([4, 6, 8]);
  });

  // RULES §7-2
  it('единственный сотрудник команды 2 видит себя и Р2', () => {
    expect(cal(7)).toEqual([5, 7]);
  });

  // RULES §7-2: руководитель - только прямые подчинённые, коллег-руководителей не видит
  it('руководитель видит себя и прямых подчинённых, но не Р2, HR и заместителя', () => {
    expect(cal(4)).toEqual([4, 6, 8]);
    expect(cal(5)).toEqual([5, 7]);
  });

  // RULES §7-2, §7-3: заместитель и директор - как руководители
  it('заместитель и директор видят прямых подчинённых', () => {
    expect(cal(2)).toEqual([2, 3, 4, 5]);
    expect(cal(1)).toEqual([1, 2]);
  });

  // RULES §7-2
  it('HR видит всю компанию', () => {
    expect(cal(3)).toBe('ALL');
  });

  // RULES §7-2: календарь не уже `scope` - всё, что видно по `scope`, видно и в календаре
  it('scope(v) ⊆ calendarScope(v)', () => {
    for (const u of org) {
      const s = scope(u, reportsOf(u.id));
      const c = cal(u.id);
      if (s === 'ALL') expect(c).toBe('ALL');
      else if (c !== 'ALL') for (const id of s) expect(c).toContain(id);
    }
  });
});

describe('approverOf', () => {
  const HR_ID = 3;

  // RULES §4-1: согласует непосредственный руководитель, в том числе заявки заместителя и HR
  it.each([
    [2, 1], // заместитель -> директор
    [3, 2], // HR -> заместитель
    [4, 2], // Р1 -> заместитель
    [6, 4], // С1 -> Р1
    [7, 5], // С2 -> Р2
  ])('сотрудник %i -> согласующий %i', (employeeId, expected) => {
    expect(approverOf(byId(employeeId), HR_ID)).toBe(expected);
  });

  // RULES §4-2: заявки директора (начальника нет) подтверждает HR («допуск HR»)
  it('директор -> HR', () => {
    expect(approverOf(byId(1), HR_ID)).toBe(HR_ID);
  });
});

describe('canDecide', () => {
  const HR_ID = 3;

  // RULES §4-1, §4-2: решает только согласующий
  it.each([
    [4, 6, true], // Р1 по заявке С1
    [3, 1, true], // HR по заявке директора
    [2, 3, true], // заместитель по заявке HR
    [3, 6, false], // HR по заявке С1
    [2, 6, false], // заместитель по заявке С1 (не непосредственный)
    [5, 6, false], // Р2 по заявке С1
  ])('%i по заявке %i -> %s', (actorId, employeeId, expected) => {
    expect(canDecide(actorId, byId(employeeId), HR_ID)).toBe(expected);
  });

  // RULES §4-2; DECISIONS [S5]: свою заявку не решает никто
  // включая вырожденный случай: автор сам оказался бы согласующим (директор и HR в одном лице)
  it('автор по своей заявке -> false, даже если он же согласующий', () => {
    fc.assert(
      fc.property(fc.constantFrom(...users), fc.boolean(), (u, selfHr) => {
        const employee = selfHr ? { ...u, managerId: null } : u;
        return !canDecide(u.id, employee, selfHr ? u.id : HR_ID);
      }),
    );
  });
});
