import type { OrgUser } from '../org/policy';
import { SEED_USERS } from '../seed-data';
import type { DomainEvent } from './event-bus';
import { deliver } from './event-filter';

// Структура seed (RULES §7): margaret <- thomas <- (emily HR, daniel, olivia);
// daniel <- (james, sophie, liam); olivia <- (grace, henry, chloe). id - порядковый номер.
const id = (login: string) =>
  SEED_USERS.findIndex((u) => u.login === login) + 1;
const org: OrgUser[] = SEED_USERS.map((u) => ({
  id: id(u.login),
  isHr: u.isHr,
  managerId: u.managerLogin === null ? null : id(u.managerLogin),
}));
const LOGINS = SEED_USERS.map((u) => u.login);

/** Кому из 11 пользователей seed событие доставляется. */
const recipients = (event: DomainEvent) =>
  LOGINS.filter((login) => deliver(event, id(login), org));

const vacationEvents = (login: string): [string, DomainEvent][] => {
  const employeeId = id(login);
  return [
    ['approved', { type: 'vacation.approved', employeeId, vacationId: 1 }],
    [
      'cancelled EMPLOYEE',
      { type: 'vacation.cancelled', employeeId, vacationId: 1, by: 'EMPLOYEE' },
    ],
    [
      'cancelled HR_RECALL',
      {
        type: 'vacation.cancelled',
        employeeId,
        vacationId: 1,
        by: 'HR_RECALL',
      },
    ],
    [
      'transfer-approved',
      {
        type: 'vacation.transfer-approved',
        employeeId,
        vacationId: 2,
        replacedId: 1,
      },
    ],
  ];
};

const sorted = (xs: string[]) => [...xs].sort();

describe('deliver: кому доставляется событие SSE', () => {
  // RULES §7-2, §10-2: отпуск сотрудника видят он сам, коллеги с тем же руководителем,
  // руководитель и HR; команда 2, заместитель и директор - нет
  describe.each(vacationEvents('james'))('отпуск james: %s', (_name, event) => {
    it('james, sophie, liam, daniel, emily', () => {
      expect(sorted(recipients(event))).toEqual(
        sorted(['james', 'sophie', 'liam', 'daniel', 'emily']),
      );
    });
  });

  // RULES §7-2, §10-2: отпуск руководителя видят его подчинённые, его руководитель и HR;
  // коллега-руководитель olivia - нет
  describe.each(vacationEvents('daniel'))(
    'отпуск daniel: %s',
    (_name, event) => {
      it('daniel, thomas, emily, james, sophie, liam', () => {
        expect(sorted(recipients(event))).toEqual(
          sorted(['daniel', 'thomas', 'emily', 'james', 'sophie', 'liam']),
        );
      });
    },
  );

  // RULES §7-2, §7-3, §10-2: отпуск директора видят только он сам и HR
  // (руководитель не видит своего руководителя, у директора коллег нет)
  describe.each(vacationEvents('margaret'))(
    'отпуск margaret: %s',
    (_name, event) => {
      it('только margaret и emily', () => {
        expect(sorted(recipients(event))).toEqual(
          sorted(['margaret', 'emily']),
        );
      });
    },
  );

  // RULES §6, §7-2, §10-2: смену даты выхода получают те, кому виден остаток:
  // сам сотрудник, его руководитель и HR; коллеги не получают
  it('дата выхода james: james, daniel, emily; sophie и liam - нет', () => {
    const event: DomainEvent = {
      type: 'employee.hire-date-changed',
      employeeId: id('james'),
    };
    expect(sorted(recipients(event))).toEqual(
      sorted(['james', 'daniel', 'emily']),
    );
  });

  // RULES §6, §7-2, §10-2: остаток руководителя виден ему, его руководителю и HR,
  // подчинённым - нет
  it('дата выхода daniel: daniel, thomas, emily', () => {
    const event: DomainEvent = {
      type: 'employee.hire-date-changed',
      employeeId: id('daniel'),
    };
    expect(sorted(recipients(event))).toEqual(
      sorted(['daniel', 'thomas', 'emily']),
    );
  });

  // RULES §9-3, §10-2: смена демо-часов доходит до всех вошедших
  it('clock.changed: все 11', () => {
    expect(recipients({ type: 'clock.changed' })).toEqual(LOGINS);
  });

  // RULES §7-2: зритель, которого нет в структуре (удалён), ничего не получает
  it('неизвестный зритель не получает ни одного события', () => {
    const event: DomainEvent = {
      type: 'vacation.approved',
      employeeId: id('james'),
      vacationId: 1,
    };
    expect(deliver(event, 999, org)).toBe(false);
    expect(deliver({ type: 'clock.changed' }, 999, org)).toBe(false);
  });
});
