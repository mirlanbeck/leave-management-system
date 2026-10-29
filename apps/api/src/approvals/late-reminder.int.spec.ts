/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- тела ответов supertest и строки pg имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { MailTransport, type OutgoingMail } from '../mail/mail-transport';
import { OutboxDispatcher } from '../mail/outbox-dispatcher';
import { ReminderScheduler } from '../scheduler/reminder-scheduler';
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

// Отпуск вт 2026-11-10 – пт 2026-11-13, N = 3: дата напоминания чт 2026-11-05 (RULES §8-3).
// Моменты — по Бишкеку (UTC+6).
const START = '2026-11-10';
const END = '2026-11-13';
const REM_0800 = '2026-11-05T02:00:00.000Z';
const REM_0900 = '2026-11-05T03:00:00.000Z';
const REM_1000 = '2026-11-05T04:00:00.000Z';
const DAY_AFTER = '2026-11-06T05:15:00.000Z';
const EVE_OF_START = '2026-11-09T12:00:00.000Z';
const START_DAY = '2026-11-10T04:00:00.000Z';
const DAY_BEFORE_REM = '2026-11-04T05:00:00.000Z';

class FakeTransport extends MailTransport {
  sent: OutgoingMail[] = [];
  send(mail: OutgoingMail): Promise<void> {
    this.sent.push(mail);
    return Promise.resolve();
  }
}

describe('немедленное напоминание при позднем одобрении (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let transport: FakeTransport;
  let ids: Record<RulesOrgKey, number>;
  let tokens: Partial<Record<RulesOrgKey, string>>;

  const token = async (login: RulesOrgKey) =>
    (tokens[login] ??= await loginAs(app, login));
  // токен берётся до создания запроса: вход закрывает временный сервер supertest
  const post = async (login: RulesOrgKey, path: string, body: object = {}) => {
    const auth = bearer(await token(login));
    return request(app.getHttpServer()).post(path).set(auth).send(body);
  };
  const backstopperOf = (who: RulesOrgKey) =>
    who === 'employee2' ? ids.employee1 : ids.employee2;
  const pending = (who: RulesOrgKey, start = START, end = END) =>
    insertVacation(pool, {
      employeeId: ids[who],
      backstopperId: backstopperOf(who),
      start,
      end,
      workDays: 4,
    });
  const mails = async (vacationId: number, type: string) =>
    (
      await pool.query(
        `SELECT "recipientId", "createdAt", status FROM "OutboxMessage"
         WHERE "vacationId" = $1 AND type = $2::"MailType" ORDER BY "recipientId"`,
        [vacationId, type],
      )
    ).rows as { recipientId: number; createdAt: Date; status: string }[];
  const reminderRecipients = async (vacationId: number) =>
    (await mails(vacationId, 'REMINDER')).map((r) => r.recipientId);
  const decidedAt = async (vacationId: number): Promise<Date> =>
    (
      await pool.query(`SELECT "decidedAt" FROM "Vacation" WHERE id = $1`, [
        vacationId,
      ])
    ).rows[0].decidedAt;
  /** Одобрение в момент `instant` по демо-часам. */
  const approveAt = async (
    instant: string,
    approver: RulesOrgKey,
    id: number,
  ) => {
    await setDbClock(pool, instant);
    const res = await post(approver, `/vacations/${id}/approve`);
    expect(res.status).toBe(200);
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
    tokens = {};
    transport.sent = [];
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('обычная заявка (RULES §8-3)', () => {
    // RULES §8-3: одобрение в 08:00 в день напоминания → письмо сразу, ожидания 09:00 нет
    // (аудит 2, F-1: «одобрение, когда дата напоминания = сегодня → 2 письма сразу»)
    it('дата напоминания сегодня, 08:00 → 2 сразу; проход в 09:00 дубля не даёт', async () => {
      const id = await pending('employee1');
      await approveAt(REM_0800, 'manager1', id);
      const rows = await mails(id, 'REMINDER');
      expect(rows.map((r) => r.recipientId)).toEqual([
        ids.manager1,
        ids.employee1,
      ]);
      // RULES §9-1: момент письма = момент решения по Clock
      const at = (await decidedAt(id)).toISOString();
      expect(at).toBe(REM_0800);
      for (const r of rows) expect(r.createdAt.toISOString()).toBe(at);

      await setDbClock(pool, REM_0900);
      await app.get(ReminderScheduler).pass();
      expect(await mails(id, 'REMINDER')).toHaveLength(2);
    });

    // RULES §8-3: и после 09:00 в день напоминания
    it('дата напоминания сегодня, 10:00 → 2 сразу', async () => {
      const id = await pending('employee1');
      await approveAt(REM_1000, 'manager1', id);
      expect(await reminderRecipients(id)).toEqual([
        ids.manager1,
        ids.employee1,
      ]);
    });

    // RULES §8-3: дата напоминания прошла (одобрение менее чем за N рабочих дней)
    it.each([
      ['на следующий день после даты напоминания', DAY_AFTER],
      ['накануне начала', EVE_OF_START],
    ])('%s → 2 сразу', async (_name, instant) => {
      const id = await pending('employee1');
      await approveAt(instant, 'manager1', id);
      expect(await mails(id, 'REMINDER')).toHaveLength(2);
    });

    // RULES §8-4: дата начала наступила — напоминания нет, письмо о решении как обычно
    it('одобрение в день начала → напоминания нет, DECISION есть', async () => {
      const id = await pending('employee1');
      await approveAt(START_DAY, 'manager1', id);
      expect(await mails(id, 'REMINDER')).toEqual([]);
      expect(await mails(id, 'DECISION')).toHaveLength(1);
    });

    // RULES §8-3: одобрено вовремя — плановое напоминание в 09:00 даты напоминания
    it('дата напоминания впереди → хук не ставит, проход в 09:00 даты напоминания ставит', async () => {
      const id = await pending('employee1');
      await approveAt(DAY_BEFORE_REM, 'manager1', id);
      expect(await mails(id, 'REMINDER')).toEqual([]);
      await setDbClock(pool, REM_0900);
      await app.get(ReminderScheduler).pass();
      expect(await mails(id, 'REMINDER')).toHaveLength(2);
    });

    // RULES §8-3: отклонение напоминания не даёт
    it('отклонение при поздней дате → напоминания нет', async () => {
      const id = await pending('employee1');
      await setDbClock(pool, DAY_AFTER);
      expect((await post('manager1', `/vacations/${id}/reject`)).status).toBe(
        200,
      );
      expect(await mails(id, 'REMINDER')).toEqual([]);
    });

    // RULES §8-5, §4-2: заявку директора одобряет HR — напоминание только директору
    it('заявка директора, одобрение HR поздно → только директор', async () => {
      const id = await pending('director');
      await approveAt(DAY_AFTER, 'hr', id);
      expect(await reminderRecipients(id)).toEqual([ids.director]);
    });

    // RULES §8-6: своя заявка HR — HR и её руководитель (заместитель директора)
    it('заявка HR, одобрение заместителем поздно → HR и заместитель', async () => {
      const id = await pending('hr');
      await approveAt(DAY_AFTER, 'deputy', id);
      expect(await reminderRecipients(id)).toEqual([ids.deputy, ids.hr]);
    });

    // RULES §10-1: двойной клик — одно напоминание на получателя
    it('два параллельных approve поздно → 200 и 409, по одному напоминанию', async () => {
      const id = await pending('employee1');
      await setDbClock(pool, DAY_AFTER);
      await token('manager1');
      const results = await Promise.all([
        post('manager1', `/vacations/${id}/approve`),
        post('manager1', `/vacations/${id}/approve`),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await mails(id, 'REMINDER')).toHaveLength(2);
    });

    // RULES §8-2, §8-3, §9-1: диспетчер доставляет решение и оба напоминания
    it('доставка: письмо о решении сотруднику и напоминания сотруднику и руководителю', async () => {
      const id = await pending('employee1');
      await approveAt(REM_0800, 'manager1', id);
      await app.get(OutboxDispatcher).runOnce();
      expect(transport.sent.map((m) => [m.to, m.subject]).sort()).toEqual([
        [
          'employee1@vacation.local',
          'Заявка на отпуск одобрена: 2026-11-10–2026-11-13',
        ],
        [
          'employee1@vacation.local',
          'Напоминание: отпуск 2026-11-10–2026-11-13',
        ],
        [
          'manager1@vacation.local',
          'Напоминание: отпуск Сотрудник employee1, 2026-11-10–2026-11-13',
        ],
      ]);
    });
  });

  describe('утверждение переноса (RULES §8-3 «Перенос»; Н-7)', () => {
    /** Одобренный отпуск со списанием, пн 2026-11-23 – чт 2026-11-26 (напоминание 2026-11-18). */
    const approvedSource = async () => {
      const id = await insertVacation(pool, {
        employeeId: ids.employee1,
        backstopperId: ids.employee2,
        start: '2026-11-23',
        end: '2026-11-26',
        workDays: 4,
        status: 'APPROVED',
      });
      await insertLedger(pool, { kind: 'DEBIT', vacationId: id, halfDays: 8 });
      return id;
    };
    const transfer = async (
      sourceId: number,
      startDate = START,
      endDate = END,
    ) => {
      const res = await post('employee1', `/vacations/${sourceId}/transfer`, {
        startDate,
        endDate,
        backstopperId: ids.employee2,
      });
      expect(res.status).toBe(201);
      return res.body.id as number;
    };

    // Н-7 (DECISIONS 2026-10-29 07:08): дата напоминания по новым датам прошла → сразу
    it('перенос на даты, у которых дата напоминания прошла → 2 по новому отпуску, 0 по старому', async () => {
      const source = await approvedSource();
      await setDbClock(pool, DAY_AFTER);
      const moved = await transfer(source);
      await approveAt(DAY_AFTER, 'manager1', moved);
      expect(await reminderRecipients(moved)).toEqual([
        ids.manager1,
        ids.employee1,
      ]);
      expect(await mails(source, 'REMINDER')).toEqual([]);
    });

    // RULES §8-3 «Перенос»: дата напоминания по новым датам сегодня, до 09:00 → тоже сразу
    it('перенос, дата напоминания по новым датам сегодня, 08:00 → 2 сразу', async () => {
      const source = await approvedSource();
      await setDbClock(pool, REM_0800);
      const moved = await transfer(source);
      await approveAt(REM_0800, 'manager1', moved);
      expect(await mails(moved, 'REMINDER')).toHaveLength(2);
    });

    // RULES §8-3 «Перенос»: утверждено вовремя — плановое напоминание по новым датам, одно
    it('перенос, дата напоминания по новым датам впереди → хук не ставит, проход ставит одно', async () => {
      const source = await approvedSource();
      await setDbClock(pool, DAY_BEFORE_REM);
      const moved = await transfer(source);
      await approveAt(DAY_BEFORE_REM, 'manager1', moved);
      expect(await mails(moved, 'REMINDER')).toEqual([]);
      await setDbClock(pool, REM_0900);
      await app.get(ReminderScheduler).pass();
      await setDbClock(pool, '2026-11-18T03:00:00.000Z');
      await app.get(ReminderScheduler).pass();
      expect(await mails(moved, 'REMINDER')).toHaveLength(2);
      // старый «Заменена переносом» — его напоминание не ставится и в его дату
      expect(await mails(source, 'REMINDER')).toEqual([]);
    });
  });
});
