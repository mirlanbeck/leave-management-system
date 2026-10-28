/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- тела ответов supertest и строки pg имеют тип any */
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import request from 'supertest';
import { addDays } from '../domain';
import { MailTransport, type OutgoingMail } from '../mail/mail-transport';
import { OutboxDispatcher } from '../mail/outbox-dispatcher';
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
  insertMail,
  insertVacation,
  seedRulesOrg,
  truncateAll,
} from '../testing/test-db';
import { VacationApprovedHook } from './vacation-approved.hook';

// Среда 2026-10-21, 09:17:42.123 по Бишкеку; у всех заявителей дней хватает на 5 рабочих дней
const NOW = '2026-10-21T03:17:42.123Z';

/** Подменный транспорт: запоминает отправленные письма. */
class FakeTransport extends MailTransport {
  sent: OutgoingMail[] = [];
  send(mail: OutgoingMail): Promise<void> {
    this.sent.push(mail);
    return Promise.resolve();
  }
}

interface MailRow {
  type: string;
  recipientId: number;
  subject: string;
  body: string;
  createdAt: Date;
  status: string;
}

describe('письмо о решении DECISION (integration, нужен Postgres)', () => {
  let pool: Pool;
  let app: INestApplication;
  let transport: FakeTransport;
  let ids: Record<RulesOrgKey, number>;
  let tokens: Partial<Record<RulesOrgKey, string>>;

  const token = async (login: RulesOrgKey) =>
    (tokens[login] ??= await loginAs(app, login));
  // токен берётся до создания запроса: вход закрывает временный сервер supertest
  const decide = async (
    login: RulesOrgKey,
    id: number,
    decision: 'approve' | 'reject',
    comment?: string,
  ) => {
    const auth = bearer(await token(login));
    return request(app.getHttpServer())
      .post(`/vacations/${id}/${decision}`)
      .set(auth)
      .send(comment === undefined ? {} : { comment });
  };
  /** Заявка PENDING на 5 рабочих дней (по умолчанию пн–пт 2026-11-02…06). */
  const vacation = (who: RulesOrgKey, start = '2026-11-02') =>
    insertVacation(pool, {
      employeeId: ids[who],
      backstopperId: who === 'employee2' ? ids.employee1 : ids.employee2,
      start,
      end: addDays(start, 4),
      workDays: 5,
    });
  const mails = async (vacationId: number): Promise<MailRow[]> =>
    (
      await pool.query(
        `SELECT type, "recipientId", subject, body, "createdAt", status
         FROM "OutboxMessage" WHERE "vacationId" = $1 ORDER BY id`,
        [vacationId],
      )
    ).rows;
  const decidedAt = async (vacationId: number): Promise<Date> =>
    (
      await pool.query(`SELECT "decidedAt" FROM "Vacation" WHERE id = $1`, [
        vacationId,
      ])
    ).rows[0].decidedAt;
  const statusOf = async (vacationId: number) =>
    (
      await pool.query(`SELECT status FROM "Vacation" WHERE id = $1`, [
        vacationId,
      ])
    ).rows[0].status;
  const debitCount = async (vacationId: number) =>
    Number(
      (
        await pool.query(
          `SELECT count(*) AS n FROM "LedgerEntry" WHERE "vacationId" = $1`,
          [vacationId],
        )
      ).rows[0].n,
    );

  beforeAll(async () => {
    pool = createPool();
    transport = new FakeTransport();
    app = await createTestApp({ DEMO_MODE: 'true' }, (b) =>
      b.overrideProvider(MailTransport).useValue(transport),
    );
  });

  beforeEach(async () => {
    await truncateAll(pool);
    await setDbClock(pool, NOW);
    ids = await seedRulesOrg(pool, await passwordHash());
    tokens = {};
    transport.sent = [];
  });

  afterEach(() => jest.restoreAllMocks());

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  describe('получатель и текст', () => {
    // RULES §8-2, §9-1: решение → сотруднику, одно письмо; момент письма = момент решения по Clock
    it('одобрение: одно письмо сотруднику, createdAt = decidedAt = Clock', async () => {
      const id = await vacation('employee1');
      expect((await decide('manager1', id, 'approve')).status).toBe(200);
      const rows = await mails(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'DECISION',
        recipientId: ids.employee1,
        status: 'PENDING',
        subject: 'Заявка на отпуск одобрена: 2026-11-02–2026-11-06',
        body: [
          'Ваша заявка на отпуск с 2026-11-02 по 2026-11-06 одобрена.',
          'Рабочих дней: 5. Решение принял(а): Сотрудник manager1.',
        ].join('\n'),
      });
      expect(rows[0].createdAt.toISOString()).toBe(NOW);
      expect((await decidedAt(id)).toISOString()).toBe(NOW);
    });

    // RULES §3-3, §8-2, §8-6: backstopper, руководитель и HR писем о решении не получают
    it('руководитель, backstopper и HR письма о решении не получают', async () => {
      const approved = await vacation('employee1');
      const rejected = await vacation('employee1', '2026-11-16');
      await decide('manager1', approved, 'approve');
      await decide('manager1', rejected, 'reject');
      for (const id of [approved, rejected]) {
        expect((await mails(id)).map((m) => m.recipientId)).toEqual([
          ids.employee1,
        ]);
      }
    });

    // RULES §8-2, §4-1: отклонение - то же письмо о решении, с комментарием согласующего
    it('отклонение: одно письмо «отклонена» с комментарием, createdAt по Clock', async () => {
      const id = await vacation('employee1');
      await decide('manager1', id, 'reject', '  перенесите на декабрь  ');
      const rows = await mails(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: 'DECISION',
        recipientId: ids.employee1,
        subject: 'Заявка на отпуск отклонена: 2026-11-02–2026-11-06',
        body: [
          'Ваша заявка на отпуск с 2026-11-02 по 2026-11-06 отклонена.',
          'Рабочих дней: 5. Решение принял(а): Сотрудник manager1.',
          'Комментарий: перенесите на декабрь',
        ].join('\n'),
      });
      expect(rows[0].createdAt.toISOString()).toBe(NOW);
    });

    // RULES §4-2, §8-2: заявку директора решает HR («допуск HR»), письмо о решении - директору
    it.each([
      ['approve', 'одобрена'],
      ['reject', 'отклонена'],
    ] as const)(
      'заявка директора (%s): письмо директору с «Допуск HR», HR письма нет',
      async (decision, word) => {
        const id = await vacation('director');
        expect((await decide('hr', id, decision)).status).toBe(200);
        const rows = await mails(id);
        expect(rows).toHaveLength(1);
        expect(rows[0].recipientId).toBe(ids.director);
        expect(rows[0].subject).toBe(
          `Допуск HR: заявка на отпуск ${word}, 2026-11-02–2026-11-06`,
        );
        expect(rows[0].body.split('\n').at(-1)).toBe(
          'Решение по заявке директора принимает HR (допуск HR).',
        );
      },
    );

    // RULES §8-2, §8-6: по своей заявке HR - обычный сотрудник и получает письмо о решении
    it('заместитель решает заявку HR: письмо получает HR', async () => {
      const id = await vacation('hr');
      expect((await decide('deputy', id, 'approve')).status).toBe(200);
      const rows = await mails(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].recipientId).toBe(ids.hr);
      expect(rows[0].subject).toBe(
        'Заявка на отпуск одобрена: 2026-11-02–2026-11-06',
      );
    });
  });

  describe('ровно одно письмо (RULES §10-1)', () => {
    // RULES §10-1: повторное решение - «уже обработана», второго письма нет, текст не меняется
    it.each([
      ['approve', 'approve', 'одобрена'],
      ['approve', 'reject', 'одобрена'],
      ['reject', 'approve', 'отклонена'],
    ] as const)(
      'повтор %s → %s: 409, одно письмо «%s»',
      async (first, second, word) => {
        const id = await vacation('employee1');
        expect((await decide('manager1', id, first)).status).toBe(200);
        expect((await decide('manager1', id, second)).status).toBe(409);
        const rows = await mails(id);
        expect(rows).toHaveLength(1);
        expect(rows[0].subject).toContain(word);
      },
    );

    // RULES §4-3: нехватка дней - решения нет, письма нет
    it('422 при нехватке дней: письма нет', async () => {
      // 44 рабочих дня (2026-11-02…12-31), а у employee1 к 2 ноября 40 (37,5 + 2,5)
      const id = await insertVacation(pool, {
        employeeId: ids.employee1,
        backstopperId: ids.employee2,
        start: '2026-11-02',
        end: '2026-12-31',
        workDays: 44,
      });
      expect((await decide('manager1', id, 'approve')).status).toBe(422);
      expect(await mails(id)).toHaveLength(0);
    });

    // RULES §8-3, §10-1: ключ «тип + отпуск + получатель» - последняя линия против дубля
    it('строка DECISION уже есть: решение проходит, второй строки нет', async () => {
      const id = await vacation('employee1');
      await insertMail(pool, {
        type: 'DECISION',
        vacationId: id,
        recipientId: ids.employee1,
      });
      expect((await decide('manager1', id, 'approve')).status).toBe(200);
      expect(await mails(id)).toHaveLength(1);
    });

    // RULES §10-1: хук работает внутри транзакции одобрения - его сбой откатывает решение
    it('сбой хука onVacationApproved: 500, заявка PENDING, ни списания, ни письма', async () => {
      jest
        .spyOn(app.get(VacationApprovedHook), 'onVacationApproved')
        .mockRejectedValueOnce(new Error('сбой хука'));
      const id = await vacation('employee1');
      expect((await decide('manager1', id, 'approve')).status).toBe(500);
      expect(await statusOf(id)).toBe('PENDING');
      expect(await debitCount(id)).toBe(0);
      expect(await mails(id)).toHaveLength(0);
    });

    // RULES §10-1: двойной клик - одно письмо
    it('два параллельных approve: 200 и 409, одно письмо', async () => {
      const id = await vacation('employee1');
      await token('manager1');
      const results = await Promise.all([
        decide('manager1', id, 'approve'),
        decide('manager1', id, 'approve'),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const rows = await mails(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].subject).toContain('одобрена');
    });

    // RULES §10-1: approve и reject одновременно - одно письмо, текст соответствует итоговому статусу
    it('параллельные approve и reject: одно письмо по итоговому статусу', async () => {
      await token('manager1');
      for (let i = 0; i < 5; i += 1) {
        const id = await vacation('employee1', addDays('2026-11-02', i * 7));
        const results = await Promise.all([
          decide('manager1', id, 'approve'),
          decide('manager1', id, 'reject'),
        ]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        const rows = await mails(id);
        expect(rows).toHaveLength(1);
        const word =
          (await statusOf(id)) === 'APPROVED' ? 'одобрена' : 'отклонена';
        expect(rows[0].subject).toContain(word);
      }
    });
  });

  describe('доставка (OutboxDispatcher.runOnce)', () => {
    // RULES §8-2, §10-1: диспетчер отправляет одно письмо сотруднику, повторный проход - ничего
    it('после одобрения: одно письмо на email сотрудника, повторный проход пуст', async () => {
      const id = await vacation('employee1');
      await decide('manager1', id, 'approve');
      const dispatcher = app.get(OutboxDispatcher);
      await dispatcher.runOnce();
      expect(transport.sent).toHaveLength(1);
      expect(transport.sent[0]).toMatchObject({
        to: 'employee1@vacation.local',
        subject: 'Заявка на отпуск одобрена: 2026-11-02–2026-11-06',
      });
      expect((await mails(id))[0].status).toBe('SENT');
      await dispatcher.runOnce();
      expect(transport.sent).toHaveLength(1);
    });
  });
});
