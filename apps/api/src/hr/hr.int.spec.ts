/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- тела ответов supertest и строки pg имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { EventBus } from '../events/event-bus';
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
  insertUser,
  insertVacation,
  seedRulesOrg,
  truncateAll,
} from '../testing/test-db';

// Среда 2026-10-21, 09:00 по Бишкеку. Остаток employee1 (выход 2022-03-15) сегодня 37,5.
// Отпуск по умолчанию пн 2026-11-09 – пт 2026-11-13, 5 рабочих дней; списание 2026-10-05.
// Выход 2026-09-10: единственное начисление 1 октября, 21 день -> 2,0 (RULES §2-3).
const NOW = '2026-10-21T03:00:00.000Z';

type Body = Record<string, unknown>;

describe('экран HR: GET /hr/balances и PATCH /employees/{id}/hire-date (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<RulesOrgKey, number>;
  let tokens: Partial<Record<string, string>>;

  const token = async (login: string) =>
    (tokens[login] ??= await loginAs(app, login));
  // токен берётся до создания запроса: вход закрывает временный сервер supertest
  const get = async (login: string, path: string) => {
    const auth = bearer(await token(login));
    return request(app.getHttpServer()).get(path).set(auth);
  };
  const patch = async (
    login: string,
    id: number | string,
    body: Body | string,
  ) => {
    const auth = bearer(await token(login));
    return request(app.getHttpServer())
      .patch(`/employees/${id}/hire-date`)
      .set(auth)
      .send(typeof body === 'string' ? { hireDate: body } : body);
  };
  const login = (who: string) =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ login: who, password: 'pass-1234' });
  const balance = async (who: RulesOrgKey) =>
    (await get(who, '/me/balance')).body.balance;

  /** Одобренный отпуск со списанием всех рабочих дней, как при согласовании. */
  const approved = async (who: RulesOrgKey) => {
    const id = await insertVacation(pool, {
      employeeId: ids[who],
      backstopperId: ids.employee2,
      start: '2026-11-09',
      end: '2026-11-13',
      status: 'APPROVED',
    });
    const debitId = await insertLedger(pool, {
      kind: 'DEBIT',
      vacationId: id,
      halfDays: 10,
    });
    return { id, debitId };
  };
  const snapshot = async () => ({
    ledger: (
      await pool.query(
        `SELECT id, kind, "vacationId", "refundOfId", "halfDays", "occurredAt"
         FROM "LedgerEntry" ORDER BY id`,
      )
    ).rows,
    vacations: (
      await pool.query(
        `SELECT id, status, "startDate", "endDate", "workDays", "cancelledAt", "decidedAt"
         FROM "Vacation" ORDER BY id`,
      )
    ).rows,
    outbox: (await pool.query(`SELECT id FROM "OutboxMessage" ORDER BY id`))
      .rows,
  });
  const accessGranted = async (id: number) =>
    (await pool.query(`SELECT "accessGranted" FROM "User" WHERE id = $1`, [id]))
      .rows[0].accessGranted;

  beforeAll(async () => {
    pool = createPool();
    app = await createTestApp({ DEMO_MODE: 'true' });
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await setDbClock(pool, NOW);
    ids = await seedRulesOrg(pool, await passwordHash());
    tokens = {};
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('GET /hr/balances', () => {
    // RULES §7-2: HR видит остатки всех сотрудников, в том числе свой и директора
    it('HR получает всех сотрудников с командой, руководителем и датой выхода', async () => {
      const res = await get('hr', '/hr/balances');
      expect(res.status).toBe(200);
      const expectedOrder = (
        await pool.query(`SELECT id FROM "User" ORDER BY "fullName", id`)
      ).rows.map((r) => r.id);
      expect(res.body.map((r: Body) => r.employeeId)).toEqual(expectedOrder);
      expect(res.body).toHaveLength(11);

      const byId = new Map(res.body.map((r: Body) => [r.employeeId, r]));
      expect(byId.get(ids.employee1)).toEqual({
        employeeId: ids.employee1,
        fullName: 'Сотрудник employee1',
        teamName: 'Фронт-отдел',
        manager: { id: ids.manager1, fullName: 'Сотрудник manager1' },
        hireDate: '2022-03-15',
        balance: 37.5,
      });
      expect(byId.get(ids.director)).toMatchObject({
        manager: null,
        teamName: null,
      });
      expect(byId.has(ids.hr)).toBe(true);
    });

    // RULES §3-10, §6-6: тот же расчёт, что /me/balance
    it('остаток совпадает с /me/balance сотрудника', async () => {
      await approved('employee1');
      const res = await get('hr', '/hr/balances');
      const row = res.body.find((r: Body) => r.employeeId === ids.employee1);
      expect(row.balance).toBe(32.5);
      expect(row.balance).toBe(await balance('employee1'));
    });

    // RULES §2-6, §3-6: до первого начисления остатка нет
    it('сотрудник до первого начисления - 0', async () => {
      const res = await get('hr', '/hr/balances');
      const row = res.body.find((r: Body) => r.employeeId === ids.employee3);
      expect(row.balance).toBe(0);
    });

    // RULES §7-2: остатки всех видит только HR
    it.each(['director', 'manager1', 'employee1'])(
      '%s - 403 FORBIDDEN',
      async (who) => {
        const res = await get(who, '/hr/balances');
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('FORBIDDEN');
      },
    );

    // RULES §7-2: лишний параметр query - 400 (architecture §7)
    it('лишний параметр query - 400 VALIDATION_FAILED', async () => {
      const res = await get('hr', `/hr/balances?employeeId=${ids.employee1}`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('PATCH /employees/{id}/hire-date: пересчёт', () => {
    // RULES §6-1, §6-4: сдвиг позже - остаток может стать отрицательным
    it('позже: 2022-03-15 -> 2026-09-10 при одобренном отпуске - остаток −3', async () => {
      await approved('employee1');
      const res = await patch('hr', ids.employee1, '2026-09-10');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        employeeId: ids.employee1,
        fullName: 'Сотрудник employee1',
        teamName: 'Фронт-отдел',
        manager: { id: ids.manager1, fullName: 'Сотрудник manager1' },
        hireDate: '2026-09-10',
        balance: -3,
      });
      expect(await balance('employee1')).toBe(-3);
      const list = await get('hr', '/hr/balances');
      expect(
        list.body.find((r: Body) => r.employeeId === ids.employee1).balance,
      ).toBe(-3);
    });

    // RULES §6-1, §3-6: сдвиг раньше даёт первое начисление, подача становится возможной
    it('раньше: employee3 2026-10-12 -> 2026-09-01 - остаток 2,5, подача проходит', async () => {
      const submit = async () => {
        const auth = bearer(await token('employee3'));
        return request(app.getHttpServer()).post('/vacations').set(auth).send({
          startDate: '2026-11-02',
          endDate: '2026-11-02',
          backstopperId: ids.employee1,
        });
      };
      const before = await submit();
      expect(before.status).toBe(422);
      expect(before.body.code).toBe('NO_ACCRUAL_YET');

      const res = await patch('hr', ids.employee3, '2026-09-01');
      expect(res.status).toBe(200);
      expect(res.body.balance).toBe(2.5);
      expect((await submit()).status).toBe(201);
    });

    // RULES §6-1: в любую сторону, в том числе в будущее
    it('в будущее: 2027-01-01 при одобренном отпуске - остаток −5', async () => {
      await approved('employee1');
      const res = await patch('hr', ids.employee1, '2027-01-01');
      expect(res.status).toBe(200);
      expect(res.body.hireDate).toBe('2027-01-01');
      expect(res.body.balance).toBe(-5);
    });

    // RULES §6-1: HR меняет дату и себе (DECISIONS 2026-10-28 19:19)
    it('HR меняет свою дату выхода', async () => {
      const res = await patch('hr', ids.hr, '2018-03-01');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        employeeId: ids.hr,
        hireDate: '2018-03-01',
      });
    });

    // RULES §7-2: профиль показывает дату, которую сменил HR
    it('профиль сотрудника показывает новую дату', async () => {
      await patch('hr', ids.employee1, '2026-09-10');
      const me = await get('employee1', '/me');
      expect(me.body.hireDate).toBe('2026-09-10');
    });
  });

  describe('PATCH: что не меняется', () => {
    // RULES §6-6: списания и возвраты остаются на своих датах, заявки не меняются
    it('журнал и заявки те же; пересчитываются только начисления', async () => {
      await approved('employee1');
      const b = await insertVacation(pool, {
        employeeId: ids.employee1,
        backstopperId: ids.employee2,
        start: '2026-11-23',
        end: '2026-11-27',
        status: 'CANCELLED',
      });
      const debitB = await insertLedger(pool, {
        kind: 'DEBIT',
        vacationId: b,
        halfDays: 10,
        occurredAt: '2026-10-06T03:00:00Z',
      });
      await insertLedger(pool, {
        kind: 'REFUND',
        vacationId: b,
        refundOfId: debitB,
        halfDays: 10,
        occurredAt: '2026-10-07T03:00:00Z',
      });
      await insertVacation(pool, {
        employeeId: ids.employee1,
        backstopperId: ids.employee2,
        start: '2026-12-07',
        end: '2026-12-11',
        status: 'PENDING',
      });
      const before = await snapshot();
      expect(before.ledger).toHaveLength(3);

      const res = await patch('hr', ids.employee1, '2026-09-10');
      expect(res.status).toBe(200);
      expect(await snapshot()).toEqual(before);
      // начисление 2,0 - списание A 5; списание и возврат B взаимно гасятся
      expect(res.body.balance).toBe(-3);
    });

    // RULES §6-3, §8-1: писем нет, автоматических отмен нет, отпуск остаётся в календаре
    it('писем нет; одобренный отпуск раньше новой даты остаётся «Одобрена» и в календаре', async () => {
      const { id } = await approved('employee1');
      const res = await patch('hr', ids.employee1, '2026-12-01');
      expect(res.status).toBe(200);
      expect(
        (await pool.query(`SELECT count(*)::int AS n FROM "OutboxMessage"`))
          .rows[0].n,
      ).toBe(0);
      const v = await get('employee1', `/vacations/${id}`);
      expect(v.body.status).toBe('APPROVED');
      const cal = await get('hr', '/calendar?from=2026-11-01&to=2026-11-30');
      expect(cal.body.entries.map((e: Body) => e.vacationId)).toContain(id);
    });

    // RULES §10-2: событие одно, после коммита; та же дата - без события
    it('событие employee.hire-date-changed одно; при той же дате события нет', async () => {
      const publish = jest.spyOn(app.get(EventBus), 'publish');
      try {
        expect((await patch('hr', ids.employee1, '2026-09-10')).status).toBe(
          200,
        );
        expect(publish).toHaveBeenCalledTimes(1);
        expect(publish).toHaveBeenCalledWith({
          type: 'employee.hire-date-changed',
          employeeId: ids.employee1,
        });

        publish.mockClear();
        const same = await patch('hr', ids.employee1, '2026-09-10');
        expect(same.status).toBe(200);
        expect(same.body.hireDate).toBe('2026-09-10');
        expect(publish).not.toHaveBeenCalled();
      } finally {
        publish.mockRestore();
      }
    });
  });

  describe('PATCH: доступ не отзывается', () => {
    // RULES §6-5, §6-7: вошедший работает со старым токеном и входит снова
    it('сдвиг в будущее: старый токен работает, вход снова проходит, признак остаётся', async () => {
      await token('employee1');
      expect((await patch('hr', ids.employee1, '2027-01-01')).status).toBe(200);
      expect((await get('employee1', '/me')).status).toBe(200);
      expect((await login('employee1')).status).toBe(200);
      expect(await accessGranted(ids.employee1)).toBe(true);
    });

    // RULES §6-7: признак, поставленный первым входом, сдвиг даты выхода вперёд не снимает
    it('первый вход, затем сдвиг в будущее: вход снова проходит', async () => {
      const first = await insertUser(pool, {
        login: 'first',
        managerId: ids.manager1,
        hireDate: '2026-10-01',
        passwordHash: await passwordHash(),
        accessGranted: false,
      });
      expect((await login('first')).status).toBe(200);
      expect((await patch('hr', first, '2027-01-01')).status).toBe(200);
      expect((await login('first')).status).toBe(200);
      expect(await accessGranted(first)).toBe(true);
    });

    // RULES §6-7, §2-6: без признака вход до даты выхода закрыт
    it('не входивший: дата в будущем - вход 403, в прошлом - 200', async () => {
      const fresh = await insertUser(pool, {
        login: 'fresh',
        managerId: ids.manager1,
        hireDate: '2026-10-01',
        passwordHash: await passwordHash(),
        accessGranted: false,
      });
      expect((await patch('hr', fresh, '2026-11-02')).status).toBe(200);
      const denied = await login('fresh');
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('AUTH_NOT_HIRED_YET');
      expect(await accessGranted(fresh)).toBe(false);

      expect((await patch('hr', fresh, '2026-10-01')).status).toBe(200);
      expect((await login('fresh')).status).toBe(200);
    });
  });

  describe('PATCH: после сдвига', () => {
    // RULES §3-12: новая заявка проверяется по новой дате выхода
    it('подача с началом раньше новой даты - 422 VACATION_BEFORE_HIRE', async () => {
      await patch('hr', ids.employee1, '2026-09-10');
      const auth = bearer(await token('employee1'));
      const res = await request(app.getHttpServer())
        .post('/vacations')
        .set(auth)
        .send({
          startDate: '2026-09-07',
          endDate: '2026-09-07',
          backstopperId: ids.employee2,
          comment: 'задним числом',
        });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VACATION_BEFORE_HIRE');
    });

    // RULES §4-3, §6-1: согласование повторно проверяет остаток по новой дате
    it('согласование после сдвига - 422 APPROVE_INSUFFICIENT_BALANCE, доступно 4,5', async () => {
      const id = await insertVacation(pool, {
        employeeId: ids.employee1,
        backstopperId: ids.employee2,
        start: '2026-11-09',
        end: '2026-11-13',
      });
      await patch('hr', ids.employee1, '2026-09-10');
      const auth = bearer(await token('manager1'));
      const res = await request(app.getHttpServer())
        .post(`/vacations/${id}/approve`)
        .set(auth);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('APPROVE_INSUFFICIENT_BALANCE');
      // 2,0 (1 октября) + 2,5 (1 ноября)
      expect(res.body.details).toEqual({ available: 4.5, requested: 5 });
    });
  });

  describe('PATCH: права и тело', () => {
    // RULES §6-1, §7-2: сотрудник виден, но менять дату может только HR
    it.each([
      ['manager1', 'employee1'],
      ['employee1', 'employee1'],
    ] as const)('%s над %s - 403 FORBIDDEN', async (who, target) => {
      const res = await patch(who, ids[target], '2026-09-10');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    // RULES §7-2: невидимый, несуществующий и некорректный id - 404
    it.each([
      ['employee1', 'employee4'],
      ['manager1', 'employee4'],
    ] as const)('%s над невидимым %s - 404', async (who, target) => {
      const res = await patch(who, ids[target], '2026-09-10');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    // RULES §7-2
    it.each(['999999', 'abc', '0', '-1'])(
      'HR, id "%s" - 404 NOT_FOUND',
      async (id) => {
        const res = await patch('hr', id, '2026-09-10');
        expect(res.status).toBe(404);
        expect(res.body.code).toBe('NOT_FOUND');
      },
    );

    // RULES §6-1: тело только {hireDate}, дата YYYY-MM-DD, год 2000-2100 (architecture §7)
    it.each([
      ['нет поля', {}],
      ['не строка', { hireDate: 20260910 }],
      ['несуществующая дата', { hireDate: '2026-02-30' }],
      ['неверный формат', { hireDate: '10.09.2026' }],
      ['год раньше 2000', { hireDate: '1999-12-31' }],
      ['год позже 2100', { hireDate: '2101-01-01' }],
    ])('%s - 400 VALIDATION_FAILED', async (_name, body) => {
      const res = await patch('hr', ids.employee1, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.details.fields.hireDate).toBeDefined();
    });

    // RULES §6-1: лишнее поле отклоняется
    it('лишнее поле - 400 VALIDATION_FAILED', async () => {
      const res = await patch('hr', ids.employee1, {
        hireDate: '2026-09-10',
        balance: 100,
      });
      expect(res.status).toBe(400);
      expect(res.body.details.fields.balance).toBeDefined();
    });

    // RULES §7-2: тело проверяется раньше прав (architecture §8)
    it('не HR с неверным телом - 400, а не 403', async () => {
      const res = await patch('employee1', ids.employee1, {});
      expect(res.status).toBe(400);
    });

    // RULES §6-1: границы годов API допустимы (architecture §7)
    it.each(['2000-01-01', '2100-12-31'])(
      'дата %s принимается',
      async (date) => {
        const res = await patch('hr', ids.employee1, date);
        expect(res.status).toBe(200);
        expect(res.body.hireDate).toBe(date);
      },
    );
  });

  describe('PATCH: блокировка', () => {
    // RULES §10-1: смена даты встаёт в очередь за другой операцией над сотрудником (architecture §6)
    it('ждёт блокировку User, взятую другой транзакцией', async () => {
      await token('hr');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `SELECT id FROM "User" WHERE id = $1 FOR NO KEY UPDATE`,
          [ids.employee1],
        );
        let done = false;
        const pending = patch('hr', ids.employee1, '2026-09-10').then((r) => {
          done = true;
          return r;
        });
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(done).toBe(false);
        await client.query('COMMIT');
        const res = await pending;
        expect(res.status).toBe(200);
        expect(res.body.hireDate).toBe('2026-09-10');
      } finally {
        client.release();
      }
    });
  });
});
