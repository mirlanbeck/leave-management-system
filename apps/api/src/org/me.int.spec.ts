/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- тела ответов supertest имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import {
  bearer,
  loginAs,
  passwordHash,
  setDbClock,
} from '../testing/int-helpers';
import { createTestApp } from '../testing/test-app';
import {
  RulesOrgKey,
  createPool,
  seedRulesOrg,
  truncateAll,
} from '../testing/test-db';

describe('GET /me (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<RulesOrgKey, number>;

  const me = async (login: RulesOrgKey) => {
    const token = await loginAs(app, login);
    return request(app.getHttpServer()).get('/me').set(bearer(token));
  };

  beforeAll(async () => {
    pool = createPool();
    app = await createTestApp({ DEMO_MODE: 'true' });
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await setDbClock(pool, '2026-10-24T03:00:00Z');
    ids = await seedRulesOrg(pool, await passwordHash());
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // RULES §7-2, §7-6
  it('сотрудник: имя, дата выхода, команда, руководитель', async () => {
    const res = await me('employee1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: ids.employee1,
      fullName: 'Сотрудник employee1',
      hireDate: '2022-03-15',
      teamName: 'Фронт-отдел',
      manager: { id: ids.manager1, fullName: 'Сотрудник manager1' },
      isHr: false,
      isManager: false,
    });
  });

  // RULES §7-2
  it('у директора руководитель пуст', async () => {
    const res = await me('director');
    expect(res.body.manager).toBeNull();
    expect(res.body.isManager).toBe(true);
  });

  // RULES §7-6
  it('у руководителя название команды пустое, без списка членов', async () => {
    const res = await me('manager1');
    expect(res.body.teamName).toBeNull();
    expect(res.body.isManager).toBe(true);
    expect(Object.keys(res.body).sort()).toEqual([
      'fullName',
      'hireDate',
      'id',
      'isHr',
      'isManager',
      'manager',
      'teamName',
    ]);
  });

  // RULES §7-2
  it('HR: isHr', async () => {
    const res = await me('hr');
    expect(res.body.isHr).toBe(true);
    expect(res.body.isManager).toBe(false);
  });

  // RULES §1-3: дата выхода — календарная дата, а не момент
  it('дата выхода без времени и сдвига пояса', async () => {
    const res = await me('employee3');
    expect(res.body.hireDate).toBe('2026-10-12');
  });
});
