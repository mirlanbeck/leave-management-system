/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument -- тела ответов supertest имеют тип any */
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
import { FakeClock } from '../clock/clock';
import { createTestApp } from '../testing/test-app';
import { createPool, insertUser, truncateAll } from '../testing/test-db';
import { LOGIN_LIMIT_CLOCK } from './login-attempts';

// 2026-10-24 09:00 в Бишкеке (UTC+6)
const NOW = '2026-10-24T03:00:00Z';
// лимит по DECISIONS 2026-11-01 07:36: 5 неудач за 15 минут -> блокировка на 15 минут
const LIMIT = 5;
const LOCK_SECONDS = 15 * 60;
const WRONG = 'не тот пароль';

describe('лимит попыток входа (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;

  const post = (login: string, password: string = PASSWORD) =>
    request(app.getHttpServer()).post('/auth/login').send({ login, password });

  const fail = async (login: string, times: number) => {
    for (let i = 0; i < times; i++) {
      expect((await post(login, WRONG)).status).toBe(401);
    }
  };

  const expectLocked = (res: request.Response) => {
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('AUTH_TOO_MANY_ATTEMPTS');
    expect(res.body.message).toBe(
      'Слишком много неудачных попыток входа. Повторите через 15 мин.',
    );
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(LOCK_SECONDS - 60);
    expect(retryAfter).toBeLessThanOrEqual(LOCK_SECONDS);
    expect(res.body.details).toEqual({ retryAfterSeconds: retryAfter });
  };

  beforeAll(() => {
    pool = createPool();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await setDbClock(pool, NOW);
    const hash = await passwordHash();
    const director = await insertUser(pool, {
      managerId: null,
      login: 'director',
      passwordHash: hash,
    });
    for (const login of ['ok', 'other']) {
      await insertUser(pool, {
        managerId: director,
        login,
        passwordHash: hash,
      });
    }
    await insertUser(pool, {
      managerId: director,
      login: 'future',
      hireDate: '2026-11-01',
      passwordHash: hash,
    });
    // счётчик в памяти процесса: у каждого теста своё приложение
    app = await createTestApp({ DEMO_MODE: 'true' });
  });

  afterEach(async () => {
    await app.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  // RULES §7-1
  it('после 5 неудач вход закрыт, в том числе с верным паролем: 429 и Retry-After', async () => {
    await fail('ok', LIMIT);
    expectLocked(await post('ok'));
  });

  // RULES §7-1: ответ при блокировке не выдаёт, существует ли логин
  it('несуществующий логин блокируется так же и получает тот же ответ', async () => {
    await fail('ok', LIMIT);
    await fail('нет-такого', LIMIT);
    const known = await post('ok');
    const unknown = await post('нет-такого');
    expectLocked(known);
    expectLocked(unknown);
    // retryAfterSeconds может разойтись на секунду: блокировки поставлены не одновременно;
    // точное совпадение тела и заголовка - в тесте с подменой часов лимита
    const pick = ({ body }: request.Response) => {
      const { statusCode, code, message } = body as Record<string, unknown>;
      return { statusCode, code, message };
    };
    expect(pick(unknown)).toEqual(pick(known));
  });

  // RULES §7-1
  it('блокировка одного логина не затрагивает другие', async () => {
    await fail('ok', LIMIT);
    expectLocked(await post('ok'));
    expect((await post('other')).status).toBe(200);
    expect((await post('other', WRONG)).status).toBe(401);
  });

  // RULES §7-1
  it('попытки во время блокировки не считаются неудачами и не дают 401', async () => {
    await fail('ok', LIMIT);
    for (let i = 0; i < 3; i++) expectLocked(await post('ok', WRONG));
  });

  // RULES §7-1
  it('успешный вход сбрасывает счётчик', async () => {
    await fail('ok', LIMIT - 1);
    expect((await post('ok')).status).toBe(200);
    await fail('ok', LIMIT - 1);
    expect((await post('ok')).status).toBe(200);
    // после сброса порог снова 5
    await fail('ok', LIMIT);
    expectLocked(await post('ok'));
  });

  // RULES §7-1, §6-7: 403 «до даты выхода» — пароль верный, счётчик сбрасывается
  it('403 AUTH_NOT_HIRED_YET неудачей не считается и сбрасывает счётчик', async () => {
    await fail('future', LIMIT - 1);
    expect((await post('future')).status).toBe(403);
    await fail('future', LIMIT - 1);
    expect((await post('future')).status).toBe(403);
    await fail('future', LIMIT);
    expectLocked(await post('future'));
  });

  // RULES §7-1: 400 до сервиса не доходит и в счётчик не попадает
  it('ошибка валидации (пароль длиннее 72 байт) не считается', async () => {
    for (let i = 0; i < LIMIT + 1; i++) {
      expect((await post('ok', 'a'.repeat(73))).status).toBe(400);
    }
    await fail('ok', LIMIT - 1);
    expect((await post('ok')).status).toBe(200);
  });

  // RULES §7-1: параллельные запросы порог не обходят
  it('10 параллельных неверных паролей: не больше 5 проверок, остальные 429', async () => {
    const res = await Promise.all(
      Array.from({ length: 10 }, () => post('ok', WRONG)),
    );
    const statuses = res.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 401)).toHaveLength(LIMIT);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10 - LIMIT);
  });

  describe('часы лимита подменены (FakeClock вместо системных)', () => {
    let limitClock: FakeClock;

    beforeEach(async () => {
      await app.close();
      limitClock = new FakeClock('2026-11-01T03:00:00Z');
      app = await createTestApp({ DEMO_MODE: 'true' }, (b) =>
        b.overrideProvider(LOGIN_LIMIT_CLOCK).useValue(limitClock),
      );
    });

    // RULES §7-1: тело и Retry-After не выдают, существует ли логин
    it('при одновременной блокировке ответы известному и несуществующему логину совпадают целиком', async () => {
      await fail('ok', LIMIT);
      await fail('нет-такого', LIMIT);
      const known = await post('ok');
      const unknown = await post('нет-такого');
      expectLocked(known);
      expect(unknown.status).toBe(known.status);
      expect(unknown.body).toEqual(known.body);
      expect(unknown.headers['retry-after']).toBe(String(LOCK_SECONDS));
      expect(known.headers['retry-after']).toBe(String(LOCK_SECONDS));
    });

    // RULES §7-1, §9-1: через 15 минут системного времени вход снова открыт
    it('через 15 минут по часам лимита вход открыт', async () => {
      await fail('ok', LIMIT);
      limitClock.advanceMs(LOCK_SECONDS * 1000 - 1000);
      const res = await post('ok');
      expect(res.status).toBe(429);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body.details).toEqual({ retryAfterSeconds: 1 });
      expect(res.body.message).toContain('Повторите через 1 мин.');
      limitClock.advanceMs(1000);
      expect((await post('ok')).status).toBe(200);
    });
  });

  // RULES §9-1, §9-3: окно по системным часам; перевод демо-часов блокировку не снимает
  it.each([
    ['вперёд на сутки', '2026-10-25'],
    ['назад на год', '2025-10-24'],
  ])(
    'перевод демо-часов через PUT /clock (%s) блокировку не снимает',
    async (_, date) => {
      const token = await loginAs(app, 'other');
      await fail('ok', LIMIT);
      const put = await request(app.getHttpServer())
        .put('/clock')
        .set(bearer(token))
        .send({ date, time: '09:00' });
      expect(put.status).toBe(200);
      expectLocked(await post('ok'));
    },
  );
});
