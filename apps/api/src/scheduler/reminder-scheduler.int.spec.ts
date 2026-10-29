/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- строки pg имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { MailTransport, type OutgoingMail } from '../mail/mail-transport';
import { OutboxDispatcher } from '../mail/outbox-dispatcher';
import { passwordHash, setDbClock } from '../testing/int-helpers';
import { createTestApp, testEnv } from '../testing/test-app';
import {
  RulesOrgKey,
  createPool,
  insertVacation,
  seedRulesOrg,
  truncateAll,
} from '../testing/test-db';
import { ReminderScheduler } from './reminder-scheduler';
import { ReminderWorker } from './reminder-worker';

// Отпуск вт 2026-11-10 – пт 2026-11-13, N = 3: дата напоминания чт 2026-11-05 (RULES §8-3).
// Моменты — по Бишкеку (UTC+6).
const START = '2026-11-10';
const END = '2026-11-13';
const REM_0859 = '2026-11-05T02:59:00.000Z';
const REM_0900 = '2026-11-05T03:00:00.000Z';
const REM_1730 = '2026-11-05T11:30:00.000Z';
const DAY_AFTER_0800 = '2026-11-06T02:00:00.000Z';
const BEFORE = '2026-11-01T03:00:00.000Z';
const START_0900 = '2026-11-10T03:00:00.000Z';

class FakeTransport extends MailTransport {
  sent: OutgoingMail[] = [];
  send(mail: OutgoingMail): Promise<void> {
    this.sent.push(mail);
    return Promise.resolve();
  }
}

interface ReminderRow {
  recipientId: number;
  subject: string;
  body: string;
  createdAt: Date;
  status: string;
}

describe('планировщик напоминаний (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let transport: FakeTransport;
  let ids: Record<RulesOrgKey, number>;

  type Status = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REPLACED';
  const vacation = (
    who: RulesOrgKey,
    o: {
      start?: string;
      end?: string;
      status?: Status;
      replacesId?: number;
    } = {},
  ) =>
    insertVacation(pool, {
      employeeId: ids[who],
      backstopperId: who === 'employee2' ? ids.employee1 : ids.employee2,
      start: o.start ?? START,
      end: o.end ?? END,
      workDays: 4,
      status: o.status ?? 'APPROVED',
      replacesId: o.replacesId,
    });
  const reminders = async (vacationId: number): Promise<ReminderRow[]> =>
    (
      await pool.query(
        `SELECT "recipientId", subject, body, "createdAt", status FROM "OutboxMessage"
         WHERE type = 'REMINDER' AND "vacationId" = $1 ORDER BY "recipientId"`,
        [vacationId],
      )
    ).rows;
  const recipients = async (vacationId: number) =>
    (await reminders(vacationId)).map((r) => r.recipientId);
  const setStatus = (vacationId: number, status: Status) =>
    pool.query(
      `UPDATE "Vacation" SET status = $2::"VacationStatus" WHERE id = $1`,
      [vacationId, status],
    );
  /** Часы на момент и проход планировщика, как после PUT /clock (RULES §9-4). */
  const passAt = async (instant: string) => {
    await setDbClock(pool, instant);
    return app.get(ReminderScheduler).pass();
  };
  /** Старт сервиса: проход ReminderWorker при bootstrap (RULES §9-4). */
  const startServiceAt = async (instant: string) => {
    await setDbClock(pool, instant);
    const worker = new ReminderWorker(
      app.get(ReminderScheduler),
      testEnv({ DEMO_MODE: 'true' }),
    );
    await worker.onApplicationBootstrap();
    await worker.onModuleDestroy();
  };

  beforeAll(async () => {
    pool = createPool();
    transport = new FakeTransport();
    app = await createTestApp({ DEMO_MODE: 'true' }, (b) =>
      b.overrideProvider(MailTransport).useValue(transport),
    );
  });

  beforeEach(async () => {
    await truncateAll(pool);
    ids = await seedRulesOrg(pool, await passwordHash());
    transport.sent = [];
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('время прохода (RULES §8-3, §8-4)', () => {
    // RULES §8-3: в 09:00 по поясу компании, не раньше
    it('дата напоминания сегодня, 08:59 → напоминаний нет', async () => {
      const id = await vacation('employee1');
      await passAt(REM_0859);
      expect(await reminders(id)).toEqual([]);
    });

    // RULES §8-3: перемотка часов на дату напоминания 09:00 → 2 письма (аудит 2, F-1)
    it('дата напоминания сегодня, 09:00 → сотруднику и руководителю, по одному', async () => {
      const id = await vacation('employee1');
      expect(await passAt(REM_0900)).toBe(1);
      const rows = await reminders(id);
      expect(rows.map((r) => r.recipientId)).toEqual([
        ids.manager1,
        ids.employee1,
      ]);
      const toEmployee = rows.find((r) => r.recipientId === ids.employee1)!;
      const toManager = rows.find((r) => r.recipientId === ids.manager1)!;
      expect(toEmployee).toMatchObject({
        status: 'PENDING',
        subject: 'Напоминание: отпуск 2026-11-10–2026-11-13',
        body: [
          'Ваш отпуск с 2026-11-10 по 2026-11-13 скоро начнётся.',
          'Рабочих дней: 4. Заменяющий: Сотрудник employee2.',
        ].join('\n'),
      });
      expect(toManager).toMatchObject({
        status: 'PENDING',
        subject:
          'Напоминание: отпуск Сотрудник employee1, 2026-11-10–2026-11-13',
        body: [
          'Сотрудник employee1 уходит в отпуск с 2026-11-10 по 2026-11-13.',
          'Рабочих дней: 4. Заменяющий: Сотрудник employee2.',
        ].join('\n'),
      });
      // RULES §9-1: момент письма — по Clock
      for (const r of rows) expect(r.createdAt.toISOString()).toBe(REM_0900);
    });

    // RULES §8-3: после 09:00 в тот же день — тоже
    it('дата напоминания сегодня, 17:30 → 2', async () => {
      const id = await vacation('employee1');
      await passAt(REM_1730);
      expect(await reminders(id)).toHaveLength(2);
    });

    // RULES §8-3; DECISIONS 2026-10-22 15:35: просроченное — на очередном проходе, даже до 09:00
    it('дата напоминания прошла, отпуск не начался → 2', async () => {
      const id = await vacation('employee1');
      await passAt(DAY_AFTER_0800);
      expect(await reminders(id)).toHaveLength(2);
    });

    // RULES §8-4: дата начала наступила — напоминание не создаётся
    it.each([
      ['день начала', START_0900],
      ['отпуск идёт', '2026-11-12T03:00:00.000Z'],
      ['отпуск прошёл', '2026-11-20T03:00:00.000Z'],
    ])('%s → напоминаний нет', async (_name, instant) => {
      const id = await vacation('employee1');
      await passAt(instant);
      expect(await reminders(id)).toEqual([]);
    });

    // RULES §8-3: дата напоминания впереди — рано
    it('дата напоминания впереди → напоминаний нет', async () => {
      const id = await vacation('employee1');
      await passAt(BEFORE);
      expect(await reminders(id)).toEqual([]);
    });
  });

  describe('статус отпуска (RULES §8-3)', () => {
    // RULES §8-3: только «Одобрена»
    it.each(['PENDING', 'REJECTED', 'CANCELLED', 'REPLACED'] as const)(
      'статус %s → напоминаний нет',
      async (status) => {
        const id = await vacation('employee1', { status });
        await passAt(REM_0900);
        expect(await reminders(id)).toEqual([]);
      },
    );

    // RULES §8-3, §8-8: отмена после постановки — проверка в момент отправки, письма нет
    it('отмена до отправки: строки SKIPPED, писем нет', async () => {
      const id = await vacation('employee1');
      await passAt(REM_0900);
      await setStatus(id, 'CANCELLED');
      await app.get(OutboxDispatcher).runOnce();
      expect(transport.sent).toEqual([]);
      expect((await reminders(id)).map((r) => r.status)).toEqual([
        'SKIPPED',
        'SKIPPED',
      ]);
    });

    // RULES §8-3 «Перенос»: до утверждения старое может уйти, после — нет; у нового одно своё
    it('перенос: старое до утверждения ставится, после утверждения не уходит; новое одно', async () => {
      const oldId = await vacation('employee1');
      // перенос вт 2026-11-17 – пт 2026-11-20: дата напоминания чт 2026-11-12
      const newId = await vacation('employee1', {
        start: '2026-11-17',
        end: '2026-11-20',
        status: 'PENDING',
        replacesId: oldId,
      });
      await passAt(REM_0900);
      expect(await reminders(oldId)).toHaveLength(2);
      expect(await reminders(newId)).toEqual([]);

      // утверждение переноса: старый «Заменена переносом», новый «Одобрена»
      await setStatus(oldId, 'REPLACED');
      await setStatus(newId, 'APPROVED');
      await app.get(OutboxDispatcher).runOnce();
      expect(transport.sent).toEqual([]);
      expect((await reminders(oldId)).map((r) => r.status)).toEqual([
        'SKIPPED',
        'SKIPPED',
      ]);

      await passAt('2026-11-12T03:00:00.000Z');
      expect(await reminders(oldId)).toHaveLength(2);
      expect(await recipients(newId)).toEqual([ids.manager1, ids.employee1]);
    });
  });

  describe('получатели (RULES §8-3, §8-5, §8-6)', () => {
    // RULES §8-5: у директора руководителя нет — только он сам
    it('директор: напоминание только себе', async () => {
      const id = await vacation('director');
      await passAt(REM_0900);
      expect(await recipients(id)).toEqual([ids.director]);
    });

    // RULES §8-6: по своему отпуску HR — обычный сотрудник; её руководитель тоже получает
    it('отпуск HR: HR и заместитель директора', async () => {
      const id = await vacation('hr');
      await passAt(REM_0900);
      expect(await recipients(id)).toEqual([ids.deputy, ids.hr]);
    });

    // RULES §8-6, §3-3: HR и backstopper по чужому отпуску напоминаний не получают
    it('отпуск сотрудника: HR, backstopper, заместитель и директор не получают', async () => {
      const id = await vacation('employee1');
      await passAt(REM_0900);
      const got = await recipients(id);
      for (const who of ['hr', 'employee2', 'deputy', 'director'] as const) {
        expect(got).not.toContain(ids[who]);
      }
    });

    // RULES §8-5: руководитель получает по каждому подчинённому, руководитель руководителя — нет
    it('отпуск руководителя: сам и его руководитель (заместитель)', async () => {
      const id = await vacation('manager2');
      await passAt(REM_0900);
      expect(await recipients(id)).toEqual([ids.deputy, ids.manager2]);
    });
  });

  describe('без дублей (RULES §10-1, §9-5)', () => {
    // RULES §10-1: повторный проход
    it('три прохода подряд → по-прежнему 2', async () => {
      const id = await vacation('employee1');
      await passAt(REM_0900);
      await passAt(REM_0900);
      await passAt(REM_1730);
      expect(await reminders(id)).toHaveLength(2);
    });

    // RULES §9-5, §10-1: откат часов и повторная перемотка
    it('перемотка через 09:00, откат назад, снова вперёд → одно напоминание на получателя', async () => {
      const id = await vacation('employee1');
      await passAt(REM_0859);
      expect(await reminders(id)).toEqual([]);
      await passAt(REM_0900);
      await passAt(BEFORE);
      await passAt(REM_0900);
      await passAt(DAY_AFTER_0800);
      expect(await recipients(id)).toEqual([ids.manager1, ids.employee1]);
    });

    // RULES §10-1: после отправки повторный проход не создаёт и не отправляет второе письмо
    it('после отправки: повторный проход и диспетчер второго письма не дают', async () => {
      const id = await vacation('employee1');
      await passAt(REM_0900);
      const dispatcher = app.get(OutboxDispatcher);
      await dispatcher.runOnce();
      expect(transport.sent.map((m) => m.to).sort()).toEqual([
        'employee1@vacation.local',
        'manager1@vacation.local',
      ]);
      await passAt(DAY_AFTER_0800);
      await dispatcher.runOnce();
      expect(transport.sent).toHaveLength(2);
      expect((await reminders(id)).map((r) => r.status)).toEqual([
        'SENT',
        'SENT',
      ]);
    });

    // Н-8 (DECISIONS 2026-10-29 07:08): новый id отпуска — новое напоминание
    it('отмена и новая заявка на те же даты (новый id) → напоминание по новому отпуску', async () => {
      const first = await vacation('employee1');
      await passAt(REM_0900);
      await setStatus(first, 'CANCELLED');
      const second = await vacation('employee1');
      await passAt(REM_1730);
      expect(await reminders(first)).toHaveLength(2);
      expect(await recipients(second)).toEqual([ids.manager1, ids.employee1]);
    });

    // Н-8, DECISIONS 2026-10-29 10:49: новый руководитель получает своё, строка прежнего остаётся
    it('сменился руководитель → новому одно напоминание, прежнему не перенаправляется', async () => {
      const id = await vacation('employee1');
      await passAt(REM_0900);
      await pool.query(`UPDATE "User" SET "managerId" = $2 WHERE id = $1`, [
        ids.employee1,
        ids.manager2,
      ]);
      await passAt(REM_1730);
      expect(await recipients(id)).toEqual([
        ids.manager1,
        ids.manager2,
        ids.employee1,
      ]);
    });
  });

  describe('старт сервиса (RULES §9-4; DECISIONS 2026-10-22 15:35)', () => {
    // RULES §8-3: при старте до 09:00 в день напоминания — ждём 09:00
    it('старт в 08:00 при дате напоминания сегодня → письма нет до 09:00', async () => {
      const id = await vacation('employee1');
      await startServiceAt('2026-11-05T02:00:00.000Z');
      expect(await reminders(id)).toEqual([]);
      await passAt(REM_0900);
      expect(await reminders(id)).toHaveLength(2);
    });

    // DECISIONS 2026-10-22 15:35: просроченное создаётся при старте; отправка — за диспетчером
    it('старт при дате напоминания вчера → строки созданы, планировщик сам не отправляет', async () => {
      const id = await vacation('employee1');
      await startServiceAt(DAY_AFTER_0800);
      expect((await reminders(id)).map((r) => r.status)).toEqual([
        'PENDING',
        'PENDING',
      ]);
      expect(transport.sent).toEqual([]);
    });

    // RULES §10-1: перезапуск не дублирует
    it('повторный старт → без дубля', async () => {
      const id = await vacation('employee1');
      await startServiceAt(DAY_AFTER_0800);
      await startServiceAt(DAY_AFTER_0800);
      expect(await reminders(id)).toHaveLength(2);
    });
  });

  describe('REMINDER_DAYS (RULES §8-3)', () => {
    // RULES §8-3: N задаётся окружением
    it('REMINDER_DAYS=1: дата напоминания — пн 2026-11-09', async () => {
      const other = await createTestApp({
        DEMO_MODE: 'true',
        REMINDER_DAYS: '1',
      });
      try {
        const id = await vacation('employee1');
        await setDbClock(pool, REM_0900);
        await other.get(ReminderScheduler).pass();
        expect(await reminders(id)).toEqual([]);
        await setDbClock(pool, '2026-11-09T03:00:00.000Z');
        await other.get(ReminderScheduler).pass();
        expect(await reminders(id)).toHaveLength(2);
      } finally {
        await other.close();
      }
    });
  });
});
