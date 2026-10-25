/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument -- тела ответов supertest имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import {
  PASSWORD,
  bearer,
  loginAs,
  passwordHash,
  setDbClock,
} from '../testing/int-helpers';
import { createTestApp } from '../testing/test-app';
import {
  createPool,
  insertUser,
  shiftHireDate,
  truncateAll,
} from '../testing/test-db';

// 2026-10-24 09:00 в Бишкеке (UTC+6)
const NOW = '2026-10-24T03:00:00Z';

describe('POST /auth/login (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let ids: Record<string, number>;

  const post = (login: string, password: string = PASSWORD) =>
    request(app.getHttpServer()).post('/auth/login').send({ login, password });

  const granted = async (id: number) =>
    (
      await pool.query<{ accessGranted: boolean }>(
        `SELECT "accessGranted" FROM "User" WHERE id = $1`,
        [id],
      )
    ).rows[0].accessGranted;

  beforeAll(async () => {
    pool = createPool();
    app = await createTestApp({ DEMO_MODE: 'true' });
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await setDbClock(pool, NOW);
    const hash = await passwordHash();
    // в системе ровно один пользователь без руководителя (директор)
    const director = await insertUser(pool, {
      managerId: null,
      login: 'director',
      passwordHash: hash,
    });
    const mk = (login: string, hireDate: string, accessGranted = false) =>
      insertUser(pool, {
        managerId: director,
        login,
        hireDate,
        accessGranted,
        passwordHash: hash,
      });
    ids = {
      ok: await mk('ok', '2022-03-15'),
      future: await mk('future', '2026-11-01'),
      today: await mk('today', '2026-10-24'),
      tomorrow: await mk('tomorrow', '2026-10-25'),
      seeded: await mk('seeded', '2026-11-01', true),
    };
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // RULES §7-1
  it('успешный вход: 200, токен и срок', async () => {
    const res = await post('ok');
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe('string');
    expect(Number.isNaN(Date.parse(res.body.expiresAt))).toBe(false);
  });

  // RULES §7-1
  it('неверный пароль и неизвестный логин дают одинаковый 401', async () => {
    const wrongPassword = await post('ok', 'не тот пароль');
    const unknown = await post('нет-такого');
    expect(wrongPassword.status).toBe(401);
    expect(wrongPassword.body.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect(unknown.status).toBe(401);
    expect(unknown.body).toEqual(wrongPassword.body);
  });

  // RULES §7-1, §6-7
  it('до даты выхода: 403 AUTH_NOT_HIRED_YET', async () => {
    const res = await post('future');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AUTH_NOT_HIRED_YET');
    expect(await granted(ids.future)).toBe(false);
  });

  // RULES §7-1: пароль проверяется раньше даты выхода
  it('неверный пароль у ещё не вышедшего -> 401, а не 403', async () => {
    const res = await post('future', 'не тот пароль');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_INVALID_CREDENTIALS');
  });

  // RULES §6-7, §1-3
  it('в день выхода вход разрешён, на следующий день нет', async () => {
    expect((await post('today')).status).toBe(200);
    expect((await post('tomorrow')).status).toBe(403);
  });

  // RULES §6-7, §1-3: «сегодня» считается по поясу компании
  it('день выхода сверяется с поясом компании, а не UTC', async () => {
    // 02:00 по Бишкеку 24-го, в UTC ещё 23-е
    await setDbClock(pool, '2026-10-23T20:00:00Z');
    expect((await post('today')).status).toBe(200);
  });

  // RULES §6-7, §1-3
  it('при COMPANY_TZ=America/New_York тот же момент ещё 23-е', async () => {
    const ny = await createTestApp({
      DEMO_MODE: 'true',
      COMPANY_TZ: 'America/New_York',
    });
    try {
      // 2026-10-24 03:00 UTC = 23 октября 23:00 в Нью-Йорке
      const send = (login: string) =>
        request(ny.getHttpServer())
          .post('/auth/login')
          .send({ login, password: PASSWORD });
      expect((await send('today')).status).toBe(403);
      await shiftHireDate(pool, ids.today, '2026-10-23');
      expect((await send('today')).status).toBe(200);
    } finally {
      await ny.close();
    }
  });

  // RULES §6-7
  it('первый вход ставит accessGranted', async () => {
    expect(await granted(ids.ok)).toBe(false);
    await post('ok');
    expect(await granted(ids.ok)).toBe(true);
  });

  // RULES §6-7
  it('сдвиг даты выхода вперёд признак не снимает', async () => {
    await post('ok');
    await shiftHireDate(pool, ids.ok, '2027-01-01');
    expect((await post('ok')).status).toBe(200);
    expect(await granted(ids.ok)).toBe(true);
  });

  // RULES §6-7, §9-2
  it('откат демо-часов признак не снимает, а не входившему вход закрыт', async () => {
    await post('ok');
    await setDbClock(pool, '2020-01-01T03:00:00Z');
    expect((await post('ok')).status).toBe(200);
    // у не входившего в тех же условиях вход закрыт
    await shiftHireDate(pool, ids.today, '2026-10-24');
    expect((await post('today')).status).toBe(403);
  });

  // RULES §6-7
  it('признак из seed пускает до даты выхода', async () => {
    expect((await post('seeded')).status).toBe(200);
  });

  // RULES §6-5
  it('вошедший до даты выхода (признак есть) работает с токеном', async () => {
    const token = await loginAs(app, 'seeded');
    const me = await request(app.getHttpServer()).get('/me').set(bearer(token));
    expect(me.status).toBe(200);
    expect(me.body.hireDate).toBe('2026-11-01');
  });

  // RULES §7-1
  it('пустой логин или пароль -> 400 VALIDATION_FAILED', async () => {
    const res = await post('', '');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
