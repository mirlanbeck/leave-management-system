/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call -- тела ответов supertest имеют тип any */
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

// Среда 2026-10-21, 09:17 по Бишкеку. Календарь запрашивается за ноябрь 2026.
const NOW = '2026-10-21T03:17:42.123Z';
const NOVEMBER = 'from=2026-11-01&to=2026-11-30';

type Status = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REPLACED';

describe('календарь: GET /calendar (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<RulesOrgKey, number>;
  let tokens: Partial<Record<RulesOrgKey, string>>;

  const token = async (login: RulesOrgKey) =>
    (tokens[login] ??= await loginAs(app, login));
  // токен берётся до создания запроса: вход закрывает временный сервер supertest
  const get = async (login: RulesOrgKey, path: string) => {
    const auth = bearer(await token(login));
    return request(app.getHttpServer()).get(path).set(auth);
  };
  const calendar = (login: RulesOrgKey, query = NOVEMBER) =>
    get(login, `/calendar?${query}`);
  /** Отпуск сотрудника; по умолчанию «Одобрена», пн–пт 2026-11-02…06. */
  const vacation = (
    who: RulesOrgKey,
    patch: { start?: string; end?: string; status?: Status } = {},
  ) =>
    insertVacation(pool, {
      employeeId: ids[who],
      backstopperId: who === 'hr' ? ids.deputy : ids.hr,
      start: patch.start ?? '2026-11-02',
      end: patch.end ?? '2026-11-06',
      status: patch.status ?? 'APPROVED',
    });
  const who = (body: { entries: { employee: { id: number } }[] }) =>
    body.entries.map((e) => e.employee.id);

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

  // RULES §3-11, §7-2
  it('«Одобрена» видна; «На согласовании», «Отклонена», «Отменена», «Заменена переносом» нет', async () => {
    const approved = await vacation('employee1');
    await vacation('employee2', { status: 'PENDING' });
    await vacation('employee4', { status: 'REJECTED' });
    await vacation('employee5', { status: 'CANCELLED' });
    await vacation('employee6', { status: 'REPLACED' });

    const res = await calendar('hr');

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([
      {
        vacationId: approved,
        employee: { id: ids.employee1, fullName: 'Сотрудник employee1' },
        teamName: 'Фронт-отдел',
        startDate: '2026-11-02',
        endDate: '2026-11-06',
      },
    ]);
  });

  // RULES §7-2
  it('сотрудник видит только себя: одобренный отпуск коллеги в том же месяце не виден', async () => {
    await vacation('employee1');
    await vacation('employee2', { start: '2026-11-09', end: '2026-11-13' });

    const res = await calendar('employee1');

    expect(res.status).toBe(200);
    expect(who(res.body)).toEqual([ids.employee1]);
  });

  // RULES §7-2
  it('чужой календарь по прямому запросу недоступен: параметра employeeId нет, 400', async () => {
    await vacation('employee2');

    const res = await calendar(
      'employee1',
      `${NOVEMBER}&employeeId=${ids.employee2}`,
    );

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body)).not.toContain('2026-11-02');
  });

  // RULES §7-2, §7-3
  it('руководитель 2 видит себя и команду 2, но не команду 1', async () => {
    await vacation('employee1');
    await vacation('manager1', { start: '2026-11-09', end: '2026-11-13' });
    await vacation('employee4', { start: '2026-11-16', end: '2026-11-20' });
    await vacation('manager2', { start: '2026-11-23', end: '2026-11-27' });

    const res = await calendar('manager2');

    expect(res.status).toBe(200);
    expect(who(res.body)).toEqual([ids.employee4, ids.manager2]);
  });

  // RULES §7-3
  it('команда — только прямые подчинённые: заместитель видит руководителя 1, но не его сотрудника', async () => {
    await vacation('employee1');
    await vacation('manager1', { start: '2026-11-09', end: '2026-11-13' });

    const res = await calendar('deputy');

    expect(who(res.body)).toEqual([ids.manager1]);
  });

  // RULES §7-2
  it('HR видит всю компанию, остатков в ответе нет', async () => {
    await vacation('employee1');
    await vacation('employee4');
    await vacation('director', { start: '2026-11-09', end: '2026-11-13' });

    const res = await calendar('hr');

    expect(res.status).toBe(200);
    expect(new Set(who(res.body))).toEqual(
      new Set([ids.employee1, ids.employee4, ids.director]),
    );
    expect(res.body).not.toHaveProperty('balances');
  });

  // RULES §7-2
  it('руководитель получает остатки всех прямых подчинённых на сегодня, как /me/balance', async () => {
    const res = await calendar('manager1');

    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    const expected = [];
    for (const key of ['employee1', 'employee2', 'employee3'] as const) {
      const own = await get(key, '/me/balance');
      expected.push({
        employee: { id: ids[key], fullName: `Сотрудник ${key}` },
        balance: own.body.balance,
      });
    }
    expect(res.body.balances).toEqual(expected);
    // RULES §3-10: employee1 сегодня 37,5 (см. approvals.int.spec)
    expect(res.body.balances[0].balance).toBe(37.5);
  });

  // RULES §7-2
  it('у сотрудника поля остатков нет', async () => {
    const res = await calendar('employee1');

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('balances');
  });

  // RULES §7-2
  it('отпуск, пересекающий границы диапазона, попадает с полными датами; вне диапазона нет', async () => {
    await vacation('employee5', { start: '2026-10-26', end: '2026-10-30' });
    const across = await vacation('employee1', {
      start: '2026-10-28',
      end: '2026-11-03',
    });
    const endsOnFrom = await vacation('employee3', {
      start: '2026-10-26',
      end: '2026-11-01',
    });
    const startsOnTo = await vacation('employee2', {
      start: '2026-11-30',
      end: '2026-12-04',
    });
    await vacation('employee4', { start: '2026-12-01', end: '2026-12-04' });

    const res = await calendar('hr');

    expect(
      res.body.entries.map((e: { vacationId: number }) => e.vacationId),
    ).toEqual([endsOnFrom, across, startsOnTo]);
    expect(res.body.entries[1]).toMatchObject({
      startDate: '2026-10-28',
      endDate: '2026-11-03',
    });
    expect(res.body.entries[2]).toMatchObject({
      startDate: '2026-11-30',
      endDate: '2026-12-04',
    });
  });

  // RULES §7-2
  it('порядок: дата начала, затем имя', async () => {
    const later = await vacation('employee1', {
      start: '2026-11-09',
      end: '2026-11-13',
    });
    const second = await vacation('employee4');
    const first = await vacation('employee2');

    const res = await calendar('hr');

    expect(
      res.body.entries.map((e: { vacationId: number }) => e.vacationId),
    ).toEqual([first, second, later]);
  });

  // RULES §1-4
  it.each([
    ['нет from', 'to=2026-11-30', 'from'],
    ['нет to', 'from=2026-11-01', 'to'],
    ['from позже to', 'from=2026-11-30&to=2026-11-01', 'to'],
    ['несуществующая дата', 'from=2026-02-30&to=2026-03-31', 'from'],
    ['не формат YYYY-MM-DD', 'from=01.11.2026&to=2026-11-30', 'from'],
  ])('%s → 400 VALIDATION_FAILED', async (_name, query, field) => {
    const res = await calendar('employee1', query);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.details.fields).toHaveProperty(field);
  });

  // RULES §3-11, §5-4, §5-5 (S6-a): после отмены и отзыва отпуск пропадает из календаря целиком
  it('после отмены сотрудником и отзыва HR отпуска в календаре нет ни у кого', async () => {
    const cancelled = await vacation('employee1', {
      start: '2026-11-16',
      end: '2026-11-20',
    });
    const recalled = await vacation('employee2');
    for (const vacationId of [cancelled, recalled]) {
      await insertLedger(pool, { kind: 'DEBIT', vacationId, halfDays: 10 });
    }
    const kept = await vacation('employee4');

    const post = async (login: RulesOrgKey, path: string, body: object) => {
      const auth = bearer(await token(login)); // до создания запроса, как в get
      return request(app.getHttpServer()).post(path).set(auth).send(body);
    };
    expect(
      (await post('employee1', `/vacations/${cancelled}/cancel`, {})).status,
    ).toBe(200);
    await setDbClock(pool, '2026-11-04T03:00:00.000Z'); // отпуск employee2 идёт
    expect(
      (
        await post('hr', `/vacations/${recalled}/recall`, {
          returnDate: '2026-11-05',
        })
      ).status,
    ).toBe(200);

    expect(
      (await calendar('hr')).body.entries.map(
        (e: { vacationId: number }) => e.vacationId,
      ),
    ).toEqual([kept]);
    expect(who((await calendar('manager1')).body)).toEqual([]);
    expect(who((await calendar('employee1')).body)).toEqual([]);
    expect(who((await calendar('employee2')).body)).toEqual([]);
  });

  // RULES §3-11, §5-2 (S6-b): пока перенос ждёт решения - старые даты; после утверждения - новые
  it('после утверждения переноса в календаре новые даты, а «Заменена переносом» не показывается', async () => {
    const old = await vacation('employee1');
    await insertLedger(pool, {
      kind: 'DEBIT',
      vacationId: old,
      halfDays: 10,
    });
    const post = async (login: RulesOrgKey, path: string, body: object) => {
      const auth = bearer(await token(login)); // до создания запроса, как в get
      return request(app.getHttpServer()).post(path).set(auth).send(body);
    };
    const transfer = await post('employee1', `/vacations/${old}/transfer`, {
      startDate: '2026-11-16',
      endDate: '2026-11-20',
      backstopperId: ids.hr,
    });
    expect(transfer.status).toBe(201);
    type Entry = { vacationId: number; startDate: string };
    const dates = async (login: RulesOrgKey) =>
      ((await calendar(login)).body.entries as Entry[]).map((e) => [
        e.vacationId,
        e.startDate,
      ]);
    for (const login of ['employee1', 'manager1', 'hr'] as const) {
      expect(await dates(login)).toEqual([[old, '2026-11-02']]);
    }

    expect(
      (await post('manager1', `/vacations/${transfer.body.id}/approve`, {}))
        .status,
    ).toBe(200);
    for (const login of ['employee1', 'manager1', 'hr'] as const) {
      expect(await dates(login)).toEqual([[transfer.body.id, '2026-11-16']]);
    }
  });

  // RULES §7-1
  it('без токена 401', async () => {
    const res = await request(app.getHttpServer()).get(`/calendar?${NOVEMBER}`);

    expect(res.status).toBe(401);
  });
});
