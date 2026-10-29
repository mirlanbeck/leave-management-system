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
  createPool,
  insertVacation,
  seedRulesOrg,
  truncateAll,
} from '../testing/test-db';

describe('GET/PUT /clock (integration, нужен Postgres)', () => {
  let pool: Pool;

  beforeAll(() => {
    pool = createPool();
  });

  let ids: Awaited<ReturnType<typeof seedRulesOrg>>;

  beforeEach(async () => {
    await truncateAll(pool);
    ids = await seedRulesOrg(pool, await passwordHash());
  });

  afterAll(() => pool.end());

  const stored = async () =>
    (
      await pool.query<{ instant: Date }>(
        `SELECT instant FROM "ClockState" WHERE id = 1`,
      )
    ).rows[0]?.instant.toISOString();

  describe('с DEMO_MODE=true', () => {
    let app: INestApplication;
    let token: string;

    beforeAll(async () => {
      app = await createTestApp({ DEMO_MODE: 'true' });
    });

    beforeEach(async () => {
      await setDbClock(pool, '2026-10-24T03:00:00Z');
      token = await loginAs(app, 'employee1');
    });

    afterAll(() => app.close());

    const put = (body: object, t = token) =>
      request(app.getHttpServer()).put('/clock').set(bearer(t)).send(body);

    // RULES §9-2
    it('GET отдаёт текущий момент и frozen: true', async () => {
      const res = await request(app.getHttpServer())
        .get('/clock')
        .set(bearer(token));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        now: '2026-10-24T03:00:00.000Z',
        frozen: true,
      });
    });

    // RULES §9-3
    it('PUT принимает дату и время в поясе компании и хранит момент UTC', async () => {
      const res = await put({ date: '2026-12-31', time: '09:00' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        now: '2026-12-31T03:00:00.000Z',
        frozen: true,
      });
      expect(await stored()).toBe('2026-12-31T03:00:00.000Z');
    });

    // RULES §9-2
    it('часы не идут: два чтения подряд дают одно значение', async () => {
      await put({ date: '2026-12-31', time: '09:00' });
      const read = () =>
        request(app.getHttpServer()).get('/clock').set(bearer(token));
      expect((await read()).body.now).toBe((await read()).body.now);
    });

    // RULES §9-2: назад тоже можно
    it('часы можно вернуть назад', async () => {
      await put({ date: '2020-01-01', time: '09:00' });
      expect(await stored()).toBe('2020-01-01T03:00:00.000Z');
    });

    // RULES §9-3
    it.each([
      ['неверный формат даты', { date: '31.12.2026', time: '09:00' }],
      ['неверный формат времени', { date: '2026-12-31', time: '9:00' }],
      ['время 24:00', { date: '2026-12-31', time: '24:00' }],
      ['несуществующая дата', { date: '2026-02-30', time: '09:00' }],
      ['нет поля time', { date: '2026-12-31' }],
      ['лишнее поле', { date: '2026-12-31', time: '09:00', extra: 1 }],
    ])('%s -> 400 VALIDATION_FAILED', async (_name, body) => {
      const res = await put(body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(await stored()).toBe('2026-10-24T03:00:00.000Z');
    });

    // Одобренный отпуск вт 2026-11-10 – пт 2026-11-13: дата напоминания чт 2026-11-05 (N = 3)
    const approvedVacation = () =>
      insertVacation(pool, {
        employeeId: ids.employee1,
        backstopperId: ids.employee2,
        start: '2026-11-10',
        end: '2026-11-13',
        workDays: 4,
        status: 'APPROVED',
      });
    const reminders = async (vacationId: number) =>
      (
        await pool.query<{ recipientId: number; createdAt: Date }>(
          `SELECT "recipientId", "createdAt" FROM "OutboxMessage"
           WHERE type = 'REMINDER' AND "vacationId" = $1 ORDER BY "recipientId"`,
          [vacationId],
        )
      ).rows;

    // RULES §9-4, §8-3: проход планировщика после установки, до ответа (аудит 2, F-1, F-5)
    it('часы на дату напоминания 09:00 → к ответу уже 2 напоминания', async () => {
      const id = await approvedVacation();
      const res = await put({ date: '2026-11-05', time: '09:00' });
      expect(res.status).toBe(200);
      const rows = await reminders(id);
      expect(rows.map((r) => r.recipientId)).toEqual([
        ids.manager1,
        ids.employee1,
      ]);
      for (const r of rows) {
        expect(r.createdAt.toISOString()).toBe('2026-11-05T03:00:00.000Z');
      }
    });

    // RULES §8-3, §9-4: проход срабатывает «как в этот день»: до 09:00 напоминания нет
    it('часы на дату напоминания 08:59 → напоминаний нет', async () => {
      const id = await approvedVacation();
      expect((await put({ date: '2026-11-05', time: '08:59' })).status).toBe(
        200,
      );
      expect(await reminders(id)).toEqual([]);
    });

    // RULES §9-5, §10-1: откат часов и повторная перемотка дубля не дают
    it('вперёд, назад, снова вперёд → по-прежнему 2', async () => {
      const id = await approvedVacation();
      await put({ date: '2026-11-05', time: '09:00' });
      await put({ date: '2026-11-01', time: '09:00' });
      await put({ date: '2026-11-06', time: '09:00' });
      expect(await reminders(id)).toHaveLength(2);
    });

    // RULES §9-3: неверные данные — часы не меняются, прохода нет
    it('при неверных данных проход не выполняется', async () => {
      const id = await approvedVacation();
      await setDbClock(pool, '2026-11-05T03:00:00Z');
      await put({ date: '2026-02-30', time: '09:00' });
      expect(await reminders(id)).toEqual([]);
    });

    // RULES §9-3: любому вошедшему
    it('доступно любому вошедшему, не только руководителю', async () => {
      const t = await loginAs(app, 'employee2');
      expect((await put({ date: '2026-11-02', time: '09:00' }, t)).status).toBe(
        200,
      );
    });
  });

  describe('без DEMO_MODE', () => {
    let app: INestApplication;
    let token: string;

    beforeAll(async () => {
      app = await createTestApp({});
    });

    beforeEach(async () => {
      token = await loginAs(app, 'employee1');
    });

    afterAll(() => app.close());

    // RULES §9-2
    it('GET и PUT -> 404 NOT_FOUND, сохранённое значение игнорируется', async () => {
      await setDbClock(pool, '2030-01-01T03:00:00Z');
      const get = await request(app.getHttpServer())
        .get('/clock')
        .set(bearer(token));
      const put = await request(app.getHttpServer())
        .put('/clock')
        .set(bearer(token))
        .send({ date: '2026-12-31', time: '09:00' });
      expect(get.status).toBe(404);
      expect(get.body.code).toBe('NOT_FOUND');
      expect(put.status).toBe(404);
      expect(put.body.code).toBe('NOT_FOUND');
      expect(await stored()).toBe('2030-01-01T03:00:00.000Z');
    });

    // RULES §9-2: 404 раньше проверки тела
    it('PUT с неверным телом без флага всё равно 404', async () => {
      const res = await request(app.getHttpServer())
        .put('/clock')
        .set(bearer(token))
        .send({ nonsense: true });
      expect(res.status).toBe(404);
    });
  });
});
