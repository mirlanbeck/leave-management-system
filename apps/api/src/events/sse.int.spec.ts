/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- тела ответов supertest и fetch, getHttpServer() имеют тип any */
import { INestApplication, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import request from 'supertest';
import { Clock, FakeClock } from '../clock/clock';
import { OrgService } from '../org/org.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReminderScheduler } from '../scheduler/reminder-scheduler';
import { runSeed } from '../seed';
import { DEMO_PASSWORD, SEED_USERS } from '../seed-data';
import { bearer, loginAs, setDbClock } from '../testing/int-helpers';
import { SseClient } from '../testing/sse-client';
import { TEST_JWT_SECRET, createTestApp } from '../testing/test-app';
import {
  createPool,
  insertLedger,
  insertVacation,
  truncateAll,
} from '../testing/test-db';
import { EventBus, type DomainEvent } from './event-bus';
import { SSE_OPTIONS, SseHub } from './sse-hub';

// Среда 2026-10-21, 09:00 по Бишкеку. Будущий отпуск пн 2026-11-09 – пт 2026-11-13 (5 дней),
// идущий - пн 2026-10-19 – пт 2026-10-23.
const NOW = '2026-10-21T03:00:00.000Z';
const KEEP_ALIVE_MS = 100;

type Login = (typeof SEED_USERS)[number]['login'];

/**
 * Приложение на настоящем порту: SSE читается через fetch, как в браузере.
 * `demo` - с DEMO_MODE (часы из БД); без него часы подменяются FakeClock.
 */
async function startApp(demo: boolean) {
  const app = await createTestApp(demo ? { DEMO_MODE: 'true' } : {}, (b) => {
    const withOptions = b
      .overrideProvider(SSE_OPTIONS)
      .useValue({ keepAliveMs: KEEP_ALIVE_MS });
    return demo
      ? withOptions
      : withOptions.overrideProvider(Clock).useValue(new FakeClock(NOW));
  });
  await app.listen(0, '127.0.0.1');
  const { port } = app.getHttpServer().address() as AddressInfo;
  return { app, base: `http://127.0.0.1:${port}` };
}

/** Ждёт условия, проверяя его на каждом проходе цикла событий (без фиксированных пауз). */
async function until(check: () => boolean): Promise<void> {
  while (!check()) await new Promise((r) => setTimeout(r, 5));
}

describe.each([
  ['демо-режим', true],
  ['без демо-режима', false],
])('SSE GET /events, %s (integration, нужен Postgres)', (_mode, demo) => {
  let pool: Pool;
  let app: INestApplication;
  let base: string;
  let ids: Record<Login, number>;
  let tokens: Partial<Record<Login, string>>;
  let clients: SseClient[];

  const token = async (login: Login) =>
    (tokens[login] ??= await loginAs(app, login, DEMO_PASSWORD));
  const connect = async (login: Login) => {
    const c = await SseClient.open(
      `${base}/events`,
      bearer(await token(login)),
    );
    expect(c.status).toBe(200);
    clients.push(c);
    return c;
  };
  const connectAll = async <L extends Login>(logins: L[]) =>
    Object.fromEntries(
      await Promise.all(
        logins.map(async (l) => [l, await connect(l)] as const),
      ),
    ) as Record<L, SseClient>;

  const api = async (login: Login) => {
    const auth = bearer(await token(login));
    const server = app.getHttpServer();
    return {
      post: (path: string, body: object = {}) =>
        request(server).post(path).set(auth).send(body),
      patch: (path: string, body: object) =>
        request(server).patch(path).set(auth).send(body),
      put: (path: string, body: object) =>
        request(server).put(path).set(auth).send(body),
      get: (path: string) => request(server).get(path).set(auth),
    };
  };

  /** Заявка; у «Одобрена» - списание всех рабочих дней, как при согласовании. */
  const vacation = async (
    who: Login,
    status: 'PENDING' | 'APPROVED' = 'PENDING',
    span: [string, string] = ['2026-11-09', '2026-11-13'],
  ) => {
    const id = await insertVacation(pool, {
      employeeId: ids[who],
      backstopperId: who === 'henry' ? ids.grace : ids.henry,
      start: span[0],
      end: span[1],
      workDays: 5,
      status,
    });
    if (status === 'APPROVED') {
      await insertLedger(pool, { kind: 'DEBIT', vacationId: id, halfDays: 10 });
    }
    return id;
  };
  /** Подаёт заявку `who` и одобряет её согласующий `approver`. */
  const approve = async (who: Login, approver: Login) => {
    const id = await vacation(who);
    const res = await (await api(approver)).post(`/vacations/${id}/approve`);
    expect(res.status).toBe(200);
    return id;
  };
  const approved = (employeeId: number, vacationId: number) => ({
    event: 'vacation.approved',
    data: { type: 'vacation.approved', employeeId, vacationId },
  });

  beforeAll(async () => {
    pool = createPool();
    ({ app, base } = await startApp(demo));
  });

  beforeEach(async () => {
    await truncateAll(pool);
    if (demo) await setDbClock(pool, NOW);
    await runSeed(app.get(PrismaService), new FakeClock(NOW));
    const { rows } = await pool.query<{ id: number; login: Login }>(
      'SELECT id, login FROM "User"',
    );
    ids = Object.fromEntries(rows.map((r) => [r.login, r.id]));
    tokens = {};
    clients = [];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(clients.map((c) => c.close()));
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  // RULES §7-2, §10-2: событие по отпуску команды 1 получают руководитель 1, HR и сама команда;
  // руководитель 2 и команда 2 - нет. «Не получил» проверяется следующим видимым событием:
  // оно должно прийти первым
  it('одобрение отпуска james: daniel, emily, james, sophie получают; olivia, grace - нет', async () => {
    const c = await connectAll([
      'daniel',
      'olivia',
      'emily',
      'james',
      'sophie',
      'grace',
    ]);

    const jamesVacation = await approve('james', 'daniel');
    for (const who of ['daniel', 'emily', 'james', 'sophie'] as const) {
      expect(await c[who].next()).toEqual(approved(ids.james, jamesVacation));
    }

    const graceVacation = await approve('grace', 'olivia');
    for (const who of ['olivia', 'grace'] as const) {
      expect(await c[who].next()).toEqual(approved(ids.grace, graceVacation));
    }
  });

  // RULES §10-2: в кадре только тип и идентификаторы; заголовки для fetch-stream и nginx
  it('заголовки потока и формат кадра', async () => {
    const c = await connect('james');
    expect(c.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(c.headers.get('cache-control')).toBe('no-cache');
    expect(c.headers.get('x-accel-buffering')).toBe('no');

    const id = await approve('james', 'daniel');
    const frame = await c.next();
    expect(Object.keys(frame.data as object).sort()).toEqual([
      'employeeId',
      'type',
      'vacationId',
    ]);
    expect(frame).toEqual(approved(ids.james, id));
  });

  describe('доступ (RULES §7-1)', () => {
    // RULES §7-1: без токена поток не открывается
    it('без токена 401 AUTH_REQUIRED', async () => {
      const c = await SseClient.open(`${base}/events`);
      expect(c.status).toBe(401);
      expect(c.headers.get('content-type')).not.toMatch(/event-stream/);
      expect(((await c.json()) as { code: string }).code).toBe('AUTH_REQUIRED');
    });

    // RULES §7-1; DECISIONS 2026-10-22 12:15: токен в URL не принимается
    it('токен в URL (?token=) - 401', async () => {
      const c = await SseClient.open(
        `${base}/events?token=${await token('james')}`,
      );
      expect(c.status).toBe(401);
      expect(((await c.json()) as { code: string }).code).toBe('AUTH_REQUIRED');
    });

    // RULES §7-1: недействительный токен
    it('недействительный токен - 401', async () => {
      const c = await SseClient.open(`${base}/events`, bearer('not-a-jwt'));
      expect(c.status).toBe(401);
    });

    // RULES §7-1, §9-1: истёкший токен
    it('истёкший токен - 401 AUTH_TOKEN_EXPIRED', async () => {
      const expired = new JwtService({ secret: TEST_JWT_SECRET }).sign(
        {},
        { subject: String(ids.james), expiresIn: -10 },
      );
      const c = await SseClient.open(`${base}/events`, bearer(expired));
      expect(c.status).toBe(401);
      expect(((await c.json()) as { code: string }).code).toBe(
        'AUTH_TOKEN_EXPIRED',
      );
    });

    // RULES §7-1, §9-1: при истечении токена сервер закрывает открытый поток
    it('токен с exp через 1 с: сервер закрывает поток', async () => {
      const short = new JwtService({ secret: TEST_JWT_SECRET }).sign(
        {},
        { subject: String(ids.james), expiresIn: 1 },
      );
      const c = await SseClient.open(`${base}/events`, bearer(short));
      clients.push(c);
      expect(c.status).toBe(200);
      await c.ended;
      await until(() => app.get(SseHub).size === 0);
    });
  });

  // RULES §10-2: порядок событий сохраняется, даже если чтение структуры для первого дольше
  it('три события подряд приходят в порядке публикации', async () => {
    const c = await connect('daniel');
    const org = app.get(OrgService);
    const real = org.structure.bind(org);
    jest
      .spyOn(org, 'structure')
      .mockImplementationOnce(async () => {
        await new Promise((r) => setTimeout(r, 50));
        return real();
      })
      .mockImplementation(real);

    const events: DomainEvent[] = [
      { type: 'vacation.approved', employeeId: ids.james, vacationId: 1 },
      { type: 'vacation.approved', employeeId: ids.sophie, vacationId: 2 },
      { type: 'employee.hire-date-changed', employeeId: ids.liam },
    ];
    const bus = app.get(EventBus);
    for (const e of events) bus.publish(e);

    for (const e of events) expect((await c.next()).data).toEqual(e);
  });

  // RULES §10-2; architecture §4: сбой обработки события пишется в лог, ответ API и поток целы
  it('сбой чтения структуры: лог, ответ 200, следующее событие доходит', async () => {
    const c = await connect('daniel');
    const logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    jest
      .spyOn(app.get(OrgService), 'structure')
      .mockRejectedValueOnce(new Error('БД недоступна'));

    await approve('james', 'daniel');
    const second = await approve('sophie', 'daniel');

    expect(await c.next()).toEqual(approved(ids.sophie, second));
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('БД недоступна'),
    );
  });

  describe('утечки и остановка (RULES §10-2)', () => {
    // после отключения подписка удаляется
    it('после отключения число подключений возвращается', async () => {
      const hub = app.get(SseHub);
      const before = hub.size;
      const a = await connect('james');
      const b = await connect('daniel');
      expect(hub.size).toBe(before + 2);
      await a.close();
      await b.close();
      await until(() => hub.size === before);
    });

    // keep-alive не даёт прокси закрыть простаивающее соединение
    it('приходит keep-alive', async () => {
      const c = await connect('james');
      expect(await c.nextComment()).toBe('keep-alive');
    });

    // остановка с открытыми потоками не виснет: потоки закрываются
    it('app.close() закрывает открытые потоки', async () => {
      const second = await startApp(demo);
      const t = await loginAs(second.app, 'james', DEMO_PASSWORD);
      const c = await SseClient.open(`${second.base}/events`, bearer(t));
      expect(c.status).toBe(200);
      await second.app.close();
      await c.ended;
    });
  });

  // RULES §10-2: событие во время обрыва не доставляется, следующее после переподключения - да
  it('обрыв: отмена во время разрыва не приходит, следующее событие приходит', async () => {
    const hub = app.get(SseHub);
    const cancelled = await vacation('james', 'APPROVED');
    const first = await connect('daniel');
    await first.close();
    await until(() => hub.size === 0);

    const res = await (
      await api('james')
    ).post(`/vacations/${cancelled}/cancel`);
    expect(res.status).toBe(200);

    const again = await connect('daniel');
    const next = await approve('sophie', 'daniel');
    expect(await again.next()).toEqual(approved(ids.sophie, next));
  });

  describe('F-2: отмена и отзыв убирают отпуск из календаря (RULES §5-5, §10-2)', () => {
    const calendar = async (login: Login) =>
      (
        await (await api(login)).get('/calendar?from=2026-10-01&to=2026-11-30')
      ).body.entries.map((e: { vacationId: number }) => e.vacationId);

    // кадр без способа отмены: точное равенство не пропустит лишнего поля (DECISIONS 2026-10-30 14:24)
    const cancelled = (employeeId: number, vacationId: number) => ({
      event: 'vacation.cancelled',
      data: { type: 'vacation.cancelled', employeeId, vacationId },
    });

    const watchers = ['james', 'daniel', 'sophie', 'emily', 'olivia'] as const;

    /**
     * james - владелец, daniel - руководитель, sophie - коллега, emily - HR получают одинаковый
     * кадр; olivia не получает: следующим у неё приходит одобрение отпуска grace.
     */
    const expectCancelledFrames = async (
      c: Record<(typeof watchers)[number], SseClient>,
      id: number,
    ) => {
      for (const who of ['james', 'daniel', 'sophie', 'emily'] as const) {
        expect(await c[who].next()).toEqual(cancelled(ids.james, id));
      }
      const graceVacation = await approve('grace', 'olivia');
      expect(await c.olivia.next()).toEqual(approved(ids.grace, graceVacation));
    };

    // RULES §5-4, §7-2, §10-2: отмена одобренного сотрудником
    it('james отменяет одобренный: кадр без by у james, daniel, sophie, emily; olivia - нет; в календаре его нет', async () => {
      const id = await vacation('james', 'APPROVED');
      const c = await connectAll([...watchers]);
      expect(await calendar('daniel')).toContain(id);

      const res = await (await api('james')).post(`/vacations/${id}/cancel`);
      expect(res.status).toBe(200);

      await expectCancelledFrames(c, id);
      expect(await calendar('daniel')).not.toContain(id);
    });

    // RULES §5-5, §7-2, §10-2: отзыв HR из идущего отпуска; коллеги не узнают, что это отзыв
    it('HR отзывает james: кадр без by у james, daniel, sophie, emily; olivia - нет; в календаре его нет', async () => {
      const id = await vacation('james', 'APPROVED', [
        '2026-10-19',
        '2026-10-23',
      ]);
      const c = await connectAll([...watchers]);
      expect(await calendar('daniel')).toContain(id);

      const res = await (
        await api('emily')
      ).post(`/vacations/${id}/recall`, {
        returnDate: '2026-10-22',
      });
      expect(res.status).toBe(200);

      await expectCancelledFrames(c, id);
      expect(await calendar('daniel')).not.toContain(id);
    });
  });

  // RULES §10-2: утверждение переноса - тем, у кого сотрудник в календаре
  it('утверждение переноса james: daniel, emily, james, sophie; olivia - нет', async () => {
    const old = await vacation('james', 'APPROVED');
    const c = await connectAll([
      'daniel',
      'emily',
      'james',
      'sophie',
      'olivia',
    ]);

    const transfer = await (
      await api('james')
    ).post(`/vacations/${old}/transfer`, {
      startDate: '2026-11-16',
      endDate: '2026-11-20',
      backstopperId: ids.henry,
    });
    expect(transfer.status).toBe(201);
    const res = await (
      await api('daniel')
    ).post(`/vacations/${transfer.body.id}/approve`);
    expect(res.status).toBe(200);

    const expected = {
      event: 'vacation.transfer-approved',
      data: {
        type: 'vacation.transfer-approved',
        employeeId: ids.james,
        vacationId: transfer.body.id,
        replacedId: old,
      },
    };
    for (const who of ['daniel', 'emily', 'james', 'sophie'] as const) {
      expect(await c[who].next()).toEqual(expected);
    }
    const marker = await approve('grace', 'olivia');
    expect(await c.olivia.next()).toEqual(approved(ids.grace, marker));
  });

  // RULES §6, §7-2, §10-2: смену даты выхода получают сам сотрудник, руководитель и HR
  it('смена даты выхода james: james, daniel, emily; sophie - нет', async () => {
    const c = await connectAll(['james', 'daniel', 'emily', 'sophie']);

    const res = await (
      await api('emily')
    ).patch(`/employees/${ids.james}/hire-date`, { hireDate: '2022-03-16' });
    expect(res.status).toBe(200);

    const expected = {
      event: 'employee.hire-date-changed',
      data: { type: 'employee.hire-date-changed', employeeId: ids.james },
    };
    for (const who of ['james', 'daniel', 'emily'] as const) {
      expect(await c[who].next()).toEqual(expected);
    }
    const marker = await approve('james', 'daniel');
    expect(await c.sophie.next()).toEqual(approved(ids.james, marker));
  });

  if (demo) {
    // RULES §9-3, §9-4, §10-2: после установки часов и прохода планировщика - всем вошедшим
    it('PUT /clock: clock.changed всем подключённым, после прохода планировщика', async () => {
      const c = await connectAll(['margaret', 'daniel', 'olivia', 'grace']);
      const pass = jest.spyOn(app.get(ReminderScheduler), 'pass');
      const publish = jest.spyOn(app.get(EventBus), 'publish');

      const res = await (
        await api('grace')
      ).put('/clock', {
        date: '2026-10-22',
        time: '09:00',
      });
      expect(res.status).toBe(200);

      for (const who of ['margaret', 'daniel', 'olivia', 'grace'] as const) {
        expect(await c[who].next()).toEqual({
          event: 'clock.changed',
          data: { type: 'clock.changed' },
        });
      }
      expect(pass).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith({ type: 'clock.changed' });
      expect(pass.mock.invocationCallOrder[0]).toBeLessThan(
        publish.mock.invocationCallOrder[0],
      );
    });
  } else {
    // RULES §9-2, §10-2: без демо-режима эндпоинта часов нет, clock.changed не публикуется
    it('PUT /clock - 404, clock.changed не приходит', async () => {
      const c = await connect('daniel');
      const res = await (
        await api('daniel')
      ).put('/clock', {
        date: '2026-10-22',
        time: '09:00',
      });
      expect(res.status).toBe(404);

      const marker = await approve('james', 'daniel');
      expect(await c.next()).toEqual(approved(ids.james, marker));
    });
  }
});
