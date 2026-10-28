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
  insertLedger,
  insertVacation,
  seedRulesOrg,
  truncateAll,
} from '../testing/test-db';

// 2026-10-21 09:00 по Бишкеку (UTC+6)
const OCT_21 = '2026-10-21T03:00:00Z';

describe('GET /me/balance (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<RulesOrgKey, number>;

  const balance = async (login: RulesOrgKey, query = '') => {
    const token = await loginAs(app, login);
    return request(app.getHttpServer())
      .get(`/me/balance${query}`)
      .set(bearer(token));
  };

  beforeAll(async () => {
    pool = createPool();
    app = await createTestApp({ DEMO_MODE: 'true' });
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await setDbClock(pool, OCT_21);
    ids = await seedRulesOrg(pool, await passwordHash());
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // RULES §7-1
  it('без токена 401', async () => {
    const res = await request(app.getHttpServer()).get('/me/balance');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  // RULES §3-10, §7-2: «баланс сегодня» без on; on и availableOn пусты
  it('без on: остаток на сегодня, «сегодня» с сервера по Clock и поясу компании', async () => {
    const res = await balance('employee1');
    expect(res.status).toBe(200);
    // выход 2022-03-15: первое начисление 1,5, затем по 2,5; на 1 января 2026 обрезка до 15,
    // с февраля по октябрь 2026 девять начислений: 15 + 22,5 = 37,5 (RULES §2)
    expect(res.body).toEqual({
      employeeId: ids.employee1,
      today: '2026-10-21',
      balance: 37.5,
      on: null,
      availableOn: null,
    });
  });

  // RULES §3-10: события строго после сегодня и до D включительно
  it('on в будущем: добавляются начисления 1-го числа', async () => {
    const res = await balance('employee1', '?on=2026-12-31');
    expect(res.body.balance).toBe(37.5);
    expect(res.body.on).toBe('2026-12-31');
    expect(res.body.availableOn).toBe(42.5); // 1 ноября и 1 декабря
  });

  // RULES §3-10, §2-5: на 1 января сначала начисление, потом обрезка до 15
  it('on = 1 января: начисление, затем обрезка до 15', async () => {
    const res = await balance('employee1', '?on=2027-01-01');
    expect(res.body.availableOn).toBe(15);
  });

  // RULES §3-10: события сегодняшнего дня уже в балансе и повторно не считаются
  it.each(['2026-10-21', '2026-10-01', '2026-01-01', '2020-05-05'])(
    'on = %s (сегодня или в прошлом): берётся баланс сегодня',
    async (on) => {
      const res = await balance('employee1', `?on=${on}`);
      expect(res.body.availableOn).toBe(37.5);
    },
  );

  // RULES §3-10: граница суток по поясу компании (2026-12-31T18:00Z — это 1 января в Бишкеке)
  it('«сегодня» определяется по COMPANY_TZ', async () => {
    await setDbClock(pool, '2026-12-31T17:59:00Z');
    const before = await balance('employee1');
    expect(before.body.today).toBe('2026-12-31');
    expect(before.body.balance).toBe(42.5);

    await setDbClock(pool, '2026-12-31T18:00:00Z');
    const after = await balance('employee1');
    expect(after.body.today).toBe('2027-01-01');
    expect(after.body.balance).toBe(15); // начисление и обрезка 1 января уже в балансе
  });

  // RULES §6-6: все списания и возвраты журнала, независимо от даты
  it('списания уменьшают, возвраты увеличивают остаток; чужой журнал не влияет', async () => {
    const own = await insertVacation(pool, {
      employeeId: ids.employee1,
      backstopperId: ids.employee2,
      start: '2026-12-07',
      end: '2026-12-11',
      status: 'APPROVED',
    });
    const debit = await insertLedger(pool, {
      kind: 'DEBIT',
      vacationId: own,
      halfDays: 10,
    });
    await insertLedger(pool, {
      kind: 'REFUND',
      vacationId: own,
      refundOfId: debit,
      halfDays: 4,
    });
    const foreign = await insertVacation(pool, {
      employeeId: ids.employee2,
      backstopperId: ids.employee1,
      start: '2026-11-02',
      end: '2026-11-06',
      status: 'APPROVED',
    });
    await insertLedger(pool, {
      kind: 'DEBIT',
      vacationId: foreign,
      halfDays: 10,
    });
    const res = await balance('employee1');
    expect(res.body.balance).toBe(37.5 - 5 + 2);
  });

  // RULES §6-4: минус на экране только после сдвига даты выхода
  it('после сдвига даты выхода остаток может быть отрицательным', async () => {
    const vacation = await insertVacation(pool, {
      employeeId: ids.employee1,
      backstopperId: ids.employee2,
      start: '2026-10-26',
      end: '2026-10-30',
      status: 'APPROVED',
    });
    await insertLedger(pool, {
      kind: 'DEBIT',
      vacationId: vacation,
      halfDays: 10,
    });
    // HR сдвигает выход на 2026-09-10: единственное начисление 1 октября, 21 день -> 2,0
    const hr = await loginAs(app, 'hr');
    const patched = await request(app.getHttpServer())
      .patch(`/employees/${ids.employee1}/hire-date`)
      .set(bearer(hr))
      .send({ hireDate: '2026-09-10' });
    expect(patched.status).toBe(200);
    const res = await balance('employee1');
    expect(res.body.balance).toBe(-3);
  });

  // RULES §3-6, §2-3: Сотрудник 3 (выход 12 октября) до 1 ноября дней не имеет
  it('сотрудник до первого начисления: 0, на 1 ноября 1,5', async () => {
    const res = await balance('employee3', '?on=2026-11-01');
    expect(res.body.balance).toBe(0);
    expect(res.body.availableOn).toBe(1.5);
  });

  // RULES §1-4: граница дат API (DECISIONS [S4], остаток F-4)
  it.each([
    '2026-5-1',
    '2026-02-30',
    'вчера',
    '',
    '1999-12-31',
    '2101-01-01',
    '9999-12-01',
  ])('on = "%s" -> 400 VALIDATION_FAILED', async (on) => {
    const res = await balance('employee1', `?on=${encodeURIComponent(on)}`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(Object.keys(res.body.details.fields)).toEqual(['on']);
  });

  // RULES §2-7: шаг 0,5 дня
  it('все числа кратны 0,5', async () => {
    for (const on of ['2026-11-15', '2027-03-15', '2028-08-08']) {
      const res = await balance('employee2', `?on=${on}`);
      expect((res.body.availableOn * 2) % 1).toBe(0);
      expect((res.body.balance * 2) % 1).toBe(0);
    }
  });
});
