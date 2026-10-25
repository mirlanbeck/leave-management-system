/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- тела ответов supertest имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { bearer, loginAs, passwordHash } from '../testing/int-helpers';
import { createTestApp } from '../testing/test-app';
import {
  RulesOrgKey,
  createPool,
  seedRulesOrg,
  truncateAll,
} from '../testing/test-db';

describe('GET /employees (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<RulesOrgKey, number>;

  const list = async (login: RulesOrgKey) => {
    const token = await loginAs(app, login);
    return request(app.getHttpServer()).get('/employees').set(bearer(token));
  };

  beforeAll(async () => {
    pool = createPool();
    app = await createTestApp({});
  });

  beforeEach(async () => {
    await truncateAll(pool);
    ids = await seedRulesOrg(pool, await passwordHash());
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // RULES §3-3, §7-1
  it('без токена 401', async () => {
    const res = await request(app.getHttpServer()).get('/employees');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  // RULES §3-3: «id + имя» и ничего больше (§7-2: даты выхода, команды, руководители не раскрываются)
  it('в ответе только id и fullName', async () => {
    const res = await list('employee1');
    expect(res.status).toBe(200);
    for (const row of res.body) {
      expect(Object.keys(row).sort()).toEqual(['fullName', 'id']);
    }
  });

  // RULES §3-3: любой сотрудник компании, кроме заявителя; руководитель и HR тоже
  it('все, кроме вошедшего; директор, руководитель и HR входят', async () => {
    const res = await list('employee1');
    const got = (res.body as { id: number }[])
      .map((r) => r.id)
      .sort((a, b) => a - b);
    const expected = Object.entries(ids)
      .filter(([key]) => key !== 'employee1')
      .map(([, id]) => id)
      .sort((a, b) => a - b);
    expect(got).toEqual(expected);
    expect(got).toEqual(
      expect.arrayContaining([ids.director, ids.manager1, ids.hr]),
    );
  });

  // RULES §3-3: справочник доступен любой роли
  it.each(['director', 'hr', 'manager2', 'employee6'] as const)(
    'роль %s получает 10 записей',
    async (login) => {
      const res = await list(login);
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(10);
    },
  );

  // RULES §3-3: стабильный порядок для выпадающего списка
  it('отсортирован по имени', async () => {
    const res = await list('employee1');
    const names = (res.body as { fullName: string }[]).map((r) => r.fullName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
