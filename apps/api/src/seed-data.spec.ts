import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BACK_TEAM,
  DEMO_PASSWORD,
  FRONT_TEAM,
  SEED_USERS,
  assertOrgInvariants,
  shouldGrantAccess,
} from './seed-data';

describe('данные seed (RULES §7)', () => {
  const byLogin = new Map(SEED_USERS.map((x) => [x.login, x]));
  const leaders = ['margaret', 'thomas', 'emily', 'daniel', 'olivia'];
  const front = ['james', 'sophie', 'liam'];
  const back = ['grace', 'henry', 'chloe'];

  // RULES §7-5
  it('11 пользователей с уникальными логинами', () => {
    expect(SEED_USERS).toHaveLength(11);
    expect(byLogin.size).toBe(11);
  });

  // RULES §4-2, §7-1
  it('ровно один без начальника и ровно один HR', () => {
    expect(SEED_USERS.filter((x) => x.managerLogin === null)).toHaveLength(1);
    expect(SEED_USERS.filter((x) => x.isHr)).toHaveLength(1);
  });

  // RULES §7-5: иерархия
  it('руководитель каждого есть в данных и стоит раньше подчинённого', () => {
    SEED_USERS.forEach((user, i) => {
      if (user.managerLogin === null) return;
      const idx = SEED_USERS.findIndex((x) => x.login === user.managerLogin);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(i);
    });
    const manager = (login: string) => byLogin.get(login)!.managerLogin;
    expect(manager('thomas')).toBe('margaret');
    expect(manager('emily')).toBe('thomas');
    expect(manager('daniel')).toBe('thomas');
    expect(manager('olivia')).toBe('thomas');
    for (const l of front) expect(manager(l)).toBe('daniel');
    for (const l of back) expect(manager(l)).toBe('olivia');
  });

  // RULES §7-5: даты выхода
  it('даты выхода сотрудников 1–6 по таблице, руководящих в 2015–2021', () => {
    const dates = Object.fromEntries(
      SEED_USERS.map((x) => [x.login, x.hireDate]),
    );
    expect(dates).toMatchObject({
      james: '2022-03-15',
      sophie: '2024-06-03',
      liam: '2026-10-12',
      grace: '2023-09-01',
      henry: '2024-01-10',
      chloe: '2025-02-10',
    });
    for (const l of leaders) {
      const year = Number(dates[l].slice(0, 4));
      expect(year).toBeGreaterThanOrEqual(2015);
      expect(year).toBeLessThanOrEqual(2021);
    }
  });

  // RULES §7-6
  it('названия команд только у сотрудников 1–6', () => {
    const team = (l: string) => byLogin.get(l)!.teamName;
    for (const l of front) expect(team(l)).toBe(FRONT_TEAM);
    for (const l of back) expect(team(l)).toBe(BACK_TEAM);
    for (const l of leaders) expect(team(l)).toBeNull();
  });

  // RULES §6-7: границы «дата выхода ≤ сегодня»
  it('доступ в seed: выход ≤ сегодня', () => {
    expect(shouldGrantAccess('2026-10-12', '2026-10-12')).toBe(true);
    expect(shouldGrantAccess('2026-10-12', '2026-10-11')).toBe(false);
    expect(shouldGrantAccess('2022-03-15', '2026-10-25')).toBe(true);
  });

  // RULES §4-2, §7-1
  it('инварианты: нарушение даёт ошибку', () => {
    expect(() =>
      assertOrgInvariants({ withoutManager: 1, hr: 1 }),
    ).not.toThrow();
    expect(() => assertOrgInvariants({ withoutManager: 0, hr: 1 })).toThrow(
      /без начальника/,
    );
    expect(() => assertOrgInvariants({ withoutManager: 2, hr: 1 })).toThrow(
      /без начальника/,
    );
    expect(() => assertOrgInvariants({ withoutManager: 1, hr: 0 })).toThrow(
      /HR/,
    );
    expect(() => assertOrgInvariants({ withoutManager: 1, hr: 2 })).toThrow(
      /HR/,
    );
  });

  // RULES §7-5: таблица README совпадает с seed
  it('таблица в README совпадает с данными seed', () => {
    const readme = readFileSync(
      join(__dirname, '..', '..', '..', 'README.md'),
      'utf8',
    );
    const rows = readme
      .split('\n')
      .filter((line) => /^\|.*`\w+`.*\|\s*`demo\d+`\s*\|/.test(line))
      .map((line) => line.split('|').map((c) => c.trim()));
    expect(rows).toHaveLength(SEED_USERS.length);
    for (const user of SEED_USERS) {
      const row = rows.find((c) => c[3] === `\`${user.login}\``);
      expect(row).toBeDefined();
      const [, , name, , password, manager, hire, team] = row!;
      expect(name).toBe(user.fullName);
      expect(password).toBe(`\`${DEMO_PASSWORD}\``);
      expect(hire).toBe(user.hireDate);
      expect(team).toBe(user.teamName ?? '—');
      const managerName = user.managerLogin
        ? byLogin.get(user.managerLogin)!.fullName.split(' ')[0]
        : '—';
      expect(manager).toBe(managerName);
    }
  });
});
