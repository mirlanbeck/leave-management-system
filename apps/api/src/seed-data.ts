// Данные seed: 11 демо-пользователей (RULES §7, README «Демо-пользователи»).
// Только демо-значения для локального запуска; пароль общий и указан в README.
import { CalendarDate, compareDates } from './domain/calendar-date';

export const DEMO_PASSWORD = 'demo1234';

export interface SeedUser {
  login: string;
  fullName: string;
  hireDate: CalendarDate;
  managerLogin: string | null;
  isHr: boolean;
  teamName: string | null;
}

export const FRONT_TEAM = 'Фронт-отдел';
export const BACK_TEAM = 'Бэк-отдел';

const u = (
  login: string,
  fullName: string,
  hireDate: CalendarDate,
  managerLogin: string | null,
  extra: Partial<Pick<SeedUser, 'isHr' | 'teamName'>> = {},
): SeedUser => ({
  login,
  fullName,
  hireDate,
  managerLogin,
  isHr: extra.isHr ?? false,
  teamName: extra.teamName ?? null,
});

/** Порядок важен: руководитель всегда раньше подчинённых. */
export const SEED_USERS: readonly SeedUser[] = [
  u('margaret', 'Margaret Collins', '2015-03-02', null),
  u('thomas', 'Thomas Reed', '2016-09-12', 'margaret'),
  u('emily', 'Emily Carter', '2018-02-05', 'thomas', { isHr: true }),
  u('daniel', 'Daniel Brooks', '2019-06-17', 'thomas'),
  u('olivia', 'Olivia Turner', '2021-04-05', 'thomas'),
  u('james', 'James Walker', '2022-03-15', 'daniel', { teamName: FRONT_TEAM }),
  u('sophie', 'Sophie Bennett', '2024-06-03', 'daniel', {
    teamName: FRONT_TEAM,
  }),
  u('liam', 'Liam Foster', '2026-10-12', 'daniel', { teamName: FRONT_TEAM }),
  u('grace', 'Grace Morgan', '2023-09-01', 'olivia', { teamName: BACK_TEAM }),
  u('henry', 'Henry Price', '2024-01-10', 'olivia', { teamName: BACK_TEAM }),
  u('chloe', 'Chloe Ward', '2025-02-10', 'olivia', { teamName: BACK_TEAM }),
];

/** RULES §6-7: признак «доступ получен» в seed при дате выхода ≤ «сегодня» по Clock. */
export function shouldGrantAccess(
  hireDate: CalendarDate,
  today: CalendarDate,
): boolean {
  return compareDates(hireDate, today) <= 0;
}

/** RULES §4-2, §7-1: ровно один пользователь без начальника и ровно один HR. */
export function assertOrgInvariants(counts: {
  withoutManager: number;
  hr: number;
}): void {
  if (counts.withoutManager !== 1) {
    throw new Error(
      `seed: ожидался ровно один пользователь без начальника, найдено ${counts.withoutManager}`,
    );
  }
  if (counts.hr !== 1) {
    throw new Error(`seed: ожидался ровно один HR, найдено ${counts.hr}`);
  }
}
