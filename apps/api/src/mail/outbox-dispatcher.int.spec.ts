/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call -- строки pg и тела supertest имеют тип any */
import { INestApplication } from '@nestjs/common';
import { createServer } from 'node:net';
import { Pool } from 'pg';
import request from 'supertest';
import { Clock, FakeClock } from '../clock/clock';
import {
  bearer,
  loginAs,
  passwordHash,
  setDbClock,
} from '../testing/int-helpers';
import { TestEnv, createTestApp } from '../testing/test-app';
import {
  RulesOrgKey,
  createPool,
  insertMail,
  insertVacation,
  seedRulesOrg,
  truncateAll,
} from '../testing/test-db';
import {
  MailTransport,
  OutgoingMail,
  SmtpMailTransport,
} from './mail-transport';
import { DEFAULT_OUTBOX_CONFIG } from './outbox-config';
import { OutboxDispatcher } from './outbox-dispatcher';

// Среда 2026-10-21, 09:17:42.123 по Бишкеку (UTC+6)
const NOW = '2026-10-21T03:17:42.123Z';
const MAIL_FROM = 'Отпуска (тест) <outbox-test@vacation.local>';
const BASE_MS = 60_000;

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Подменный транспорт: запоминает письма, по флагу отвечает ошибкой, может «тормозить». */
class FakeTransport extends MailTransport {
  sent: OutgoingMail[] = [];
  failWith: Error | null = null;
  delayMs = 0;

  async send(mail: OutgoingMail): Promise<void> {
    if (this.delayMs) await tick(this.delayMs);
    if (this.failWith) throw this.failWith;
    this.sent.push(mail);
  }
}

/** Транспорт, который можно «восстановить»: сначала настоящий SMTP на закрытый порт, потом подменный. */
class SwitchableTransport extends MailTransport {
  constructor(public current: MailTransport) {
    super();
  }
  send(mail: OutgoingMail): Promise<void> {
    return this.current.send(mail);
  }
}

/** Свободный локальный порт, на котором никто не слушает. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  await new Promise<void>((r) => server.close(() => r()));
  return port;
}

describe('диспетчер outbox (integration, нужен Postgres)', () => {
  let pool: Pool;
  let ids: Record<RulesOrgKey, number>;
  const apps: INestApplication[] = [];

  async function startApp(
    transport: MailTransport,
    env: TestEnv = {},
    clock?: Clock,
  ): Promise<OutboxDispatcher> {
    const app = await createTestApp(
      {
        MAIL_FROM,
        OUTBOX_RETRY_BASE_MS: String(BASE_MS),
        ...env,
      },
      (b) => {
        const withTransport = b
          .overrideProvider(MailTransport)
          .useValue(transport);
        return clock
          ? withTransport.overrideProvider(Clock).useValue(clock)
          : withTransport;
      },
    );
    apps.push(app);
    return app.get(OutboxDispatcher);
  }

  const email = (login: RulesOrgKey) => `${login}@vacation.local`;

  const vacation = (
    status:
      | 'PENDING'
      | 'APPROVED'
      | 'CANCELLED'
      | 'REJECTED'
      | 'REPLACED' = 'APPROVED',
    start = '2026-11-02',
  ) =>
    insertVacation(pool, {
      employeeId: ids.employee1,
      backstopperId: ids.employee2,
      start,
      end: start,
      workDays: 1,
      status,
    });

  const mail = (
    vacationId: number,
    recipient: RulesOrgKey,
    type: 'NEW_REQUEST' | 'DECISION' | 'REMINDER' = 'NEW_REQUEST',
  ) => insertMail(pool, { type, vacationId, recipientId: ids[recipient] });

  /** Строка outbox; dueInMs - через сколько мс по времени БД наступит nextAttemptAt. */
  const row = async (id: number) =>
    (
      await pool.query(
        `SELECT status, attempts, "lastError", "sentAt", "createdAt",
                (EXTRACT(EPOCH FROM ("nextAttemptAt" - clock_timestamp())) * 1000)::float AS "dueInMs",
                (EXTRACT(EPOCH FROM (clock_timestamp() - "sentAt")) * 1000)::float AS "sentAgoMs"
         FROM "OutboxMessage" WHERE id = $1`,
        [id],
      )
    ).rows[0];

  /** «Пауза прошла»: nextAttemptAt в прошлое, без ожидания. */
  const makeDue = (id: number) =>
    pool.query(
      `UPDATE "OutboxMessage" SET "nextAttemptAt" = now() - interval '1 second' WHERE id = $1`,
      [id],
    );

  beforeAll(() => {
    pool = createPool();
  });

  beforeEach(async () => {
    await truncateAll(pool);
    ids = await seedRulesOrg(pool, await passwordHash());
  });

  afterEach(async () => {
    while (apps.length) await apps.pop()!.close();
  });

  afterAll(async () => {
    await pool.end();
  });

  describe('выбор строк', () => {
    // RULES §10-1: отправляются только PENDING, у которых наступило время попытки
    it('берёт PENDING с наступившим nextAttemptAt; SENT, SKIPPED и будущие не трогает', async () => {
      const t = new FakeTransport();
      const dispatcher = await startApp(t);
      const v = await vacation();
      const due = await mail(v, 'manager1');
      const sent = await mail(v, 'employee1', 'DECISION');
      const skipped = await mail(v, 'employee1', 'REMINDER');
      const future = await mail(v, 'hr');
      await pool.query(
        `UPDATE "OutboxMessage" SET status = 'SENT', "sentAt" = now() WHERE id = $1`,
        [sent],
      );
      await pool.query(
        `UPDATE "OutboxMessage" SET status = 'SKIPPED' WHERE id = $1`,
        [skipped],
      );
      await pool.query(
        `UPDATE "OutboxMessage" SET "nextAttemptAt" = now() + interval '1 hour' WHERE id = $1`,
        [future],
      );

      expect(await dispatcher.runOnce()).toBe(1);
      expect(t.sent.map((m) => m.to)).toEqual([email('manager1')]);
      expect((await row(due)).status).toBe('SENT');
      expect((await row(future)).status).toBe('PENDING');
      expect((await row(future)).attempts).toBe(0);
      expect(await dispatcher.runOnce()).toBe(0);
    });

    // RULES §10-1: проход берёт не больше 10 писем, остальные - следующим проходом
    it('пачка не больше 10 писем, остаток уходит следующим проходом', async () => {
      const t = new FakeTransport();
      const dispatcher = await startApp(t);
      const [v1, v2] = [
        await vacation(),
        await vacation('APPROVED', '2026-11-09'),
      ];
      const logins = Object.keys(ids) as RulesOrgKey[];
      for (const login of logins) await mail(v1, login);
      await mail(v2, 'director');

      expect(await dispatcher.runOnce()).toBe(10);
      expect(await dispatcher.runOnce()).toBe(2);
      expect(await dispatcher.runOnce()).toBe(0);
      expect(t.sent).toHaveLength(12);
    });
  });

  describe('отправка', () => {
    // RULES §8-1: письмо уходит через SMTP; §9-1: sentAt по системному времени БД
    it('успех: письмо получателю с темой и текстом из строки, status = SENT, sentAt по времени БД', async () => {
      const t = new FakeTransport();
      const dispatcher = await startApp(t);
      const id = await mail(await vacation(), 'manager1');

      await dispatcher.runOnce();

      expect(t.sent).toEqual([
        {
          from: MAIL_FROM,
          to: email('manager1'),
          subject: 'тема',
          text: 'текст',
        },
      ]);
      const r = await row(id);
      expect(r).toMatchObject({ status: 'SENT', attempts: 0, lastError: null });
      expect(r.sentAgoMs).toBeGreaterThanOrEqual(0);
      expect(r.sentAgoMs).toBeLessThan(5000);
    });

    // RULES §9-1, §10-1: при сбое повтор позже по системному времени, пауза нарастает
    it('сбой: attempts + 1, lastError, пауза от базы и удваивается', async () => {
      const t = new FakeTransport();
      t.failWith = new Error('connect ECONNREFUSED');
      const dispatcher = await startApp(t);
      const id = await mail(await vacation(), 'manager1');

      expect(await dispatcher.runOnce()).toBe(1);
      let r = await row(id);
      expect(r).toMatchObject({
        status: 'PENDING',
        attempts: 1,
        lastError: 'connect ECONNREFUSED',
        sentAt: null,
      });
      expect(r.dueInMs).toBeGreaterThan(BASE_MS - 5000);
      expect(r.dueInMs).toBeLessThanOrEqual(BASE_MS);

      // пауза не прошла - строка не берётся
      expect(await dispatcher.runOnce()).toBe(0);
      expect((await row(id)).attempts).toBe(1);

      await makeDue(id);
      await dispatcher.runOnce();
      r = await row(id);
      expect(r.attempts).toBe(2);
      expect(r.dueInMs).toBeGreaterThan(2 * BASE_MS - 5000);
      expect(r.dueInMs).toBeLessThanOrEqual(2 * BASE_MS);
    });

    // RULES §9-1: лимита попыток нет (DECISIONS 2026-10-26 00:43), пауза упирается в 5 минут
    it('20 сбоев подряд: строка остаётся PENDING, пауза не больше 5 минут', async () => {
      const t = new FakeTransport();
      t.failWith = new Error('SMTP недоступен');
      const dispatcher = await startApp(t);
      const id = await mail(await vacation(), 'manager1');

      for (let i = 0; i < 20; i += 1) {
        await makeDue(id);
        await dispatcher.runOnce();
      }

      const r = await row(id);
      expect(r).toMatchObject({ status: 'PENDING', attempts: 20 });
      expect(r.dueInMs).toBeGreaterThan(
        DEFAULT_OUTBOX_CONFIG.retryMaxMs - 5000,
      );
      expect(r.dueInMs).toBeLessThanOrEqual(DEFAULT_OUTBOX_CONFIG.retryMaxMs);

      t.failWith = null;
      await makeDue(id);
      await dispatcher.runOnce();
      expect((await row(id)).status).toBe('SENT');
      expect(t.sent).toHaveLength(1);
    });

    // RULES §10-1: при сбое проход останавливается, остальные письма не получают лишнюю попытку
    it('после сбоя остальные письма пачки ждут следующего прохода без attempts + 1', async () => {
      const t = new FakeTransport();
      t.failWith = new Error('SMTP недоступен');
      const dispatcher = await startApp(t);
      const v = await vacation();
      const first = await mail(v, 'manager1');
      const second = await mail(v, 'employee1', 'DECISION');

      await dispatcher.runOnce();

      expect((await row(first)).attempts).toBe(1);
      expect(await row(second)).toMatchObject({
        status: 'PENDING',
        attempts: 0,
      });
      expect((await row(second)).dueInMs).toBeLessThanOrEqual(0);

      t.failWith = null;
      expect(await dispatcher.runOnce()).toBe(1); // second; first ждёт паузу
      expect(t.sent.map((m) => m.to)).toEqual([email('employee1')]);
    });

    // RULES §10-1: диспетчер блокирует только строки outbox, не User и не Vacation (architecture, раздел 6)
    it('во время отправки User и Vacation письма не заблокированы', async () => {
      const t = new FakeTransport();
      t.delayMs = 300;
      const dispatcher = await startApp(t);
      const v = await vacation();
      await mail(v, 'manager1');

      const pass = dispatcher.runOnce();
      await tick(100);
      const lock = await pool.connect();
      try {
        await lock.query('BEGIN');
        await lock.query(
          `SELECT id FROM "User" WHERE id = $1 FOR UPDATE NOWAIT`,
          [ids.manager1],
        );
        await lock.query(
          `SELECT id FROM "Vacation" WHERE id = $1 FOR UPDATE NOWAIT`,
          [v],
        );
        await lock.query('ROLLBACK');
      } finally {
        lock.release();
      }
      expect(await pass).toBe(1);
    });
  });

  describe('напоминание: проверка в момент отправки', () => {
    // RULES §8-3: напоминание уходит, только если отпуск в момент отправки «Одобрена»
    it.each(['PENDING', 'CANCELLED', 'REJECTED', 'REPLACED'] as const)(
      'отпуск %s: REMINDER получает SKIPPED и не отправляется',
      async (status) => {
        const t = new FakeTransport();
        const dispatcher = await startApp(t, {}, new FakeClock(NOW));
        const id = await mail(await vacation(status), 'employee1', 'REMINDER');

        expect(await dispatcher.runOnce()).toBe(1);

        expect(t.sent).toEqual([]);
        expect(await row(id)).toMatchObject({
          status: 'SKIPPED',
          attempts: 0,
          sentAt: null,
        });
      },
    );

    // RULES §8-3, §8-4: одобренный, ещё не начавшийся отпуск - напоминание уходит;
    // «сегодня» по Clock и COMPANY_TZ: 2026-11-01T23:59:59.999 в Бишкеке
    it('APPROVED, сегодня накануне начала: REMINDER отправляется', async () => {
      const t = new FakeTransport();
      const clock = new FakeClock('2026-11-01T17:59:59.999Z');
      const dispatcher = await startApp(t, {}, clock);
      const id = await mail(
        await vacation('APPROVED', '2026-11-02'),
        'employee1',
        'REMINDER',
      );

      await dispatcher.runOnce();

      expect(t.sent.map((m) => m.to)).toEqual([email('employee1')]);
      expect((await row(id)).status).toBe('SENT');
    });

    // RULES §8-4: «если дата начала уже наступила (сегодня ≥ даты начала), напоминание не отправляется»;
    // 2026-11-01T18:00Z - это уже 2 ноября в Бишкеке
    it.each(['2026-11-01T18:00:00.000Z', '2026-11-05T03:00:00.000Z'])(
      'APPROVED, Clock %s (начало наступило): REMINDER получает SKIPPED',
      async (now) => {
        const t = new FakeTransport();
        const dispatcher = await startApp(t, {}, new FakeClock(now));
        const id = await mail(
          await vacation('APPROVED', '2026-11-02'),
          'employee1',
          'REMINDER',
        );

        await dispatcher.runOnce();

        expect(t.sent).toEqual([]);
        expect((await row(id)).status).toBe('SKIPPED');
      },
    );

    // RULES §8-2: письмо о новой заявке статус и дату отпуска не проверяет (architecture, раздел 10)
    it('NEW_REQUEST по начавшемуся отпуску отправляется', async () => {
      const t = new FakeTransport();
      const dispatcher = await startApp(
        t,
        {},
        new FakeClock('2026-11-05T03:00:00.000Z'),
      );
      await mail(await vacation('PENDING', '2026-11-02'), 'manager1');

      await dispatcher.runOnce();

      expect(t.sent.map((m) => m.to)).toEqual([email('manager1')]);
    });
  });

  describe('идемпотентность и параллельность', () => {
    // RULES §10-1: «письмо о событии уходит ровно одно»; два воркера - SKIP LOCKED
    it('два диспетчера параллельно: каждое письмо отправлено ровно один раз', async () => {
      const t = new FakeTransport();
      t.delayMs = 30;
      const a = await startApp(t);
      const b = await startApp(t);
      const v = await vacation();
      const logins: RulesOrgKey[] = [
        'manager1',
        'manager2',
        'hr',
        'deputy',
        'director',
      ];
      for (const login of logins) await mail(v, login);

      for (let i = 0; i < 5; i += 1) {
        await Promise.all([a.runOnce(), b.runOnce(), a.runOnce(), b.runOnce()]);
      }

      expect(t.sent.map((m) => m.to).sort()).toEqual(logins.map(email).sort());
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM "OutboxMessage" WHERE status = 'SENT'`,
      );
      expect(rows[0].n).toBe(5);
    });

    // RULES §10-1: перезапуск диспетчера между попытками не даёт дубля
    it('сбой, перезапуск, повтор: одно письмо', async () => {
      const failing = new FakeTransport();
      failing.failWith = new Error('SMTP недоступен');
      const first = await startApp(failing);
      const id = await mail(await vacation(), 'manager1');
      await first.runOnce();
      await apps.pop()!.close();

      const ok = new FakeTransport();
      const second = await startApp(ok);
      expect(await second.runOnce()).toBe(0); // пауза ещё идёт
      await makeDue(id);
      expect(await second.runOnce()).toBe(1);
      expect(await second.runOnce()).toBe(0);

      expect(failing.sent).toEqual([]);
      expect(ok.sent).toHaveLength(1);
      expect(await row(id)).toMatchObject({ status: 'SENT', attempts: 1 });
    });

    // RULES §9-1, §10-1: Mailpit недоступен при замороженных демо-часах; повтор по системному
    // времени, после восстановления ровно одно письмо, Clock не двигается
    it('SMTP недоступен при замороженных демо-часах: после восстановления одно письмо, часы стоят', async () => {
      const recovered = new FakeTransport();
      const transport = new SwitchableTransport(
        new SmtpMailTransport({
          ...DEFAULT_OUTBOX_CONFIG,
          smtpPort: await closedPort(),
        }),
      );
      const app = await createTestApp(
        {
          DEMO_MODE: 'true',
          MAIL_FROM,
          OUTBOX_RETRY_BASE_MS: '300',
          OUTBOX_RETRY_MAX_MS: '300',
        },
        (b) => b.overrideProvider(MailTransport).useValue(transport),
      );
      apps.push(app);
      const dispatcher = app.get(OutboxDispatcher);
      await setDbClock(pool, NOW);
      const clockInstant = async () =>
        (
          await pool.query(`SELECT instant FROM "ClockState" WHERE id = 1`)
        ).rows[0].instant.toISOString();

      const auth = bearer(await loginAs(app, 'employee1'));
      const res = await request(app.getHttpServer())
        .post('/vacations')
        .set(auth)
        .send({
          startDate: '2026-11-02',
          endDate: '2026-11-06',
          backstopperId: ids.employee2,
        });
      expect(res.status).toBe(201);
      const {
        rows: [{ id }],
      } = await pool.query(`SELECT id FROM "OutboxMessage"`);

      // настоящий SMTP-клиент на закрытый порт
      expect(await dispatcher.runOnce()).toBe(1);
      const failed = await row(id);
      expect(failed).toMatchObject({ status: 'PENDING', attempts: 1 });
      expect(failed.lastError).toEqual(expect.any(String));

      transport.current = recovered; // Mailpit снова доступен
      // повтор наступает по системному времени, демо-часы не трогаем
      const deadline = 5000;
      for (let waited = 0; recovered.sent.length === 0; waited += 50) {
        if (waited > deadline) throw new Error('повтор не наступил за 5 с');
        await dispatcher.runOnce();
        await tick(50);
      }
      await dispatcher.runOnce();

      expect(recovered.sent.map((m) => m.to)).toEqual([email('manager1')]);
      expect(await row(id)).toMatchObject({ status: 'SENT', attempts: 1 });
      expect(await clockInstant()).toBe(NOW);
      expect((await row(id)).createdAt.toISOString()).toBe(NOW);
    });
  });
});
