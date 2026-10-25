/* eslint-disable @typescript-eslint/no-unsafe-argument -- тела ответов supertest имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { PrismaAuthUsers } from './auth/prisma-auth-users';
import { verifyPassword } from './auth/password';
import { FakeClock } from './clock/clock';
import { OrgService } from './org/org.service';
import { canSee, scope } from './org/policy';
import { PrismaService } from './prisma/prisma.service';
import { runSeed, seedClock } from './seed';
import { DEMO_PASSWORD, SEED_USERS } from './seed-data';
import { setDbClock } from './testing/int-helpers';
import { createTestApp } from './testing/test-app';
import {
  DATABASE_URL,
  createPool,
  insertUser,
  pgFailure,
  truncateAll,
} from './testing/test-db';

// 2026-10-25 09:00 в Бишкеке (UTC+6)
const AFTER_LIAM = '2026-10-25T03:00:00Z';
// 2026-10-11 09:00 в Бишкеке: за день до выхода Сотрудника 3
const BEFORE_LIAM = '2026-10-11T03:00:00Z';

interface Row {
  id: number;
  login: string;
  hireDate: string;
  passwordHash: string;
  accessGranted: boolean;
  teamName: string | null;
  isHr: boolean;
  managerId: number | null;
}

describe('seed 11 демо-пользователей (integration, нужен Postgres)', () => {
  let pool: Pool;
  let prisma: PrismaService;

  const seedAt = (instant: string) => runSeed(prisma, new FakeClock(instant));
  const failureOf = (op: Promise<unknown>) =>
    op.then(
      () => null,
      (e: Error) => e,
    );
  const rows = async (): Promise<Row[]> =>
    (
      await pool.query<Row>(
        `SELECT id, login, to_char("hireDate", 'YYYY-MM-DD') AS "hireDate", "passwordHash",
                "accessGranted", "teamName", "isHr", "managerId"
         FROM "User" ORDER BY id`,
      )
    ).rows;

  beforeAll(() => {
    pool = createPool();
    prisma = new PrismaService(DATABASE_URL);
  });

  beforeEach(() => truncateAll(pool));

  afterAll(async () => {
    await prisma.$disconnect();
    await pool.end();
  });

  // RULES §7-5, §7-6
  it('создаёт 11 пользователей с иерархией и командами', async () => {
    await seedAt(AFTER_LIAM);
    const all = await rows();
    expect(all).toHaveLength(11);
    const byLogin = new Map(all.map((r) => [r.login, r]));
    for (const s of SEED_USERS) {
      const r = byLogin.get(s.login)!;
      expect(r.hireDate).toBe(s.hireDate);
      expect(r.teamName).toBe(s.teamName);
      expect(r.isHr).toBe(s.isHr);
      expect(r.managerId).toBe(
        s.managerLogin ? byLogin.get(s.managerLogin)!.id : null,
      );
    }
  });

  // RULES §4-2, §7-1
  it('ровно один без начальника и ровно один HR', async () => {
    await seedAt(AFTER_LIAM);
    const all = await rows();
    expect(all.filter((r) => r.managerId === null)).toHaveLength(1);
    expect(all.filter((r) => r.isHr)).toHaveLength(1);
  });

  // RULES §4-2: чужой корень в БД; seed падает (ошибка БД) и ничего не создаёт
  it('посторонний директор в БД: seed падает и ничего не создаёт', async () => {
    await insertUser(pool, { managerId: null, login: 'boss', isHr: true });
    const failure = await failureOf(seedAt(AFTER_LIAM));
    expect(failure?.message).toMatch(/margaret не создан/);
    // откат транзакции: из seed в БД ничего не осталось
    expect((await rows()).map((r) => r.login)).toEqual(['boss']);
  });

  // RULES §7-1
  it('два HR после seed: повторный seed падает', async () => {
    await seedAt(AFTER_LIAM);
    await pool.query(`UPDATE "User" SET "isHr" = true WHERE login = 'james'`);
    const failure = await failureOf(seedAt(AFTER_LIAM));
    expect(failure?.message).toMatch(/ровно один HR/);
  });

  // RULES §4-2: второй корень БД не допускает (защита S1)
  it('второго директора БД не допускает', async () => {
    await seedAt(AFTER_LIAM);
    const f = await pgFailure(
      insertUser(pool, { managerId: null, login: 'second' }),
    );
    expect(f.constraint).toBe('User_single_root_idx');
  });

  // RULES §6-7
  it('доступ получен у всех при сегодня ≥ 2026-10-12', async () => {
    await seedAt(AFTER_LIAM);
    expect((await rows()).every((r) => r.accessGranted)).toBe(true);
  });

  // RULES §6-7
  it('доступ получен у всех, кроме liam, при сегодня 2026-10-11', async () => {
    await seedAt(BEFORE_LIAM);
    for (const r of await rows()) {
      expect(r.accessGranted).toBe(r.login !== 'liam');
    }
  });

  // RULES §1-3, §6-7: «сегодня» по поясу компании, а не по UTC
  it('граница суток по COMPANY_TZ: 2026-10-11T19:00Z уже 2026-10-12 в Бишкеке', async () => {
    await seedAt('2026-10-11T19:00:00Z');
    const liam = (await rows()).find((r) => r.login === 'liam')!;
    expect(liam.accessGranted).toBe(true);
  });

  // RULES §9-2: часы seed из БД только в демо-режиме
  it('seedClock: с DEMO_MODE часы из БД, без флага системные', async () => {
    await setDbClock(pool, BEFORE_LIAM);
    const demo = await seedClock(prisma, { DEMO_MODE: 'true' }).now();
    expect(demo.toISOString()).toBe('2026-10-11T03:00:00.000Z');
    const system = await seedClock(prisma, {}).now();
    expect(system.getTime()).toBeGreaterThan(
      Date.parse('2026-10-25T00:00:00Z'),
    );
  });

  // RULES §9-2: в демо-режиме seed создаёт ClockState при первом обращении
  it('в демо-режиме без строки часов seed создаёт её', async () => {
    const env = { DEMO_MODE: 'true' };
    await runSeed(prisma, seedClock(prisma, env), env);
    const { rows: c } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "ClockState"`,
    );
    expect(c[0].n).toBe(1);
  });

  // RULES §6-7: повторный seed ничего не плодит и не затирает
  it('повторный seed: те же строки, hireDate и пароль не затираются', async () => {
    await seedAt(AFTER_LIAM);
    await pool.query(
      `UPDATE "User" SET "hireDate" = '2027-01-11', "passwordHash" = 'custom' WHERE login = 'james'`,
    );
    const before = await rows();
    await seedAt(AFTER_LIAM);
    expect(await rows()).toEqual(before);
  });

  // RULES §6-7: признак не снимается, в том числе при откате часов
  it('откат часов назад не снимает доступ, а дату выхода seed не меняет', async () => {
    await seedAt(AFTER_LIAM);
    await seedAt(BEFORE_LIAM);
    const liam = (await rows()).find((r) => r.login === 'liam')!;
    expect(liam.accessGranted).toBe(true);
    expect(liam.hireDate).toBe('2026-10-12');
  });

  // RULES §6-7: seed может только поднять признак
  it('повторный seed поднимает признак у существующего, чья дата выхода наступила', async () => {
    await seedAt(BEFORE_LIAM);
    await seedAt(AFTER_LIAM);
    const liam = (await rows()).find((r) => r.login === 'liam')!;
    expect(liam.accessGranted).toBe(true);
  });

  // RULES §7-1
  it('пароли хранятся хешем и подходят', async () => {
    await seedAt(AFTER_LIAM);
    for (const r of await rows()) {
      expect(r.passwordHash).not.toBe(DEMO_PASSWORD);
      expect(await verifyPassword(DEMO_PASSWORD, r.passwordHash)).toBe(true);
    }
  });

  // RULES §7-2, §7-3
  it('видимость на реальной структуре seed', async () => {
    await seedAt(AFTER_LIAM);
    const all = await rows();
    const id = (l: string) => all.find((r) => r.login === l)!.id;
    const org = new OrgService(prisma);
    const users = new PrismaAuthUsers(prisma);
    const seen = async (login: string) => {
      const viewer = (await users.findById(id(login)))!;
      const s = await org.visibleTo(viewer);
      return s === 'ALL' ? s : [...s].sort((a, b) => a - b);
    };
    const ids = (...l: string[]) => l.map(id).sort((a, b) => a - b);

    expect(await seen('james')).toEqual(ids('james'));
    expect(await seen('daniel')).toEqual(
      ids('daniel', 'james', 'sophie', 'liam'),
    );
    expect(await seen('olivia')).toEqual(
      ids('olivia', 'grace', 'henry', 'chloe'),
    );
    expect(await seen('thomas')).toEqual(
      ids('thomas', 'daniel', 'olivia', 'emily'),
    );
    expect(await seen('margaret')).toEqual(ids('margaret', 'thomas'));
    expect(await seen('emily')).toBe('ALL');

    // руководитель не видит вложенных (сотрудников чужой команды)
    const daniel = { id: id('daniel'), isHr: false, managerId: id('thomas') };
    const reports = ids('james', 'sophie', 'liam');
    expect(canSee(daniel, reports, id('james'))).toBe(true);
    expect(canSee(daniel, reports, id('grace'))).toBe(false);
    expect(scope(daniel, reports)).not.toBe('ALL');
  });
});

describe('вход seed-пользователей (integration, нужен Postgres)', () => {
  let pool: Pool;
  let prisma: PrismaService;
  let app: INestApplication;

  const login = (l: string, password = DEMO_PASSWORD) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ login: l, password });

  beforeAll(async () => {
    pool = createPool();
    prisma = new PrismaService(DATABASE_URL);
    app = await createTestApp({ DEMO_MODE: 'true' });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
    await pool.end();
  });

  beforeEach(() => truncateAll(pool));

  // RULES §7-1, §6-7
  it('при сегодня после 2026-10-12 входят все 11', async () => {
    await setDbClock(pool, AFTER_LIAM);
    await runSeed(prisma, new FakeClock(AFTER_LIAM));
    for (const s of SEED_USERS) {
      expect((await login(s.login)).status).toBe(200);
    }
  });

  // RULES §6-7
  it('при сегодня 2026-10-11 liam не входит, остальные входят', async () => {
    await setDbClock(pool, BEFORE_LIAM);
    await runSeed(prisma, new FakeClock(BEFORE_LIAM));
    for (const s of SEED_USERS) {
      const res = await login(s.login);
      expect(res.status).toBe(s.login === 'liam' ? 403 : 200);
    }
  });

  // RULES §7-1
  it('неверный пароль не пускает', async () => {
    await setDbClock(pool, AFTER_LIAM);
    await runSeed(prisma, new FakeClock(AFTER_LIAM));
    expect((await login('james', 'wrong')).status).toBe(401);
  });
});
